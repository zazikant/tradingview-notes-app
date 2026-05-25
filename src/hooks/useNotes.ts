'use client';

import { useCallback, useRef } from 'react';
import { useAppContext } from '@/context/AppContext';
import { Note, Tag, AppState } from '@/types';
import { uid, fullDate, exportNotesToCSV, parseNotesFromCSV } from '@/lib/utils';
import { saveNotes } from '@/lib/storage';

export function useNotes() {
  const { state, dispatch, getFilteredNotes, getTag, getTagColor, countFor } = useAppContext();
  const autoSaveTimer = useRef<NodeJS.Timeout | null>(null);

  const activeNote = state.notes.find(n => n.id === state.activeId) || null;

  const createNote = useCallback(() => {
    const newNote: Note = {
      id: uid(),
      ticker: '',
      body: '',
      tags: [],
      created: Date.now(),
    };
    dispatch({ type: 'ADD_NOTE', payload: newNote });
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
    (updates: Partial<Pick<Note, 'ticker' | 'body' | 'tags'>>) => {
      if (!state.activeId) return;
      const note = state.notes.find(n => n.id === state.activeId);
      if (!note) return;

      const updated: Note = {
        ...note,
        ...updates,
        ticker: updates.ticker !== undefined ? updates.ticker.toUpperCase().trim() : note.ticker,
      };
      dispatch({ type: 'UPDATE_NOTE', payload: updated });
    },
    [state.activeId, state.notes, dispatch]
  );

  const saveCurrentNote = useCallback(() => {
    if (!state.activeId) return;
    if (autoSaveTimer.current) {
      clearTimeout(autoSaveTimer.current);
      autoSaveTimer.current = null;
    }
    saveNotes(state.notes);
  }, [state.activeId, state.notes]);

  const scheduleAutoSave = useCallback(() => {
    if (autoSaveTimer.current) {
      clearTimeout(autoSaveTimer.current);
    }
    autoSaveTimer.current = setTimeout(() => {
      if (state.activeId) {
        saveNotes(state.notes);
      }
    }, 600);
  }, [state.activeId, state.notes]);

  const deleteNote = useCallback(
    (id: string) => {
      dispatch({ type: 'DELETE_NOTE', payload: id });
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
    (tagId: string) => {
      if (!state.activeId) return;
      const note = state.notes.find(n => n.id === state.activeId);
      if (!note) return;

      const newTags = note.tags.includes(tagId)
        ? note.tags.filter(t => t !== tagId)
        : [...note.tags, tagId];

      dispatch({ type: 'UPDATE_NOTE', payload: { ...note, tags: newTags } });
    },
    [state.activeId, state.notes, dispatch]
  );

  const exportAllNotes = useCallback(() => {
    exportNotesToCSV(state.notes, state.tags);
  }, [state.notes, state.tags]);

  const importNotesFromCSV = useCallback((csv: string): number => {
    const { notes: newNotes, newTags, skipped } = parseNotesFromCSV(csv, state.tags, state.notes);
    newTags.forEach(tag => dispatch({ type: 'ADD_TAG', payload: tag }));
    newNotes.forEach(note => dispatch({ type: 'ADD_NOTE', payload: note }));
    return skipped;
  }, [state.tags, state.notes, dispatch]);

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
    addTag: (tag: Tag) => dispatch({ type: 'ADD_TAG', payload: tag }),
    updateTag: (tag: Tag) => dispatch({ type: 'UPDATE_TAG', payload: tag }),
    deleteTag: (tagId: string) => dispatch({ type: 'DELETE_TAG', payload: tagId }),
    exportAllNotes,
    importNotesFromCSV,
    countFor,
  };
}