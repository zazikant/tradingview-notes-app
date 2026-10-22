

# TradingView Notes App

## AX DSPy Quality Gate

The Brain RAG pipeline is now quality-gated word-to-word after the [atomic-graph-opencode](https://github.com/zazikant/atomic-graph-opencode) AX DSPy reference implementation, while serving this repo's output (streamed grounded answers via /api/brain/chat):

```
REDUCE (multi-chunk synthesis, temperature 0.2)
  → AX quality gate (src/lib/brain/ax-pipeline.ts), time-budgeted at 20s:
    repeat up to 3 iterations (MAX_ITERATIONS):
      1. VALIDATE → score 0.0-1.0 rubric on the synthesis (temperature 0.1,
         exact JSON format, scoring bands, "Be FAIR")
      if score >= 0.75 (VALIDATION_THRESHOLD):
        break
      else:
      2. REFINE → fix issues with DSPy-compiled fix context
         (compileRefinePrompt, temperature 0.2) → revalidate
ANSWER (streamed, temperature 0.3, retries with AX error-history awareness)
```

Ported patterns:

- **AX_VALIDATE_SYSTEM_PROMPT** — the Bible's VALIDATE rubric (weighted axes: coverage > fidelity > coherence > conflict surfacing > citation accuracy, exact JSON format, scoring bands, "Be FAIR") adapted to context synthesis
- **AX_REFINE_SYSTEM_PROMPT** — the Bible's REFINE prompt ("fix the identified issues while preserving what already works")
- **compileRefinePrompt()** — DSPy-style Module.compile(): surgical fix context compiled from the full error history, word-to-word
- **ErrorEntry tracking** — every failed LLM call is recorded via callWithRetryAwareness (rate-limit / transient classification) and fed into the compiled refinement prompt; the answer-stage retries use the same awareness
- **parseLLMJson + recoverTruncatedJSON** — robust JSON parsing chain for the validate response
- **Stage-specific temperatures** — reduce=0.2, validate=0.1, refine=0.2 (answer keeps its source 0.3)
- **Graceful degradation** — validation failures fall back to the Bible's default score (0.7); the gate never fails the pipeline; a 20s time budget keeps the 60s Vercel cap safe
- Echo detection (isEcho) intentionally not ported — a RAG synthesis never echoes a natural-language input the way extract/translate tasks do

The original RAG prompts (SYSTEM_PROMPT / REDUCER_PROMPT / NO_CONTEXT_PROMPT) remain untouched verbatim from rag-document-assistant-opencode.

<!-- Updated: 2026-09-18 -->
