'use client';

import { useCallback, useRef } from 'react';
import { useAppContext } from '@/context/AppContext';
import { Note, Tag, AppState } from '@/types';
import { uid, fullDate, exportNotesToCSV, parseNotesFromCSV, parseCSVRows } from '@/lib/utils';
import { addNote as sbAddNote, updateNote as sbUpdateNote, deleteNote as sbDeleteNote, addTag as sbAddTag, updateTag as sbUpdateTag, deleteTag as sbDeleteTag } from '@/lib/supabase';

export function useNotes() {
  const { state, dispatch, getFilteredNotes, getTag, getTagColor, countFor } = useAppContext();
  const autoSaveTimer = useRef<NodeJS.Timeout | null>(null);
  const isDirty = useRef(false);
  const lastSavedNote = useRef<string>('');

  const activeNote = state.notes.find(n => n.id === state.activeId) || null;

  // Check if the current note has unsaved changes
  const getIsDirty = useCallback((): boolean => {
    return isDirty.current;
  }, []);

  const createNote = useCallback(async () => {
    const newNote: Note = {
      id: uid(),
      ticker: '',
      body: '',
      tags: [],
      created: Date.now(),
    };
    dispatch({ type: 'ADD_NOTE', payload: newNote });
    await sbAddNote(newNote);
    isDirty.current = false;
    lastSavedNote.current = JSON.stringify(newNote);
    if (typeof window !== 'undefined' && window.innerWidth <= 768) {
      dispatch({ type: 'SET_MOBILE_PANEL', payload: 'editor' });
    }
    return newNote;
  }, [dispatch]);

  const openNote = useCallback(
    (id: string) => {
      // Reset dirty state when switching notes
      isDirty.current = false;
      const note = state.notes.find(n => n.id === id);
      if (note) {
        lastSavedNote.current = JSON.stringify(note);
      }
      dispatch({ type: 'SET_ACTIVE_ID', payload: id });
      if (typeof window !== 'undefined' && window.innerWidth <= 768) {
        dispatch({ type: 'SET_MOBILE_PANEL', payload: 'editor' });
      }
    },
    [state.notes, dispatch]
  );

  // Update local state ONLY — does NOT persist to Supabase
  const updateCurrentNote = useCallback(
    (updates: Partial<Pick<Note, 'ticker' | 'body' | 'tags'>>) => {
      if (!state.activeId) return;
      const note = state.notes.find(n => n.id === state.activeId);
      if (!note) return;

      const updated: Note = {
        ...note,
        ...updates,
        ticker: updates.ticker !== undefined ? updates.ticker : note.ticker,
      };

      // Mark as dirty since we changed local state without persisting
      isDirty.current = true;

      dispatch({ type: 'UPDATE_NOTE', payload: updated });
    },
    [state.activeId, state.notes, dispatch]
  );

  // Explicitly save the current note to Supabase
  const saveCurrentNote = useCallback(async () => {
    if (!state.activeId) return;
    const note = state.notes.find(n => n.id === state.activeId);
    if (!note) return;

    // Clear any pending auto-save
    if (autoSaveTimer.current) {
      clearTimeout(autoSaveTimer.current);
      autoSaveTimer.current = null;
    }

    await sbUpdateNote(note);
    isDirty.current = false;
    lastSavedNote.current = JSON.stringify(note);
  }, [state.activeId, state.notes]);

  // Schedule a debounced auto-save — only persists if dirty
  const scheduleAutoSave = useCallback(() => {
    if (autoSaveTimer.current) {
      clearTimeout(autoSaveTimer.current);
    }
    autoSaveTimer.current = setTimeout(async () => {
      if (state.activeId && isDirty.current) {
        const note = state.notes.find(n => n.id === state.activeId);
        if (note) {
          await sbUpdateNote(note);
          isDirty.current = false;
          lastSavedNote.current = JSON.stringify(note);
        }
      }
    }, 2000); // 2 second debounce — longer than before to let user type freely
  }, [state.activeId, state.notes]);

  // Discard unsaved changes — revert to last saved state
  const discardChanges = useCallback(() => {
    if (!state.activeId) return;

    // Clear any pending auto-save
    if (autoSaveTimer.current) {
      clearTimeout(autoSaveTimer.current);
      autoSaveTimer.current = null;
    }

    try {
      const saved = JSON.parse(lastSavedNote.current) as Note;
      if (saved && saved.id === state.activeId) {
        dispatch({ type: 'UPDATE_NOTE', payload: saved });
        isDirty.current = false;
      }
    } catch {
      // If we can't parse the saved state, just mark as clean
      isDirty.current = false;
    }
  }, [state.activeId, dispatch]);

  const deleteNote = useCallback(
    async (id: string) => {
      dispatch({ type: 'DELETE_NOTE', payload: id });
      await sbDeleteNote(id);
      isDirty.current = false;
    },
    [dispatch]
  );

  const copyNote = useCallback(
    (id: string) => {
      const note = state.notes.find(n => n.id === id);
      if (!note) return;

      const tagNames = note.tags.map(t => getTag(t)?.name || t).join(', ');
      const text = `${note.ticker}\n${fullDate(note.created)}\nTags: ${tagNames}\n\n${note.body}`;
      navigator.clipboard.writeText(text);
    },
    [state.notes, getTag]
  );

  const toggleEditorTag = useCallback(
    async (tagId: string) => {
      if (!state.activeId) return;
      const note = state.notes.find(n => n.id === state.activeId);
      if (!note) return;

      const newTags = note.tags.includes(tagId)
        ? note.tags.filter(t => t !== tagId)
        : [...note.tags, tagId];

      const updated = { ...note, tags: newTags };

      // Tag toggles persist immediately (considered a deliberate action)
      dispatch({ type: 'UPDATE_NOTE', payload: updated });
      await sbUpdateNote(updated);
      isDirty.current = false;
      lastSavedNote.current = JSON.stringify(updated);
    },
    [state.activeId, state.notes, dispatch]
  );

  const exportAllNotes = useCallback(() => {
    exportNotesToCSV(state.notes, state.tags);
  }, [state.notes, state.tags]);

  const importNotesFromCSV = useCallback(async (csv: string): Promise<number> => {
    const { notes: newNotes, newTags, skipped } = parseNotesFromCSV(csv, state.tags, state.notes);
    for (const tag of newTags) {
      dispatch({ type: 'ADD_TAG', payload: tag });
      await sbAddTag(tag);
    }
    for (const note of newNotes) {
      dispatch({ type: 'ADD_NOTE', payload: note });
      await sbAddNote(note);
    }
    return skipped;
  }, [state.tags, state.notes, dispatch]);

  const deleteMatchingNotes = useCallback(async (csv: string): Promise<number> => {
    const rows = parseCSVRows(csv);
    if (rows.length < 2) return 0;

    // Detect column layout from header
    const header = rows[0].map(h => h.trim().toLowerCase());
    const tickerIdx = header.indexOf('ticker');
    const tIdx = tickerIdx >= 0 ? tickerIdx : 0;

    const tickersToDelete = new Set<string>();
    for (let i = 1; i < rows.length; i++) {
      const parts = rows[i];
      if (parts.every(p => !p.trim())) continue;
      const ticker = (parts[tIdx] || '').replace(/""/g, '"').trim();
      if (ticker) tickersToDelete.add(ticker.toLowerCase());
    }

    const toDelete = state.notes.filter(n => tickersToDelete.has(n.ticker.trim().toLowerCase()));
    for (const note of toDelete) {
      dispatch({ type: 'DELETE_NOTE', payload: note.id });
      await sbDeleteNote(note.id);
    }
    return toDelete.length;
  }, [state.notes, dispatch]);

  return {
    notes: state.notes,
    tags: state.tags,
    activeId: state.activeId,
    activeNote,
    currentFilter: state.currentFilter,
    activeTagFilters: state.activeTagFilters,
    sortMode: state.sortMode,
    searchQuery: state.searchQuery,
    customFrom: state.customFrom,
    customTo: state.customTo,
    mobilePanel: state.mobilePanel,
    filteredNotes: getFilteredNotes(),
    getTag,
    getTagColor,
    isDirty: getIsDirty,
    createNote,
    openNote,
    updateCurrentNote,
    saveCurrentNote,
    scheduleAutoSave,
    discardChanges,
    deleteNote,
    copyNote,
    toggleEditorTag,
    setFilter: (filter: AppState['currentFilter']) =>
      dispatch({ type: 'SET_FILTER', payload: filter }),
    setCustomRange: (from: number | null, to: number | null) =>
      dispatch({ type: 'SET_CUSTOM_RANGE', payload: { from, to } }),
    toggleTagFilter: (tagId: string) =>
      dispatch({ type: 'TOGGLE_TAG_FILTER', payload: tagId }),
    clearTagFilters: () => dispatch({ type: 'CLEAR_TAG_FILTERS' }),
    setSortMode: (mode: AppState['sortMode']) =>
      dispatch({ type: 'SET_SORT_MODE', payload: mode }),
    setSearchQuery: (query: string) =>
      dispatch({ type: 'SET_SEARCH_QUERY', payload: query }),
    setMobilePanel: (panel: AppState['mobilePanel']) =>
      dispatch({ type: 'SET_MOBILE_PANEL', payload: panel }),
    addTag: async (tag: Tag) => {
      dispatch({ type: 'ADD_TAG', payload: tag });
      await sbAddTag(tag);
    },
    updateTag: async (tag: Tag) => {
      dispatch({ type: 'UPDATE_TAG', payload: tag });
      await sbUpdateTag(tag);
    },
    deleteTag: async (tagId: string) => {
      dispatch({ type: 'DELETE_TAG', payload: tagId });
      await sbDeleteTag(tagId);
    },
    exportAllNotes,
    importNotesFromCSV,
    deleteMatchingNotes,
    countFor,
  };
}
