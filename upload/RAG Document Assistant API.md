#### just information: supabase database is on drkavitaclinics gmail account 

# RAG Document Assistant API

**Base URL:** `https://rag-document-assistant-three.vercel.app`

A second-brain RAG system with query expansion, document aggregation, and LLM-powered synthesis.

---

## 1. Ingest Document (raw text)

```bash
curl -X POST "https://rag-document-assistant-three.vercel.app/api/ingest" \
  -H "Content-Type: application/json" \
  -d '{
    "content": "Your content here",
    "filename": "filename.txt",
    "metadata": {
      "doc_type": "token",
      "project": "gem",
      "version": "1.0"
    }
  }'
```

**PowerShell example:**
```powershell
$body = @{
    content = "Your content here"
    filename = "filename.txt"
    metadata = @{
        doc_type = "token"
        project = "gem"
        version = "1.0"
    }
} | ConvertTo-Json -Compress

Invoke-RestMethod -Uri "https://rag-document-assistant-three.vercel.app/api/ingest" -Method POST -Headers @{"Content-Type" = "application/json"} -Body $body
```

---

## 2. Upload PDF File (FormData, must be <4.5MB)

```bash
curl -X POST "https://rag-document-assistant-three.vercel.app/api/upload" \
  -F "file=@/path/to/file.pdf" \
  -F "name=file.pdf" \
  -F "mode=Add"
```

**Modes:** `Add`, `Replace`, `Delete`

**Replace example (JSON) — replaces content at same filename:**
```bash
# First: Add initial content
curl -X POST "https://rag-document-assistant-three.vercel.app/api/upload" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "text",
    "content": "phone number of shashikant is 9869101909",
    "name": "shashikant.txt",
    "mode": "Add"
  }'

# Second: Replace — same filename overwrites old content
curl -X POST "https://rag-document-assistant-three.vercel.app/api/upload" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "text",
    "content": "phone number of shashikant is 7777016824",
    "name": "shashikant.txt",
    "mode": "Replace"
  }'
# After replace: only 7777016824 is stored. Old chunks deleted automatically.
```

**PowerShell example:**
```powershell
# Add initial
$body1 = @{
    type = "text"
    content = "phone number of shashikant is 9869101909"
    name = "shashikant.txt"
    mode = "Add"
} | ConvertTo-Json -Compress
Invoke-RestMethod -Uri "..." -Method POST -Headers @{"Content-Type" = "application/json"} -Body $body1

# Replace with updated content — same filename
$body2 = @{
    type = "text"
    content = "phone number of shashikant is 7777016824"
    name = "shashikant.txt"
    mode = "Replace"
} | ConvertTo-Json -Compress
Invoke-RestMethod -Uri "..." -Method POST -Headers @{"Content-Type" = "application/json"} -Body $body2
```
```bash
curl -X POST "https://rag-document-assistant-three.vercel.app/api/upload" \
  -F "file=@D:\test\Values Description PDF.pdf" \
  -F "name=Values Description PDF.pdf" \
  -F "mode=Add"
```

---

## 3. Upload via JSON (base64-encoded PDF or text)

For PDF (programmatic use - requires base64 encoding):
```bash
curl -X POST "https://rag-document-assistant-three.vercel.app/api/upload" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "pdf",
    "content": "<base64-encoded-file>",
    "name": "document.pdf",
    "mode": "Add"
  }'
```

For text content:
```bash
curl -X POST "https://rag-document-assistant-three.vercel.app/api/upload" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "text",
    "content": "Your raw text content here",
    "name": "document.txt",
    "mode": "Add"
  }'
```

**PowerShell example:**
```powershell
$body = @{
    type = "text"
    content = "Your raw text content here"
    name = "document.txt"
    mode = "Add"
} | ConvertTo-Json -Compress

Invoke-RestMethod -Uri "https://rag-document-assistant-three.vercel.app/api/upload" -Method POST -Headers @{"Content-Type" = "application/json"} -Body $body
```

---

## 4. Query Document

```bash
curl -X POST "https://rag-document-assistant-three.vercel.app/api/query" \
  -H "Content-Type: application/json" \
  -d '{"query": "Your question here"}'
```

**With mode (conversational or precise):**
```bash
curl -X POST "https://rag-document-assistant-three.vercel.app/api/query" \
  -H "Content-Type: application/json" \
  -d '{"query": "Your question", "mode": "conversational"}'
```

| Mode | Description |
|------|-------------|
| `conversational` | Broader search, uses topK=12, good for exploration |
| `precise` | Focused search, uses topK=5, good for specific answers |

**With filters:**
```bash
curl -X POST "https://rag-document-assistant-three.vercel.app/api/query" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "Your question",
    "top_k": 8,
    "filters": {
      "doc_type": "token",
      "project": "gem"
    }
  }'
```

**PowerShell examples:**
```powershell
# Conversational (default)
$body = @{
    query = "What is the architecture?"
    mode = "conversational"
} | ConvertTo-Json -Compress

Invoke-RestMethod -Uri "https://rag-document-assistant-three.vercel.app/api/query" -Method POST -Headers @{"Content-Type" = "application/json"} -Body $body

# Precise
$body = @{
    query = "Who is the project lead?"
    mode = "precise"
} | ConvertTo-Json -Compress

Invoke-RestMethod -Uri "https://rag-document-assistant-three.vercel.app/api/query" -Method POST -Headers @{"Content-Type" = "application/json"} -Body $body
```

**Response includes:**
```json
{
  "answer": "The synthesized answer...",
  "sources": ["doc1.md", "doc2.pdf"],
  "aggregatedContext": "Key Points: ...",
  "debug": {
    "hitsFound": 7,
    "documentsAggregated": 3,
    "reducerUsed": true
  }
}
```

---

## 5. List Documents

```bash
curl -X GET "https://rag-document-assistant-three.vercel.app/api/documents"
```

---

## 6. Delete Document (by filename)

```bash
curl -X POST "https://rag-document-assistant-three.vercel.app/api/upload" \
  -F "name=filename.pdf" \
  -F "mode=Delete"
```

Example:
```bash
curl -X POST "https://rag-document-assistant-three.vercel.app/api/upload" \
  -F "name=Values Description PDF.pdf" \
  -F "mode=Delete"
```

**Response:** `{"status":"Deleted"}`

---

## 7. Reset Index (delete ALL Pinecone records)

```bash
curl -X DELETE "https://rag-document-assistant-three.vercel.app/api/index/reset"
```

**Response:** `{"status":"Index reset complete"}`

---

## Features

### Query Expansion
Automatically expands synonyms to improve recall:
- `owner` → `responsible`, `lead`, `manager`, `accountable`
- `team` → `group`, `department`, `squad`
- `api` → `endpoint`, `rest`, `service`
- `database` → `db`, `postgres`, `storage`

### Document Aggregation
- Groups chunks by filename
- Reranks by `avgScore * log(chunkCount + 1)`
- Merges multiple relevant chunks into coherent context

### LLM Reducer
- Synthesizes multi-chunk answers
- Extracts key points, detects conflicts
- Produces unified, comprehensive responses

### Mode Selection
| Mode | topK | Use Case |
|------|------|----------|
| `conversational` | 12 | Exploration, broad questions |
| `precise` | 5 | Specific facts, exact answers |

---

## Notes

- **File size limit:** 4.5MB max (Vercel serverless payload limit)
- **Supported formats:** PDF, TXT, MD (via file upload) and raw text (via ingest)
- **Chunk metadata:** `doc_type`, `project`, `version`, `uploaded_at` stored with every chunk
- **Replace mode:** Auto-deletes old chunks before inserting new ones
- **Source validation:** Only returns sources that exist in the verified documents table
