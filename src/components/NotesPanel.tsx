'use client';

import { useState, useCallback, useRef, useEffect } from 'react';
import { useNotes } from '@/hooks/useNotes';
import { usePullToRefresh } from '@/hooks/usePullToRefresh';
import { PALETTE, Note } from '@/types';
import { relDate } from '@/lib/utils';

const PAGE_SIZE = 20;

export function NotesPanel() {
  const { filteredNotes, activeId, openNote, sortMode, setSortMode } = useNotes();
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [isLoading, setIsLoading] = useState(false);
  const loadMoreRef = useRef<HTMLDivElement>(null);
  const notesListRef = useRef<HTMLDivElement>(null);

  // ─── Brain sync state ────────────────────────────────────────────
  // Set of note client_ids that have been synced to the Brain.
  // Loaded once on mount; updated optimistically when the user clicks Sync.
  const [syncedNoteIds, setSyncedNoteIds] = useState<Set<string>>(new Set());
  const [syncingNoteIds, setSyncingNoteIds] = useState<Set<string>>(new Set());

  // Load the list of synced documents and mark each as a synced note id.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch('/api/brain/documents', { cache: 'no-store' });
        if (!r.ok) return;
        const json = await r.json();
        const ids: string[] = (json.documents || [])
          .map((d: { filename: string }) => {
            const m = d.filename.match(/^note-(.+)\.txt$/);
            return m ? m[1] : null;
          })
          .filter(Boolean) as string[];
        if (!cancelled) setSyncedNoteIds(new Set(ids));
      } catch (err) {
        console.warn('[NotesPanel] failed to load synced docs', err);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const handleSyncToBrain = useCallback(async (note: Note, e: React.MouseEvent) => {
    e.stopPropagation();
    if (syncingNoteIds.has(note.id)) return;
    setSyncingNoteIds((prev) => new Set(prev).add(note.id));

    try {
      const r = await fetch('/api/brain/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          noteId: note.id,
          ticker: note.ticker || '',
          body: note.body || '',
        }),
      });
      if (!r.ok) {
        const errJson = await r.json().catch(() => ({}));
        alert(`Sync failed: ${errJson.error || r.statusText}`);
        return;
      }
      setSyncedNoteIds((prev) => new Set(prev).add(note.id));
    } catch (err: any) {
      alert(`Sync failed: ${err?.message || 'network error'}`);
    } finally {
      setSyncingNoteIds((prev) => {
        const n = new Set(prev);
        n.delete(note.id);
        return n;
      });
    }
  }, [syncingNoteIds]);

  // Pull-to-refresh support
  const { containerRef: pullRef, pullState, pullDistance } = usePullToRefresh(70, () => {
    // Reload the page to refresh all data
    window.location.reload();
  });

  // Merge pullRef and notesListRef
  const setListRef = useCallback((el: HTMLDivElement | null) => {
    (pullRef as React.MutableRefObject<HTMLDivElement | null>).current = el;
    (notesListRef as React.MutableRefObject<HTMLDivElement | null>).current = el;
  }, [pullRef]);

  // Expose scroll-to-top for parent
  useEffect(() => {
    const el = notesListRef.current;
    if (el) {
      (el as any).__scrollToTop = () => { el.scrollTop = 0; };
    }
  }, []);

  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
  }, [filteredNotes.length, sortMode]);

  const loadMore = useCallback(() => {
    setIsLoading(true);
    setTimeout(() => {
      setVisibleCount(prev => Math.min(prev + PAGE_SIZE, filteredNotes.length));
      setIsLoading(false);
    }, 150);
  }, [filteredNotes.length]);

  useEffect(() => {
    if (!loadMoreRef.current) return;
    const observer = new IntersectionObserver(
      entries => {
        if (entries[0].isIntersecting && visibleCount < filteredNotes.length && !isLoading) {
          loadMore();
        }
      },
      { threshold: 0.1 }
    );
    observer.observe(loadMoreRef.current);
    return () => observer.disconnect();
  }, [visibleCount, filteredNotes.length, isLoading, loadMore]);

  const visibleNotes = filteredNotes.slice(0, visibleCount);
  const hasMore = visibleCount < filteredNotes.length;

  return (
    <div className="notes-panel">
      <div className="panel-header">
        <span className="panel-title">Notes</span>
        <span className="notes-count" id="listCount">
          {filteredNotes.length} note{filteredNotes.length !== 1 ? 's' : ''}
        </span>
        <select
          className="sort-select"
          value={sortMode}
          onChange={e => setSortMode(e.target.value as 'newest' | 'oldest' | 'ticker')}
        >
          <option value="newest">Newest</option>
          <option value="oldest">Oldest</option>
          <option value="ticker">Ticker A–Z</option>
        </select>
      </div>
      <div className="notes-list" id="notesList" ref={setListRef} style={{ position: 'relative' }}>
        {/* Pull-to-refresh indicator (mobile only) */}
        <div
          className={`pull-refresh-indicator ${pullState !== 'idle' ? 'visible' : ''} ${pullState === 'ready' ? 'ready' : ''}`}
          style={{ transform: `translateX(-50%) translateY(${Math.max(0, pullDistance.current - 44)}px)` }}
        >
          {pullState === 'refreshing' ? (
            <><span className="spinner" /> Refreshing...</>
          ) : pullState === 'ready' ? (
            'Release to refresh'
          ) : (
            'Pull to refresh'
          )}
        </div>
        {filteredNotes.length === 0 ? (
          <div style={{ padding: '2rem 1rem', textAlign: 'center', color: 'var(--muted)', fontSize: '13px', fontFamily: 'Syne, sans-serif' }}>
            No notes found
          </div>
        ) : (
          <>
            {visibleNotes.map(note => (
              <NoteCard
                key={note.id}
                note={note}
                isActive={note.id === activeId}
                onClick={() => openNote(note.id)}
                synced={syncedNoteIds.has(note.id)}
                syncing={syncingNoteIds.has(note.id)}
                onSyncToBrain={handleSyncToBrain}
              />
            ))}
            {hasMore && (
              <div ref={loadMoreRef} className="load-more-trigger">
                {isLoading && (
                  <div className="load-more-spinner">
                    <span>Loading...</span>
                  </div>
                )}
              </div>
            )}
            {!hasMore && filteredNotes.length > PAGE_SIZE && (
              <div className="all-loaded-msg">
                All {filteredNotes.length} notes loaded
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

interface NoteCardProps {
  note: Note;
  isActive: boolean;
  onClick: () => void;
  synced: boolean;
  syncing: boolean;
  onSyncToBrain: (note: Note, e: React.MouseEvent) => void;
}

function NoteCard({ note, isActive, onClick, synced, syncing, onSyncToBrain }: NoteCardProps) {
  const { getTag, getTagColor } = useNotes();

  return (
    <div className={`note-card ${isActive ? 'active' : ''}`} onClick={onClick}>
      <div className="note-card-top">
        <span className="note-ticker" style={{ whiteSpace: 'pre-wrap' }}>{note.ticker || '—'}</span>
        <div className="note-card-top-right">
          {synced && <span className="note-brain-badge" title="Synced to Brain">🧠</span>}
          <span className="note-date-small">{relDate(note.created)}</span>
        </div>
      </div>
      <div className="note-preview">
        {note.body || <span style={{ color: 'var(--border)' }}>No content</span>}
      </div>
      <div className="note-tags-row">
        {note.tags.map(tagId => {
          const tag = getTag(tagId);
          if (!tag) return null;
          const c = getTagColor(tagId);
          return (
            <span key={tagId} className="tag-pill" style={{ background: c.bg, color: c.text }}>
              {tag.name}
            </span>
          );
        })}
        <button
          className={`note-sync-btn ${synced ? 'synced' : ''} ${syncing ? 'syncing' : ''}`}
          onClick={(e) => onSyncToBrain(note, e)}
          disabled={syncing}
          title={synced ? 'Re-sync to Brain (updates if note changed)' : 'Sync to Brain'}
        >
          {syncing ? '⏳' : synced ? '✓ Brain' : '🧠 Sync'}
        </button>
      </div>
    </div>
  );
}