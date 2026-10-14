// Text rendering for the memory read tools. Raw /v1 rows run about 2.7K
// characters each; 40 of them overflowed Claude Code's tool output limit and
// were spilled to a file the agent never read. Search returns a short index,
// and full records are fetched by id.

export interface ObservationRow {
  id: string;
  projectId?: string;
  kind?: string;
  content?: string;
  obsType?: string | null;
  lifecycleState?: string | null;
  metadata?: Record<string, unknown> | null;
  createdAtEpoch?: number;
  supersededBy?: string;
  [key: string]: unknown;
}

export interface LimitSpec { default: number; max: number }

export const SEARCH_LIMIT: LimitSpec = { default: 10, max: 25 };
export const CONTEXT_LIMIT: LimitSpec = { default: 5, max: 10 };
export const GET_MAX_IDS = 10;
export const OUTPUT_MAX_CHARS = 20_000;
export const DETAIL_MAX_CHARS = 40_000;

const TITLE_MAX_CHARS = 160;
const SNIPPET_MAX_CHARS = 200;
const DETAIL_BODY_MAX_CHARS = 6_000;

export function clampLimit(raw: unknown, spec: LimitSpec): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return spec.default;
  return Math.min(Math.max(1, Math.trunc(raw)), spec.max);
}

function stripMarkup(text: string): string {
  return text.replace(/<\/?[a-zA-Z_][\w-]*>/g, '');
}

function oneLine(text: string): string {
  return stripMarkup(text).replace(/\s+/g, ' ').trim();
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

function metaString(row: ObservationRow, key: string): string | null {
  const value = row.metadata?.[key];
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function metaList(row: ObservationRow, key: string): string[] {
  const value = row.metadata?.[key];
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && v.length > 0) : [];
}

function titleAndRest(row: ObservationRow): { title: string; rest: string } {
  const content = typeof row.content === 'string' ? row.content : '';
  const metaTitle = metaString(row, 'title');
  if (metaTitle) {
    const rest = content.startsWith(metaTitle) ? content.slice(metaTitle.length) : content;
    return { title: oneLine(metaTitle), rest };
  }
  const newline = content.indexOf('\n');
  return newline === -1
    ? { title: oneLine(content), rest: '' }
    : { title: oneLine(content.slice(0, newline)), rest: content.slice(newline + 1) };
}

function headerLine(row: ObservationRow, title?: string): string {
  const date = typeof row.createdAtEpoch === 'number' && Number.isFinite(row.createdAtEpoch)
    ? new Date(row.createdAtEpoch).toISOString().slice(0, 10)
    : 'unknown-date';
  const type = row.obsType ?? row.kind ?? 'observation';
  const parts = [`[${row.id}] ${date}`, type];
  if (title) parts.push(title);
  return parts.join(' · ');
}

const SEARCH_OMITTED = (count: number) =>
  `[${count} more result${count === 1 ? '' : 's'} omitted to stay under the output limit; narrow the query or fetch ids with observation_get]`;
const DETAIL_OMITTED = (count: number) =>
  `[${count} more record${count === 1 ? '' : 's'} omitted to stay under the output limit; request fewer ids at a time]`;

// Adds entries until the next one would cross the cap. A first entry that is
// too big on its own is cut rather than dropped, so the caller always gets data.
function pack(
  header: string,
  entries: string[],
  footer: string,
  opts: { maxChars: number; omittedNote: (count: number) => string } = { maxChars: OUTPUT_MAX_CHARS, omittedNote: SEARCH_OMITTED },
): string {
  const { maxChars, omittedNote } = opts;
  const separator = '\n\n';
  let text = header;
  let included = 0;
  for (const entry of entries) {
    const remainingAfter = entries.length - included - 1;
    const reserve = (remainingAfter > 0 ? omittedNote(remainingAfter).length : 0) + footer.length + 2 * separator.length;
    const room = maxChars - text.length - separator.length - reserve;
    if (entry.length <= room) {
      text += separator + entry;
      included++;
      continue;
    }
    if (included === 0) {
      text += separator + truncate(entry, Math.max(room, 0));
      included++;
    }
    break;
  }
  const omitted = entries.length - included;
  if (omitted > 0) text += separator + omittedNote(omitted);
  if (footer) text += separator + footer;
  return text;
}

export function formatObservationIndex(rows: ObservationRow[], opts: { query: string }): string {
  if (rows.length === 0) {
    return `No observations matched "${opts.query}". Memory has no record of this; say so before falling back to the code.`;
  }
  const entries = rows.map((row) => {
    const { title, rest } = titleAndRest(row);
    const snippet = truncate(oneLine(rest), SNIPPET_MAX_CHARS);
    const head = headerLine(row, truncate(title, TITLE_MAX_CHARS));
    return snippet ? `${head}\n    ${snippet}` : head;
  });
  return pack(
    `${rows.length} observation${rows.length === 1 ? '' : 's'} for "${opts.query}" (most relevant first):`,
    entries,
    `Fetch the full record for the relevant ids with observation_get(ids=[...]), up to ${GET_MAX_IDS} at a time.`,
  );
}

export function formatObservationContext(rows: ObservationRow[], opts: { query: string }): string {
  if (rows.length === 0) {
    return `No observations matched "${opts.query}". Memory has no record of this; say so before falling back to the code.`;
  }
  const entries = rows.map((row) => `${headerLine(row)}\n${typeof row.content === 'string' ? row.content.trim() : ''}`);
  return pack(`Memory context for "${opts.query}":`, entries, '');
}

export function formatObservationDetails(rows: ObservationRow[], requestedIds: string[]): string {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const entries: string[] = [];
  const missing: string[] = [];
  for (const id of requestedIds) {
    const row = byId.get(id);
    if (!row) { missing.push(id); continue; }
    const lines = [`## ${headerLine(row)}${row.lifecycleState ? ` · ${row.lifecycleState}` : ''}`];
    if (row.supersededBy) lines.push(`Superseded by: ${row.supersededBy}`);
    lines.push(truncate(typeof row.content === 'string' ? row.content.trim() : '', DETAIL_BODY_MAX_CHARS));
    const why = metaString(row, 'why');
    if (why) lines.push(`Why: ${why}`);
    const modified = metaList(row, 'files_modified');
    if (modified.length) lines.push(`Files modified: ${modified.join(', ')}`);
    const read = metaList(row, 'files_read');
    if (read.length) lines.push(`Files read: ${read.join(', ')}`);
    const rejected = metaList(row, 'rejected_alternatives');
    if (rejected.length) lines.push(`Rejected alternatives: ${rejected.join('; ')}`);
    entries.push(lines.join('\n'));
  }
  const notFound = missing.length > 0 ? `Not found: ${missing.join(', ')}` : '';
  if (entries.length === 0) return ['No observations found for those ids.', notFound].filter(Boolean).join('\n\n');
  const [first, ...rest] = entries;
  return pack(first, rest, notFound, { maxChars: DETAIL_MAX_CHARS, omittedNote: DETAIL_OMITTED });
}
