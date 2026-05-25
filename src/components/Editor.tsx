'use client';

import { useRef, useCallback, useState, useEffect } from 'react';
import { useNotes } from '@/hooks/useNotes';
import { PALETTE } from '@/types';

interface EditorProps {
  onCopy: () => void;
  onDelete: () => void;
  onSave: () => void;
}

/** Simple markdown → HTML renderer for preview mode */
function renderMarkdown(text: string): string {
  let html = text;

  // Escape HTML entities first (but preserve our own tags later)
  html = html.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  // Bold: **text** or __text__
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/__(.+?)__/g, '<strong>$1</strong>');

  // Italic: *text* or _text_ (but not inside bold markers)
  html = html.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '<em>$1</em>');
  html = html.replace(/(?<!_)_(?!_)(.+?)(?<!_)_(?!_)/g, '<em>$1</em>');

  // Strikethrough: ~~text~~
  html = html.replace(/~~(.+?)~~/g, '<del>$1</del>');

  // Headings: # H1, ## H2, ### H3
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');

  // Numbered lists: 1. item (consecutive lines grouped into <ol>)
  html = html.replace(
    /((?:^\d+\.\s+.+(?:\n|$))+)/gm,
    (match) => {
      const items = match.trim().split('\n').map(line =>
        line.replace(/^\d+\.\s+/, '')
      );
      return '<ol>' + items.map(item => `<li>${item}</li>`).join('') + '</ol>';
    }
  );

  // Bullet lists: - item or * item (consecutive lines grouped into <ul>)
  html = html.replace(
    /((?:^[-*]\s+.+(?:\n|$))+)/gm,
    (match) => {
      const items = match.trim().split('\n').map(line =>
        line.replace(/^[-*]\s+/, '')
      );
      return '<ul>' + items.map(item => `<li>${item}</li>`).join('') + '</ul>';
    }
  );

  // Line breaks: double newline → paragraph, single newline → <br>
  html = html.replace(/\n{2,}/g, '</p><p>');
  html = html.replace(/\n/g, '<br>');

  // Wrap in paragraph
  html = '<p>' + html + '</p>';

  // Clean up empty paragraphs
  html = html.replace(/<p>\s*<\/p>/g, '');
  html = html.replace(/<p>\s*(<(?:ol|ul|h[1-3])>)/g, '$1');
  html = html.replace(/(<\/(?:ol|ul|h[1-3])>)\s*<\/p>/g, '$1');

  return html;
}

export function Editor({ onCopy, onDelete, onSave }: EditorProps) {
  const {
    activeNote,
    tags,
    updateCurrentNote,
    scheduleAutoSave,
    toggleEditorTag,
    isDirty,
    saveCurrentNote,
    discardChanges,
  } = useNotes();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const tickerRef = useRef<HTMLTextAreaElement>(null);
  const [previewMode, setPreviewMode] = useState(false);

  // Auto-grow ticker on mount and when activeNote changes
  useEffect(() => {
    const el = tickerRef.current;
    if (el) {
      el.style.height = 'auto';
      el.style.height = el.scrollHeight + 'px';
    }
  }, [activeNote?.id]);

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

  const applyItalic = useCallback(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const selected = ta.value.substring(start, end);
    const newText = ta.value.substring(0, start) + '_' + selected + '_' + ta.value.substring(end);
    updateCurrentNote({ body: newText });
    scheduleAutoSave();
    setTimeout(() => {
      ta.setSelectionRange(start + 1, end + 1);
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
    const numbered = lines.map((line, i) => `${i + 1}. ${line}`).join('\n');
    const newText = ta.value.substring(0, start) + numbered + ta.value.substring(end);
    updateCurrentNote({ body: newText });
    scheduleAutoSave();
    setTimeout(() => {
      ta.setSelectionRange(start, start + numbered.length);
      ta.focus();
    }, 0);
  }, [updateCurrentNote, scheduleAutoSave]);

  const applyBulletList = useCallback(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const selected = ta.value.substring(start, end);
    const lines = selected.split('\n');
    const bulleted = lines.map(line => `- ${line}`).join('\n');
    const newText = ta.value.substring(0, start) + bulleted + ta.value.substring(end);
    updateCurrentNote({ body: newText });
    scheduleAutoSave();
    setTimeout(() => {
      ta.setSelectionRange(start, start + bulleted.length);
      ta.focus();
    }, 0);
  }, [updateCurrentNote, scheduleAutoSave]);

  const handleEditorKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const ta = textareaRef.current;

    // ── Enter key: auto-continue lists ──
    if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey && !e.altKey && ta) {
      const value = ta.value;
      const cursorPos = ta.selectionStart;
      // Find the start of the current line
      const lineStart = value.lastIndexOf('\n', cursorPos - 1) + 1;
      const currentLine = value.substring(lineStart, cursorPos);

      // Match numbered list: e.g. "1. " or "12. "
      const numberedMatch = currentLine.match(/^(\d+)\.\s+/);
      if (numberedMatch) {
        const prefix = numberedMatch[0];
        // If the line is ONLY the prefix (no content), remove it and exit list
        if (currentLine.trim() === prefix.trim()) {
          e.preventDefault();
          const before = value.substring(0, lineStart);
          const after = value.substring(cursorPos);
          const newText = before + '\n' + after;
          updateCurrentNote({ body: newText });
          scheduleAutoSave();
          setTimeout(() => {
            ta.selectionStart = ta.selectionEnd = before.length + 1;
          }, 0);
          return;
        }
        // Continue with next number
        const nextNum = parseInt(numberedMatch[1], 10) + 1;
        const nextPrefix = `${nextNum}. `;
        e.preventDefault();
        const before = value.substring(0, cursorPos);
        const after = value.substring(cursorPos);
        const newText = before + '\n' + nextPrefix + after;
        updateCurrentNote({ body: newText });
        scheduleAutoSave();
        setTimeout(() => {
          const newPos = before.length + 1 + nextPrefix.length;
          ta.selectionStart = ta.selectionEnd = newPos;
        }, 0);
        return;
      }

      // Match bullet list: "- " or "* "
      const bulletMatch = currentLine.match(/^[-*]\s+/);
      if (bulletMatch) {
        const prefix = bulletMatch[0];
        // If the line is ONLY the bullet prefix (no content), remove it and exit list
        if (currentLine.trim() === prefix.trim()) {
          e.preventDefault();
          const before = value.substring(0, lineStart);
          const after = value.substring(cursorPos);
          const newText = before + '\n' + after;
          updateCurrentNote({ body: newText });
          scheduleAutoSave();
          setTimeout(() => {
            ta.selectionStart = ta.selectionEnd = before.length + 1;
          }, 0);
          return;
        }
        // Continue with same bullet prefix
        e.preventDefault();
        const before = value.substring(0, cursorPos);
        const after = value.substring(cursorPos);
        const newText = before + '\n' + prefix + after;
        updateCurrentNote({ body: newText });
        scheduleAutoSave();
        setTimeout(() => {
          const newPos = before.length + 1 + prefix.length;
          ta.selectionStart = ta.selectionEnd = newPos;
        }, 0);
        return;
      }
    }

    // Bold: Ctrl+Shift+B or Ctrl+B
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'B') {
      e.preventDefault();
      e.stopPropagation();
      applyBold();
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key === 'b') {
      e.preventDefault();
      e.stopPropagation();
      applyBold();
      return;
    }
    // Italic: Ctrl+I
    if ((e.metaKey || e.ctrlKey) && e.key === 'i') {
      e.preventDefault();
      e.stopPropagation();
      applyItalic();
      return;
    }
    // Numbered list: Ctrl+Shift+L (Ctrl+L is reserved by browser for address bar)
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'L') {
      e.preventDefault();
      e.stopPropagation();
      applyList();
      return;
    }
    // Bullet list: Ctrl+Shift+U
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'U') {
      e.preventDefault();
      e.stopPropagation();
      applyBulletList();
      return;
    }
  }, [applyBold, applyItalic, applyList, applyBulletList, updateCurrentNote, scheduleAutoSave]);

  // Word count
  const wordCount = activeNote?.body.trim()
    ? activeNote.body.trim().split(/\s+/).length
    : 0;

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
        <textarea
          ref={tickerRef}
          className="editor-ticker-input"
          placeholder="TICKER / TITLE"
          value={activeNote.ticker}
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          rows={1}
          onKeyDown={e => {
            // Only stop propagation for Ctrl/Cmd shortcuts
            if ((e.metaKey || e.ctrlKey) && (e.key === 's' || e.key === 'n' || e.key === 'b' || e.key === 'i' || (e.shiftKey && (e.key === 'L' || e.key === 'U')))) {
              e.stopPropagation();
            }
          }}
          onChange={e => {
            updateCurrentNote({ ticker: e.target.value });
            scheduleAutoSave();
            // Auto-grow: reset height then set to scrollHeight
            requestAnimationFrame(() => {
              const el = tickerRef.current;
              if (el) {
                el.style.height = 'auto';
                el.style.height = el.scrollHeight + 'px';
              }
            });
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
      {/* Toolbar: format buttons + action buttons all in one bar */}
      <div className="editor-toolbar">
        <div className="editor-toolbar-left">
          <button
            className="fmt-btn"
            title="Bold (Ctrl+B)"
            onMouseDown={e => e.preventDefault()} // prevent stealing textarea focus
            onClick={() => { if (previewMode) setPreviewMode(false); applyBold(); }}
          >
            <strong>B</strong>
          </button>
          <button
            className="fmt-btn"
            title="Italic (Ctrl+I)"
            onMouseDown={e => e.preventDefault()}
            onClick={() => { if (previewMode) setPreviewMode(false); applyItalic(); }}
          >
            <em>I</em>
          </button>
          <button
            className="fmt-btn"
            title="Numbered list (Ctrl+Shift+L)"
            onMouseDown={e => e.preventDefault()}
            onClick={() => { if (previewMode) setPreviewMode(false); applyList(); }}
          >
            <span style={{ fontFamily: 'monospace' }}>1.</span>
          </button>
          <button
            className="fmt-btn"
            title="Bullet list (Ctrl+Shift+U)"
            onMouseDown={e => e.preventDefault()}
            onClick={() => { if (previewMode) setPreviewMode(false); applyBulletList(); }}
          >
            <span style={{ fontFamily: 'monospace' }}>&#8226;</span>
          </button>
          <div className="fmt-separator" />
          <button
            className={`fmt-btn ${previewMode ? 'fmt-btn-active' : ''}`}
            title={previewMode ? 'Edit mode' : 'Preview mode'}
            onMouseDown={e => e.preventDefault()}
            onClick={() => setPreviewMode(!previewMode)}
          >
            {previewMode ? '✎ Edit' : '👁 Preview'}
          </button>
        </div>
        <div className="editor-toolbar-right">
          <span className="toolbar-word-count">{wordCount}w</span>
          {isDirty() && <button className="fmt-btn fmt-btn-discard" title="Discard unsaved changes" onClick={discardChanges}>Discard</button>}
          <button className="fmt-btn fmt-btn-action" title="Copy note" onClick={onCopy}>Copy</button>
          <button className="fmt-btn fmt-btn-danger" title="Delete note" onClick={onDelete}>Delete</button>
          <button className={`fmt-btn fmt-btn-save ${isDirty() ? 'fmt-btn-dirty' : ''}`} title="Save note (Ctrl+S)" onClick={async () => { await saveCurrentNote(); onSave(); }}>{isDirty() ? 'Save •' : 'Saved'}</button>
        </div>
      </div>
      <div className="editor-body">
        {previewMode ? (
          <div
            className="editor-preview"
            onClick={() => setPreviewMode(false)}
            title="Click to switch back to edit mode"
            dangerouslySetInnerHTML={{ __html: renderMarkdown(activeNote.body) }}
          />
        ) : (
          <textarea
            ref={textareaRef}
            className="editor-textarea"
            placeholder="Write your analysis, observations, trade rationale…&#10;&#10;Formatting: **bold**, _italic_, ~~strikethrough~~&#10;1. or - then Enter = auto-continue list&#10;Ctrl+B = Bold | Ctrl+I = Italic | Ctrl+Shift+L = Numbered list"
            value={activeNote.body}
            onChange={e => {
              updateCurrentNote({ body: e.target.value });
              scheduleAutoSave();
            }}
            onKeyDown={handleEditorKeyDown}
          />
        )}
      </div>
    </div>
  );
}
