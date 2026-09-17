'use client';

import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
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
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Docs rail: search + multi-select
  const [docSearch, setDocSearch] = useState('');
  const [docSelectMode, setDocSelectMode] = useState(false);
  const [selectedDocs, setSelectedDocs] = useState<Set<string>>(new Set());
  const [bulkDocAction, setBulkDocAction] = useState<'idle' | 'deleting'>('idle');
  const [bulkDocProgress, setBulkDocProgress] = useState<{ current: number; total: number } | null>(null);

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

  // ─── File upload handler ───────────────────────────────────────────
  const handleUploadFile = useCallback(async (file: File) => {
    const ext = file.name.toLowerCase().split('.').pop() || '';
    if (!['pdf', 'txt', 'md', 'json'].includes(ext)) {
      setUploadError(`Unsupported file type: .${ext}. Allowed: PDF, TXT, MD, JSON`);
      return;
    }
    if (file.size > 50 * 1024 * 1024) {
      setUploadError(`File too large: ${(file.size / 1024 / 1024).toFixed(1)} MB. Max: 50 MB.`);
      return;
    }

    setUploading(true);
    setUploadError(null);
    try {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('name', file.name);
      formData.append('mode', 'Add');

      const r = await fetch('/api/brain/upload', {
        method: 'POST',
        body: formData,
      });
      const json = await r.json();
      if (!r.ok) {
        setUploadError(json?.error || `Upload failed (${r.status})`);
        return;
      }
      // Refresh the docs list so the new file appears in the rail + sidebar count updates.
      await loadDocs();
      // Surface a system message in the chat so the user sees confirmation.
      const msg: ChatMessage = {
        id: `sys_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        role: 'assistant',
        content: `Uploaded ${file.name} — ${json.chunks} chunks indexed${json.pages ? `, ${json.pages} pages` : ''}. You can now ask questions about it.`,
        ts: Date.now(),
      };
      setMessages((prev) => [...prev, msg]);
    } catch (err: any) {
      setUploadError(err?.message || 'Upload failed');
    } finally {
      setUploading(false);
    }
  }, [loadDocs]);

  const handleFileInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) handleUploadFile(f);
    // Reset so picking the same file again still fires onChange.
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, [handleUploadFile]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const f = e.dataTransfer.files?.[0];
    if (f) handleUploadFile(f);
  }, [handleUploadFile]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
  }, []);

  const handleRemoveDoc = useCallback(async (filename: string) => {
    if (!confirm(`Remove ${filename} from the Brain?`)) return;
    try {
      // Hit the upload route's DELETE endpoint — it cascades storage + pinecone + db.
      const formData = new FormData();
      formData.append('name', filename);
      formData.append('mode', 'Delete');
      const r = await fetch('/api/brain/upload', {
        method: 'POST',
        body: formData,
      });
      if (r.ok) {
        setDocs((prev) => prev.filter((d) => d.filename !== filename));
      }
    } catch (err) {
      console.error('[BrainPanel] removeDoc failed', err);
    }
  }, []);

  // ─── Docs rail: multi-select + bulk delete ──────────────────────────
  const filteredDocs = useMemo(() => {
    const q = docSearch.trim().toLowerCase();
    if (!q) return docs;
    return docs.filter((d) => d.filename.toLowerCase().includes(q));
  }, [docs, docSearch]);

  const toggleDocSelect = useCallback((filename: string) => {
    setSelectedDocs((prev) => {
      const n = new Set(prev);
      if (n.has(filename)) n.delete(filename); else n.add(filename);
      return n;
    });
  }, []);

  const exitDocSelectMode = useCallback(() => {
    setDocSelectMode(false);
    setSelectedDocs(new Set());
    setBulkDocAction('idle');
    setBulkDocProgress(null);
  }, []);

  const handleBulkDeleteDocs = useCallback(async () => {
    if (selectedDocs.size === 0 || bulkDocAction !== 'idle') return;
    if (!confirm(`Remove ${selectedDocs.size} document${selectedDocs.size !== 1 ? 's' : ''} from the Brain?\nThis will delete the Pinecone vectors, the Storage bucket file (if PDF), and the documents table row for each.`)) return;
    setBulkDocAction('deleting');
    setBulkDocProgress({ current: 0, total: selectedDocs.size });

    const filenames = Array.from(selectedDocs);
    let successCount = 0;
    for (let i = 0; i < filenames.length; i++) {
      const f = filenames[i];
      setBulkDocProgress({ current: i + 1, total: filenames.length });
      try {
        const formData = new FormData();
        formData.append('name', f);
        formData.append('mode', 'Delete');
        const r = await fetch('/api/brain/upload', { method: 'POST', body: formData });
        if (r.ok) successCount++;
      } catch (err) {
        console.error('[BrainPanel] bulk delete failed for', f, err);
      }
    }
    // Refresh from server so we show the accurate remaining list.
    await loadDocs();
    setBulkDocAction('idle');
    setBulkDocProgress(null);
    setDocSelectMode(false);
    setSelectedDocs(new Set());
    if (successCount > 0) {
      // Optional: surface a brief success indicator in the chat
      setMessages((prev) => [
        ...prev,
        {
          id: `sys_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          role: 'assistant',
          content: `Removed ${successCount} of ${filenames.length} document${filenames.length !== 1 ? 's' : ''} from the Brain.`,
          ts: Date.now(),
        },
      ]);
    }
  }, [selectedDocs, bulkDocAction, loadDocs]);

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
                  ? `${syncedCount} item${syncedCount !== 1 ? 's' : ''} in Brain`
                  : 'Brain is empty — sync a note or upload a PDF'}
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
                    Sync notes via the <strong>Sync to Brain</strong> button, or upload a PDF / TXT / MD via the <strong>📎</strong> button below.
                    Then ask questions here. Answers cite the documents they came from.
                  </p>
                  {syncedCount === 0 && (
                    <p className="brain-empty-hint">
                      Nothing in Brain yet. Either close this panel and click <strong>🧠 Sync</strong> on a note card, or click the <strong>📎</strong> button below to upload a PDF.
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
            <div
              className={`brain-input-wrap ${dragOver ? 'drag-over' : ''}`}
              onDrop={handleDrop}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
            >
              {uploadError && (
                <div className="brain-upload-error">⚠️ {uploadError}</div>
              )}
              {uploading && (
                <div className="brain-upload-progress">
                  Uploading + indexing… (large PDFs may take 30-60s)
                </div>
              )}
              <input
                ref={fileInputRef}
                type="file"
                accept=".pdf,.txt,.md,.json,application/pdf,text/plain,text/markdown,application/json"
                style={{ display: 'none' }}
                onChange={handleFileInputChange}
              />
              <button
                type="button"
                className="brain-upload-btn"
                onClick={() => fileInputRef.current?.click()}
                disabled={uploading || loading}
                title="Upload PDF / TXT / MD to the Brain"
              >
                {uploading ? '⏳' : '📎'}
              </button>
              <textarea
                ref={inputRef}
                className="brain-input"
                placeholder={
                  loading ? 'Generating…' :
                  dragOver ? 'Drop your file here to upload to the Brain' :
                  'Ask your Brain… (Enter to send, Shift+Enter for newline, 📎 to upload PDF/TXT/MD)'
                }
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
                <span>In Brain ({syncedCount})</span>
                <div className="brain-docs-rail-actions">
                  <button
                    type="button"
                    className={`brain-docs-rail-btn ${docSelectMode ? 'active' : ''}`}
                    onClick={() => (docSelectMode ? exitDocSelectMode() : setDocSelectMode(true))}
                    disabled={bulkDocAction !== 'idle' || docs.length === 0}
                    title={docSelectMode ? 'Exit select mode' : 'Select multiple to delete'}
                  >
                    {docSelectMode ? '✕' : '☑'}
                  </button>
                  <button
                    type="button"
                    className="brain-docs-refresh"
                    onClick={loadDocs}
                    disabled={docsLoading || bulkDocAction !== 'idle'}
                    title="Refresh"
                  >
                    {docsLoading ? '⟳' : '↻'}
                  </button>
                </div>
              </header>

              {/* Search input */}
              <div className="brain-docs-search-wrap">
                <input
                  type="text"
                  className="brain-docs-search"
                  placeholder="Search by filename…"
                  value={docSearch}
                  onChange={(e) => setDocSearch(e.target.value)}
                  disabled={bulkDocAction !== 'idle'}
                />
                {docSearch && (
                  <button
                    type="button"
                    className="brain-docs-search-clear"
                    onClick={() => setDocSearch('')}
                    title="Clear search"
                  >✕</button>
                )}
              </div>

              {/* Bulk action bar — visible when in select mode */}
              {docSelectMode && (
                <div className="brain-docs-bulk-bar">
                  <span className="brain-docs-bulk-count">
                    {selectedDocs.size} selected
                    {bulkDocProgress && (
                      <span className="brain-docs-bulk-progress">
                        {' '}— deleting {bulkDocProgress.current}/{bulkDocProgress.total}…
                      </span>
                    )}
                  </span>
                  <div className="brain-docs-bulk-actions">
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={exitDocSelectMode}
                      disabled={bulkDocAction !== 'idle'}
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      className="btn btn-danger btn-sm"
                      onClick={handleBulkDeleteDocs}
                      disabled={selectedDocs.size === 0 || bulkDocAction !== 'idle'}
                    >
                      Delete ({selectedDocs.size})
                    </button>
                  </div>
                </div>
              )}

              <div className="brain-docs-list">
                {docs.length === 0 ? (
                  <div className="brain-docs-empty">
                    Nothing in the Brain yet. Click <strong>Sync to Brain</strong> on a note, or upload a PDF via the 📎 button below.
                  </div>
                ) : filteredDocs.length === 0 ? (
                  <div className="brain-docs-empty">
                    No files match <strong>“{docSearch}”</strong>. Try a different search.
                  </div>
                ) : (
                  filteredDocs.map((d) => {
                    const m = d.filename.match(/^note-(.+)\.txt$/);
                    const isNote = !!m;
                    const label = isNote ? m![1] : d.filename;
                    const icon = isNote ? '📝' : (d.filename.toLowerCase().endsWith('.pdf') ? '📄' : '📃');
                    const isSelected = selectedDocs.has(d.filename);
                    return (
                      <div
                        key={d.filename}
                        className={`brain-doc-row ${docSelectMode ? 'select-mode' : ''} ${isSelected ? 'selected' : ''}`}
                        onClick={() => docSelectMode && toggleDocSelect(d.filename)}
                      >
                        {docSelectMode && (
                          <div className={`brain-doc-checkbox ${isSelected ? 'checked' : ''}`}>
                            {isSelected ? '✓' : ''}
                          </div>
                        )}
                        <span className="brain-doc-icon">{icon}</span>
                        <div className="brain-doc-info">
                          <div className="brain-doc-name" title={d.filename}>{label}</div>
                          <div className="brain-doc-meta">
                            {new Date(d.updated_at).toLocaleString()}
                          </div>
                        </div>
                        {!docSelectMode && (
                          <button
                            type="button"
                            className="brain-doc-remove"
                            onClick={(e) => { e.stopPropagation(); handleRemoveDoc(d.filename); }}
                            title="Remove from Brain"
                          >
                            ✕
                          </button>
                        )}
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
