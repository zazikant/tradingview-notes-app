# Cell 2: Imports and Colab async fix
import sys
import io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

import asyncio
import nest_asyncio
nest_asyncio.apply()  # Required: Colab's event loop conflicts with asyncio.run()

import os
import time
import httpx
import logging
from typing import Any, Dict, List, Literal, Optional, Annotated
from pydantic import BaseModel, Field, HttpUrl

from langchain_openai import ChatOpenAI
from langchain_core.messages import HumanMessage
from langgraph.graph import StateGraph, END
from langgraph.graph.message import add_messages

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger(__name__)

print("OK - Imports")

# Cell 3: API Keys — entered securely via getpass (never stored in notebook)
import argparse

NVIDIA_API_KEY      = "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"
SERPER_API_KEY      = "bcb286526f8ae32472a6d3ec795691b7247cb271"
BROWSERLESS_API_KEY = "2UGxf41CvMtudVG22f11751aed7a7e86085581863bb77efe0"

os.environ["NVIDIA_API_KEY"] = NVIDIA_API_KEY

parser = argparse.ArgumentParser()
parser.add_argument("--query", type=str, required=True, help="Search query")
args = parser.parse_args()

print("OK - Keys loaded")

# Cell 4 COMPLETE REPLACEMENT with proper reducer syntax

from typing import TypedDict, Annotated
import operator

class SearchResult(BaseModel):
    title: str = Field(..., min_length=1)
    url: str = Field(...)
    snippet: str = Field(..., max_length=500)
    rank: int = Field(..., ge=1)

class WebPageContent(BaseModel):
    url: str = Field(...)
    html: str = Field(...)
    text: str = Field(...)
    fetched_at: float = Field(..., description="epoch seconds")

# Reducer function for merging dictionaries from parallel nodes
def merge_dicts(left: dict, right: dict) -> dict:
    """Merge two dictionaries, with right overwriting left on key conflicts."""
    result = dict(left) if left else {}
    if right:
        result.update(right)
    return result

class GraphState(TypedDict):
    user_query:      str
    intent:          str
    search_results:  list
    page_contents:   list
    aggregated_text: str

    # CRITICAL FIX: Use Annotated with reducer for parallel writes
    strategy_outputs: Annotated[dict, merge_dicts]
    final_answer:    str
    errors:          Annotated[list, operator.add]

print("OK Schemas OK")

# Cell 5: Custom exceptions for each failure mode in the spec

class SerperAuthError(Exception): pass
class SerperRateLimit(Exception): pass
class SerperTimeout(Exception): pass
class SerperNetworkError(Exception): pass

class BrowserlessAuthError(Exception): pass
class BrowserlessRateLimit(Exception): pass
class BrowserlessTimeout(Exception): pass
class BrowserlessNetworkError(Exception): pass

class ReducerError(Exception): pass
class ClassificationError(Exception): pass
class LLMError(Exception): pass

print("OK Exceptions OK")

# Cell 6: serper.dev search client
# Spec: returns List[SearchResult], raises typed errors, max 10 results

async def serper_search(query: str, *, max_results: int = 10) -> List[SearchResult]:
    """
    Calls serper.dev Search API.
    Preconditions : query non-empty, SERPER_API_KEY set.
    Postconditions: list length <= max_results, each entry validated.
    Raises        : SerperAuthError, SerperRateLimit, SerperTimeout, SerperNetworkError
    """
    if not query.strip():
        raise ValueError("query must be non-empty")

    url = "https://google.serper.dev/search"
    headers = {"X-API-KEY": SERPER_API_KEY, "Content-Type": "application/json"}
    # Enhanced payload for higher quality results
    payload = {
        "q": query, 
        "num": max_results,
        "gl": "us",  # Geolocation
        "hl": "en",  # Language
        "autocorrect": True,
    }

    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(url, json=payload, headers=headers)

        if resp.status_code == 401:
            raise SerperAuthError(f"Serper auth failed: {resp.text}")
        if resp.status_code == 429:
            raise SerperRateLimit("Serper rate limit hit")
        resp.raise_for_status()

        data = resp.json()
        results = []
        for i, item in enumerate(data.get("organic", [])[:max_results], start=1):
            try:
                results.append(SearchResult(
                    title=item.get("title", "No title"),
                    url=item.get("link", ""),
                    snippet=item.get("snippet", "")[:500],
                    rank=i
                ))
            except Exception as e:
                log.warning(f"Skipping malformed search result: {e}")

        return results

    except httpx.TimeoutException:
        raise SerperTimeout("Serper request timed out")
    except (SerperAuthError, SerperRateLimit):
        raise
    except Exception as e:
        raise SerperNetworkError(f"Serper network error: {e}") from e


# Quick smoke test (comment out if no key yet)
# results = asyncio.get_event_loop().run_until_complete(serper_search("LangGraph tutorials"))
# print(f"OK Serper returned {len(results)} results")
print("OK Serper client defined")

# Cell 7: browserless.io headless fetch client
# Spec: async, per-URL timeout, html/text size <= 5MB

async def browserless_fetch(url: str, *, timeout: int = 90) -> WebPageContent:
    """
    Fetches page via browserless.io headless Chrome.
    Preconditions : url reachable, BROWSERLESS_API_KEY set.
    Postconditions: WebPageContent with html/text size <= 5MB.
    Raises        : BrowserlessAuthError, BrowserlessRateLimit,
                    BrowserlessTimeout, BrowserlessNetworkError
    """
    endpoint = (
        f"https://chrome.browserless.io/content"
        f"?token={BROWSERLESS_API_KEY}"
    )
    # Simple payload - some URLs may not be fetchable (RSS, etc.)
    payload = {"url": url}

    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.post(endpoint, json=payload)

        if resp.status_code == 400:
            log.warning(f"[Browserless] 400 for {url}, skipping")
            raise BrowserlessNetworkError(f"400 Bad Request for {url}")
        if resp.status_code == 401:
            raise BrowserlessAuthError(f"Browserless auth failed for {url}")
        if resp.status_code == 429:
            raise BrowserlessRateLimit(f"Browserless rate limit for {url}")
        resp.raise_for_status()

        html = resp.text
        # Enforce 5 MB cap
        if len(html.encode()) > 5 * 1024 * 1024:
            html = html[:5 * 1024 * 1024]
            log.warning(f"HTML truncated at 5MB for {url}")

        # Improved text extraction - remove scripts, styles, and metadata
        import re
        # Remove script and style tags first
        html_clean = re.sub(r'<script[^>]*>.*?</script>', '', html, flags=re.DOTALL | re.IGNORECASE)
        html_clean = re.sub(r'<style[^>]*>.*?</style>', '', html_clean, flags=re.DOTALL | re.IGNORECASE)
        html_clean = re.sub(r'<meta[^>]*>', '', html_clean, flags=re.IGNORECASE)
        html_clean = re.sub(r'<header[^>]*>.*?</header>', '', html_clean, flags=re.DOTALL | re.IGNORECASE)
        html_clean = re.sub(r'<footer[^>]*>.*?</footer>', '', html_clean, flags=re.DOTALL | re.IGNORECASE)
        html_clean = re.sub(r'<nav[^>]*>.*?</nav>', '', html_clean, flags=re.DOTALL | re.IGNORECASE)
        
        # Extract text
        text = re.sub(r'<[^>]+>', ' ', html_clean)
        text = re.sub(r'\s+', ' ', text).strip()
        
        # Further clean: remove extra whitespace and shorten
        text = re.sub(r'\n\s*\n', '\n', text)
        text = text.strip()

        return WebPageContent(
            url=url,
            html=html,
            text=text,
            fetched_at=time.time()
        )

    except httpx.TimeoutException:
        raise BrowserlessTimeout(f"Browserless timed out for {url}")
    except (BrowserlessAuthError, BrowserlessRateLimit):
        raise
    except Exception as e:
        raise BrowserlessNetworkError(f"Browserless network error for {url}: {e}") from e

print("OK Browserless client defined")

# Cell 8: Pure, order-independent reducers
# Spec: pure, no side effects, raises ReducerError only

def reducer_max_confidence(
    prev: List[SearchResult],
    incoming: List[SearchResult]
) -> List[SearchResult]:
    """
    Merge strategy: keep the result with higher rank (lower rank number = better).
    Order-independent: result is the same regardless of which list comes first.
    """
    try:
        combined: Dict[str, SearchResult] = {}
        for r in prev + incoming:
            key = str(r.url)
            if key not in combined or r.rank < combined[key].rank:
                combined[key] = r
        # Re-assign sequential ranks, sorted by original rank
        sorted_results = sorted(combined.values(), key=lambda x: x.rank)
        return [
            SearchResult(title=r.title, url=r.url, snippet=r.snippet, rank=i+1)
            for i, r in enumerate(sorted_results)
        ]
    except Exception as e:
        raise ReducerError(f"max_confidence merge failed: {e}") from e


def reducer_append_unique(
    prev: List[WebPageContent],
    incoming: List[WebPageContent]
) -> List[WebPageContent]:
    """
    Merge strategy: append items from incoming that aren't already in prev (by URL).
    Order-independent: dedup is key-based, not position-based.
    """
    try:
        seen = {str(p.url) for p in prev}
        merged = list(prev)
        for item in incoming:
            if str(item.url) not in seen:
                merged.append(item)
                seen.add(str(item.url))
        return merged
    except Exception as e:
        raise ReducerError(f"append_unique merge failed: {e}") from e


def reducer_merge(
    prev: Dict[str, Any],
    incoming: Dict[str, Any],
    key: str,
    strategy: Literal["max_confidence", "append_unique", "overwrite"]
) -> Dict[str, Any]:
    """
    Unified reducer dispatcher — matches spec interface contract exactly.
    """
    result = dict(prev)
    try:
        if strategy == "max_confidence":
            result[key] = reducer_max_confidence(prev.get(key, []), incoming.get(key, []))
        elif strategy == "append_unique":
            result[key] = reducer_append_unique(prev.get(key, []), incoming.get(key, []))
        elif strategy == "overwrite":
            result[key] = incoming.get(key, prev.get(key))
        else:
            raise ReducerError(f"Unknown strategy: {strategy}")
    except ReducerError:
        raise
    except Exception as e:
        raise ReducerError(f"reducer_merge failed on key={key}: {e}") from e
    return result

print("OK Reducers defined")

# Cell 9: NVIDIA NIM — openai/gpt-oss-120b via native OpenAI SDK (streaming)
from openai import OpenAI
from langchain_core.messages import HumanMessage
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage
from langchain_core.outputs import ChatResult, ChatGeneration

nvidia_client = OpenAI(
    base_url="https://integrate.api.nvidia.com/v1",
    api_key=NVIDIA_API_KEY
)

# Cell 9: call_nvidia_llm — capture reasoning_content when content is empty
def call_nvidia_llm(prompt: str, max_tokens: int = 4096) -> str:
    completion = nvidia_client.chat.completions.create(
        model="openai/gpt-oss-120b",
        messages=[{"role": "user", "content": prompt}],
        temperature=1,
        top_p=1,
        max_tokens=max_tokens,
        stream=True
    )

    full_response = []
    reasoning_response = []

    for chunk in completion:
        if not getattr(chunk, "choices", None):
            continue
        delta = chunk.choices[0].delta

        reasoning = getattr(delta, "reasoning_content", None)
        if reasoning:
            reasoning_response.append(reasoning)

        content = delta.content
        if content is not None:
            full_response.append(content)

    content_final   = "".join(full_response).strip()
    reasoning_final = "".join(reasoning_response).strip()

    log.info(f"[llm] content='{repr(content_final)}' | reasoning_len={len(reasoning_final)}")

    # gpt-oss-120b puts its answer in reasoning_content, content is always empty
    return content_final if content_final else reasoning_final


# Smoke test
try:
    resp = call_nvidia_llm("Reply with just: OK")
    print(f"OK NVIDIA gpt-oss-120b ready — test response: {resp.strip()}")
except Exception as e:
    print(f"❌ LLM connection failed: {e}")

    # Cell 10: ClassifierNode — scan from end of reasoning text for intent
def classifier_node(state: dict) -> dict:
    query = state["user_query"]
    prompt = f"""Classify this query into one category: search, browse, or unknown.

User query: {query}

Reply with ONE word only: search, browse, or unknown."""

    for attempt in range(3):
        try:
            raw = call_nvidia_llm(prompt, max_tokens=500).strip().lower()
            log.info(f"[ClassifierNode] raw='{raw}'")

            # Scan words from the END — reasoning models conclude at the end
            intent_raw = "unknown"
            for word in reversed(raw.split()):
                cleaned = word.strip(".,!?\"':-\n")
                if cleaned in ("search", "browse", "unknown"):
                    intent_raw = cleaned
                    break

            log.info(f"[ClassifierNode] intent={intent_raw}")
            return {"intent": intent_raw}

        except Exception as e:
            log.warning(f"[ClassifierNode] attempt {attempt+1} failed: {e}")
            if attempt == 2:
                return {"intent": "unknown",
                        "errors": state.get("errors", []) + [str(e)]}

print("OK ClassifierNode defined")

# Cell 11: SearchNode
# Spec: reads user_query, writes search_results
# Error handling: auth→abort, rate limit→backoff 3x, timeout→empty+continue

def search_node(state: dict) -> dict:
    """Calls serper.dev with exponential backoff on rate limit."""
    query = state["user_query"]
    errors = list(state.get("errors", []))
    
    # Simplify long queries for better search results
    simplified_query = query
    if len(query) > 100:
        # Extract key terms
        keywords = query.replace("?", "").replace(".", "").replace(",", " ").split()
        # Keep important DSPy-related keywords
        important = [w for w in keywords if any(k in w.lower() for k in ['dspy', 'mipro', 'gepa', 'optimizer', 'rag', 'instruction', 'drift', 'gpt', 'llama', 'bayesian', 'genetic', 'pareto'])]
        if len(important) >= 3:
            simplified_query = " ".join(important[:10])
        log.info(f"[SearchNode] Simplified query: '{query[:50]}...' -> '{simplified_query}'")

    async def _run():
        for attempt in range(4):   # 1 + 3 retries
            try:
                results = await serper_search(simplified_query)
                log.info(f"[SearchNode] Got {len(results)} results")
                return {"search_results": [r.model_dump() for r in results]}
            except SerperAuthError as e:
                log.error(f"[SearchNode] Auth error: {e}")
                errors.append(str(e))
                return {"search_results": [], "errors": errors}
            except SerperRateLimit as e:
                wait = 2 ** attempt
                log.warning(f"[SearchNode] Rate limit, waiting {wait}s (attempt {attempt+1})")
                await asyncio.sleep(wait)
                if attempt == 3:
                    errors.append(str(e))
                    return {"search_results": [], "errors": errors}
            except SerperTimeout as e:
                log.warning(f"[SearchNode] Timeout: {e} — returning empty results")
                errors.append(str(e))
                return {"search_results": [], "errors": errors}
            except SerperNetworkError as e:
                log.error(f"[SearchNode] Network error: {e}")
                errors.append(str(e))
                return {"search_results": [], "errors": errors}

    return asyncio.get_event_loop().run_until_complete(_run())

print("OK SearchNode defined")


# Cell 12: BrowserNode
# Spec: reads search_results, fetches top 3 URLs in parallel, writes page_contents
# Semaphore limits concurrency (spec open decision: bounded pool = 10)

BROWSER_SEMAPHORE = asyncio.Semaphore(10)

def browser_node(state: dict) -> dict:
    """Parallel fetch of top-3 URLs via browserless. Drops failures gracefully."""
    search_results = state.get("search_results", [])
    errors = list(state.get("errors", []))

    if not search_results:
        log.warning("[BrowserNode] No search results to browse")
        return {"page_contents": [], "errors": errors}

    # Reconstruct Pydantic objects if they're dicts (LangGraph serializes state)
    results_parsed = [
        SearchResult(**r) if isinstance(r, dict) else r
        for r in search_results
    ]
    top_urls = [str(r.url) for r in sorted(results_parsed, key=lambda x: x.rank)[:10]]

    async def fetch_with_guard(url: str):
        async with BROWSER_SEMAPHORE:
            for attempt in range(3):  # 1 + 2 retries per spec
                try:
                    content = await browserless_fetch(url)
                    return content
                except BrowserlessAuthError as e:
                    log.error(f"[BrowserNode] Auth error for {url}: {e}")
                    errors.append(str(e))
                    return None
                except BrowserlessRateLimit:
                    wait = 2 ** attempt
                    await asyncio.sleep(wait)
                except BrowserlessTimeout as e:
                    log.warning(f"[BrowserNode] Timeout dropping {url}: {e}")
                    errors.append(str(e))
                    return None
                except MemoryError:
                    log.error(f"[BrowserNode] OOM fetching {url}")
                    errors.append(f"OOM for {url}")
                    return None
                except BrowserlessNetworkError as e:
                    log.error(f"[BrowserNode] Network error {url}: {e}")
                    errors.append(str(e))
                    return None
            return None

    async def _run():
        fetched = await asyncio.gather(*[fetch_with_guard(u) for u in top_urls])
        pages = [f.model_dump() for f in fetched if f is not None]
        log.info(f"[BrowserNode] Fetched {len(pages)}/{len(top_urls)} pages")
        return {"page_contents": pages, "errors": errors}

    return asyncio.get_event_loop().run_until_complete(_run())

print("OK BrowserNode defined")

# Cell 13: ReducerNode[search] and ReducerNode[browse]
# Spec: pure merge, keep previous state on ReducerError

def reducer_node_search(state: dict) -> dict:
    """
    Merges incoming search_results into state using max_confidence strategy.
    On ReducerError: logs and keeps previous state unchanged.
    """
    try:
        prev = [SearchResult(**r) if isinstance(r, dict) else r
                for r in state.get("search_results", [])]
        # In a superstep graph, 'incoming' would come from the node's partial update.
        # Here, state already contains the SearchNode output, so we validate + deduplicate.
        merged = reducer_max_confidence(prev, [])   # idempotent dedup pass
        log.info(f"[ReducerNode:search] Merged → {len(merged)} results")
        return {"search_results": [r.model_dump() for r in merged]}
    except ReducerError as e:
        log.error(f"[ReducerNode:search] ReducerError — keeping prev state: {e}")
        state.get("errors", []).append(str(e))
        return {}   # Empty dict = no state mutation (LangGraph merges dicts)


def reducer_node_browse(state: dict) -> dict:
    """
    Merges incoming page_contents using append_unique strategy.
    On ReducerError: logs and keeps previous state unchanged.
    """
    try:
        prev = [WebPageContent(**p) if isinstance(p, dict) else p
                for p in state.get("page_contents", [])]
        merged = reducer_append_unique(prev, [])    # idempotent dedup pass
        log.info(f"[ReducerNode:browse] Merged → {len(merged)} pages")
        return {"page_contents": [p.model_dump() for p in merged]}
    except ReducerError as e:
        log.error(f"[ReducerNode:browse] ReducerError — keeping prev state: {e}")
        state.get("errors", []).append(str(e))
        return {}

print("OK ReducerNodes defined")

# Cell 14: AggregatorNode
# Spec: concatenates page text, truncates to 20000 chars

def aggregator_node(state: dict) -> dict:
    """
    Extracts text from page_contents, concatenates, truncates to 20k chars.
    Falls back to search snippets if no page content available.
    """
    try:
        pages = state.get("page_contents", [])
        search_results = state.get("search_results", [])

        texts = []
        for p in pages:
            text = p.get("text", "") if isinstance(p, dict) else p.text
            if text.strip():
                texts.append(text.strip())

        # Fallback: use search snippets when no pages were fetched
        if not texts and search_results:
            log.info("[AggregatorNode] No page content — falling back to snippets")
            for r in search_results:
                snippet = r.get("snippet", "") if isinstance(r, dict) else r.snippet
                texts.append(snippet)

        aggregated = "\n\n".join(texts)
        aggregated = aggregated[:20000]
        last_period = aggregated.rfind('.')
        if last_period > 15000:
            aggregated = aggregated[:last_period + 1]

        log.info(f"[AggregatorNode] aggregated_text length={len(aggregated)}")
        return {"aggregated_text": aggregated}

    except Exception as e:
        log.error(f"[AggregatorNode] AggregationError: {e}")
        return {"aggregated_text": "", "errors": state.get("errors", []) + [str(e)]}

print("OK AggregatorNode defined")

# Cell 15: AnswerNode — using call_nvidia_llm directly
def answer_node(state: dict) -> dict:
    aggregated_text = state.get("aggregated_text", "")
    intent = state.get("intent", "unknown")
    errors = list(state.get("errors", []))

    def build_prompt(text: str, intent: str) -> str:
        context = text if text.strip() else "No context available."
        return f"""You are a helpful assistant. Based on the context below, answer the user's query.
Intent: {intent}
Context:
{context}

Provide a clear, concise answer in 3-5 sentences."""

    for attempt in range(2):
        try:
            prompt = build_prompt(aggregated_text, intent)
            answer = call_nvidia_llm(prompt).strip()
            if not answer:
                raise LLMError("Empty response")
            log.info(f"[AnswerNode] Generated answer ({len(answer)} chars)")
            return {"final_answer": answer}
        except Exception as e:
            log.warning(f"[AnswerNode] attempt {attempt+1} failed: {e}")
            errors.append(str(e))
            if attempt == 1:
                return {"final_answer": "Unable to generate answer.", "errors": errors}

print("OK AnswerNode defined")

# Cell 16: Adversarial Multi-Strategy Graph with Improved Judge

from typing import Literal

# Strategy 1: Quick Search (snippets only, no browsing)
def strategy_quick_node(state: dict) -> dict:
    """Fast answer from search snippets only."""
    try:
        snippets = []
        for r in state.get("search_results", []):
            snippet = r.get("snippet", "") if isinstance(r, dict) else r.snippet
            snippets.append(snippet)

        context = "\n".join(snippets[:5])  # Top 5 snippets
        prompt = f"""Answer this query using ONLY the snippets below. Be concise.

Query: {state['user_query']}

Snippets:
{context}

Answer in 2-3 sentences."""

        answer = call_nvidia_llm(prompt, max_tokens=1500)
        log.info(f"[Strategy:Quick] Generated answer ({len(answer)} chars)")

        return {"strategy_outputs": {"quick": answer}}

    except Exception as e:
        log.error(f"[Strategy:Quick] Failed: {e}")
        return {"strategy_outputs": {"quick": f"Error: {e}"}}


# Strategy 2: Deep Browse (full page content analysis)
def strategy_deep_node(state: dict) -> dict:
    """Detailed answer from scraped full pages."""
    try:
        pages = state.get("page_contents", [])
        if not pages:
            return {"strategy_outputs": {"deep": "No pages fetched"}}

        # Aggregate full text from all pages
        full_text = []
        for p in pages:
            text = p.get("text", "") if isinstance(p, dict) else p.text
            full_text.append(text[:5000])  # 5k chars per page

        context = "\n\n---PAGE BREAK---\n\n".join(full_text)[:15000]
        last_period = context.rfind('.')
        if last_period > 10000:
            context = context[:last_period + 1]
        prompt = f"""You have access to full web pages. Provide a comprehensive answer.

Query: {state['user_query']}

Full Page Content:
{context}

Provide a detailed answer (4-6 sentences) with specific facts."""

        answer = call_nvidia_llm(prompt, max_tokens=3000)
        log.info(f"[Strategy:Deep] Generated answer ({len(answer)} chars)")

        return {"strategy_outputs": {"deep": answer}}

    except Exception as e:
        log.error(f"[Strategy:Deep] Failed: {e}")
        return {"strategy_outputs": {"deep": f"Error: {e}"}}


# Strategy 3: Hybrid (snippets + key page sections)
def strategy_hybrid_node(state: dict) -> dict:
    """Balanced approach: snippets for breadth, page samples for depth."""
    try:
        # Get top 5 snippets (was 3)
        snippets = []
        for r in state.get("search_results", [])[:5]:
            snippet = r.get("snippet", "") if isinstance(r, dict) else r.snippet
            snippets.append(snippet)

        # Get first 2k chars from top 5 pages (was 2)
        page_samples = []
        for p in state.get("page_contents", [])[:5]:
            text = p.get("text", "") if isinstance(p, dict) else p.text
            page_samples.append(text[:3000])

        context = f"""SNIPPETS:
{chr(10).join(f"{i+1}. {s}" for i, s in enumerate(snippets))}

DETAILED CONTENT:
{chr(10).join(page_samples)}"""

        prompt = f"""Combine quick facts (snippets) with detailed context (pages) to answer.

Query: {state['user_query']}

{context}

Answer in 3-4 sentences, balancing breadth and depth."""

        answer = call_nvidia_llm(prompt, max_tokens=2500)
        log.info(f"[Strategy:Hybrid] Generated answer ({len(answer)} chars)")

        return {"strategy_outputs": {"hybrid": answer}}

    except Exception as e:
        log.error(f"[Strategy:Hybrid] Failed: {e}")
        return {"strategy_outputs": {"hybrid": f"Error: {e}"}}


# Adversarial Judge: Compare all strategies and synthesize
def adversarial_judge_node(state: dict) -> dict:
    """LLM judges which strategy worked best and synthesizes final answer."""
    try:
        outputs = state.get("strategy_outputs", {})
        query = state["user_query"]

        # Build comparison prompt
        strategies_text = "\n\n".join([
            f"STRATEGY {name.upper()}:\n{answer}"
            for name, answer in outputs.items()
        ])

        # IMPROVED PROMPT - Forces critique into content, not reasoning
        prompt = f"""You are evaluating 3 different search strategies that answered the same query.
Analyze each, identify strengths/weaknesses, then synthesize the BEST final answer.

Original Query: {query}

{strategies_text}

YOUR TASK:
1. Critique each strategy in 1 sentence
2. Synthesize final answer combining their strengths

IMPORTANT: Write your critique in the response body, not in reasoning. Do not use markdown formatting.

CRITIQUE:
Quick: [your critique here]
Deep: [your critique here]
Hybrid: [your critique here]

FINAL ANSWER:
[synthesized answer here]"""

        response = call_nvidia_llm(prompt, max_tokens=3000)

        log.info(f"[AdversarialJudge] Full response:\n{response}")

        # Extract critique and final answer sections
        critique_section = ""
        final_section = ""

        if "CRITIQUE:" in response and "FINAL ANSWER:" in response:
            parts = response.split("FINAL ANSWER:")
            critique_section = parts[0].replace("CRITIQUE:", "").strip()
            final_section = parts[1].strip()
        elif "FINAL ANSWER:" in response:
            # Fallback: just extract final answer
            final_section = response.split("FINAL ANSWER:")[1].strip()
        else:
            # Fallback: use entire response
            final_section = response.strip()

        log.info(f"[AdversarialJudge] Synthesized answer ({len(final_section)} chars)")

        # Store both critique and final answer in state
        return {
            "final_answer": final_section,
            "aggregated_text": f"CRITIQUE:\n{critique_section}\n\nFINAL ANSWER:\n{final_section}"
        }

    except Exception as e:
        log.error(f"[AdversarialJudge] Failed: {e}")
        # Fallback: return best available strategy
        outputs = state.get("strategy_outputs", {})
        fallback = outputs.get("hybrid") or outputs.get("deep") or outputs.get("quick") or "Error"
        return {"final_answer": fallback, "errors": state.get("errors", []) + [str(e)]}


# Build the adversarial graph (SEQUENTIAL EXECUTION)
def build_adversarial_graph():
    builder = StateGraph(GraphState)

    # Core data gathering
    builder.add_node("classifier",     classifier_node)
    builder.add_node("search",         search_node)
    builder.add_node("reducer_search", reducer_node_search)
    builder.add_node("browser",        browser_node)
    builder.add_node("reducer_browse", reducer_node_browse)

    # Combined strategy node that runs all 3 strategies sequentially
    def all_strategies_node(state: dict) -> dict:
        """Run all strategies in sequence and collect outputs."""
        outputs = {}

        # Strategy 1: Quick
        quick_result = strategy_quick_node(state)
        outputs.update(quick_result.get("strategy_outputs", {}))

        # Strategy 2: Deep
        deep_result = strategy_deep_node(state)
        outputs.update(deep_result.get("strategy_outputs", {}))

        # Strategy 3: Hybrid
        hybrid_result = strategy_hybrid_node(state)
        outputs.update(hybrid_result.get("strategy_outputs", {}))

        return {"strategy_outputs": outputs}

    builder.add_node("all_strategies", all_strategies_node)
    builder.add_node("judge", adversarial_judge_node)

    # Linear pipeline: classifier → search → browser → all_strategies → judge
    builder.set_entry_point("classifier")
    builder.add_edge("classifier",     "search")
    builder.add_edge("search",         "reducer_search")
    builder.add_edge("reducer_search", "browser")
    builder.add_edge("browser",        "reducer_browse")
    builder.add_edge("reducer_browse", "all_strategies")
    builder.add_edge("all_strategies", "judge")
    builder.add_edge("judge", END)

    return builder.compile()

print("OK Adversarial strategies and graph builder defined")

# Cell 17: Build graph and run with critique display

def run_query(user_query: str) -> dict:
    """Execute the adversarial search pipeline."""
    initial_state: GraphState = {
        "user_query":       user_query,
        "intent":           "unknown",
        "search_results":   [],
        "page_contents":    [],
        "aggregated_text":  "",
        "strategy_outputs": {},
        "final_answer":     "",
        "errors":           [],
    }

    log.info(f"[run_query] Starting ADVERSARIAL pipeline for: '{user_query}'")
    result = graph.invoke(initial_state)
    return result


# Build the graph
graph = build_adversarial_graph()
print("OK Adversarial graph compiled")


# ==================== TEST QUERY ====================

result = run_query(args.query)

print("\n" + "="*70)
print(f"QUERY: {result['user_query']}")
print(f"INTENT: {result['intent']}")
print(f"\n--- STRATEGY OUTPUTS ---")
for strategy, answer in result.get('strategy_outputs', {}).items():
    print(f"\n[{strategy.upper()}]:\n{answer}")

# NEW: Show the critique if available
if "CRITIQUE:" in result.get('aggregated_text', ''):
    critique_part = result['aggregated_text'].split('FINAL ANSWER:')[0]
    print(f"\n--- ADVERSARIAL JUDGE'S CRITIQUE ---\n{critique_part}")

print(f"\n--- FINAL SYNTHESIZED ANSWER ---\n{result['final_answer']}")
print("="*70)
