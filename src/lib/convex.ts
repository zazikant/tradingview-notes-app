import { ConvexHttpClient } from 'convex/browser';
import type { FunctionReference } from 'convex/server';

const CONVEX_URL = process.env.NEXT_PUBLIC_CONVEX_URL || 'http://127.0.0.1:3210';

export const convexClient = new ConvexHttpClient(CONVEX_URL);

export interface Note {
  id: string;
  ticker: string;
  body: string;
  tags: string[];
  created: number;
}

export interface Tag {
  id: string;
  name: string;
  color: number;
}

export async function loadNotes(): Promise<Note[]> {
  const notes = await convexClient.query('notes:list' as unknown as import('convex/server').FunctionReference<'query'>, {});
  return (notes as any[]).map((n: any) => ({
    id: n.clientId,
    ticker: n.ticker,
    body: n.body,
    tags: n.tags,
    created: n.created,
  }));
}

export async function loadTags(): Promise<Tag[]> {
  const tags = await convexClient.query('notes:listTags' as unknown as import('convex/server').FunctionReference<'query'>, {});
  return (tags as any[]).map((t: any) => ({
    id: t.clientId,
    name: t.name,
    color: t.color,
  }));
}

type MutationRef = import('convex/server').FunctionReference<'mutation'>;

export async function addNote(note: Note): Promise<void> {
  await convexClient.mutation('notes:add' as unknown as MutationRef, {
    clientId: note.id,
    ticker: note.ticker,
    body: note.body,
    tags: note.tags,
    created: note.created,
  });
}

export async function updateNote(note: Note): Promise<void> {
  await convexClient.mutation('notes:update' as unknown as MutationRef, {
    clientId: note.id,
    ticker: note.ticker,
    body: note.body,
    tags: note.tags,
  });
}

export async function deleteNote(id: string): Promise<void> {
  await convexClient.mutation('notes:remove' as unknown as MutationRef, { clientId: id });
}

export async function addTag(tag: Tag): Promise<void> {
  await convexClient.mutation('notes:addTag' as unknown as MutationRef, {
    clientId: tag.id,
    name: tag.name,
    color: tag.color,
  });
}

export async function updateTag(tag: Tag): Promise<void> {
  await convexClient.mutation('notes:updateTag' as unknown as MutationRef, {
    clientId: tag.id,
    name: tag.name,
    color: tag.color,
  });
}

export async function deleteTag(id: string): Promise<void> {
  await convexClient.mutation('notes:removeTag' as unknown as MutationRef, { clientId: id });
}

export async function seedIfEmpty(): Promise<void> {
  await convexClient.mutation('notes:seed' as unknown as MutationRef, {});
}

let pollInterval: ReturnType<typeof setInterval> | null = null;

export function startPolling(callback: () => void, intervalMs = 2000): () => void {
  if (pollInterval) clearInterval(pollInterval);
  pollInterval = setInterval(callback, intervalMs);
  return () => {
    if (pollInterval) clearInterval(pollInterval);
    pollInterval = null;
  };
}