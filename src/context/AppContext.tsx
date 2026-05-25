'use client';

import React, { createContext, useContext, useReducer, useEffect, useCallback, useRef } from 'react';
import { AppState, AppAction, Note, Tag, PALETTE } from '@/types';
import { loadNotes, saveNotes, loadTags, saveTags, createSeedNotes } from '@/lib/storage';
import { uid } from '@/lib/utils';

const initialState: AppState = {
  notes: [],
  tags: [],
  activeId: null,
  currentFilter: 'all',
  activeTagFilters: new Set(),
  sortMode: 'newest',
  searchQuery: '',
  customFrom: null,
  customTo: null,
  mobilePanel: 'sidebar',
};

function appReducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case 'SET_NOTES':
      return { ...state, notes: action.payload };
    case 'SET_TAGS':
      return { ...state, tags: action.payload };
    case 'ADD_NOTE':
      return { ...state, notes: [action.payload, ...state.notes], activeId: action.payload.id };
    case 'UPDATE_NOTE':
      return {
        ...state,
        notes: state.notes.map(n => (n.id === action.payload.id ? action.payload : n)),
      };
    case 'DELETE_NOTE': {
      const remaining = state.notes.filter(n => n.id !== action.payload);
      return {
        ...state,
        notes: remaining,
        activeId: remaining.length > 0 ? remaining[0].id : null,
      };
    }
    case 'SET_ACTIVE_ID':
      return { ...state, activeId: action.payload };
    case 'SET_FILTER':
      return { ...state, currentFilter: action.payload };
    case 'SET_CUSTOM_RANGE':
      return { ...state, customFrom: action.payload.from, customTo: action.payload.to };
    case 'TOGGLE_TAG_FILTER': {
      const newFilters = new Set(state.activeTagFilters);
      if (newFilters.has(action.payload)) {
        newFilters.delete(action.payload);
      } else {
        newFilters.add(action.payload);
      }
      return { ...state, activeTagFilters: newFilters };
    }
    case 'CLEAR_TAG_FILTERS':
      return { ...state, activeTagFilters: new Set() };
    case 'SET_SORT_MODE':
      return { ...state, sortMode: action.payload };
    case 'SET_SEARCH_QUERY':
      return { ...state, searchQuery: action.payload };
    case 'SET_MOBILE_PANEL':
      return { ...state, mobilePanel: action.payload };
    case 'ADD_TAG':
      return { ...state, tags: [...state.tags, action.payload] };
    case 'UPDATE_TAG':
      return {
        ...state,
        tags: state.tags.map(t => (t.id === action.payload.id ? action.payload : t)),
      };
    case 'DELETE_TAG':
      return {
        ...state,
        tags: state.tags.filter(t => t.id !== action.payload),
        notes: state.notes.map(n => ({
          ...n,
          tags: n.tags.filter(tagId => tagId !== action.payload),
        })),
        activeTagFilters: (() => {
          const newFilters = new Set(state.activeTagFilters);
          newFilters.delete(action.payload);
          return newFilters;
        })(),
      };
    default:
      return state;
  }
}

interface AppContextValue {
  state: AppState;
  dispatch: React.Dispatch<AppAction>;
  // Helper functions
  getFilteredNotes: () => Note[];
  getTag: (id: string) => Tag | undefined;
  getTagColor: (id: string) => typeof PALETTE[number];
  countFor: (filter: AppState['currentFilter']) => number;
}

const AppContext = createContext<AppContextValue | null>(null);

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useReducer(appReducer, initialState);
  const autoSaveTimer = useRef<NodeJS.Timeout | null>(null);

  // Initialize data from localStorage
  useEffect(() => {
    let notes = loadNotes();
    const tags = loadTags();

    if (notes.length === 0) {
      notes = createSeedNotes();
      saveNotes(notes);
    }

    dispatch({ type: 'SET_NOTES', payload: notes });
    dispatch({ type: 'SET_TAGS', payload: tags });
  }, []);

  // Persist notes when they change
  useEffect(() => {
    if (state.notes.length > 0) {
      saveNotes(state.notes);
    }
  }, [state.notes]);

  // Persist tags when they change
  useEffect(() => {
    if (state.tags.length > 0) {
      saveTags(state.tags);
    }
  }, [state.tags]);

  const getFilteredNotes = useCallback((): Note[] => {
    const { notes, currentFilter, activeTagFilters, sortMode, searchQuery, customFrom, customTo } = state;
    const now = Date.now();

    let filtered = [...notes];

    // Date filter
    if (currentFilter === 'today') {
      const start = new Date(now);
      start.setHours(0, 0, 0, 0);
      filtered = filtered.filter(n => n.created >= start.getTime());
    } else if (currentFilter === 'week') {
      const start = new Date(now);
      start.setHours(0, 0, 0, 0);
      start.setDate(start.getDate() - start.getDay());
      filtered = filtered.filter(n => n.created >= start.getTime());
    } else if (currentFilter === 'month') {
      const start = new Date(now);
      start.setHours(0, 0, 0, 0);
      start.setDate(1);
      filtered = filtered.filter(n => n.created >= start.getTime());
    } else if (currentFilter === 'quarter') {
      const start = new Date(now);
      start.setHours(0, 0, 0, 0);
      start.setMonth(Math.floor(start.getMonth() / 3) * 3, 1);
      filtered = filtered.filter(n => n.created >= start.getTime());
    } else if (currentFilter === 'year') {
      const start = new Date(now);
      start.setHours(0, 0, 0, 0);
      start.setMonth(0, 1);
      filtered = filtered.filter(n => n.created >= start.getTime());
    } else if (currentFilter === 'custom' && (customFrom || customTo)) {
      filtered = filtered.filter(n => {
        const d = new Date(n.created);
        d.setHours(0, 0, 0, 0);
        const dayStart = d.getTime();
        if (customFrom && dayStart < customFrom) return false;
        if (customTo && dayStart > customTo) return false;
        return true;
      });
    }

    // Tag filter
    if (activeTagFilters.size > 0) {
      filtered = filtered.filter(n =>
        [...activeTagFilters].some(tagId => n.tags.includes(tagId))
      );
    }

    // Search
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      filtered = filtered.filter(n =>
        n.ticker.toLowerCase().includes(q) || n.body.toLowerCase().includes(q)
      );
    }

    // Sort
    if (sortMode === 'newest') {
      filtered.sort((a, b) => b.created - a.created);
    } else if (sortMode === 'oldest') {
      filtered.sort((a, b) => a.created - b.created);
    } else {
      filtered.sort((a, b) => a.ticker.localeCompare(b.ticker));
    }

    return filtered;
  }, [state]);

  const getTag = useCallback(
    (id: string): Tag | undefined => {
      return state.tags.find(t => t.id === id);
    },
    [state.tags]
  );

  const getTagColor = useCallback(
    (id: string) => {
      const tag = getTag(id);
      return PALETTE[tag?.color ?? 0] || PALETTE[0];
    },
    [getTag]
  );

  const countFor = useCallback(
    (filter: AppState['currentFilter']): number => {
      const savedFilter = state.currentFilter;
      const savedFrom = state.customFrom;
      const savedTo = state.customTo;

      // Temporarily apply filter
      dispatch({ type: 'SET_FILTER', payload: filter });
      if (filter === 'custom') {
        dispatch({ type: 'SET_CUSTOM_RANGE', payload: { from: savedFrom, to: savedTo } });
      }

      const count = getFilteredNotes().length;

      // Restore original filter
      dispatch({ type: 'SET_FILTER', payload: savedFilter });
      dispatch({ type: 'SET_CUSTOM_RANGE', payload: { from: savedFrom, to: savedTo } });

      return count;
    },
    [state.currentFilter, state.customFrom, state.customTo, getFilteredNotes]
  );

  return (
    <AppContext.Provider value={{ state, dispatch, getFilteredNotes, getTag, getTagColor, countFor }}>
      {children}
    </AppContext.Provider>
  );
}

export function useAppContext() {
  const context = useContext(AppContext);
  if (!context) {
    throw new Error('useAppContext must be used within AppProvider');
  }
  return context;
}