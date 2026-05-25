'use client';

import { useNotes } from '@/hooks/useNotes';
import { PALETTE } from '@/types';

interface EditorProps {
  onCopy: () => void;
  onDelete: () => void;
  onSave: () => void;
}

export function Editor({ onCopy, onDelete, onSave }: EditorProps) {
  const {
    activeNote,
    tags,
    updateCurrentNote,
    scheduleAutoSave,
    toggleEditorTag,
  } = useNotes();

  if (!activeNote) {
    return (
      <div className="editor-panel">
        <div className="empty-state">
          <div className="empty-icon">📝</div>
          <div className="empty-msg">Select a note or create a new one</div>
        </div>
      </div>
    );
  }

  const wordCount = activeNote.body.trim()
    ? activeNote.body.trim().split(/\s+/).length
    : 0;

  return (
    <div className="editor-panel">
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
        <div className="editor-topbar">
          <input
            className="editor-ticker-input"
            placeholder="TICKER"
            maxLength={10}
            value={activeNote.ticker}
            onChange={e => {
              updateCurrentNote({ ticker: e.target.value.toUpperCase() });
              scheduleAutoSave();
            }}
          />
          <div className="editor-date">
            {new Date(activeNote.created).toLocaleDateString('en-GB', {
              weekday: 'short',
              day: 'numeric',
              month: 'long',
              year: 'numeric',
            })}
          </div>
        </div>
        <div className="editor-tags-bar">
          <span className="tags-label">Tags</span>
          {tags.map(tag => {
            const c = PALETTE[tag.color] || PALETTE[0];
            const isOn = activeNote.tags.includes(tag.id);
            return (
              <button
                key={tag.id}
                className={`editor-tag-btn ${isOn ? 'on' : ''}`}
                onClick={() => toggleEditorTag(tag.id)}
                style={
                  isOn
                    ? { background: c.bg, color: c.text, borderColor: c.border }
                    : {}
                }
              >
                <span className="etag-dot" style={{ background: c.dot }}></span>
                {tag.name}
              </button>
            );
          })}
        </div>
        <div className="editor-body" style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          <textarea
            className="editor-textarea"
            placeholder="Write your analysis, observations, trade rationale…"
            value={activeNote.body}
            onChange={e => {
              updateCurrentNote({ body: e.target.value });
              scheduleAutoSave();
            }}
            style={{ flex: 1, overflowY: 'auto', minHeight: 0, WebkitOverflowScrolling: 'touch' }}
          />
        </div>
        <div className="editor-footer">
          <span className="word-count">
            {wordCount} word{wordCount !== 1 ? 's' : ''}
          </span>
          <div className="editor-actions">
            <button className="btn btn-ghost" onClick={onCopy}>
              Copy
            </button>
            <button className="btn btn-danger mobile-delete-btn" onClick={onDelete}>
              Delete
            </button>
            <button className="btn btn-primary" onClick={onSave}>
              Save
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}