'use client';

import { useRef, useCallback, useState, useEffect } from 'react';
import { useNotes } from '@/hooks/useNotes';
import { usePullToRefresh } from '@/hooks/usePullToRefresh';
import { PALETTE } from '@/types';

interface EditorProps {
  onCopy: () => void;
  onDelete: () => void;
  onSave: () => void;
}

/** Simple markdown → HTML renderer for preview mode */
function renderMarkdown(text: string): string {
  // Apply renumber first so preview always shows clean sequential numbers
  const renumbered = renumberLists(text);

  // Line-by-line parser for robust list handling
  const lines = renumbered.split('\n');
  const output: string[] = [];

  // Track open list contexts
  let inOrderedList = false;
  let inUnorderedList = false;
  let inSubList = false;
  let openLiForSub = false; // true when a <li> is open waiting for sub-list

  function closeSubList() {
    if (inSubList) {
      output.push('</ul>');
      inSubList = false;
    }
    if (openLiForSub) {
      output.push('</li>');
      openLiForSub = false;
    }
  }

  function closeAllLists() {
    closeSubList();
    if (inOrderedList) { output.push('</ol>'); inOrderedList = false; }
    if (inUnorderedList) { output.push('</ul>'); inUnorderedList = false; }
  }

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];

    // ── Inline formatting on the raw line ──
    let line = rawLine;
    // Escape HTML
    line = line.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    // Bold
    line = line.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    line = line.replace(/__(.+?)__/g, '<strong>$1</strong>');
    // Italic
    line = line.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '<em>$1</em>');
    line = line.replace(/(?<!_)_(?!_)(.+?)(?<!_)_(?!_)/g, '<em>$1</em>');
    // Strikethrough
    line = line.replace(/~~(.+?)~~/g, '<del>$1</del>');

    // ── Classify the original (pre-escape) line ──
    const headingMatch = rawLine.match(/^#{1,3}\s+/);
    const orderedMatch = rawLine.match(/^\d+\.\s+/);
    const subBulletMatch = rawLine.match(/^\s+[-*]\s+/);
    const topBulletMatch = rawLine.match(/^[-*]\s+/);
    const isBlank = rawLine.trim() === '';

    // ── Headings ──
    if (headingMatch) {
      closeAllLists();
      const hMatch = rawLine.match(/^(#{1,3})\s+(.+)$/);
      if (hMatch) {
        const level = hMatch[1].length;
        const content = line.replace(/^#{1,3}\s+/, '');
        output.push(`<h${level}>${content}</h${level}>`);
      }
      continue;
    }

    // ── Ordered list item (e.g. "1. something") ──
    if (orderedMatch) {
      if (inUnorderedList) {
        // Switching from bullet to numbered
        closeAllLists();
      }
      if (!inOrderedList) {
        output.push('<ol>');
        inOrderedList = true;
      }
      closeSubList(); // close any sub-list from previous item
      const content = line.replace(/^\d+\.\s+/, '');

      // Check if next line is a sub-bullet
      const nextLine = i + 1 < lines.length ? lines[i + 1] : '';
      const hasNextSubBullet = /^\s+[-*]\s+/.test(nextLine);

      if (hasNextSubBullet) {
        output.push(`<li>${content}`);
        openLiForSub = true;
      } else {
        output.push(`<li>${content}</li>`);
      }
      continue;
    }

    // ── Sub-bullet under a list item (indented - or *) ──
    if (subBulletMatch) {
      if (!inOrderedList && !inUnorderedList) {
        // Orphan sub-bullet — treat as top-level bullet
        output.push('<ul>');
        inUnorderedList = true;
      }
      if (!inSubList) {
        output.push('<ul>');
        inSubList = true;
      }
      const content = line.replace(/^\s+[-*]\s+/, '');
      output.push(`<li>${content}</li>`);
      continue;
    }

    // ── Top-level bullet list item ──
    if (topBulletMatch) {
      if (inOrderedList) {
        // Switching from numbered to bullet
        closeAllLists();
      }
      if (!inUnorderedList) {
        output.push('<ul>');
        inUnorderedList = true;
      }
      closeSubList();
      const content = line.replace(/^[-*]\s+/, '');
      output.push(`<li>${content}</li>`);
      continue;
    }

    // ── Blank line ──
    if (isBlank) {
      closeAllLists();
      output.push('');
      continue;
    }

    // ── Regular text line ──
    closeAllLists();
    output.push(line);
  }

  closeAllLists();

  // Join lines: double blank line → paragraph break, single newline → <br>
  let html = output.join('\n');
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

/** Renumber all top-level numbered items in text sequentially (1, 2, 3, …)
 *  Sub-bullet lines (indented `- ` or `* `) are left unchanged. */
function renumberLists(text: string): string {
  const lines = text.split('\n');
  let counter = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\d+)\.\s+/);
    if (m) {
      counter++;
      lines[i] = lines[i].replace(/^\d+\.\s+/, `${counter}. `);
    }
    // Lines that are sub-bullets (indented - or *) or non-numbered are skipped
  }
  return lines.join('\n');
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
  const editorBodyRef = useRef<HTMLDivElement>(null);
  // Default: view/read mode. Must explicitly click Edit to enable editing.
  const [isEditing, setIsEditing] = useState(false);

  // Pull-to-refresh support on the editor body
  const { containerRef: pullRef, pullState } = usePullToRefresh(70, () => {
    window.location.reload();
  });

  // Merge pullRef and editorBodyRef
  const setBodyRef = useCallback((el: HTMLDivElement | null) => {
    (pullRef as React.MutableRefObject<HTMLDivElement | null>).current = el;
    (editorBodyRef as React.MutableRefObject<HTMLDivElement | null>).current = el;
  }, [pullRef]);

  // Auto-grow ticker on mount and when activeNote changes
  useEffect(() => {
    const el = tickerRef.current;
    if (el) {
      el.style.height = 'auto';
      el.style.height = el.scrollHeight + 'px';
    }
  }, [activeNote?.id]);

  // Scroll the textarea so the cursor is visible above the bottom mobile nav
  const scrollCursorIntoView = useCallback(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    // Use a small delay to let React update the value first
    requestAnimationFrame(() => {
      const cursorPos = ta.selectionStart;
      const textBeforeCursor = ta.value.substring(0, cursorPos);
      const linesBeforeCursor = textBeforeCursor.split('\n').length;
      const lineHeight = parseFloat(getComputedStyle(ta).lineHeight) || 24;
      const paddingTop = parseFloat(getComputedStyle(ta).paddingTop) || 16;
      // Calculate the pixel position of the cursor from the top of the content
      const cursorY = paddingTop + (linesBeforeCursor - 1) * lineHeight;
      // The visible height of the textarea (viewport)
      const visibleHeight = ta.clientHeight;
      // We want the cursor to be at least 80px above the bottom of the visible area
      // to clear the mobile bottom nav
      const bottomBuffer = 80;
      const maxScrollTop = cursorY - visibleHeight + bottomBuffer;
      // If the cursor is below the safe visible area, scroll down
      if (ta.scrollTop < maxScrollTop) {
        ta.scrollTop = maxScrollTop;
      }
    });
  }, []);

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
            scrollCursorIntoView();
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
          scrollCursorIntoView();
        }, 0);
        return;
      }

      // Match indented sub-bullet list: " - " or "  * " (under a numbered item)
      const subBulletMatch = currentLine.match(/^(\s+)([-*])\s+/);
      if (subBulletMatch) {
        const indent = subBulletMatch[1];
        const bulletChar = subBulletMatch[2];
        const prefix = subBulletMatch[0];
        // If the line is ONLY the prefix (no content), transition to next numbered item or exit
        if (currentLine.trim() === `${bulletChar} ` || currentLine.trim() === `${bulletChar}`) {
          e.preventDefault();
          // Find the most recent numbered item above this line
          const textBeforeLine = value.substring(0, lineStart);
          const prevLines = textBeforeLine.split('\n');
          let lastNumber = 0;
          for (let i = prevLines.length - 1; i >= 0; i--) {
            const nm = prevLines[i].match(/^(\d+)\.\s+/);
            if (nm) {
              lastNumber = parseInt(nm[1], 10);
              break;
            }
          }
          const nextNum = lastNumber + 1;
          const nextPrefix = `${nextNum}. `;
          const before = value.substring(0, lineStart);
          const after = value.substring(cursorPos);
          const newText = before + '\n' + nextPrefix + after;
          updateCurrentNote({ body: renumberLists(newText) });
          scheduleAutoSave();
          setTimeout(() => {
            const newPos = before.length + 1 + `${lastNumber + 1}. `.length;
            // After renumber, the actual prefix may have shifted — recalculate
            const updatedText = ta.value;
            const updatedLineStart = updatedText.lastIndexOf('\n', newPos - 1) + 1;
            const updatedLine = updatedText.substring(updatedLineStart, updatedLineStart + 20);
            const updatedNumMatch = updatedLine.match(/^(\d+)\.\s+/);
            if (updatedNumMatch) {
              ta.selectionStart = ta.selectionEnd = updatedLineStart + updatedNumMatch[0].length;
            } else {
              ta.selectionStart = ta.selectionEnd = newPos;
            }
            scrollCursorIntoView();
          }, 0);
          return;
        }
        // Continue with same indented bullet prefix
        e.preventDefault();
        const before = value.substring(0, cursorPos);
        const after = value.substring(cursorPos);
        const newText = before + '\n' + indent + bulletChar + ' ' + after;
        updateCurrentNote({ body: newText });
        scheduleAutoSave();
        setTimeout(() => {
          const newPos = before.length + 1 + indent.length + bulletChar.length + 1;
          ta.selectionStart = ta.selectionEnd = newPos;
          scrollCursorIntoView();
        }, 0);
        return;
      }

      // Match top-level bullet list: "- " or "* " (not indented)
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
            scrollCursorIntoView();
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
          scrollCursorIntoView();
        }, 0);
        return;
      }

      // Plain Enter (not in a list) — still need to scroll cursor into safe view
      // Let the default Enter happen, then scroll after
      setTimeout(() => {
        scrollCursorIntoView();
      }, 0);
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
  }, [applyBold, applyItalic, applyList, applyBulletList, updateCurrentNote, scheduleAutoSave, scrollCursorIntoView]);

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
          className={`editor-ticker-input ${!isEditing ? 'editor-ticker-readonly' : ''}`}
          placeholder="TICKER / TITLE"
          value={activeNote.ticker}
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          rows={1}
          readOnly={!isEditing}
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
          {isEditing && (<>
            <button
              className="fmt-btn"
              title="Bold (Ctrl+B)"
              onMouseDown={e => e.preventDefault()}
              onClick={() => applyBold()}
            >
              <strong>B</strong>
            </button>
            <button
              className="fmt-btn"
              title="Italic (Ctrl+I)"
              onMouseDown={e => e.preventDefault()}
              onClick={() => applyItalic()}
            >
              <em>I</em>
            </button>
            <button
              className="fmt-btn"
              title="Numbered list (Ctrl+Shift+L)"
              onMouseDown={e => e.preventDefault()}
              onClick={() => applyList()}
            >
              <span style={{ fontFamily: 'monospace' }}>1.</span>
            </button>
            <button
              className="fmt-btn"
              title="Bullet list (Ctrl+Shift+U)"
              onMouseDown={e => e.preventDefault()}
              onClick={() => applyBulletList()}
            >
              <span style={{ fontFamily: 'monospace' }}>&#8226;</span>
            </button>
            <div className="fmt-separator" />
          </>)}
          {/* Edit / Done toggle button — always visible */}
          <button
            className={`fmt-btn ${isEditing ? 'fmt-btn-active' : 'fmt-btn-edit-primary'}`}
            title={isEditing ? 'Done editing' : 'Edit this note'}
            onMouseDown={e => e.preventDefault()}
            onClick={() => {
              if (isEditing) {
                // Exiting edit mode — renumber lists, save and switch to view
                const renumbered = renumberLists(activeNote.body);
                updateCurrentNote({ body: renumbered });
                saveCurrentNote();
                onSave();
              }
              setIsEditing(!isEditing);
            }}
          >
            {isEditing ? '✓ Done' : '✎ Edit'}
          </button>
        </div>
        <div className="editor-toolbar-right">
          <span className="toolbar-word-count">{wordCount}w</span>
          {isDirty() && <button className="fmt-btn fmt-btn-discard" title="Discard unsaved changes" onClick={discardChanges}>Discard</button>}
          <button className="fmt-btn fmt-btn-action" title="Download note as text file" onClick={() => {
            if (!activeNote) return;
            const content = `${activeNote.ticker}\n\n${activeNote.body}`;
            const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `${activeNote.ticker || 'note'}.txt`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
          }}>Download</button>
          <button className="fmt-btn fmt-btn-action" title="Copy note" onClick={onCopy}>Copy</button>
          <button className="fmt-btn fmt-btn-danger" title="Delete note" onClick={onDelete}>Delete</button>
          <button className={`fmt-btn fmt-btn-save ${isDirty() ? 'fmt-btn-dirty' : ''}`} title="Save note (Ctrl+S)" onClick={async () => { const renumbered = renumberLists(activeNote.body); updateCurrentNote({ body: renumbered }); await saveCurrentNote(); onSave(); }}>{isDirty() ? 'Save •' : 'Saved'}</button>
        </div>
      </div>
      <div className="editor-body" ref={setBodyRef}>
        {/* Pull-to-refresh indicator (mobile only) */}
        <div className={`pull-refresh-indicator ${pullState !== 'idle' ? 'visible' : ''}`}>
          {pullState === 'refreshing' ? (
            <><span className="spinner" /> Refreshing...</>
          ) : pullState === 'ready' ? (
            'Release to refresh'
          ) : (
            'Pull to refresh'
          )}
        </div>
        {isEditing ? (
          <textarea
            ref={textareaRef}
            className="editor-textarea"
            placeholder="Write your analysis, observations, trade rationale…&#10;&#10;Formatting: **bold**, _italic_, ~~strikethrough~~&#10;1. or - then Enter = auto-continue list&#10;Ctrl+B = Bold | Ctrl+I = Italic | Ctrl+Shift+L = Numbered list"
            value={activeNote.body}
            onChange={e => {
              updateCurrentNote({ body: e.target.value });
              scheduleAutoSave();
              // On mobile, ensure cursor stays visible above bottom nav after typing
              scrollCursorIntoView();
            }}
            onKeyDown={handleEditorKeyDown}
          />
        ) : (
          <div
            className="editor-preview editor-preview-readonly"
            dangerouslySetInnerHTML={{ __html: renderMarkdown(activeNote.body) }}
          />
        )}
      </div>
    </div>
  );
}
