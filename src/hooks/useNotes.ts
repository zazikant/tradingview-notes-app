'use client';

import { useCallback, useRef } from 'react';
import { useAppContext } from '@/context/AppContext';
import { Note, Tag, AppState } from '@/types';
import { uid, fullDate, exportNotesToCSV, parseNotesFromCSV } from '@/lib/utils';
import { addNote as convexAddNote, updateNote as convexUpdateNote, deleteNote as convexDeleteNote, addTag as convexAddTag, updateTag as convexUpdateTag, deleteTag as convexDeleteTag } from '@/lib/convex';

export function useNotes() {
  const { state, dispatch, getFilteredNotes, getTag, getTagColor, countFor } = useAppContext();
  const autoSaveTimer = useRef<NodeJS.Timeout | null>(null);

  const activeNote = state.notes.find(n => n.id === state.activeId) || null;

  const createNote = useCallback(async () => {
    const newNote: Note = {
      id: uid(),
      ticker: '',
      body: '',
      tags: [],
      created: Date.now(),
    };
    dispatch({ type: 'ADD_NOTE', payload: newNote });
    await convexAddNote(newNote);
    if (typeof window !== 'undefined' && window.innerWidth <= 768) {
      dispatch({ type: 'SET_MOBILE_PANEL', payload: 'editor' });
    }
    return newNote;
  }, [dispatch]);

  const openNote = useCallback(
    (id: string) => {
      dispatch({ type: 'SET_ACTIVE_ID', payload: id });
      if (typeof window !== 'undefined' && window.innerWidth <= 768) {
        dispatch({ type: 'SET_MOBILE_PANEL', payload: 'editor' });
      }
    },
    [dispatch]
  );

  const updateCurrentNote = useCallback(
    async (updates: Partial<Pick<Note, 'ticker' | 'body' | 'tags'>>) => {
      if (!state.activeId) return;
      const note = state.notes.find(n => n.id === state.activeId);
      if (!note) return;

      const updated: Note = {
        ...note,
        ...updates,
        ticker: updates.ticker !== undefined ? updates.ticker.toUpperCase().trim() : note.ticker,
      };
      dispatch({ type: 'UPDATE_NOTE', payload: updated });
      await convexUpdateNote(updated);
    },
    [state.activeId, state.notes, dispatch]
  );

  const saveCurrentNote = useCallback(() => {
    if (!state.activeId) return;
    if (autoSaveTimer.current) {
      clearTimeout(autoSaveTimer.current);
      autoSaveTimer.current = null;
    }
  }, [state.activeId]);

  const scheduleAutoSave = useCallback(() => {
    if (autoSaveTimer.current) {
      clearTimeout(autoSaveTimer.current);
    }
    autoSaveTimer.current = setTimeout(() => {
      if (state.activeId) {
        const note = state.notes.find(n => n.id === state.activeId);
        if (note) {
          convexUpdateNote(note);
        }
      }
    }, 600);
  }, [state.activeId, state.notes]);

  const deleteNote = useCallback(
    async (id: string) => {
      dispatch({ type: 'DELETE_NOTE', payload: id });
      await convexDeleteNote(id);
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
      dispatch({ type: 'UPDATE_NOTE', payload: updated });
      await convexUpdateNote(updated);
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
      await convexAddTag(tag);
    }
    for (const note of newNotes) {
      dispatch({ type: 'ADD_NOTE', payload: note });
      await convexAddNote(note);
    }
    return skipped;
  }, [state.tags, state.notes, dispatch]);

  const deleteMatchingNotes = useCallback(async (csv: string): Promise<number> => {
    const lines = csv.split(/\r?\n/).filter(l => l.trim());
    if (lines.length < 2) return 0;
    const keysToDelete = new Set<string>();
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim()) continue;
      const parts = parseCSVLine(line);
      if (parts.length < 4) continue;
      let ticker: string;
      let body: string;
      if (parts.length >= 5) {
        ticker = parts[0].trim().toUpperCase();
        body = parts[4].replace(/""/g, '"').trim();
      } else {
        ticker = parts[0].trim().toUpperCase();
        body = parts[3].replace(/""/g, '"').trim();
      }
      keysToDelete.add(`${ticker}:${body}`);
    }
    const toDelete = state.notes.filter(n => keysToDelete.has(`${n.ticker}:${n.body}`));
    for (const note of toDelete) {
      dispatch({ type: 'DELETE_NOTE', payload: note.id });
      await convexDeleteNote(note.id);
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
    createNote,
    openNote,
    updateCurrentNote,
    saveCurrentNote,
    scheduleAutoSave,
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
      await convexAddTag(tag);
    },
    updateTag: async (tag: Tag) => {
      dispatch({ type: 'UPDATE_TAG', payload: tag });
      await convexUpdateTag(tag);
    },
    deleteTag: async (tagId: string) => {
      dispatch({ type: 'DELETE_TAG', payload: tagId });
      await convexDeleteTag(tagId);
    },
    exportAllNotes,
    importNotesFromCSV,
    deleteMatchingNotes,
    countFor,
  };
}