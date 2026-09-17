import { NextRequest, NextResponse } from 'next/server';
import { listDocuments, deleteDocument } from '@/lib/brain/documents';
import { deleteRecords } from '@/lib/brain/pinecone';

export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * GET /api/brain/documents
 *
 * Returns the list of all Brain documents — synced notes AND uploaded files.
 *
 * Pass ?notes=1 to filter to only synced notes (filename LIKE 'note-%').
 *
 * Each row: { filename, sha256, storage_path, created_at, updated_at }
 */
export async function GET(req: NextRequest) {
  const notesOnly = req.nextUrl.searchParams.get('notes') === '1';
  try {
    const docs = await listDocuments(notesOnly ? 'note-' : null);
    return NextResponse.json({ documents: docs });
  } catch (err: any) {
    console.error('[/api/brain/documents GET] error', err);
    return NextResponse.json(
      { error: err?.message || 'list failed' },
      { status: 500 },
    );
  }
}

/**
 * DELETE /api/brain/documents?filename=note-abc.txt
 *
 * Removes a single document + its Pinecone vectors.
 */
export async function DELETE(req: NextRequest) {
  const filename = req.nextUrl.searchParams.get('filename');
  if (!filename) {
    return NextResponse.json(
      { error: 'filename query param is required' },
      { status: 400 },
    );
  }
  try {
    await deleteRecords(filename);
    await deleteDocument(filename);
    return NextResponse.json({ filename, deleted: true });
  } catch (err: any) {
    console.error('[/api/brain/documents DELETE] error', err);
    return NextResponse.json(
      { error: err?.message || 'delete failed' },
      { status: 500 },
    );
  }
}
