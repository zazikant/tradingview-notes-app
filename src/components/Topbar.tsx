'use client';

import { useNotes } from '@/hooks/useNotes';

interface TopbarProps {
  onDelete: () => void;
  onNew: () => void;
}

export function Topbar({ onDelete, onNew }: TopbarProps) {
  const { searchQuery, setSearchQuery, mobilePanel, setMobilePanel } = useNotes();

  const handleMobileBack = () => {
    if (mobilePanel === 'editor') {
      setMobilePanel('notes');
    } else if (mobilePanel === 'notes') {
      setMobilePanel('sidebar');
    }
  };

  return (
    <header className="topbar">
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