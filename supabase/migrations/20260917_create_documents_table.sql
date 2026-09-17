-- Migration: create `documents` table for the integrated "Chat RAG" brain
--
-- Mirrors the schema of the `documents` table in the rag-document-assistant-opencode
-- project, so that notes synced to the Brain are stored in the same shape that
-- the ported RAG code expects.
--
-- Run this once against the tradingview-notes-app Supabase project
-- (sdrjqrlvttbyrtkppfam) via the Supabase SQL editor:
--   https://supabase.com/dashboard/project/sdrjqrlvttbyrtkppfam/sql/new
--
-- Idempotent: safe to re-run.

-- 1. Documents table — one row per synced note (or future uploaded file).
--    `filename` is the natural primary key. For synced notes, it follows
--    the convention `note-<client_id>.txt`.
CREATE TABLE IF NOT EXISTS public.documents (
  filename     text PRIMARY KEY,
  sha256       text NOT NULL,
  storage_path text,
  created_at   timestamptz DEFAULT now(),
  updated_at   timestamptz DEFAULT now()
);

-- 2. Enable Row Level Security immediately — the source project skipped this
--    and was flagged by Supabase's security advisor. We enable RLS and add a
--    service-role-only policy. The Next.js API routes use the service_role
--    key (SUPABASE_SERVICE_ROLE_KEY env var), so they keep working. The anon
--    role (used by the client-side supabase.ts in the notes app) is blocked
--    from reading/writing documents directly — all brain access must go
--    through the server-side API routes.
ALTER TABLE public.documents ENABLE ROW LEVEL SECURITY;

-- Drop the policy if it exists from a prior run, then recreate.
DROP POLICY IF EXISTS "service role full access on documents" ON public.documents;
CREATE POLICY "service role full access on documents"
  ON public.documents FOR ALL
  TO service_role
  USING (true) WITH CHECK (true);

-- 3. Updated_at trigger — keeps `updated_at` in sync automatically on every
--    UPDATE, so upserts can rely on it for "last synced" timestamps.
CREATE OR REPLACE FUNCTION public.touch_documents_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS documents_touch_updated_at ON public.documents;
CREATE TRIGGER documents_touch_updated_at
  BEFORE UPDATE ON public.documents
  FOR EACH ROW
  EXECUTE FUNCTION public.touch_documents_updated_at();

-- 4. (Optional) Helpful index for filename-prefix scans (e.g. listing all
--    `note-*.txt` rows). Postgres already has the PK btree; this is a
--    minor nicety for prefix queries.
CREATE INDEX IF NOT EXISTS documents_filename_prefix_idx
  ON public.documents (filename text_pattern_ops);
