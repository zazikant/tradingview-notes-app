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
  const lines = csv.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return { notes: [], newTags: [], skipped: 0 };

  const tagNameToId = new Map(existingTags.map(t => [t.name.toLowerCase(), t.id]));
  const existingKeys = new Set(existingNotes.map(n => `${n.ticker}:${n.body}`));
  const tagNames = new Set<string>();
  const notes: Note[] = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;

    const parts = parseCSVLine(line);
    if (parts.length < 4) continue;

    const ticker = parts[0].trim().toUpperCase();
    const tagStr = parts[2].trim();
    const body = parts[3].replace(/""/g, '"').trim();
    const noteTags: string[] = [];

    tagStr.split(';').map(t => t.trim()).filter(Boolean).forEach(name => {
      const lower = name.toLowerCase();
      if (tagNameToId.has(lower)) {
        noteTags.push(tagNameToId.get(lower)!);
      } else {
        tagNames.add(name);
      }
    });

    const key = `${ticker}:${body}`;
    if (existingKeys.has(key)) continue;
    existingKeys.add(key);

    notes.push({
      id: uid(),
      ticker,
      body,
      tags: noteTags,
      created: Date.now(),
    });
  }

  const newTags: Tag[] = Array.from(tagNames).map(name => ({
    id: 'tag_' + Math.random().toString(36).slice(2) + Date.now().toString(36),
    name,
    color: Math.floor(Math.random() * 10),
  }));

  return { notes, newTags, skipped: lines.length - 1 - notes.length };
}

function parseCSVLine(line: string): string[] {
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
    const tagNames = note.tags.map(id => tagMap.get(id) || id).join('; ');
    const date = fullDate(note.created);
    const body = note.body.replace(/"/g, '""');
    return [note.ticker, `"${date}"`, tagNames, `"${body}"`].join(',');
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