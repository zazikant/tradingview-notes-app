'use client';

import { useState, useCallback, useEffect } from 'react';
import { Topbar } from '@/components/Topbar';
import { Sidebar } from '@/components/Sidebar';
import { NotesPanel } from '@/components/NotesPanel';
import { Editor } from '@/components/Editor';
import { ToastManager, showToast } from '@/components/Toast';
import { useNotes } from '@/hooks/useNotes';
import { uid, fullDate } from '@/lib/utils';
import { PALETTE } from '@/types';

export default function Home() {
  const {
    activeId,
    activeNote,
    createNote,
    deleteNote,
    copyNote,
    setMobilePanel,
    mobilePanel,
    tags,
    updateTag,
    deleteTag,
    getTag,
  } = useNotes();

  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [showDeleteTagModal, setShowDeleteTagModal] = useState(false);
  const [showRenameTagModal, setShowRenameTagModal] = useState(false);
  const [pendingDeleteTagId, setPendingDeleteTagId] = useState<string | null>(null);
  const [pendingRenameTagId, setPendingRenameTagId] = useState<string | null>(null);
  const [renameTagName, setRenameTagName] = useState('');
  const [renameTagColor, setRenameTagColor] = useState(0);
  const [tickerToDelete, setTickerToDelete] = useState('');

  // Handle new note
  const handleNew = useCallback(() => {
    createNote();
  }, [createNote]);

  // Handle delete note
  const handleDelete = useCallback(() => {
    if (!activeId || !activeNote) {
      showToast('No note selected');
      return;
    }
    setTickerToDelete(activeNote.ticker || 'this note');
    setShowDeleteModal(true);
  }, [activeId, activeNote]);

  // Confirm delete note
  const handleConfirmDelete = useCallback(() => {
    console.log('Confirm delete, activeId:', activeId);
    if (activeId) {
      deleteNote(activeId);
      setShowDeleteModal(false);
      showToast('Note deleted');
    }
  }, [activeId, deleteNote]);

  // Handle copy note
  const handleCopy = useCallback(() => {
    if (activeId) {
      copyNote(activeId);
      showToast('Copied to clipboard');
    }
  }, [activeId, copyNote]);

  // Handle save
  const handleSave = useCallback(() => {
    showToast('Note saved');
  }, []);

  // Handle tag delete
  const handleOpenDeleteTag = useCallback((tagId: string) => {
    const tag = getTag(tagId);
    if (!tag) return;
    setPendingDeleteTagId(tagId);
    setShowDeleteTagModal(true);
  }, [getTag]);

  const handleConfirmDeleteTag = useCallback(() => {
    if (pendingDeleteTagId) {
      deleteTag(pendingDeleteTagId);
      setShowDeleteTagModal(false);
      setPendingDeleteTagId(null);
      showToast('Tag deleted');
    }
  }, [pendingDeleteTagId, deleteTag]);

  // Handle tag rename
  const handleOpenRenameTag = useCallback((tagId: string) => {
    const tag = getTag(tagId);
    if (!tag) return;
    setPendingRenameTagId(tagId);
    setRenameTagName(tag.name);
    setRenameTagColor(tag.color);
    setShowRenameTagModal(true);
  }, [getTag]);

  const handleConfirmRenameTag = useCallback(() => {
    if (!pendingRenameTagId || !renameTagName.trim()) return;
    if (tags.some(t => t.id !== pendingRenameTagId && t.name.toLowerCase() === renameTagName.trim().toLowerCase())) {
      showToast('Tag name already exists');
      return;
    }
    const tag = getTag(pendingRenameTagId);
    if (tag) {
      updateTag({ ...tag, name: renameTagName.trim(), color: renameTagColor });
      setShowRenameTagModal(false);
      setPendingRenameTagId(null);
      showToast('Tag updated');
    }
  }, [pendingRenameTagId, renameTagName, renameTagColor, tags, getTag, updateTag]);

  const handleCloseDeleteTagModal = useCallback(() => {
    setShowDeleteTagModal(false);
    setPendingDeleteTagId(null);
  }, []);

  const handleCloseRenameTagModal = useCallback(() => {
    setShowRenameTagModal(false);
    setPendingRenameTagId(null);
  }, []);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        handleSave();
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'n') {
        e.preventDefault();
        handleNew();
      }
      if (e.key === 'Escape') {
        setShowDeleteModal(false);
        setShowDeleteTagModal(false);
        setShowRenameTagModal(false);
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleNew, handleSave]);

  // Handle resize for mobile state initialization
  useEffect(() => {
    const handleResize = () => {
      if (typeof window !== 'undefined' && window.innerWidth > 768) {
        // Reset mobile panel on desktop
      }
    };

    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // Mobile back button handler
  const handleMobileBack = useCallback(() => {
    if (mobilePanel === 'editor') {
      setMobilePanel('notes');
    } else if (mobilePanel === 'notes') {
      setMobilePanel('sidebar');
    }
  }, [mobilePanel, setMobilePanel]);

  return (
    <>
      <Topbar onDelete={handleDelete} onNew={handleNew} />

      <div className="layout" data-panel={mobilePanel}>
        <Sidebar
          onOpenRenameTag={handleOpenRenameTag}
          onOpenDeleteTag={handleOpenDeleteTag}
        />
        <NotesPanel />
        <Editor onCopy={handleCopy} onDelete={handleDelete} onSave={handleSave} />
      </div>

      {/* Mobile Bottom Nav */}
      <nav className="mobile-nav">
        <button
          className={`mobile-nav-btn ${mobilePanel === 'sidebar' ? 'active' : ''}`}
          onClick={() => setMobilePanel('sidebar')}
        >
          <span className="mobile-nav-icon">☰</span>
          Filters
        </button>
        <button
          className={`mobile-nav-btn ${mobilePanel === 'notes' ? 'active' : ''}`}
          onClick={() => setMobilePanel('notes')}
        >
          <span className="mobile-nav-icon">📋</span>
          Notes
        </button>
        <button
          className={`mobile-nav-btn ${mobilePanel === 'editor' ? 'active' : ''}`}
          onClick={() => setMobilePanel('editor')}
        >
          <span className="mobile-nav-icon">✏️</span>
          Editor
        </button>
      </nav>

      <ToastManager />

      {/* Delete note confirm */}
      <div
        className={`modal-overlay ${showDeleteModal ? 'show' : ''}`}
        onClick={e => {
          if (e.target === e.currentTarget) setShowDeleteModal(false);
        }}
      >
        <div className="modal-box">
          <div className="modal-title">Delete this note?</div>
          <div className="modal-msg">
            &quot;{tickerToDelete}&quot; will be permanently deleted. This cannot be undone.
          </div>
          <div className="modal-actions">
            <button className="btn btn-ghost" onClick={() => setShowDeleteModal(false)}>
              Cancel
            </button>
            <button className="btn btn-danger" onClick={handleConfirmDelete}>
              Delete
            </button>
          </div>
        </div>
      </div>

      {/* Delete tag confirm */}
      <div
        className={`modal-overlay ${showDeleteTagModal ? 'show' : ''}`}
        onClick={e => {
          if (e.target === e.currentTarget) handleCloseDeleteTagModal();
        }}
      >
        <div className="modal-box">
          <div className="modal-title">Delete tag?</div>
          <div className="modal-msg">
            {pendingDeleteTagId && getTag(pendingDeleteTagId)
              ? `"${getTag(pendingDeleteTagId)?.name}" will be removed from notes. This cannot be undone.`
              : 'This cannot be undone.'}
          </div>
          <div className="modal-actions">
            <button className="btn btn-ghost" onClick={handleCloseDeleteTagModal}>
              Cancel
            </button>
            <button className="btn btn-danger" onClick={handleConfirmDeleteTag}>
              Delete tag
            </button>
          </div>
        </div>
      </div>

      {/* Rename tag modal */}
      <div
        className={`modal-overlay ${showRenameTagModal ? 'show' : ''}`}
        onClick={e => {
          if (e.target === e.currentTarget) handleCloseRenameTagModal();
        }}
      >
        <div className="modal-box">
          <div className="modal-title">Edit tag</div>
          <input
            className="rename-input"
            maxLength={20}
            placeholder="Tag name…"
            value={renameTagName}
            onChange={e => setRenameTagName(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') handleConfirmRenameTag();
            }}
          />
          <div className="modal-color-row">
            <div className="modal-color-label">Color</div>
            <div className="color-swatches">
              {PALETTE.map((c, i) => (
                <span
                  key={i}
                  className={`swatch ${i === renameTagColor ? 'selected' : ''}`}
                  style={{ background: c.dot }}
                  onClick={() => setRenameTagColor(i)}
                />
              ))}
            </div>
          </div>
          <div className="modal-actions">
            <button className="btn btn-ghost" onClick={handleCloseRenameTagModal}>
              Cancel
            </button>
            <button className="btn btn-primary" onClick={handleConfirmRenameTag}>
              Save
            </button>
          </div>
        </div>
      </div>
    </>
  );
}