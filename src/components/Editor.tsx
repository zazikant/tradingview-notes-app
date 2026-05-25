'use client';

import { useRef, useCallback } from 'react';
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
  const textareaRef = useRef<HTMLTextAreaElement>(null);

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

  const applyBold = useCallback(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const selected = ta.value.substring(start, end);
    const newText = ta.value.substring(0, start) + '**' + selected + '**' + ta.value.substring(end);
    updateCurrentNote({ body: newText });
    scheduleAutoSave();
    setTimeout(() => {
      ta.setSelectionRange(start + 2, end + 2);
      ta.focus();
    }, 0);
  }, [updateCurrentNote, scheduleAutoSave]);

  const applyList = useCallback(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const selected = ta.value.substring(start, end);
    const lines = selected.split('\n');
    let numbered = lines.map((line, i) => (i === 0 ? `1. ${line}` : `${i + 1}. ${line}`)).join('\n');
    const newText = ta.value.substring(0, start) + numbered + ta.value.substring(end);
    updateCurrentNote({ body: newText });
    scheduleAutoSave();
    setTimeout(() => {
      ta.setSelectionRange(start, start + numbered.length);
      ta.focus();
    }, 0);
  }, [updateCurrentNote, scheduleAutoSave]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'b') {
      e.preventDefault();
      applyBold();
    }
    if ((e.metaKey || e.ctrlKey) && e.key === 'l') {
      e.preventDefault();
      applyList();
    }
  }, [applyBold, applyList]);

  return (
    <div className="editor-panel">
      <div className="editor-topbar">
        <input
          className="editor-ticker-input"
          placeholder="TICKER"
          value={activeNote.ticker}
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
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
      <div className="editor-format-bar">
        <button
          className="fmt-btn"
          title="Bold (Ctrl+B)"
          onClick={applyBold}
        >
          <strong>B</strong>
        </button>
        <button
          className="fmt-btn"
          title="Numbered list (Ctrl+L)"
          onClick={applyList}
        >
          <span style={{ fontFamily: 'monospace' }}>1.</span>
        </button>
      </div>
      <div className="editor-body">
        <textarea
          ref={textareaRef}
          className="editor-textarea"
          placeholder="Write your analysis, observations, trade rationale…"
          value={activeNote.body}
          onChange={e => {
            updateCurrentNote({ body: e.target.value });
            scheduleAutoSave();
          }}
          onKeyDown={handleKeyDown}
        />
      </div>
    </div>
  );
}