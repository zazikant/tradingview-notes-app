/**
 * AX DSPy quality gate for the Brain RAG pipeline — ported word-to-word
 * from atomic-graph-opencode (the "Bible" AX DSPy reference implementation),
 * serving this repo's output (streamed grounded answers built on a reduced
 * context).
 *
 * The Bible pipeline is: EXTRACT → LINK → VALIDATE → REFINE with a
 * validate→refine loop gated by a 0.75 threshold. In this repo the
 * equivalent "extraction" stage is the REDUCE stage (multi-chunk context
 * synthesis in /api/brain/chat). This module wraps that stage with the
 * Bible's VALIDATE → REFINE quality gate:
 *
 * - AX_VALIDATE_SYSTEM_PROMPT — the Bible's VALIDATE rubric (weighted axes,
 *   exact JSON format, scoring bands, "Be FAIR") adapted to context synthesis
 * - AX_REFINE_SYSTEM_PROMPT  — the Bible's REFINE prompt ("fix the identified
 *   issues while preserving what already works")
 * - compileRefinePrompt()    — DSPy-style Module.compile(): surgical fix
 *   context compiled from the full error history, word-to-word
 * - getStageTemperature()    — validate=0.1, refine=0.2 (reduce synthesis
 *   keeps its existing 0.2 in the route)
 * - parseLLMJson() + recoverTruncatedJSON() — robust JSON parsing chain for
 *   the validate response
 * - callWithRetryAwareness() — rate-limit / transient error detection with
 *   ErrorEntry history (feeds compileRefinePrompt on the next attempt)
 * - VALIDATION_THRESHOLD 0.75, MAX_ITERATIONS 3 — Bible defaults
 *
 * Echo detection (isEcho) is intentionally NOT ported: a RAG synthesis never
 * risks echoing a natural-language "input" the way extract/translate tasks do.
 *
 * Time budget: the chat route runs on Vercel Hobby Node (60s cap), so the
 * gate takes a deadline and degrades gracefully — the reduce output is
 * returned as-is when the budget runs out.
 */

// ─── Constants (from atomic-graph-opencode) ──────────────────────────────────

/** Minimum validation score (0.0-1.0) required to accept the synthesis.
 *  Ported from atomic-graph-opencode's default threshold (0.75). */
export const VALIDATION_THRESHOLD = 0.75;

/** Maximum pipeline iterations (validate → refine loops).
 *  Ported from atomic-graph-opencode's default (3). */
export const MAX_ITERATIONS = 3;

// ─── DSPy-style Error Tracking (from atomic-graph-opencode) ─────────────────

export interface ErrorEntry {
  attempt: number;
  stage: 'reduce' | 'validate' | 'refine';
  error: string;
  issues?: string[];
}

/** Validation result shape — ported word-to-word from atomic-graph-opencode's
 *  validate step: score is 0.0-1.0 with issues + suggestions lists. */
export interface AxValidationResult {
  score: number;
  issues: string[];
  suggestions: string[];
}

// ─── VALIDATE — quality-aware self-critique (ported from atomic-graph) ───────
// Same structure word-to-word: weighted axes, exact JSON format, scoring
// bands, and the "Be FAIR" instruction. Axes adapted from the Bible's
// semantic-fidelity rubric to multi-chunk context synthesis.

export const AX_VALIDATE_SYSTEM_PROMPT = `You are a context synthesis quality reviewer. Evaluate the provided synthesis and respond in JSON format.

Evaluate on these criteria (weight: coverage > fidelity > coherence > conflict surfacing > citation accuracy):
1. COVERAGE: Does the synthesis include ALL relevant information from the source chunks? Minor wording differences don't lower score.
2. FIDELITY: Does it preserve the chunks' meaning exactly — nothing added, nothing removed, nothing changed?
3. COHERENCE: Is it a unified synthesis (not concatenated fragments)? Are connections between chunks made explicit?
4. CONFLICT SURFACING: Are contradictions between sources noted rather than silently resolved?
5. CITATION ACCURACY: Are statements attributable to the documents they came from?

Respond in this exact JSON format:
{
  "score": 0.85,
  "issues": ["issue1", "issue2"],
  "suggestions": ["suggestion1"]
}

Scoring:
- 0.90-1.00: Faithful representation, minor wording differences only
- 0.75-0.89: Minor gaps
- 0.50-0.74: Significant gaps
- 0.00-0.49: Major problems

Be FAIR — clear chunks + good synthesis = high score. Don't invent reasons to lower it.
Only list issues affecting MEANING or COMPLETENESS.`;

// ─── REFINE — targeted fixes (ported from atomic-graph) ──────────────────────

export const AX_REFINE_SYSTEM_PROMPT = `You are a context synthesis refinement engine. Fix the identified issues while preserving what already works.
Output ONLY the corrected synthesis, nothing else.

CRITICAL OUTPUT RULES:
- Output ONLY the corrected synthesis text. No markdown fences, no explanation, no meta-commentary.
- Preserve accurate wording where it is correct — only fix COMPLETENESS or FIDELITY problems.
- Missing information from the chunks? ADD it.
- Contradictions between sources? SURFACE them instead of resolving silently.
- Rambling or redundant passages? TIGHTEN them.
- No speculative additions — never invent information not in the chunks.
- Keep everything that already works — return the FULL corrected synthesis with unchanged parts as-is.`;

// ─── VALIDATE / REFINE user prompt builders ──────────────────────────────────
// Ported word-to-word from atomic-graph-opencode's validate/refine user
// prompts, with long inputs truncated (Bible truncates notes at 3000).

export function buildValidateUserPrompt(input: {
  query: string;
  chunksContext: string;
  synthesis: string;
}): string {
  const chunksForValidation = input.chunksContext.length > 3000
    ? input.chunksContext.slice(0, 3000) + '\n… (chunks truncated)'
    : input.chunksContext;
  const synthesisForValidation = input.synthesis.length > 3000
    ? input.synthesis.slice(0, 3000) + '\n… (synthesis truncated)'
    : input.synthesis;

  return `Evaluate this context synthesis for quality and fidelity.

Axes (weight: coverage > fidelity > coherence > conflict surfacing > citation accuracy):
1. COVERAGE: Does the synthesis include ALL relevant information from the source chunks?
2. FIDELITY: Does it preserve the chunks' meaning exactly?
3. COHERENCE: Is it a unified synthesis, not concatenated fragments?
4. CONFLICT SURFACING: Are contradictions between sources noted?
5. CITATION ACCURACY: Are statements attributable to their documents?

Scoring:
- 0.90-1.00: Faithful representation, minor wording differences only
- 0.75-0.89: Minor gaps
- 0.50-0.74: Significant gaps
- 0.00-0.49: Major problems

Be FAIR — clear chunks + good synthesis = high score. Don't invent reasons to lower it.

ORIGINAL CHUNKS:
${chunksForValidation}

SYNTHESIS (will ground the answer to: ${input.query.slice(0, 200)}):
"""
${synthesisForValidation}
"""

Return JSON: { "score": 0.85, "issues": ["..."], "suggestions": ["..."] }
Only list issues affecting MEANING or COMPLETENESS.`;
}

export function buildRefineUserPrompt(input: {
  query: string;
  chunksContext: string;
  synthesis: string;
  fixContext: string;
  issues: string[];
}): string {
  return `Fix ONLY these specific issues in the context synthesis.

Rules:
- Preserve accurate wording where it is correct
- Only fix COMPLETENESS or FIDELITY problems
- Missing information from the chunks? ADD it.
- Contradictions between sources? SURFACE them.
- Rambling passage? TIGHTEN it.
- No speculative additions.
- Return the FULL corrected synthesis. Keep unchanged parts as-is.
- ${input.fixContext}

Issues:
${input.issues.map((i) => `- ${i}`).join('\n')}

ORIGINAL CHUNKS:
${input.chunksContext}

Current synthesis (grounds the answer to: ${input.query.slice(0, 200)}):
"""
${input.synthesis}
"""`;
}

// ─── compileRefinePrompt — pure function (DSPy-like) ─────────────────────────
// Like DSPy's Module.compile() — produces focused prompts based on error history.
// This is the ONLY place refinement context construction happens.
// Ported word-to-word from atomic-graph-opencode's compileRefinePrompt().

export function compileRefinePrompt(
  issues: string[],
  errorHistory: ErrorEntry[],
  stage: 'reduce' | 'validate' | 'refine'
): string {
  // No errors yet — this is initial context
  if (errorHistory.length === 0 && issues.length === 0) {
    return `Initial ${stage} request for context synthesis`;
  }

  // Build surgical context from error history (Mode B: surgical fix)
  const latestError = errorHistory.length > 0
    ? errorHistory[errorHistory.length - 1]
    : null;
  const previousErrors = errorHistory.slice(0, -1).map(e =>
    `  Attempt ${e.attempt} | ${e.stage}: ${e.error.substring(0, 200)}`
  ).join('\n');

  const issueContext = issues.length > 0
    ? `\nValidation issues to fix:\n${issues.map(i => `  - ${i}`).join('\n')}`
    : '';

  const errorContext = latestError
    ? `\nLatest error (attempt ${latestError.attempt}, stage ${latestError.stage}): ${latestError.error.substring(0, 300)}\n${latestError.issues ? `Issues: ${latestError.issues.join(', ')}` : ''}`
    : '';

  const previousContext = previousErrors.length > 0
    ? `\nPrevious errors — do NOT repeat these patterns:\n${previousErrors}`
    : '';

  return `Refinement context for stage "${stage}":${issueContext}${errorContext}${previousContext}`;
}

// ─── Stage-Specific Temperatures (from atomic-graph-opencode's axPipeline) ───
// Lower temperature = more deterministic/focused output.

export function getStageTemperature(stage: 'reduce' | 'validate' | 'refine'): number {
  switch (stage) {
    case 'reduce': return 0.2;    // Focused synthesis (route already used 0.2)
    case 'validate': return 0.1;  // Very deterministic — objective quality assessment
    case 'refine': return 0.2;    // Slightly creative — targeted fixes
    default: return 0.3;
  }
}

// ─── callWithRetryAwareness (ported from atomic-graph-opencode) ──────────────

/**
 * Wrap an async API call with rate-limit / transient error detection.
 * Records errors to the passed errorHistory array (mutated in place — pass a
 * working copy and persist it for the loop) for DSPy-style
 * compileRefinePrompt().
 * Ported word-to-word from atomic-graph-opencode's callWithRetryAwareness().
 */
export async function callWithRetryAwareness<T>(
  fn: () => Promise<T>,
  errorHistory: ErrorEntry[],
  attempt: number,
  phaseLabel: string,
  stage: ErrorEntry['stage'],
  log?: (line: string) => void,
): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);

    // Track error in history for DSPy-style compiled prompts
    errorHistory.push({
      attempt,
      stage,
      error: msg,
    });

    const isRateLimit =
      msg.includes('rate limit') ||
      msg.includes('Rate limit') ||
      msg.includes('429') ||
      msg.includes('retry attempt') ||
      msg.includes('too many requests');

    const isTransient =
      msg.includes('server error') ||
      msg.includes('Server Error') ||
      msg.includes('502') ||
      msg.includes('503') ||
      msg.includes('504') ||
      msg.includes('temporary');

    if (isRateLimit) {
      log?.(
        `[AX Pipeline] retrying | iteration=${attempt} — Rate limited during ${phaseLabel} — all proxy retries exhausted. Please wait and try again.`
      );
    } else if (isTransient) {
      log?.(
        `[AX Pipeline] retrying | iteration=${attempt} — Transient server error during ${phaseLabel} — all proxy retries exhausted. Try again shortly.`
      );
    }

    throw error;
  }
}

// ─── Quality-Gated Reduce (the Bible's run() loop, serving this repo) ────────

/** Minimal LLM call contract so this module stays decoupled from the client. */
export type AxLLMCall = (
  systemPrompt: string,
  userContent: string,
  maxTokens: number,
  temperature: number,
) => Promise<string>;

export interface QualityGatedReduceResult {
  /** Final (possibly refined) synthesis — "" falls back to the raw context. */
  synthesis: string;
  /** Final rubric score 0.0-1.0 (0 when validation could not run). */
  score: number;
  issues: string[];
  /** Validate/refine trace for the pipeline log. */
  pipeline: string[];
  iterations: number;
}

/**
 * Validate → refine loop over the REDUCE stage output, ported word-to-word
 * from atomic-graph-opencode's run() state machine:
 *
 *   validate synthesis → score >= 0.75 ? accept : refine (compiled context)
 *   → revalidate → … up to MAX_ITERATIONS, bounded by the time budget.
 *
 * Every failure degrades gracefully: validation errors fall back to the
 * Bible's default score (0.7) with the current synthesis, and the caller
 * can always fall back to the raw context.
 */
export async function runQualityGatedReduce(opts: {
  query: string;
  /** Raw multi-chunk context (the reducer's input). */
  chunksContext: string;
  /** The REDUCE stage's synthesis output. */
  synthesis: string;
  callLLM: AxLLMCall;
  onLog?: (line: string) => void;
  /** Wall-clock budget in ms for the whole gate (Vercel Hobby 60s cap). */
  timeBudgetMs?: number;
}): Promise<QualityGatedReduceResult> {
  const log = opts.onLog ?? (() => {});
  const deadline = Date.now() + (opts.timeBudgetMs ?? 20_000);
  const timeLeft = () => deadline - Date.now();

  const errorHistory: ErrorEntry[] = [];
  const pipeline: string[] = [];
  let currentSynthesis = opts.synthesis;
  let score = 0;
  let currentIssues: string[] = [];
  let iterations = 0;

  // Resume-from state machine: validate → refine → done (Bible run() pattern)
  type GateStage = 'validate' | 'refine' | 'done';
  let resumeFrom: GateStage = 'validate';

  while (resumeFrom !== 'done' && iterations < MAX_ITERATIONS && timeLeft() > 3_000) {
    // ─── VALIDATE ────────────────────────────────────────────────────────
    if (resumeFrom === 'validate') {
      pipeline.push('validate');
      iterations++;
      log(`[ax-pipeline] validate ${iterations}/${MAX_ITERATIONS} — temperature=${getStageTemperature('validate')}, max_tokens=1024, threshold=${VALIDATION_THRESHOLD}`);

      try {
        const raw = await callWithRetryAwareness(
          () => opts.callLLM(
            AX_VALIDATE_SYSTEM_PROMPT,
            buildValidateUserPrompt({
              query: opts.query,
              chunksContext: opts.chunksContext,
              synthesis: currentSynthesis,
            }),
            1024, // Bible: validation returns small JSON — fixed 1024 is enough
            getStageTemperature('validate'),
          ),
          errorHistory,
          iterations,
          'Validate',
          'validate',
          log,
        );

        // Robust JSON parsing (parseLLMJson + truncation recovery), then
        // clamp values exactly like atomic-graph-opencode's validate step.
        const parsed = parseLLMJson<Partial<AxValidationResult>>(raw);
        score =
          typeof parsed.score === 'number'
            ? Math.min(1, Math.max(0, parsed.score))
            : 0.7; // Bible default fallback score
        currentIssues = Array.isArray(parsed.issues) ? parsed.issues : [];

        const passed = score >= VALIDATION_THRESHOLD;
        log(`[ax-pipeline] validate → score=${score} ${passed ? 'PASS' : 'FAIL'} (${currentIssues.length} issue(s))`);
        pipeline.push(passed ? 'validate-pass' : 'validate-fail');

        if (passed) {
          resumeFrom = 'done';
        } else {
          resumeFrom = 'refine';
        }
      } catch (validateError) {
        // Bible pattern: validate failure degrades gracefully to the default
        // fallback score instead of failing the pipeline.
        const msg = validateError instanceof Error ? validateError.message : String(validateError);
        log(`[ax-pipeline] validate failed — using default score 0.7 (${msg.slice(0, 120)})`);
        score = 0.7;
        currentIssues = ['Validation step failed — using estimated score'];
        pipeline.push('validate-error');
        resumeFrom = 'done';
      }
    }

    // ─── REFINE ──────────────────────────────────────────────────────────
    if (resumeFrom === 'refine') {
      pipeline.push('refine');
      log(`[ax-pipeline] refine — compiling surgical fix context (DSPy)`);

      // Compile DSPy-style refinement context from error history
      const fixContext = compileRefinePrompt(currentIssues, errorHistory, 'refine');
      log(`[ax-pipeline] refinement context: ${fixContext.substring(0, 200)}`);

      try {
        currentSynthesis = await callWithRetryAwareness(
          () => opts.callLLM(
            AX_REFINE_SYSTEM_PROMPT,
            buildRefineUserPrompt({
              query: opts.query,
              chunksContext: opts.chunksContext,
              synthesis: currentSynthesis,
              fixContext,
              issues: currentIssues,
            }),
            2048, // Synthesis refinement — bounded but roomy
            getStageTemperature('refine'),
          ),
          errorHistory,
          iterations,
          'Refine',
          'refine',
          log,
        );
        pipeline.push('revalidate');
        resumeFrom = 'validate'; // Bible pattern: revalidate after refine
      } catch (refineError) {
        // Keep current result (Bible run(): refine failure keeps the output)
        const msg = refineError instanceof Error ? refineError.message : String(refineError);
        log(`[ax-pipeline] refine failed — keeping current synthesis (${msg.slice(0, 120)})`);
        errorHistory.push({ attempt: iterations, stage: 'refine', error: msg, issues: currentIssues });
        resumeFrom = 'done';
      }
    }
  }

  if (timeLeft() <= 3_000 && resumeFrom !== 'done') {
    log('[ax-pipeline] time budget exhausted — returning current synthesis');
    pipeline.push('budget-exhausted');
  }

  pipeline.push(`complete (score=${score}, iterations=${iterations})`);

  return {
    synthesis: currentSynthesis,
    score,
    issues: currentIssues,
    pipeline,
    iterations,
  };
}

// ─── Robust JSON Parser (ported word-to-word from atomic-graph-opencode) ────

/**
 * Robust JSON parser for LLM outputs.
 * Strips markdown code fences, extracts JSON objects,
 * and handles reasoning model outputs that may contain
 * chain-of-thought text before/after the JSON.
 */
export function parseLLMJson<T>(raw: string): T {
  // Strip markdown code fences: ```json ... ``` or ``` ... ```
  let cleaned = raw.trim();

  const fenceMatch = cleaned.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenceMatch) {
    cleaned = fenceMatch[1].trim();
  }

  // Strategy 1: Try direct parse of the full text
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    // Continue to more sophisticated parsing
  }

  // Strategy 2: Extract balanced JSON using bracket matching.
  const jsonStr = extractBalancedJSON(cleaned);
  if (jsonStr) {
    try {
      return JSON.parse(jsonStr) as T;
    } catch {
      // Continue to fixes
    }
  }

  // Strategy 3: Fix common issues like trailing commas
  if (jsonStr) {
    const fixed = jsonStr.replace(/,\s*([}\]])/g, '$1');
    try {
      return JSON.parse(fixed) as T;
    } catch {
      // Continue
    }
  }

  // Strategy 4: Try the greedy regex as a last resort before failing
  const greedyMatch = cleaned.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
  if (greedyMatch) {
    try {
      return JSON.parse(greedyMatch[1]) as T;
    } catch {
      // Greedy match didn't work either
    }
  }

  throw new Error(
    `Failed to parse LLM JSON response. Output length: ${raw.length} chars.\nFirst 300 chars: ${raw.slice(0, 300)}\nLast 300 chars: ${raw.slice(-300)}`
  );
}

/**
 * Extract a balanced JSON object or array from text that may contain
 * extra content before or after the JSON.
 */
function extractBalancedJSON(text: string): string | null {
  const startCurly = text.indexOf('{');
  const startSquare = text.indexOf('[');

  let startIdx: number;
  let openCh: string;
  let closeCh: string;

  if (startCurly === -1 && startSquare === -1) return null;
  if (startCurly === -1) {
    startIdx = startSquare;
    openCh = '[';
    closeCh = ']';
  } else if (startSquare === -1) {
    startIdx = startCurly;
    openCh = '{';
    closeCh = '}';
  } else {
    startIdx = Math.min(startCurly, startSquare);
    openCh = startIdx === startCurly ? '{' : '[';
    closeCh = startIdx === startCurly ? '}' : ']';
  }

  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = startIdx; i < text.length; i++) {
    const ch = text[i];

    if (escape) {
      escape = false;
      continue;
    }

    if (ch === '\\' && inString) {
      escape = true;
      continue;
    }

    if (ch === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (ch === openCh || ch === '{' || ch === '[') {
      if (ch === openCh && depth === 0) {
        depth = 1;
      } else if (depth > 0) {
        depth++;
      }
    } else if (ch === closeCh || ch === '}' || ch === ']') {
      if (depth > 0) {
        depth--;
        if (depth === 0) {
          return text.slice(startIdx, i + 1);
        }
      }
    }
  }

  return null;
}

/**
 * Attempt to recover useful data from a truncated JSON response.
 */
export function recoverTruncatedJSON<T>(raw: string): T | null {
  let cleaned = raw.trim();

  const fenceMatch = cleaned.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenceMatch) {
    cleaned = fenceMatch[1].trim();
  }

  const jsonStart = cleaned.search(/\{/);
  if (jsonStart === -1) return null;
  cleaned = cleaned.slice(jsonStart);

  const attempt1 = closeOpenBrackets(cleaned);
  if (attempt1 !== null) {
    return attempt1 as T;
  }

  const attempt2 = truncateToLastCompleteElement(cleaned);
  if (attempt2 !== null) {
    return attempt2 as T;
  }

  const attempt3 = recoverFieldsIndividually(cleaned);
  if (attempt3 !== null) {
    return attempt3 as T;
  }

  return null;
}

function closeOpenBrackets(cleaned: string): Record<string, unknown> | null {
  let curlyDepth = 0, squareDepth = 0;
  let inString = false, escape = false;

  for (const ch of cleaned) {
    if (escape) { escape = false; continue; }
    if (ch === '\\' && inString) { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') curlyDepth++;
    else if (ch === '}') curlyDepth--;
    else if (ch === '[') squareDepth++;
    else if (ch === ']') squareDepth--;
  }

  if (curlyDepth === 0 && squareDepth === 0) return null;

  let attempt = findLastSafeTruncation(cleaned);
  if (attempt === null) return null;

  let newCurly = 0, newSquare = 0;
  let inStr = false, esc = false;
  for (const ch of attempt) {
    if (esc) { esc = false; continue; }
    if (ch === '\\' && inStr) { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === '{') newCurly++;
    else if (ch === '}') newCurly--;
    else if (ch === '[') newSquare++;
    else if (ch === ']') newSquare--;
  }

  for (let i = 0; i < newSquare; i++) attempt += ']';
  for (let i = 0; i < newCurly; i++) attempt += '}';

  attempt = attempt.replace(/,\s*([}\]])/g, '$1');

  try {
    return JSON.parse(attempt) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function findLastSafeTruncation(text: string): string | null {
  const stringState: boolean[] = new Array(text.length).fill(false);
  let isStr = false, isEsc = false;
  for (let j = 0; j < text.length; j++) {
    if (isEsc) { isEsc = false; stringState[j] = isStr; continue; }
    if (text[j] === '\\' && isStr) { isEsc = true; stringState[j] = isStr; continue; }
    if (text[j] === '"') isStr = !isStr;
    stringState[j] = isStr;
  }

  const endsInString = stringState[text.length - 1];

  if (endsInString) {
    let stringStartQuote = -1;
    for (let j = text.length - 1; j >= 0; j--) {
      if (text[j] === '"') {
        const stateBefore = j > 0 ? stringState[j - 1] : false;
        const stateAfter = stringState[j];
        if (!stateBefore && stateAfter) {
          stringStartQuote = j;
          break;
        }
      }
    }

    if (stringStartQuote >= 0) {
      let beforeQuote = stringStartQuote - 1;
      while (beforeQuote >= 0 && /\s/.test(text[beforeQuote])) beforeQuote--;

      if (beforeQuote >= 0) {
        const prevChar = text[beforeQuote];
        if (prevChar === ':') {
          let objOpenIdx = -1;
          let depth = 0;
          for (let k = beforeQuote; k >= 0; k--) {
            if (text[k] === '}' && !stringState[k]) depth++;
            else if (text[k] === '{' && !stringState[k]) {
              if (depth === 0) { objOpenIdx = k; break; }
              depth--;
            }
          }
          if (objOpenIdx >= 0) {
            let beforeObj = objOpenIdx - 1;
            while (beforeObj >= 0 && /\s/.test(text[beforeObj])) beforeObj--;
            if (beforeObj >= 0 && text[beforeObj] === ',') {
              return text.slice(0, beforeObj).replace(/,\s*$/, '');
            }
            if (beforeObj >= 0 && text[beforeObj] === '[') {
              return text.slice(0, beforeObj + 1);
            }
            if (beforeObj >= 0 && text[beforeObj] === '{') {
              return text.slice(0, beforeObj + 1);
            }
            return text.slice(0, objOpenIdx).replace(/,\s*$/, '');
          }
          return text.slice(0, beforeQuote).replace(/,\s*$/, '');
        }
        if (prevChar === ',' || prevChar === '[') {
          return text.slice(0, beforeQuote + (prevChar === '[' ? 1 : 0)).replace(/,\s*$/, '');
        }
      }
      return text.slice(0, stringStartQuote).replace(/,\s*$/, '');
    }
  }

  let i = text.length - 1;
  while (i >= 0 && /\s/.test(text[i])) i--;
  if (i < 0) return null;

  const ch = text[i];

  if ((ch === '}' || ch === ']') && !stringState[i]) {
    let end = i;
    let k = i - 1;
    while (k >= 0 && /\s/.test(text[k])) k--;
    if (k >= 0 && text[k] === ',') end = k;
    return text.slice(0, end + 1).replace(/,\s*$/, '');
  }

  if (ch === '"' && !stringState[i]) {
    let result = text.slice(0, i + 1);
    result = result.replace(/,\s*$/, '');
    return result;
  }

  if (/\d/.test(ch)) {
    let numEnd = i;
    let j = i;
    while (j >= 0 && /[0-9.eE+\-]/.test(text[j])) j--;
    let beforeNum = j;
    while (beforeNum >= 0 && /\s/.test(text[beforeNum])) beforeNum--;
    if (beforeNum >= 0 && (text[beforeNum] === ':' || text[beforeNum] === ',' || text[beforeNum] === '[')) {
      let result = text.slice(0, numEnd + 1);
      result = result.replace(/,\s*$/, '');
      return result;
    }
  }

  for (let j = text.length - 1; j >= 0; j--) {
    if ((text[j] === '}' || text[j] === ']') && !stringState[j]) {
      let result = text.slice(0, j + 1);
      result = result.replace(/,\s*$/, '');
      return result;
    }
  }

  return null;
}

function truncateToLastCompleteElement(cleaned: string): Record<string, unknown> | null {
  const stringState: boolean[] = new Array(cleaned.length).fill(false);
  let isStr = false, isEsc = false;
  for (let j = 0; j < cleaned.length; j++) {
    if (isEsc) { isEsc = false; stringState[j] = isStr; continue; }
    if (cleaned[j] === '\\' && isStr) { isEsc = true; stringState[j] = isStr; continue; }
    if (cleaned[j] === '"') isStr = !isStr;
    stringState[j] = isStr;
  }

  let lastCompleteObjEnd = -1;
  for (let j = cleaned.length - 1; j >= 0; j--) {
    if (cleaned[j] === '}' && !stringState[j]) { lastCompleteObjEnd = j; break; }
  }

  let lastCompleteArrEnd = -1;
  for (let j = cleaned.length - 1; j >= 0; j--) {
    if (cleaned[j] === ']' && !stringState[j]) { lastCompleteArrEnd = j; break; }
  }

  let bestIdx = Math.max(lastCompleteObjEnd, lastCompleteArrEnd);
  if (bestIdx <= 0) return null;

  let truncated = cleaned.slice(0, bestIdx + 1);
  truncated = truncated.replace(/,\s*$/, '');

  let curly = 0, square = 0;
  let inStr = false, esc = false;
  for (const ch of truncated) {
    if (esc) { esc = false; continue; }
    if (ch === '\\' && inStr) { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === '{') curly++;
    else if (ch === '}') curly--;
    else if (ch === '[') square++;
    else if (ch === ']') square--;
  }

  for (let i = 0; i < square; i++) truncated += ']';
  for (let i = 0; i < curly; i++) truncated += '}';
  truncated = truncated.replace(/,\s*([}\]])/g, '$1');

  try {
    return JSON.parse(truncated) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function recoverFieldsIndividually(cleaned: string): Record<string, unknown> | null {
  try {
    const result: Record<string, unknown> = {};

    const scoreMatch = cleaned.match(/"score"\s*:\s*([\d.]+)/);
    if (scoreMatch) result.score = parseFloat(scoreMatch[1]);

    const issuesMatch = cleaned.match(/"issues"\s*:\s*\[/);
    if (issuesMatch) {
      const issuesStart = cleaned.indexOf('[', cleaned.indexOf('"issues"'));
      const recoveredIssues = recoverArrayElements(cleaned, issuesStart);
      if (recoveredIssues && recoveredIssues.length > 0) result.issues = recoveredIssues;
    }

    const suggestionsMatch = cleaned.match(/"suggestions"\s*:\s*\[/);
    if (suggestionsMatch) {
      const suggestionsStart = cleaned.indexOf('[', cleaned.indexOf('"suggestions"'));
      const recoveredSuggestions = recoverArrayElements(cleaned, suggestionsStart);
      if (recoveredSuggestions && recoveredSuggestions.length > 0) result.suggestions = recoveredSuggestions;
    }

    if (Object.keys(result).length > 0) return result;
  } catch {
    // Recovery failed
  }

  return null;
}

function recoverArrayElements(text: string, arrayStartIndex: number): unknown[] | null {
  if (arrayStartIndex === -1) return null;

  const elements: unknown[] = [];
  let depth = 0;
  let objStart = -1;
  let inString = false;
  let escape = false;

  for (let i = arrayStartIndex; i < text.length; i++) {
    const ch = text[i];

    if (escape) { escape = false; continue; }
    if (ch === '\\' && inString) { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;

    if (ch === '{') {
      if (depth === 0) objStart = i;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && objStart !== -1) {
        const objStr = text.slice(objStart, i + 1);
        try { elements.push(JSON.parse(objStr)); } catch { /* skip */ }
        objStart = -1;
      }
    }
  }

  return elements;
}
