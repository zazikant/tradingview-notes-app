/**
 * OpenCode LLM client — streaming chat completions via the OpenCode gateway.
 *
 * Ported (and simplified) from rag-document-assistant-opencode/src/lib/opencode.ts.
 * Only the controlled streaming path is kept — it's the only one used by the
 * Brain chat endpoint. We talk to the gateway via raw fetch + SSE parsing so
 * we don't need the openai SDK at runtime (though it's listed as a dep for
 * future use / type compatibility).
 *
 * Required env vars (set on Vercel):
 *   OPENCODE_API_KEY        — your OpenCode API key
 *
 * Gateway: https://opencode.ai/zen/go/v1/chat/completions
 * Model:   glm-5.1 (alias — currently serves GLM 5.3 thinking model)
 *
 * CRITICAL: GLM 5.3 is a thinking-only model. We MUST send reasoning_effort:'low'
 * to keep the reasoning overhead minimal while still ensuring the final answer
 * lands in `content`. Do NOT combine with `thinking:{type:"disabled"}` — the
 * gateway rejects the combination.
 */

const OPENCODE_GATEWAY = 'https://opencode.ai/zen/go/v1/chat/completions';
const OPENCODE_DEFAULT_MODEL = 'glm-5.1';
// 55s per-call timeout — under Vercel Hobby's 60s Node runtime cap.
// The previous 120s was never reachable on Hobby (Vercel kills at 60s).
// GLM-5.1 typically responds in 3-15s, so 55s is plenty.
const OPENCODE_DEFAULT_TIMEOUT_MS = 55_000;

function newSessionId(): string {
  // crypto.randomUUID() is available in both Edge and Node runtimes.
  return crypto.randomUUID();
}

export interface ControlledStreamOptions {
  model?: string;
  messages: { role: 'system' | 'user' | 'assistant'; content: string }[];
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  maxRetries?: number;
  /** Fired for every log line — surfaced to the LivePipelineLog panel in the UI. */
  onLog?: (line: string) => void;
  /** Fired for every content token as it arrives — appended to the chat bubble. */
  onChunk?: (text: string) => void;
}

export interface ControlledStreamResult {
  content: string;
  reasoning: string;
  model: string;
  elapsedMs: number;
  attempts: number;
}

function isRetryableError(err: any): boolean {
  const status = err?.status || err?.statusCode || 0;
  if ([429, 500, 502, 503, 504].includes(status)) return true;
  if (['ECONNRESET', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT'].includes(err?.code)) return true;
  const msg: string = (err?.message || '').toLowerCase();
  if (msg.includes('timeout') || msg.includes('rate limit') || msg.includes('too many requests')) return true;
  return false;
}

/**
 * Streaming chat completion via the OpenCode gateway.
 *
 * - 120s per-call timeout (proven reliable for GLM-5.1 on Vercel Edge)
 * - 1 attempt per call (caller can retry at the pipeline level)
 * - Streams chunks via onChunk callback
 * - Emits structured log lines via onLog callback
 * - Returns full content + reasoning + timing metadata
 */
export async function opencodeChatStreamControlled(
  opts: ControlledStreamOptions,
): Promise<ControlledStreamResult> {
  const model = opts.model || OPENCODE_DEFAULT_MODEL;
  const timeoutMs = opts.timeoutMs ?? OPENCODE_DEFAULT_TIMEOUT_MS;
  const maxRetries = opts.maxRetries ?? 1;
  const callStart = Date.now();
  const apiKey = process.env.OPENCODE_API_KEY;

  if (!apiKey) {
    throw new Error(
      'OPENCODE_API_KEY env var is not set. Add it in Vercel → Project Settings → Environment Variables.',
    );
  }

  opts.onLog?.(
    `[opencode] start  model=${model} max_tokens=${opts.maxTokens ?? 2048} temp=${opts.temperature ?? 0.7} timeout=${timeoutMs}ms`,
  );

  let lastErr: Error | null = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(OPENCODE_GATEWAY, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
          Accept: 'text/event-stream',
          'x-opencode-session': newSessionId(),
        },
        body: JSON.stringify({
          model,
          messages: opts.messages,
          max_tokens: opts.maxTokens ?? 2048,
          temperature: opts.temperature ?? 0.7,
          stream: true,
          reasoning_effort: 'low',
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(
          `OpenCode API error (${response.status}): ${errText.slice(0, 300)}`,
        );
      }
      if (!response.body) {
        throw new Error('OpenCode API returned no response body');
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let content = '';
      let reasoning = '';
      let ttfbMs: number | null = null;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (ttfbMs === null) ttfbMs = Date.now() - callStart;

        buffer += decoder.decode(value, { stream: true });
        let nlIdx: number;
        while ((nlIdx = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, nlIdx).trim();
          buffer = buffer.slice(nlIdx + 1);
          if (!line || !line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (data === '[DONE]') {
            const elapsed = Date.now() - callStart;
            opts.onLog?.(
              `[opencode] ttfb=${ttfbMs ?? 'n/a'}ms  done attempt=${attempt} elapsed=${elapsed}ms content_chars=${content.length} reasoning_chars=${reasoning.length}`,
            );
            if (!content && reasoning) {
              content = reasoning;
              opts.onChunk?.(content);
            }
            if (!content) {
              throw new Error(
                `empty content (reasoning_chars=${reasoning.length})`,
              );
            }
            return { content, reasoning, model, elapsedMs: elapsed, attempts: attempt };
          }
          try {
            const json = JSON.parse(data);
            const delta = json.choices?.[0]?.delta;
            if (delta) {
              if (typeof delta.content === 'string' && delta.content) {
                content += delta.content;
                opts.onChunk?.(delta.content);
              }
              if (typeof delta.reasoning_content === 'string') {
                reasoning += delta.reasoning_content;
              }
            }
          } catch {
            // Partial JSON across chunks — ignore, will be retried on next read.
          }
        }
      }

      const elapsed = Date.now() - callStart;
      if (!content && reasoning) {
        content = reasoning;
        opts.onChunk?.(content);
      }
      if (!content) {
        throw new Error(
          `empty content (stream ended without [DONE], reasoning_chars=${reasoning.length})`,
        );
      }
      opts.onLog?.(
        `[opencode] ttfb=${ttfbMs ?? 'n/a'}ms  done attempt=${attempt} elapsed=${elapsed}ms content_chars=${content.length} reasoning_chars=${reasoning.length}`,
      );
      return { content, reasoning, model, elapsedMs: elapsed, attempts: attempt };
    } catch (err: unknown) {
      clearTimeout(timeout);
      const e = err as Error;
      const elapsed = Date.now() - callStart;
      lastErr = e;
      if (e.name === 'AbortError') {
        opts.onLog?.(
          `[opencode] TIMEOUT attempt=${attempt} after ${timeoutMs}ms`,
        );
      } else {
        opts.onLog?.(
          `[opencode] ERROR attempt=${attempt} after ${elapsed}ms: ${e.name}: ${e.message.slice(0, 200)}`,
        );
      }
      if (attempt < maxRetries) {
        const backoff = 500 * attempt;
        opts.onLog?.(
          `[opencode] retry  backing off ${backoff}ms before attempt ${attempt + 1}`,
        );
        await new Promise((r) => setTimeout(r, backoff));
      } else if (!isRetryableError(e)) {
        // Non-retryable — surface immediately so the UI shows a real error.
        throw e;
      }
    }
  }

  const elapsed = Date.now() - callStart;
  const finalErr = lastErr ?? new Error('unknown error');
  throw new Error(
    `OpenCode call failed after ${maxRetries} attempts (${elapsed}ms): ${finalErr.name}: ${finalErr.message}`,
  );
}
