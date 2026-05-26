'use client';

import { useRef } from 'react';
import { useNotes } from '@/hooks/useNotes';
import { ToastManager, showToast } from '@/components/Toast';

interface TopbarProps {
  onDelete: () => void;
  onNew: () => void;
}

export function Topbar({ onDelete, onNew }: TopbarProps) {
  const { searchQuery, setSearchQuery, mobilePanel, setMobilePanel, exportAllNotes, importNotesFromCSV, deleteMatchingNotes } = useNotes();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const deleteInputRef = useRef<HTMLInputElement>(null);

  const handleImportClick = () => {
    fileInputRef.current?.click();
  };

  const handleDeleteClick = () => {
    deleteInputRef.current?.click();
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>, isDelete: boolean) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (event) => {
      const csv = event.target?.result as string;
      if (isDelete) {
        const count = await deleteMatchingNotes(csv);
        if (count > 0) {
          showToast(`Deleted ${count} matching note(s)`);
        } else {
          showToast('No matching notes to delete');
        }
      } else {
        const skipped = await importNotesFromCSV(csv);
        const totalImported = skipped >= 0 ? 'Notes imported' : 'Notes imported';
        if (skipped > 0) {
          showToast(`Imported (${skipped} duplicate ticker(s) skipped)`);
        } else {
          showToast(totalImported);
        }
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  const handleMobileBack = () => {
    if (mobilePanel === 'editor') {
      setMobilePanel('notes');
    } else if (mobilePanel === 'notes') {
      setMobilePanel('sidebar');
    }
  };

  return (
    <header className="topbar">
      <input
        ref={fileInputRef}
        type="file"
        accept=".csv"
        style={{ display: 'none' }}
        onChange={e => handleFileChange(e, false)}
      />
      <input
        ref={deleteInputRef}
        type="file"
        accept=".csv"
        style={{ display: 'none' }}
        onChange={e => handleFileChange(e, true)}
      />
      <button className="mobile-back-btn" onClick={handleMobileBack}>
        ‹ <span>Notes</span>
      </button>
      <div className="logo">
        <div className="logo-dot"></div>
        TV Notes
      </div>
      <div className="search-wrap">
        <span className="search-icon">⌕</span>
        <input
          type="text"
          placeholder="Search ticker, notes…"
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
        />
      </div>
      <div className="topbar-actions">
        <button className="btn btn-ghost" onClick={onDelete}>
          Delete
        </button>
        <button className="btn btn-ghost" onClick={handleDeleteClick} title="Delete notes matching CSV">
          Delete CSV
        </button>
        <button className="btn btn-ghost" onClick={handleImportClick} title="Import notes from CSV">
          Import CSV
        </button>
        <button className="btn btn-ghost" onClick={exportAllNotes} title="Export all notes as CSV">
          Export CSV
        </button>
        <button className="btn btn-primary" onClick={onNew}>
          + New note
        </button>
      </div>
      <button className="mobile-new-btn" onClick={onNew} title="New note">
        ＋
      </button>
    </header>
  );
}