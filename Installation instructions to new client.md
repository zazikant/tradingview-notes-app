# DoqueRAG Installation 2026 — Complete Setup Guide

> **Version:** 2.0
> **Updated:** 2026-09-22
> **Covers:** tradingview-notes-app (OpenCode + NVIDIA variants) + rag-document-assistant
> **Code state:** All 3 repos on `main` ship with the synchronous delete-by-IDs fix for Pinecone serverless. No manual patching needed.
> This document captures the **complete** database schema, storage buckets, edge functions, scheduled jobs, environment variables, and deployment steps needed to set up a new client project from scratch.

---

## 1. What this project is

DoqueRAG is a trading notes app with an inbuilt Chat RAG (Retrieval-Augmented Generation) brain. It lets users capture trading notes (ticker, body, tags), sync them to a vector store, and then ask natural-language questions about their notes — getting cited, grounded answers in return. The same RAG pipeline also indexes uploaded PDFs, markdown, and text files, so the brain becomes a single searchable second-brain for the user.

This guide captures the complete database schema, storage buckets, edge functions, scheduled jobs, environment variables, and deployment steps needed to set up a brand-new client project from scratch. It is intended for the engineer performing the install — every step is concrete and copy-pasteable, with no hidden assumptions about prior state.

- **Notes** — Users create trading notes (ticker, body, tags) stored in Supabase.
- **Tags** — Color-coded tags for organizing notes (Bullish, Bearish, Watchlist, etc.).
- **Documents** — Synced notes and uploaded PDFs/TXT/MD files indexed in Pinecone for vector search.
- **Chat Brain** — Searches Pinecone for relevant chunks, synthesizes them via an LLM, streams an answer with source citations.
- **Storage Bucket** — Raw PDF blobs stored in Supabase Storage.
- **Edge Functions** — Hourly cleanup + daily keepalive to prevent free-tier pausing.

---

## 2. Choose the right template repo (NEW)

DoqueRAG is shipped as three template repos. Pick the one that matches the LLM provider the new client should use. All three repos are kept in sync on structural changes; the only differences are the LLM client file and its env var name.

Clone the chosen repo with `git clone`, or import it directly from Vercel's new-project flow at https://vercel.com/new.

| Use case | Clone from | LLM provider | LLM env var |
|---|---|---|---|
| Default — OpenCode GLM-5.1 | `github.com/zazikant/tradingview-notes-app` | GLM-5.1 via opencode.ai | `OPENCODE_API_KEY` |
| NVIDIA-hosted LLM | `github.com/zazikant/tradingview-notes-app-nvidia` | GPT-OSS 20B via build.nvidia.com | `NVIDIA_API_KEY` |
| Shweta-specific fork | `github.com/zazikant/rag-document-assistant_shweta_client` | GLM-5.1 via opencode.ai | `OPENCODE_API_KEY` |

> **Code state (as of 2026-09-22):** All three repos ship with the synchronous delete-by-IDs fix for Pinecone serverless on their `main` branch. No manual patching needed — clone from `main` and you get the fix automatically. This closes the previous bug where deleted notes sometimes still appeared in chat answers.

---

## 3. Pinecone index setup (NEW)

Before deploying the app, create a Pinecone index with the exact parameters below. The app uses the `multilingual-e5-large` embedding model, which produces 1024-dim vectors. Any mismatch in dimensions, metric, or model will cause cryptic runtime errors on the first sync attempt.

### 3.1 Create the index

Sign in to https://app.pinecone.io → click **Create Index** and fill in:

| Field | Value |
|---|---|
| Index name | `rag-documents` |
| Description | (optional) DoqueRAG vector store |
| Dimensions | `1024` |
| Metric | `cosine` |
| Index type | `Serverless` |
| Cloud provider | `AWS` |
| Region | `us-east-1` |
| Embedding model used by app | `multilingual-e5-large` (hosted by Pinecone Inference) |

The name `rag-documents` is mandatory and standardized across all client accounts — the app's default is `PINECONE_INDEX_NAME=rag-documents`. You can override this via env var if you want a client-specific index name, but the default is recommended for consistency.

### 3.2 Get the API key

From the Pinecone dashboard → **API Keys** → copy your account API key (starts with `pcsk_`). This becomes the `PINECONE_API_KEY` Vercel env var in section 8.

---

## 4. Database schema — all required tables

### 4.1 Extensions (must be installed)

```sql
CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;
CREATE EXTENSION IF NOT EXISTS pg_net  WITH SCHEMA extensions;
```

### 4.2 Table 1 — `public.notes`

Stores all trading notes. Each note has a ticker, body (markdown), tags, and timestamps. The `client_id` is generated client-side as the primary key; `created` is set at insert and never mutated; `updated` is bumped on every edit.

```sql
CREATE TABLE IF NOT EXISTS public.notes (
  client_id text PRIMARY KEY,
  ticker    text DEFAULT '',
  body      text DEFAULT '',
  tags      text[] DEFAULT '{}',
  created   BIGINT,
  updated   BIGINT
);
```

Column details:
- `client_id` — Primary key. Generated client-side.
- `ticker` — Stock ticker (e.g. `AAPL`, `TSLA`). May be empty string.
- `body` — Markdown body. Can be very long.
- `tags` — Array of tag `client_id` strings.
- `created` — Epoch milliseconds (`BIGINT`). Set at insert, never mutated.
- `updated` — Epoch milliseconds (`BIGINT`, nullable). Falls back to `created` when null.

Enable RLS:

```sql
ALTER TABLE public.notes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "notes anon full access" ON public.notes FOR ALL TO anon USING (true) WITH CHECK (true);
CREATE POLICY "notes authenticated full access" ON public.notes FOR ALL TO authenticated USING (true) WITH CHECK (true);
```

### 4.3 Table 2 — `public.tags`

Stores color-coded tags for organizing notes (Bullish, Bearish, Watchlist, Important Task, etc.). The `color` column is an integer that maps to a palette index in the frontend.

```sql
CREATE TABLE IF NOT EXISTS public.tags (
  client_id text PRIMARY KEY,
  name      text NOT NULL,
  color     integer DEFAULT 0
);
```

Enable RLS:

```sql
ALTER TABLE public.tags ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tags anon full access" ON public.tags FOR ALL TO anon USING (true) WITH CHECK (true);
CREATE POLICY "tags authenticated full access" ON public.tags FOR ALL TO authenticated USING (true) WITH CHECK (true);
```

### 4.4 Table 3 — `public.seed_status`

Tracks whether the initial seed data (default tags + sample notes) has been loaded. A single row with `id='global'` is the convention.

```sql
CREATE TABLE IF NOT EXISTS public.seed_status (
  id        text PRIMARY KEY DEFAULT 'global',
  seeded_at BIGINT DEFAULT 0
);
INSERT INTO public.seed_status (id, seeded_at) VALUES ('global', 0) ON CONFLICT DO NOTHING;
```

Enable RLS:

```sql
ALTER TABLE public.seed_status ENABLE ROW LEVEL SECURITY;
CREATE POLICY "seed_status anon full access" ON public.seed_status FOR ALL TO anon USING (true) WITH CHECK (true);
```

### 4.5 Table 4 — `public.documents`

Records metadata for every synced note and uploaded file in the Brain. This is the source-of-truth that the Brain UI consults when listing documents — Pinecone is queried separately at chat time for vector search. The two stores must stay in sync; the patched `deleteRecords` function in `pinecone.ts` guarantees this by deleting Pinecone vectors synchronously whenever a document row is deleted.

```sql
CREATE TABLE IF NOT EXISTS public.documents (
  filename     text PRIMARY KEY,
  sha256       text NOT NULL,
  storage_path text,
  created_at   timestamptz DEFAULT now(),
  updated_at   timestamptz DEFAULT now()
);
```

Column details:
- `filename` — Primary key. For synced notes: `note-<client_id>.txt`. For uploaded files: original filename.
- `sha256` — SHA-256 hash of text content (used for dedup; same-content re-sync is a no-op).
- `storage_path` — Nullable. For PDFs: equals filename. For text/markdown: `NULL` (content lives only in Pinecone metadata).
- `created_at` / `updated_at` — Timestamps with `DEFAULT now()`.

Enable RLS (service-role-only — anon cannot read documents directly):

```sql
ALTER TABLE public.documents ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service role full access on documents" ON public.documents;
CREATE POLICY "service role full access on documents"
  ON public.documents FOR ALL
  TO service_role
  USING (true) WITH CHECK (true);
```

Updated_at trigger (so the documents table row gets touched on every upsert):

```sql
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
```

Prefix index (speeds up the `LIKE 'note-%'` filter used by the documents API):

```sql
CREATE INDEX IF NOT EXISTS documents_filename_prefix_idx
  ON public.documents (filename text_pattern_ops);
```

---

## 5. Storage bucket — `documents`

Holds raw PDF blobs. Private bucket — only the service role can read/write. Created via the `storage.buckets` table; RLS policies on `storage.objects` gate access by `bucket_id`.

```sql
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'documents', 'documents', false, 52428800,
  ARRAY['application/pdf', 'text/plain', 'text/markdown', 'application/octet-stream']
)
ON CONFLICT (id) DO UPDATE SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;
```

Storage RLS policies (service-role-only):

```sql
DROP POLICY IF EXISTS "documents bucket service role read" ON storage.objects;
DROP POLICY IF EXISTS "documents bucket service role write" ON storage.objects;
DROP POLICY IF EXISTS "documents bucket service role update" ON storage.objects;
DROP POLICY IF EXISTS "documents bucket service role delete" ON storage.objects;

CREATE POLICY "documents bucket service role read"
  ON storage.objects FOR SELECT TO service_role
  USING (bucket_id = 'documents');

CREATE POLICY "documents bucket service role write"
  ON storage.objects FOR INSERT TO service_role
  WITH CHECK (bucket_id = 'documents');

CREATE POLICY "documents bucket service role update"
  ON storage.objects FOR UPDATE TO service_role
  USING (bucket_id = 'documents') WITH CHECK (bucket_id = 'documents');

CREATE POLICY "documents bucket service role delete"
  ON storage.objects FOR DELETE TO service_role
  USING (bucket_id = 'documents');
```

---

## 6. Edge functions

Two Supabase Edge Functions are deployed via the Supabase CLI. Both are deployed with `--no-verify-jwt` so the pg_cron scheduler can call them with just the service_role key in the `Authorization` header (no JWT exchange needed).

### 6.1 `daily-keepalive`

Hits the `documents` table once a day to prevent the Supabase free-tier project from auto-pausing. Without this, the project pauses after 7 days of inactivity and the first request after pause takes ~30 seconds to wake up.

```typescript
// supabase/functions/daily-keepalive/index.ts
import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

Deno.serve(async (_req) => {
  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const supabase = createClient(supabaseUrl, supabaseKey)
    const { data, error } = await supabase.from('documents').select('filename').limit(1)
    return new Response(JSON.stringify({
      status: error ? 'failed' : 'ok',
      timestamp: new Date().toISOString(),
      data,
      error: error?.message
    }), { headers: { 'Content-Type': 'application/json' } })
  } catch (e) {
    return new Response(JSON.stringify({
      status: 'error', timestamp: new Date().toISOString(), message: e.message
    }), { headers: { 'Content-Type': 'application/json' }, status: 500 })
  }
})
```

Deploy:

```bash
supabase functions deploy daily-keepalive --no-verify-jwt
```

### 6.2 `cron-cleanup`

Hourly housekeeping on the `documents` table and Storage bucket. Finds Storage objects whose filename is no longer referenced by any `documents` row, and deletes the orphans. This prevents the Storage bucket from accumulating PDF blobs that the user already removed from the Brain.

```typescript
// supabase/functions/cron-cleanup/index.ts
import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

Deno.serve(async (_req) => {
  const summary = { scanned: 0, deleted: 0, kept: 0, errors: [] as string[] }
  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL') || Deno.env.get('SUPABASE_PROJECT_URL')
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    if (!supabaseUrl || !supabaseKey) {
      summary.errors.push('Missing env vars')
      return new Response(JSON.stringify(summary), { status: 500 })
    }
    const supabase = createClient(supabaseUrl, supabaseKey)
    const { data: storageFiles } = await supabase.storage.from('documents').list()
    const { data: docRows } = await supabase.from('documents').select('filename, storage_path')
    const referencedPaths = new Set((docRows || []).map((r: any) => r.storage_path).filter(Boolean))
    const orphans = (storageFiles || []).filter((f: any) => !referencedPaths.has(f.name))
    summary.scanned = (storageFiles || []).length
    if (orphans.length > 0) {
      const { error } = await supabase.storage.from('documents').remove(orphans.map((f: any) => f.name))
      if (!error) summary.deleted = orphans.length
    }
    summary.kept = summary.scanned - summary.deleted
    return new Response(JSON.stringify({ status: 'ok', ...summary }), { headers: { 'Content-Type': 'application/json' } })
  } catch (e) {
    summary.errors.push(e.message)
    return new Response(JSON.stringify({ status: 'error', ...summary }), { status: 500 })
  }
})
```

Deploy:

```bash
supabase functions deploy cron-cleanup --no-verify-jwt
```

---

## 7. Scheduled jobs (pg_cron + pg_net)

Two cron jobs run inside Postgres itself via `pg_cron`. They use `pg_net` to make outbound HTTPS calls to the edge functions. This pattern avoids external cron services like GitHub Actions or Vercel Cron — the database is the source of truth for the schedule.

### 7.1 `cron-cleanup-hourly` — every hour

Replace `<PROJECT_REF>` with the new client's Supabase project reference (the subdomain of their project URL, e.g. `unmilshdstcpbbgddbkh`).

```sql
SELECT cron.schedule(
  'cron-cleanup-hourly',
  '0 * * * *',
  $$
    SELECT net.http_post(
      url    := 'https://<PROJECT_REF>.supabase.co/functions/v1/cron-cleanup',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || current_setting('app.settings.service_role_key', true)
      ),
      body   := '{}'::jsonb
    )
  $$
);
```

### 7.2 `daily-keepalive` — every day at 00:00 UTC

```sql
SELECT cron.schedule(
  'daily-keepalive',
  '0 0 * * *',
  'SELECT 1'
);
```

This is a database-level keepalive — a no-op `SELECT 1` run once a day. On Supabase free tier, projects pause after 7 days of inactivity; this single query keeps the DB awake. The corresponding edge function (`daily-keepalive`) is a separate concern — it touches the `documents` table to confirm the schema is still reachable.

### 7.3 Set the `service_role_key` GUC (NEW)

The `cron-cleanup-hourly` job reads the Supabase service_role key from a Postgres GUC named `app.settings.service_role_key`. This must be set on the database before the cron job can authenticate to the edge function. Set it via the Supabase Dashboard **OR** via SQL:

**Via SQL** (replace `<YOUR_SERVICE_ROLE_KEY>` with the actual `sb_secret_...` value):

```sql
ALTER DATABASE postgres SET app.settings.service_role_key = '<YOUR_SERVICE_ROLE_KEY>';
```

**Via Dashboard:** Supabase Dashboard → Project Settings → Database → Custom Postgres Config → add a new setting with name `app.settings.service_role_key` and the service_role key as the value. Restart the database (Dashboard → Database → Restart) for the GUC to take effect.

### 7.4 Refresh schema cache

After creating all tables, run this so PostgREST (the Supabase REST API) sees them:

```sql
NOTIFY pgrst, 'reload schema';
```

---

## 8. Environment variables (Vercel)

Set these in Vercel → Project Settings → Environment Variables. Mark `OPENCODE_API_KEY` or `NVIDIA_API_KEY` (whichever the chosen variant uses) as sensitive; the rest can be plaintext.

| Key | Description | Example |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL | `https://<PROJECT_REF>.supabase.co` |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase publishable (anon) key | `sb_publishable_...` |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase secret (service role) key — server-only | `sb_secret_...` |
| `PINECONE_API_KEY` | Pinecone account API key | `pcsk_...` |
| `OPENCODE_API_KEY` | OpenCode gateway API key (GLM-5.1) — OpenCode variant only | `sk-nEtb...` |
| `NVIDIA_API_KEY` | NVIDIA integrate API key — NVIDIA variant only | `nvapi-...` |
| `PINECONE_INDEX_NAME` | (optional) Pinecone index name — defaults to `rag-documents` | `rag-documents` |

> **Vercel Hobby limits:** API route body size = 4.5 MB hard limit. Function timeout = 60s (Node) / 30s (Edge). The chat route uses `maxDuration=60` on the Node runtime.

### 8.1 LLM API key acquisition (NEW)

If you don't already have an LLM API key for the chosen variant:

| Variant | Provider URL | How to get the key |
|---|---|---|
| OpenCode (GLM-5.1) | https://opencode.ai/ | Sign up → Dashboard → API Keys → Create new key. Copied value starts with `sk-...` |
| NVIDIA (GPT-OSS 20B) | https://build.nvidia.com/ | Sign in with NVIDIA account → Choose a model (e.g. `openai/gpt-oss-20b`) → Get API key. Copied value starts with `nvapi-...` |

### 8.2 PIN lock customization (NEW)

The app ships with a PIN lock screen. The default PIN is `19081992` (set in the source repo). For a new client, change the PIN before deploying:

- File: `src/components/PinLock.tsx`
- Find the `CORRECT_PIN` constant near the top of the file.
- Replace the string with the new client's PIN (any numeric string).
- Commit and push — Vercel auto-deploys.

If you skip this step, the new client's app will accept the shared default PIN, which is not desirable for production.

---

## 9. Deploy to Vercel (NEW)

Once the env vars are set and the Supabase + Pinecone infrastructure is ready:

1. Go to https://vercel.com/new.
2. Import the chosen template repo (from section 2).
3. Vercel auto-detects Next.js 14 — no framework config needed.
4. Open the **Environment Variables** section and paste all keys from section 8 (and section 8.1).
5. Click **Deploy**. The first build takes ~90 seconds.
6. Subsequent pushes to `main` auto-deploy automatically (~30–60 seconds).

After deploy finishes, visit the generated `https://<project-name>.vercel.app` URL, enter the PIN, and run the smoke test in section 11.

---

## 10. End-to-end setup checklist

Use this as a sequential checklist. Do not skip steps — later steps depend on earlier ones.

- [ ] 1. Choose the template repo (section 2)
- [ ] 2. Create the Pinecone index named `rag-documents` with 1024 dims, cosine, serverless AWS us-east-1 (section 3)
- [ ] 3. Create new Supabase project; note `PROJECT_REF` and keys
- [ ] 4. Enable extensions: `pg_cron`, `pg_net` (section 4.1)
- [ ] 5. Create `notes` table (section 4.2)
- [ ] 6. Create `tags` table (section 4.3)
- [ ] 7. Create `seed_status` table (section 4.4)
- [ ] 8. Create `documents` table with RLS, trigger, prefix index (section 4.5)
- [ ] 9. Create Storage bucket `documents` — private, 50 MB limit (section 5)
- [ ] 10. Add Storage RLS policies — service-role-only (section 5)
- [ ] 11. Deploy edge function `daily-keepalive` (section 6.1)
- [ ] 12. Deploy edge function `cron-cleanup` (section 6.2)
- [ ] 13. Schedule `cron-cleanup-hourly` (replace `<PROJECT_REF>`) (section 7.1)
- [ ] 14. Schedule `daily-keepalive` (section 7.2)
- [ ] 15. Set `app.settings.service_role_key` GUC and restart DB (section 7.3)
- [ ] 16. Refresh schema cache: `NOTIFY pgrst, 'reload schema'` (section 7.4)
- [ ] 17. Get the LLM API key from OpenCode or NVIDIA (section 8.1)
- [ ] 18. Change PIN in `src/components/PinLock.tsx` (section 8.2)
- [ ] 19. Push to `main` → Vercel auto-deploys (section 9)
- [ ] 20. Run the smoke test (section 11)

---

## 11. Smoke test (verify the delete-bug fix)

After deploy, verify the app works end-to-end and that the Pinecone delete-bug fix is live:

1. Open the deployed Vercel URL in a browser.
2. Enter the PIN — should land on the notes screen.
3. Create a test note with a unique marker (e.g. `ZIRCONIUM CALDERA 7741`).
4. Click the 🧠 **Sync** button on the note — the button should change to ✓ Brain.
5. Click 🧠 **Chat RAG** in the sidebar to open the Brain panel.
6. Ask: *"What is ZIRCONIUM CALDERA 7741?"* — should get an answer citing the note.
7. Open the synced-docs sidebar (`Notes (1)` button) and click the ✕ next to the test note.
8. Confirm the removal in the dialog.
9. The Brain should now show *"Brain is empty — sync a note or upload a PDF"*.
10. Immediately ask the same question again: *"What is ZIRCONIUM CALDERA 7741?"*
11. ✓ **PASS** — Answer should be: *"I don't have that information in my knowledge base."*
12. ✗ **FAIL** — If the answer still mentions ZIRCONIUM CALDERA, the deployed code is still the old async delete. Wait 2 minutes for Vercel to redeploy, then retry.

If the smoke test passes, the install is complete and the client is safe from the ghost-vector bug forever.

---

## 12. Complete SQL script (copy-paste into Supabase SQL Editor)

> This single script creates ALL tables, RLS policies, triggers, storage bucket, storage policies, cron jobs, and schema cache refresh. It is idempotent — safe to re-run.
> **IMPORTANT:** Replace `<PROJECT_REF>` with the actual project reference before running.

```sql
-- ═══════════════════════════════════════════════════════════════
-- DoqueRAG Complete Setup Script (v2 — 2026-09-22)
-- ═══════════════════════════════════════════════════════════════

-- Extensions
CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

-- ═══ 1. NOTES TABLE ═══
CREATE TABLE IF NOT EXISTS public.notes (
  client_id text PRIMARY KEY,
  ticker text DEFAULT '',
  body text DEFAULT '',
  tags text[] DEFAULT '{}',
  created BIGINT,
  updated BIGINT
);
ALTER TABLE public.notes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "notes anon full access" ON public.notes;
CREATE POLICY "notes anon full access" ON public.notes FOR ALL TO anon USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "notes authenticated full access" ON public.notes;
CREATE POLICY "notes authenticated full access" ON public.notes FOR ALL TO authenticated USING (true) WITH CHECK (true);
ALTER TABLE public.notes ADD COLUMN IF NOT EXISTS updated BIGINT;
UPDATE public.notes SET updated = created WHERE updated IS NULL;

-- ═══ 2. TAGS TABLE ═══
CREATE TABLE IF NOT EXISTS public.tags (
  client_id text PRIMARY KEY,
  name text NOT NULL,
  color integer DEFAULT 0
);
ALTER TABLE public.tags ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tags anon full access" ON public.tags;
CREATE POLICY "tags anon full access" ON public.tags FOR ALL TO anon USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "tags authenticated full access" ON public.tags;
CREATE POLICY "tags authenticated full access" ON public.tags FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- ═══ 3. SEED_STATUS TABLE ═══
CREATE TABLE IF NOT EXISTS public.seed_status (
  id text PRIMARY KEY DEFAULT 'global',
  seeded_at BIGINT DEFAULT 0
);
INSERT INTO public.seed_status (id, seeded_at) VALUES ('global', 0) ON CONFLICT DO NOTHING;
ALTER TABLE public.seed_status ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "seed_status anon full access" ON public.seed_status;
CREATE POLICY "seed_status anon full access" ON public.seed_status FOR ALL TO anon USING (true) WITH CHECK (true);

-- ═══ 4. DOCUMENTS TABLE ═══
CREATE TABLE IF NOT EXISTS public.documents (
  filename text PRIMARY KEY,
  sha256 text NOT NULL,
  storage_path text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
ALTER TABLE public.documents ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service role full access on documents" ON public.documents;
CREATE POLICY "service role full access on documents"
  ON public.documents FOR ALL
  TO service_role
  USING (true) WITH CHECK (true);

-- Updated_at trigger
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

-- Prefix index
CREATE INDEX IF NOT EXISTS documents_filename_prefix_idx
  ON public.documents (filename text_pattern_ops);

-- ═══ 5. STORAGE BUCKET ═══
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'documents', 'documents', false, 52428800,
  ARRAY['application/pdf', 'text/plain', 'text/markdown', 'application/octet-stream']
)
ON CONFLICT (id) DO UPDATE SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

-- ═══ 6. STORAGE RLS POLICIES ═══
DROP POLICY IF EXISTS "documents bucket service role read" ON storage.objects;
DROP POLICY IF EXISTS "documents bucket service role write" ON storage.objects;
DROP POLICY IF EXISTS "documents bucket service role update" ON storage.objects;
DROP POLICY IF EXISTS "documents bucket service role delete" ON storage.objects;

CREATE POLICY "documents bucket service role read"
  ON storage.objects FOR SELECT TO service_role
  USING (bucket_id = 'documents');
CREATE POLICY "documents bucket service role write"
  ON storage.objects FOR INSERT TO service_role
  WITH CHECK (bucket_id = 'documents');
CREATE POLICY "documents bucket service role update"
  ON storage.objects FOR UPDATE TO service_role
  USING (bucket_id = 'documents') WITH CHECK (bucket_id = 'documents');
CREATE POLICY "documents bucket service role delete"
  ON storage.objects FOR DELETE TO service_role
  USING (bucket_id = 'documents');

-- ═══ 7. CRON JOBS ═══
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'cron-cleanup-hourly') THEN
    PERFORM cron.schedule(
      'cron-cleanup-hourly',
      '0 * * * *',
      $$
        SELECT net.http_post(
          url := 'https://<PROJECT_REF>.supabase.co/functions/v1/cron-cleanup',
          headers := jsonb_build_object(
            'Content-Type', 'application/json',
            'Authorization', 'Bearer ' || current_setting('app.settings.service_role_key', true)
          ),
          body := '{}'::jsonb
        )
      $$
    );
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'cron-cleanup-hourly: %', SQLERRM;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'daily-keepalive') THEN
    PERFORM cron.schedule('daily-keepalive', '0 0 * * *', $$ SELECT 1 $$);
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'daily-keepalive: %', SQLERRM;
END $$;

-- ═══ 8. REFRESH SCHEMA CACHE ═══
NOTIFY pgrst, 'reload schema';
```

---

## 13. Key references

| Item | Value |
|---|---|
| Template repos | `github.com/zazikant/tradingview-notes-app` (+ `-nvidia` + `_shweta_client`) |
| Tables | `notes`, `tags`, `seed_status`, `documents` |
| Storage bucket | `documents` (private, 50 MB limit) |
| Edge functions | `daily-keepalive`, `cron-cleanup` |
| Cron jobs | `cron-cleanup-hourly` (every hour), `daily-keepalive` (daily 00:00 UTC) |
| Pinecone index | `rag-documents` (1024-dim cosine, `multilingual-e5-large`, serverless AWS us-east-1) |
| LLM (OpenCode variant) | GLM-5.1 via `https://opencode.ai/zen/go/v1` |
| LLM (NVIDIA variant) | GPT-OSS 20B via `https://integrate.api.nvidia.com/v1` |
| Vercel Hobby limits | Body: 4.5 MB, Function timeout: 60s (Node) / 30s (Edge) |
| Default PIN lock | `19081992` — change in `src/components/PinLock.tsx` before deploy |
| Code state | All 3 repos on `main` carry the synchronous delete-by-IDs fix (2026-09-22). No patching needed. |
