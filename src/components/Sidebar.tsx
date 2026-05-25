'use client';

import { useState, useCallback, useEffect } from 'react';
import { useNotes } from '@/hooks/useNotes';
import { PALETTE, Tag } from '@/types';

interface SidebarProps {
  onOpenRenameTag: (tagId: string) => void;
  onOpenDeleteTag: (tagId: string) => void;
}

export function Sidebar({ onOpenRenameTag, onOpenDeleteTag }: SidebarProps) {
  const {
    tags,
    currentFilter,
    activeTagFilters,
    setFilter,
    toggleTagFilter,
    clearTagFilters,
    setCustomRange,
    customFrom,
    customTo,
    addTag,
    countFor,
    notes,
  } = useNotes();

  const [showAddTagForm, setShowAddTagForm] = useState(false);
  const [newTagName, setNewTagName] = useState('');
  const [selectedNewColor, setSelectedNewColor] = useState(0);

  // Handle adding a new tag
  const handleAddTag = useCallback(() => {
    if (!newTagName.trim()) return;
    if (tags.some(t => t.name.toLowerCase() === newTagName.trim().toLowerCase())) {
      return;
    }
    const id = 'tag_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    addTag({ id, name: newTagName.trim(), color: selectedNewColor });
    setNewTagName('');
    setSelectedNewColor(0);
    setShowAddTagForm(false);
  }, [newTagName, selectedNewColor, tags, addTag]);

  // Handle custom range application
  const handleApplyCustomRange = useCallback(() => {
    const fromInput = document.getElementById('dateFrom') as HTMLInputElement;
    const toInput = document.getElementById('dateTo') as HTMLInputElement;
    const from = fromInput?.value ? new Date(fromInput.value).setHours(0, 0, 0, 0) : null;
    const to = toInput?.value ? new Date(toInput.value).setHours(23, 59, 59, 999) : null;
    setCustomRange(from, to);
  }, [setCustomRange]);

  // Handle clearing custom range
  const handleClearCustomRange = useCallback(() => {
    const fromInput = document.getElementById('dateFrom') as HTMLInputElement;
    const toInput = document.getElementById('dateTo') as HTMLInputElement;
    if (fromInput) fromInput.value = '';
    if (toInput) toInput.value = '';
    setCustomRange(null, null);
  }, [setCustomRange]);

  return (
    <aside className="sidebar">
      {/* Date filters */}
      <div className="sidebar-section">
        <div className="sidebar-label">Date</div>
        <button
          className={`filter-btn ${currentFilter === 'all' ? 'active' : ''}`}
          onClick={() => setFilter('all')}
        >
          <span className="filter-icon">📋</span> All notes{' '}
          <span className="count">{notes.length}</span>
        </button>
        <button
          className={`filter-btn ${currentFilter === 'today' ? 'active' : ''}`}
          onClick={() => setFilter('today')}
        >
          <span className="filter-icon">☀️</span> Today{' '}
          <span className="count">{countFor('today')}</span>
        </button>
        <button
          className={`filter-btn ${currentFilter === 'week' ? 'active' : ''}`}
          onClick={() => setFilter('week')}
        >
          <span className="filter-icon">📅</span> This week{' '}
          <span className="count">{countFor('week')}</span>
        </button>
        <button
          className={`filter-btn ${currentFilter === 'month' ? 'active' : ''}`}
          onClick={() => setFilter('month')}
        >
          <span className="filter-icon">🗓</span> This month{' '}
          <span className="count">{countFor('month')}</span>
        </button>
        <button
          className={`filter-btn ${currentFilter === 'quarter' ? 'active' : ''}`}
          onClick={() => setFilter('quarter')}
        >
          <span className="filter-icon">📆</span> This quarter{' '}
          <span className="count">{countFor('quarter')}</span>
        </button>
        <button
          className={`filter-btn ${currentFilter === 'year' ? 'active' : ''}`}
          onClick={() => setFilter('year')}
        >
          <span className="filter-icon">🗂</span> This year{' '}
          <span className="count">{countFor('year')}</span>
        </button>
        <button
          className={`filter-btn ${currentFilter === 'custom' ? 'active' : ''}`}
          onClick={() => setFilter('custom')}
        >
          <span className="filter-icon">✂️</span> Custom range{' '}
          <span className="count">{countFor('custom')}</span>
        </button>
      </div>

      {/* Custom date range */}
      <div
        className="date-custom-wrap"
        style={{ display: currentFilter === 'custom' ? 'block' : 'none' }}
      >
        <div id="activeRangeBadge"></div>
        <div className="date-range-row">
          <input type="date" className="date-input" id="dateFrom" title="From" />
          <span className="date-range-sep">→</span>
          <input type="date" className="date-input" id="dateTo" title="To" />
        </div>
        <div className="date-range-row" style={{ marginTop: '6px' }}>
          <button className="date-apply-btn" onClick={handleApplyCustomRange}>
            Apply
          </button>
          <button className="date-clear-btn" onClick={handleClearCustomRange}>
            Clear
          </button>
        </div>
      </div>

      <div className="sidebar-divider"></div>

      {/* Tags */}
      <div className="sidebar-section">
        <div className="sidebar-label">
          Tags
          <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
            <button
              className="sidebar-label-action"
              id="clearTagsBtn"
              onClick={clearTagFilters}
              title="Clear tag selection"
              style={{
                display: activeTagFilters.size > 0 ? 'inline-block' : 'none',
                fontSize: '11px',
                fontFamily: 'Syne, sans-serif',
                fontWeight: 600,
                letterSpacing: '0.04em',
              }}
            >
              Clear
            </button>
            <button
              className="sidebar-label-action"
              onClick={() => setShowAddTagForm(!showAddTagForm)}
              title="Add tag"
            >
              +
            </button>
          </div>
        </div>
      </div>

      {/* Add tag form */}
      <div className={`add-tag-form ${showAddTagForm ? 'open' : ''}`}>
        <div className="add-tag-row">
          <input
            className="add-tag-input"
            placeholder="Tag name…"
            maxLength={20}
            value={newTagName}
            onChange={e => setNewTagName(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') handleAddTag();
            }}
          />
        </div>
        <div className="color-swatches">
          {PALETTE.map((color, i) => (
            <span
              key={i}
              className={`swatch ${i === selectedNewColor ? 'selected' : ''}`}
              style={{ background: color.dot }}
              onClick={() => setSelectedNewColor(i)}
            />
          ))}
        </div>
        <div className="add-tag-actions">
          <button className="btn btn-primary btn-sm" onClick={handleAddTag}>
            Add tag
          </button>
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => setShowAddTagForm(false)}
          >
            Cancel
          </button>
        </div>
      </div>

      <div className="tag-list">
        {tags.map(tag => {
          const c = PALETTE[tag.color] || PALETTE[0];
          const isActive = activeTagFilters.has(tag.id);
          return (
            <button
              key={tag.id}
              className={`tag-filter ${isActive ? 'active-tag' : ''}`}
              onClick={() => toggleTagFilter(tag.id)}
              style={isActive ? { background: c.bg, color: c.text } : {}}
            >
              <span className="tag-filter-dot" style={{ background: c.dot }}></span>
              <span className="tag-filter-name">{tag.name}</span>
              <span className="tag-actions">
                <span
                  className="tag-action-btn"
                  onClick={e => {
                    e.stopPropagation();
                    onOpenRenameTag(tag.id);
                  }}
                  title="Edit"
                >
                  ✎
                </span>
                <span
                  className="tag-action-btn del"
                  onClick={e => {
                    e.stopPropagation();
                    onOpenDeleteTag(tag.id);
                  }}
                  title="Delete"
                >
                  ✕
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </aside>
  );
}