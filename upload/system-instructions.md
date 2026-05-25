# System Instructions: AI Research Agent Pipeline

## Overview

This document defines the end-to-end workflow for running a **seed researcher agent** (`.py`) and a **research delegator** (`.md`) to produce deep research output files on any given query. Follow these instructions exactly to ensure seamless, repeatable execution.

---

## Input Files (Provided by User)

| File | Purpose |
|------|---------|
| `code_for AI agent .py` | LangGraph-based adversarial research agent. Searches web, browses pages, runs 3 strategies (quick/deep/hybrid), and synthesizes via adversarial judge. |
| `research-delegator.md` | Sub-agent spec defining the research workflow: multi-source gathering, cross-validation, and 3 standardized output files (summary, sources, examples). |

---

## Step-by-Step Pipeline

### Step 1: Read and Understand Input Files

1. Read the `.py` file fully — understand its graph structure, API keys, LLM client, and output format.
2. Read the `.md` file fully — understand the research delegator workflow (Phases A-D), output file templates, and quality standards.

**Key information from the .py file:**
- Uses NVIDIA NIM (`openai/gpt-oss-120b`) as the LLM
- Uses Serper API for web search
- Uses Browserless API for headless page fetching
- Graph pipeline: `classifier → search → reducer_search → browser → reducer_browse → all_strategies → judge → END`
- Three strategies: Quick (snippets only), Deep (full page content), Hybrid (balanced)
- Adversarial Judge synthesizes the best answer from all three strategies
- The LLM often puts its answer in `reasoning_content` instead of `content` — the code handles this fallback

### Step 2: Set Up Python Environment

```bash
# Check which Python is active
which python3

# Install dependencies (use the active venv's pip)
python3 -m pip install langgraph langchain-openai langchain-core httpx pydantic openai nest_asyncio
```

**Common issues and fixes:**
- If `pip install` fails with PEP 668 error, use: `python3 -m pip install ...` (targets the venv)
- If `ModuleNotFoundError` persists, verify the correct Python is being used: `python3 -c "import langgraph"`
- The environment uses `nest_asyncio.apply()` for async compatibility

### Step 3: Adapt the .py File for Execution

Make these modifications to the original `.py` file:

**3a. Replace argparse with hardcoded query**
```python
# REMOVE:
import argparse
parser = argparse.ArgumentParser()
parser.add_argument("--query", type=str, required=True, help="Search query")
args = parser.parse_args()

# REPLACE WITH:
QUERY = "<user's research query here>"
```

**3b. Replace `args.query` with `QUERY`**
```python
# REMOVE:
result = run_query(args.query)

# REPLACE WITH:
result = run_query(QUERY)
```

**3c. Add JSON output export at the end of the file**
```python
# Add after the final print statements:
import json
output = {
    "query": result['user_query'],
    "intent": result['intent'],
    "strategy_outputs": result.get('strategy_outputs', {}),
    "final_answer": result['final_answer'],
    "aggregated_text": result.get('aggregated_text', ''),
    "search_results": result.get('search_results', []),
    "errors": result.get('errors', []),
}
with open('/home/z/my-project/download/agent_output.json', 'w', encoding='utf-8') as f:
    json.dump(output, f, indent=2, ensure_ascii=False)
print("\nResults saved to agent_output.json")
```

**3d. Save the adapted file**
```bash
cp "upload/code_for AI agent .py" /home/z/my-project/agent.py
# Apply the edits above, then save
```

### Step 4: Run the Agent

```bash
cd /home/z/my-project && python3 agent.py 2>&1
```

**Expected output:**
- Classifier assigns intent (search/browse/unknown)
- SearchNode fetches 10 results from Serper
- BrowserNode fetches top pages (some may 429 rate-limit — that's okay)
- Three strategies generate answers
- Adversarial Judge synthesizes final answer with critique
- JSON output saved to `agent_output.json`

**Timeout:** Allow up to 10 minutes. The LLM calls are streaming and can take 10-30 seconds each. The full pipeline runs 5-7 LLM calls.

### Step 5: Run Supplementary Web Searches

While the agent handles the primary research, also run **3-5 web searches** using `z-ai` CLI for broader source coverage:

```bash
z-ai function -n web_search -a '{"query": "<query> 2026", "num": 10}' -o /home/z/my-project/search_1.json
z-ai function -n web_search -a '{"query": "<query> code example python", "num": 10}' -o /home/z/my-project/search_2.json
z-ai function -n web_search -a '{"query": "<query> production patterns best practices", "num": 10}' -o /home/z/my-project/search_3.json
```

**Optional: Fetch full content from top URLs**
```bash
z-ai function -n page_reader -a '{"url": "https://example.com/article"}' -o /home/z/my-project/page_1.json
```

### Step 6: Generate Research Delegator Output Files

Using the agent's JSON output + web search results, generate 3 files following the `research-delegator.md` templates:

---

#### File 1: `{topic}-summary.md`

```markdown
# {Topic} - Research Summary

## Executive Summary
[2-3 paragraphs synthesizing the agent's final_answer + web search findings]

## Key Findings
[5-8 main findings organized by theme, each with 3-5 sentences of detail]
- Include specific technical details, API names, code patterns
- Cross-reference multiple sources for each finding

## Actionable Insights
[Specific recommendations — what should the user DO with this info]

## Latest Developments (2026)
[Current trends, recent announcements, new features]

## Confidence Assessment
- Research Coverage: X/10
- Code Implementation: Y/10
- API Accuracy: Z/10

## Next Steps
[5-6 concrete next steps ranked by priority]
```

**Quality standards:**
- Each finding must have at least 3-5 sentences (no single-sentence paragraphs)
- Each section must have at least 150-200 words
- Include specific technical details, not vague generalizations
- Cross-validate claims across multiple sources

---

#### File 2: `{topic}-sources.md`

```markdown
# {Topic} - Sources

## Primary Sources
### [Source Name]
- URL: [url]
- Access Date: [date]
- Reliability: [score/10]
- Key Excerpts: [direct quotes from the source]

## Secondary Sources
[Same format, lower reliability scores]

## Source Reliability Summary
| Source | Type | Reliability |
|--------|------|-------------|
```

**Reliability scoring:**
- 10/10: Official documentation (LangChain docs, LangGraph API reference)
- 8-9/10: Vendor tutorials (Elastic.co, official blog posts)
- 7/10: Reputable community articles (Medium with high engagement, Dev.to)
- 6/10: Community posts (Reddit, YouTube, forums)
- 5/10: Single unverified source

**Source types:** Official Documentation, Official Blog, Vendor Tutorial, Community Article, Community Post, Video Tutorial, GitHub Issue

---

#### File 3: `{topic}-examples.md`

```markdown
# {Topic} - Code Examples

## Implementation Reliability Guide
- [VERIFIED]: Code validated 2+ official/authoritative sources (8-10/10)
- [NEEDS VERIFICATION]: Single source or community-only validation (5-7/10)
- [SPECULATIVE]: Conceptual only, not tested in production (1-4/10)

## Example 1: [Title] [VERIFIED - 9/10]
Sources: [list which sources validate this code]
[Complete, runnable Python code block]

## Example 2: [Title] [NEEDS VERIFICATION - 6/10]
Sources: [list sources]
[Code block with caveats noted]
```

**Code example requirements:**
- Every example must have a reliability rating with source citations
- Code must be syntactically correct Python
- Include imports, type hints, and docstrings
- Show the complete usage pattern (graph construction + invocation)
- Include comments explaining HITL-specific patterns

---

### Step 7: Copy All Files to Download Directory

```bash
cp /home/z/my-project/agent_output.json /home/z/my-project/download/
cp "/home/z/my-project/upload/code_for AI agent .py" /home/z/my-project/download/code_for_AI_agent.py
cp /home/z/my-project/upload/research-delegator.md /home/z/my-project/download/research-delegator.md
cp /home/z/my-project/agent.py /home/z/my-project/download/agent_<topic_slug>.py
```

Ensure all generated files are in `/home/z/my-project/download/`.

---

## File Naming Convention

| Output | Name Pattern | Example |
|--------|-------------|---------|
| Summary | `{topic-slug}-summary.md` | `hitl-langgraph-summary.md` |
| Sources | `{topic-slug}-sources.md` | `hitl-langgraph-sources.md` |
| Examples | `{topic-slug}-examples.md` | `hitl-langgraph-examples.md` |
| Agent JSON | `agent_output.json` | `agent_output.json` |
| Adapted script | `agent_{topic-slug}.py` | `agent_hitl_langgraph.py` |

---

## Quality Checklist

Before finalizing, verify:

- [ ] Agent ran successfully (no import errors, no API key issues)
- [ ] Agent output JSON contains `final_answer` with substantial content (>500 chars)
- [ ] At least 3 web searches were performed for source diversity
- [ ] Summary has 5+ key findings, each with 3+ sentences
- [ ] Sources file has 10+ entries with reliability scores
- [ ] Examples file has 3+ code examples with reliability ratings
- [ ] No single-sentence paragraphs in any output file
- [ ] All files saved to `/home/z/my-project/download/`
- [ ] Original user files preserved in download directory

---

## Troubleshooting

| Issue | Solution |
|-------|----------|
| `ModuleNotFoundError` | Run `python3 -m pip install <package>` targeting the active venv |
| `argparse` error | Replace `args.query` with hardcoded `QUERY` string |
| Serper 429 rate limit | Agent retries automatically with exponential backoff |
| Browserless 429 rate limit | Agent retries automatically; some pages will be skipped — that's acceptable |
| LLM returns empty content | Code already handles `reasoning_content` fallback for gpt-oss-120b |
| `nest_asyncio` error | Ensure `nest_asyncio.apply()` is called before any async operations |
| `asyncio.get_event_loop()` deprecation warning | Safe to ignore in Python 3.12; does not affect functionality |

---

## Quick-Start Command Sequence

```bash
# 1. Read input files
# (Read both files using the Read tool)

# 2. Install deps
python3 -m pip install langgraph langchain-openai langchain-core httpx pydantic openai nest_asyncio

# 3. Adapt and save the agent script
# (Apply edits: replace argparse, add JSON export)

# 4. Run the agent
cd /home/z/my-project && python3 agent.py 2>&1

# 5. Run supplementary searches
z-ai function -n web_search -a '{"query": "<TOPIC> 2026", "num": 10}' -o search_1.json
z-ai function -n web_search -a '{"query": "<TOPIC> code example", "num": 10}' -o search_2.json
z-ai function -n web_search -a '{"query": "<TOPIC> production patterns", "num": 10}' -o search_3.json

# 6. Generate 3 research output files (summary, sources, examples)

# 7. Copy everything to /home/z/my-project/download/
```
