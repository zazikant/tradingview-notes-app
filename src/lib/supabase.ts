import { createClient } from '@supabase/supabase-js';
import type { Note, Tag } from '@/types';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://sdrjqrlvttbyrtkppfam.supabase.co';
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNkcmpxcmx2dHRieXJ0a3BwZmFtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk2NzY0NzQsImV4cCI6MjA5NTI1MjQ3NH0.PyIMp2ukkzEFdVDVsz6Tw1GBC4vJwDeJhcBoKT6-bb0';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Safety limit: prevents accidental massive payloads
const NOTES_LIMIT = 5000;
const TAGS_LIMIT = 500;

export async function loadNotes(): Promise<Note[]> {
  const { data, error } = await supabase
    .from('notes')
    .select('client_id, ticker, body, tags, created')
    .order('created', { ascending: false })
    .limit(NOTES_LIMIT);

  if (error) {
    console.error('Error loading notes:', error);
    return [];
  }

  return (data || []).map(n => ({
    id: n.client_id,
    ticker: n.ticker,
    body: n.body,
    tags: n.tags || [],
    created: n.created,
  }));
}

export async function loadTags(): Promise<Tag[]> {
  const { data, error } = await supabase
    .from('tags')
    .select('client_id, name, color')
    .order('name')
    .limit(TAGS_LIMIT);

  if (error) {
    console.error('Error loading tags:', error);
    return [];
  }

  return (data || []).map(t => ({
    id: t.client_id,
    name: t.name,
    color: t.color,
  }));
}

export async function addNote(note: Note): Promise<void> {
  const { error } = await supabase.from('notes').insert({
    client_id: note.id,
    ticker: note.ticker,
    body: note.body,
    tags: note.tags,
    created: note.created,
  });

  if (error) console.error('Error adding note:', error);
}

export async function updateNote(note: Note): Promise<void> {
  const { error } = await supabase
    .from('notes')
    .update({ ticker: note.ticker, body: note.body, tags: note.tags })
    .eq('client_id', note.id);

  if (error) console.error('Error updating note:', error);
}

export async function deleteNote(id: string): Promise<void> {
  const { error } = await supabase.from('notes').delete().eq('client_id', id);
  if (error) console.error('Error deleting note:', error);
}

export async function addTag(tag: Tag): Promise<void> {
  const { error } = await supabase.from('tags').insert({
    client_id: tag.id,
    name: tag.name,
    color: tag.color,
  });

  if (error) console.error('Error adding tag:', error);
}

export async function updateTag(tag: Tag): Promise<void> {
  const { error } = await supabase
    .from('tags')
    .update({ name: tag.name, color: tag.color })
    .eq('client_id', tag.id);

  if (error) console.error('Error updating tag:', error);
}

export async function deleteTag(id: string): Promise<void> {
  const { error } = await supabase.from('tags').delete().eq('client_id', id);
  if (error) console.error('Error deleting tag:', error);
}

export function subscribeToNotes(callback: (notes: Note[]) => void): () => void {
  // Debounce rapid realtime events into a single refetch
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  const DEBOUNCE_MS = 500;

  const channel = supabase
    .channel('notes-changes')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'notes' }, () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        loadNotes().then(callback);
      }, DEBOUNCE_MS);
    })
    .subscribe();

  return () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    supabase.removeChannel(channel);
  };
}

export function subscribeToTags(callback: (tags: Tag[]) => void): () => void {
  // Debounce rapid realtime events into a single refetch
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  const DEBOUNCE_MS = 500;

  const channel = supabase
    .channel('tags-changes')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'tags' }, () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        loadTags().then(callback);
      }, DEBOUNCE_MS);
    })
    .subscribe();

  return () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    supabase.removeChannel(channel);
  };
}

export async function seedIfEmpty(): Promise<void> {
  const { data } = await supabase
    .from('seed_status')
    .select('seeded_at')
    .eq('id', 'global')
    .single();

  if (data && data.seeded_at > 0) return;

  const existing = await loadNotes();
  if (existing.length > 0) {
    await supabase.from('seed_status').update({ seeded_at: 1 }).eq('id', 'global');
    return;
  }

  const now = Date.now();
  const seedNotes = [
    { id: 'note_aapl', ticker: 'AAPL', body: 'Strong breakout above 180 resistance. Volume confirmed. Watch for retest of breakout level before entering. Target 195, stop below 178.', tags: ['tag_bull', 'tag_idea'], created: now - 86400000 * 2 },
    { id: 'note_tsla', ticker: 'TSLA', body: 'Bearish divergence on RSI at 4H. Price rejected at 240 for the third time. Looking for a break below 225 to short. Volume declining on up moves.', tags: ['tag_bear'], created: now - 86400000 },
    { id: 'note_nvda', ticker: 'NVDA', body: 'Earnings beat was massive. Holding position through the consolidation. AI tailwinds still strong. Will review after the next earnings cycle.', tags: ['tag_bull', 'tag_review'], created: now - 3600000 * 5 },
    { id: 'note_spy', ticker: 'SPY', body: 'Adding to watchlist ahead of FOMC. Key support at 430. If we hold this level, could see push to 450. Risk-off if we close below 425.', tags: ['tag_watch'], created: now - 3600000 * 2 },
    { id: 'note_meta', ticker: 'META', body: 'Cup and handle formation on the weekly. Breakout target ~340. Fundamentals improving — ad revenue bounce is real. Setting alert at 298.', tags: ['tag_bull', 'tag_idea', 'tag_watch'], created: now - 1800000 },
  ];

  const seedTags = [
    { id: 'tag_bull', name: 'Bullish', color: 0 },
    { id: 'tag_bear', name: 'Bearish', color: 1 },
    { id: 'tag_watch', name: 'Watchlist', color: 2 },
    { id: 'tag_idea', name: 'Trade idea', color: 3 },
    { id: 'tag_review', name: 'Review', color: 4 },
  ];

  for (const note of seedNotes) {
    await addNote(note);
  }

  for (const tag of seedTags) {
    await addTag(tag);
  }

  await supabase.from('seed_status').update({ seeded_at: Date.now() }).eq('id', 'global');
}