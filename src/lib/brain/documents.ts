import { getSupabaseAdmin } from './supabase-admin';
import { hashText } from './hash';

/**
 * Documents table CRUD — thin wrapper around the Supabase admin client.
 *
 * Schema (created by `supabase/migrations/20260917_create_documents_table.sql`):
 *   filename     text PRIMARY KEY
 *   sha256       text NOT NULL
 *   storage_path text          (null for synced notes — we store text in Pinecone metadata)
 *   created_at   timestamptz DEFAULT now()
 *   updated_at   timestamptz DEFAULT now()
 *
 * RLS is ENABLED with a service-role-only policy. All access from the app
 * must go through this module (which uses the service role key).
 */

export interface BrainDocument {
  filename: string;
  sha256: string;
  storage_path: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Upsert a document row. Returns true if a new row was inserted (vs updated).
 *
 * @param filename  Primary key, e.g. `note-abc123.txt`
 * @param text      The text content — used to compute sha256 for dedup detection
 *                  (Pinecone upsert is handled separately in pinecone.ts)
 */
export async function upsertDocument(
  filename: string,
  text: string,
  storagePath: string | null = null,
): Promise<{ inserted: boolean; sha256: string }> {
  const supabase = getSupabaseAdmin();
  const sha256 = hashText(text);
  const now = new Date().toISOString();

  // Check if row already exists with the same sha256 — if so, no-op.
  const { data: existing, error: selErr } = await supabase
    .from('documents')
    .select('filename, sha256')
    .eq('filename', filename)
    .maybeSingle();

  if (selErr) {
    throw new Error(`documents select failed: ${selErr.message}`);
  }

  if (existing && existing.sha256 === sha256) {
    // Content unchanged — bump updated_at for visibility, but skip Pinecone re-embed.
    await supabase
      .from('documents')
      .update({ updated_at: now })
      .eq('filename', filename);
    return { inserted: false, sha256 };
  }

  const { error: upErr } = await supabase.from('documents').upsert(
    {
      filename,
      sha256,
      storage_path: storagePath,
      updated_at: now,
    },
    { onConflict: 'filename' },
  );

  if (upErr) {
    throw new Error(`documents upsert failed: ${upErr.message}`);
  }

  return { inserted: !existing, sha256 };
}

/**
 * Delete a document row by filename. Caller is responsible for also deleting
 * the Pinecone vectors (pinecone.ts `deleteRecords`).
 */
export async function deleteDocument(filename: string): Promise<void> {
  const supabase = getSupabaseAdmin();
  const { error } = await supabase
    .from('documents')
    .delete()
    .eq('filename', filename);
  if (error) {
    throw new Error(`documents delete failed: ${error.message}`);
  }
}

/**
 * List all documents in the Brain. Optionally filter by a filename prefix
 * (e.g. `note-` to list only synced notes).
 */
export async function listDocuments(
  prefix: string | null = null,
): Promise<BrainDocument[]> {
  const supabase = getSupabaseAdmin();
  let query = supabase
    .from('documents')
    .select('filename, sha256, storage_path, created_at, updated_at')
    .order('updated_at', { ascending: false })
    .limit(500);

  if (prefix) {
    query = query.like('filename', `${prefix}%`);
  }

  const { data, error } = await query;
  if (error) {
    throw new Error(`documents list failed: ${error.message}`);
  }
  return (data || []) as BrainDocument[];
}

/**
 * Get a single document row, or null if not found.
 * Used to check whether a given note has been synced.
 */
export async function getDocument(
  filename: string,
): Promise<BrainDocument | null> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from('documents')
    .select('filename, sha256, storage_path, created_at, updated_at')
    .eq('filename', filename)
    .maybeSingle();

  if (error) {
    throw new Error(`documents get failed: ${error.message}`);
  }
  return (data as BrainDocument) || null;
}
