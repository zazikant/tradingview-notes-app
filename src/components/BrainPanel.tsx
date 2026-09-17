'use client';

import { useState, useCallback, useRef, useEffect } from 'react';
import { LivePipelineLog, type LiveEvent } from './LivePipelineLog';

/**
 * BrainPanel — full-screen chat overlay that uses the synced notes as RAG
 * context. Mirrors the PinLock overlay pattern (covers everything).
 *
 * Streams events from /api/brain/chat (SSE) and renders:
 *   - Header with title, document count, close button
 *   - Collapsible synced-docs sidebar (right rail) with remove buttons
 *   - Scrollable message area with user/assistant bubbles + source chips
 *   - Live pipeline log (collapsible)
 *   - Textarea input with Enter-to-send
 */

interface BrainDocument {
  filename: string;
  sha256: string;
  storage_path: string | null;
  created_at: string;
  updated_at: string;
}

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  streaming?: boolean;
  error?: boolean;
  sources?: { filename: string; ticker: string; avgScore: number; chunkCount: number }[];
  ts: number;
}

interface BrainPanelProps {
  onClose: () => void;
}

export function BrainPanel({ onClose }: BrainPanelProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [events, setEvents] = useState<LiveEvent[]>([]);
  const [showLog, setShowLog] = useState(true);
  const [docs, setDocs] = useState<BrainDocument[]>([]);
  const [showDocs, setShowDocs] = useState(false);
  const [docsLoading, setDocsLoading] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const messagesRef = useRef<ChatMessage[]>(messages);

  useEffect(() => { messagesRef.current = messages; }, [messages]);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, events.length]);

  // Close on Escape
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (loading) {
          // If a stream is in flight, abort it instead of closing
          abortRef.current?.abort();
        } else {
          onClose();
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [loading, onClose]);

  // Load the documents list on first mount
  const loadDocs = useCallback(async () => {
    setDocsLoading(true);
    try {
      const r = await fetch('/api/brain/documents', { cache: 'no-store' });
      if (r.ok) {
        const json = await r.json();
        setDocs(json.documents || []);
      }
    } catch (err) {
      console.error('[BrainPanel] loadDocs failed', err);
    } finally {
      setDocsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadDocs();
  }, [loadDocs]);

  // Helper: append a new message and return its id so the streaming loop can update it
  const appendMessage = useCallback((msg: ChatMessage) => {
    setMessages((prev) => [...prev, msg]);
  }, []);

  const patchMessage = useCallback((id: string, patch: Partial<ChatMessage>) => {
    setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, ...patch } : m)));
  }, []);

  const appendToMessage = useCallback((id: string, text: string) => {
    setMessages((prev) =>
      prev.map((m) => (m.id === id ? { ...m, content: m.content + text } : m)),
    );
  }, []);

  const sendQuery = useCallback(async () => {
    const query = input.trim();
    if (!query || loading) return;

    const userMsg: ChatMessage = {
      id: `u_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      role: 'user',
      content: query,
      ts: Date.now(),
    };
    const assistantId = `a_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const assistantMsg: ChatMessage = {
      id: assistantId,
      role: 'assistant',
      content: '',
      streaming: true,
      ts: Date.now(),
    };

    appendMessage(userMsg);
    appendMessage(assistantMsg);
    setInput('');
    setLoading(true);
    setEvents([]);

    // Build history from previous messages (excluding the empty assistant placeholder)
    const history = messagesRef.current
      .filter((m) => m.content && !m.error)
      .map((m) => ({ role: m.role, content: m.content }));

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const r = await fetch('/api/brain/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, history }),
        signal: controller.signal,
      });

      if (!r.ok || !r.body) {
        const errText = await r.text().catch(() => '');
        patchMessage(assistantId, {
          content: `Request failed (${r.status}): ${errText.slice(0, 200)}`,
          streaming: false,
          error: true,
        });
        setLoading(false);
        abortRef.current = null;
        return;
      }

      // SSE parse
      const reader = r.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let nlIdx: number;
        while ((nlIdx = buffer.indexOf('\n\n')) !== -1) {
          const raw = buffer.slice(0, nlIdx);
          buffer = buffer.slice(nlIdx + 2);
          // Each SSE chunk may have multiple `data: ...` lines; we expect one per event.
          const lines = raw.split('\n');
          for (const line of lines) {
            if (!line.startsWith('data:')) continue;
            const data = line.slice(5).trim();
            if (!data) continue;
            let ev: any;
            try { ev = JSON.parse(data); } catch { continue; }

            const ts = Date.now();
            if (ev.type === 'stage-start') {
              setEvents((p) => [...p, { ts, type: 'stage-start', stage: ev.stage }]);
            } else if (ev.type === 'log') {
              setEvents((p) => [...p, { ts, type: 'log', line: ev.line }]);
            } else if (ev.type === 'sources') {
              if (Array.isArray(ev.sources) && ev.sources.length > 0) {
                patchMessage(assistantId, { sources: ev.sources });
              }
            } else if (ev.type === 'chunk') {
              appendToMessage(assistantId, ev.text || '');
            } else if (ev.type === 'stage-end') {
              setEvents((p) => [...p, {
                ts, type: 'stage-end', stage: ev.stage, ok: ev.ok,
                elapsedMs: ev.elapsedMs, summary: ev.summary,
              }]);
            } else if (ev.type === 'error') {
              patchMessage(assistantId, {
                content: (messagesRef.current.find((m) => m.id === assistantId)?.content || '') +
                          `\n\n⚠️ ${ev.message}`,
                error: true,
              });
            } else if (ev.type === 'pipeline-end') {
              // ok
            }
          }
        }
      }

      patchMessage(assistantId, { streaming: false });
    } catch (err: any) {
      if (err?.name === 'AbortError') {
        patchMessage(assistantId, {
          content: (messagesRef.current.find((m) => m.id === assistantId)?.content || '') +
                    '\n\n[aborted by user]',
          streaming: false,
        });
      } else {
        patchMessage(assistantId, {
          content: `Error: ${err?.message || 'unknown'}`,
          streaming: false,
          error: true,
        });
      }
    } finally {
      setLoading(false);
      abortRef.current = null;
    }
  }, [input, loading, appendMessage, patchMessage, appendToMessage]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendQuery();
    }
  };

  const handleRemoveDoc = useCallback(async (filename: string) => {
    if (!confirm(`Remove ${filename} from the Brain?`)) return;
    try {
      const r = await fetch(`/api/brain/documents?filename=${encodeURIComponent(filename)}`, {
        method: 'DELETE',
      });
      if (r.ok) {
        setDocs((prev) => prev.filter((d) => d.filename !== filename));
      }
    } catch (err) {
      console.error('[BrainPanel] removeDoc failed', err);
    }
  }, []);

  const syncedCount = docs.length;

  return (
    <div className="brain-overlay">
      <div className="brain-modal">
        {/* Header */}
        <header className="brain-header">
          <div className="brain-header-left">
            <div className="brain-icon">🧠</div>
            <div>
              <h2 className="brain-title">Chat Brain</h2>
              <p className="brain-subtitle">
                {syncedCount > 0
                  ? `${syncedCount} note${syncedCount !== 1 ? 's' : ''} synced`
                  : 'No notes synced yet — click "Sync to Brain" on a note'}
              </p>
            </div>
          </div>
          <div className="brain-header-actions">
            <button
              type="button"
              className="brain-header-btn"
              onClick={() => setShowDocs((s) => !s)}
              title="Toggle synced notes list"
            >
              {showDocs ? 'Hide notes' : `Notes (${syncedCount})`}
            </button>
            <button
              type="button"
              className="brain-header-btn brain-close-btn"
              onClick={onClose}
              title="Close (Esc)"
            >
              ✕
            </button>
          </div>
        </header>

        {/* Body: chat + optional docs rail */}
        <div className="brain-body">
          <div className="brain-chat-area">
            {/* Messages */}
            <div ref={scrollRef} className="brain-messages">
              {messages.length === 0 ? (
                <div className="brain-empty">
                  <div className="brain-empty-icon">🧠</div>
                  <h3>Ask your Brain anything</h3>
                  <p>
                    Sync notes from the list using the <strong>Sync to Brain</strong> button,
                    then ask questions here. Answers cite the notes they came from.
                  </p>
                  {syncedCount === 0 && (
                    <p className="brain-empty-hint">
                      No notes synced yet — close this panel, hover any note, and click the 🧠 button.
                    </p>
                  )}
                </div>
              ) : (
                messages.map((msg) => (
                  <div
                    key={msg.id}
                    className={`brain-msg ${msg.role === 'user' ? 'user' : 'assistant'}${msg.error ? ' error' : ''}`}
                  >
                    {msg.role === 'assistant' && (
                      <div className="brain-msg-avatar">🧠</div>
                    )}
                    <div className="brain-msg-bubble">
                      {msg.content || (msg.streaming ? '' : <em>(empty response)</em>)}
                      {msg.streaming && <span className="brain-cursor">▍</span>}
                    </div>
                    {msg.sources && msg.sources.length > 0 && (
                      <div className="brain-sources">
                        <span className="brain-sources-label">Sources:</span>
                        {msg.sources.map((s, idx) => (
                          <span key={idx} className="brain-source-chip" title={`avg score: ${s.avgScore} • ${s.chunkCount} chunk${s.chunkCount !== 1 ? 's' : ''}`}>
                            <span className="brain-source-ticker">{s.ticker || '—'}</span>
                            <span className="brain-source-score">{s.avgScore}</span>
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                ))
              )}
            </div>

            {/* Pipeline log */}
            <LivePipelineLog
              events={events}
              visible={showLog}
              onClose={() => setShowLog((s) => !s)}
            />

            {/* Input */}
            <div className="brain-input-wrap">
              <textarea
                ref={inputRef}
                className="brain-input"
                placeholder={loading ? 'Generating…' : 'Ask your Brain… (Enter to send, Shift+Enter for newline)'}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                disabled={loading}
                rows={2}
              />
              <button
                type="button"
                className="brain-send-btn"
                onClick={sendQuery}
                disabled={loading || !input.trim()}
              >
                {loading ? '…' : 'Send'}
              </button>
            </div>
          </div>

          {/* Synced notes rail */}
          {showDocs && (
            <aside className="brain-docs-rail">
              <header className="brain-docs-rail-header">
                <span>Synced notes ({syncedCount})</span>
                <button
                  type="button"
                  className="brain-docs-refresh"
                  onClick={loadDocs}
                  disabled={docsLoading}
                  title="Refresh"
                >
                  {docsLoading ? '⟳' : '↻'}
                </button>
              </header>
              <div className="brain-docs-list">
                {docs.length === 0 ? (
                  <div className="brain-docs-empty">
                    No notes synced yet. Click <strong>Sync to Brain</strong> on any note card.
                  </div>
                ) : (
                  docs.map((d) => {
                    const m = d.filename.match(/^note-(.+)\.txt$/);
                    const noteId = m ? m[1] : d.filename;
                    return (
                      <div key={d.filename} className="brain-doc-row">
                        <div className="brain-doc-info">
                          <div className="brain-doc-name">{noteId}</div>
                          <div className="brain-doc-meta">
                            {new Date(d.updated_at).toLocaleString()}
                          </div>
                        </div>
                        <button
                          type="button"
                          className="brain-doc-remove"
                          onClick={() => handleRemoveDoc(d.filename)}
                          title="Remove from Brain"
                        >
                          ✕
                        </button>
                      </div>
                    );
                  })
                )}
              </div>
            </aside>
          )}
        </div>
      </div>
    </div>
  );
}
