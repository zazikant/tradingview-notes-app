import { Note, Tag } from '@/types';

export function uid(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export function escHtml(s: string | null | undefined): string {
  if (!s) return '';
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function relDate(ts: number): string {
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60000);
  const h = Math.floor(diff / 3600000);
  const d = Math.floor(diff / 86400000);
  if (m < 1) return 'just now';
  if (m < 60) return m + 'm ago';
  if (h < 24) return h + 'h ago';
  if (d < 7) return d + 'd ago';
  return new Date(ts).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

export function fullDate(ts: number): string {
  return new Date(ts).toLocaleDateString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

export function startOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function startOfWeek(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - d.getDay());
  return d.getTime();
}

export function startOfMonth(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  d.setDate(1);
  return d.getTime();
}

export function startOfQuarter(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  d.setMonth(Math.floor(d.getMonth() / 3) * 3, 1);
  return d.getTime();
}

export function startOfYear(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  d.setMonth(0, 1);
  return d.getTime();
}

export function parseNotesFromCSV(csv: string, existingTags: Tag[], existingNotes: Note[]): { notes: Note[]; newTags: Tag[]; skipped: number } {
  // Parse the entire CSV into rows first (handles quoted multi-line values)
  const rows = parseCSVRows(csv);
  if (rows.length < 2) return { notes: [], newTags: [], skipped: 0 };

  // Detect column layout from header
  const header = rows[0].map(h => h.trim().toLowerCase());
  const tickerIdx = header.indexOf('ticker');
  const tagsIdx = header.indexOf('tags');
  const bodyIdx = header.indexOf('body');
  const dateIdx = header.indexOf('date');

  // Fallback: if no header match, assume [Ticker, Date, Tags, Body]
  const tIdx = tickerIdx >= 0 ? tickerIdx : 0;
  const tgIdx = tagsIdx >= 0 ? tagsIdx : 2;
  const bIdx = bodyIdx >= 0 ? bodyIdx : 3;

  const tagNameToId = new Map(existingTags.map(t => [t.name.toLowerCase(), t.id]));
  // Dedup by ticker (not ticker:body) — same ticker = update, don't duplicate
  const existingTickers = new Set(existingNotes.map(n => n.ticker.trim().toLowerCase()));
  const newTagNames = new Map<string, string>();
  const notes: Note[] = [];
  let duplicates = 0;

  for (let i = 1; i < rows.length; i++) {
    const parts = rows[i];
    if (parts.every(p => !p.trim())) continue; // skip blank rows

    if (parts.length < 2) continue; // need at least ticker

    const ticker = (parts[tIdx] || '').replace(/""/g, '"').trim();
    if (!ticker) continue; // skip rows without a ticker

    const tagStr = (parts[tgIdx] || '').trim();
    const body = (parts[bIdx] || '').replace(/""/g, '"').trim();

    const noteTags: string[] = [];

    if (tagStr) {
      tagStr.split(/[;|]/).map(t => t.trim()).filter(Boolean).forEach(name => {
        // Skip if this looks like a leaked tag ID (e.g. "tag_clocvbddju7mpm7a13n")
        if (/^tag_[a-z0-9]{10,}$/i.test(name)) return;

        const lower = name.toLowerCase();
        if (tagNameToId.has(lower)) {
          noteTags.push(tagNameToId.get(lower)!);
        } else if (!newTagNames.has(lower)) {
          const newId = 'tag_' + uid();
          newTagNames.set(lower, newId);
          tagNameToId.set(lower, newId);
          noteTags.push(newId);
        } else {
          noteTags.push(newTagNames.get(lower)!);
        }
      });
    }

    // Dedup: skip if a note with the same ticker already exists
    const tickerLower = ticker.toLowerCase();
    if (existingTickers.has(tickerLower)) {
      duplicates++;
      continue;
    }
    existingTickers.add(tickerLower);

    // Parse date if available, otherwise use now
    let created = Date.now();
    if (dateIdx >= 0 && parts[dateIdx]) {
      const parsed = Date.parse(parts[dateIdx].trim());
      if (!isNaN(parsed)) created = parsed;
    }

    notes.push({
      id: uid(),
      ticker,
      body,
      tags: noteTags,
      created,
    });
  }

  const newTags: Tag[] = Array.from(newTagNames.entries()).map(([name, id]) => ({
    id,
    name: name.charAt(0).toUpperCase() + name.slice(1),
    color: Math.floor(Math.random() * 10),
  }));

  return { notes, newTags, skipped: duplicates };
}

/**
 * Parse a full CSV string into rows, properly handling:
 * - Quoted fields containing commas, newlines, and escaped quotes ("")
 * - \r\n and \n line endings
 */
export function parseCSVRows(csv: string): string[][] {
  const rows: string[][] = [];
  let currentRow: string[] = [];
  let currentField = '';
  let inQuotes = false;
  let i = 0;

  while (i < csv.length) {
    const char = csv[i];

    if (inQuotes) {
      if (char === '"') {
        if (i + 1 < csv.length && csv[i + 1] === '"') {
          // Escaped quote ""
          currentField += '"';
          i += 2;
          continue;
        } else {
          // End of quoted field
          inQuotes = false;
          i++;
          continue;
        }
      } else {
        // Any character inside quotes (including newlines) is part of the field
        currentField += char;
        i++;
        continue;
      }
    }

    // Not in quotes
    if (char === '"') {
      inQuotes = true;
      i++;
    } else if (char === ',') {
      currentRow.push(currentField);
      currentField = '';
      i++;
    } else if (char === '\r') {
      // Handle \r\n or bare \r
      currentRow.push(currentField);
      currentField = '';
      rows.push(currentRow);
      currentRow = [];
      i++;
      if (i < csv.length && csv[i] === '\n') i++; // skip \n after \r
    } else if (char === '\n') {
      currentRow.push(currentField);
      currentField = '';
      rows.push(currentRow);
      currentRow = [];
      i++;
    } else {
      currentField += char;
      i++;
    }
  }

  // Push last field and row
  if (currentField || currentRow.length > 0) {
    currentRow.push(currentField);
    rows.push(currentRow);
  }

  return rows;
}

export function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;
  let i = 0;
  while (i < line.length) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes) {
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        inQuotes = true;
      }
    } else if (char === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += char;
    }
    i++;
  }
  result.push(current);
  return result;
}

export function exportNotesToCSV(notes: Note[], tags: Tag[]): void {
  const tagMap = new Map(tags.map(t => [t.id, t.name]));
  const headers = ['Ticker', 'Date', 'Tags', 'Body'];
  const rows = notes.map(note => {
    // Skip tag IDs that no longer exist — don't leak raw IDs into CSV
    const tagNames = note.tags.map(id => tagMap.get(id)).filter(Boolean).join('; ');
    const date = fullDate(note.created);
    const ticker = note.ticker.replace(/"/g, '""');
    const body = note.body.replace(/"/g, '""');
    const tagsEscaped = tagNames.replace(/"/g, '""');
    return [`"${ticker}"`, `"${date}"`, `"${tagsEscaped}"`, `"${body}"`].join(',');
  });
  const csv = [headers.join(','), ...rows].join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `tv-notes-${Date.now()}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}