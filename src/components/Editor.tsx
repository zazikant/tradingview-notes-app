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

  return (
    <div className="editor-panel">
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
      <div className="editor-body">
        <textarea
          className="editor-textarea"
          placeholder="Write your analysis, observations, trade rationale…"
          value={activeNote.body}
          onChange={e => {
            updateCurrentNote({ body: e.target.value });
            scheduleAutoSave();
          }}
        />
      </div>
    </div>
  );
}