import type { Observation } from '../types.js';

export type ServerObservation = {
  id: string; projectId: string; teamId: string; serverSessionId: string | null;
  kind: string; content: string; metadata: Record<string, unknown>;
  obsType?: string | null; lifecycleState?: string | null;
  createdAtEpoch: number; updatedAtEpoch: number; supersededBy?: string | null;
};

const str = (v: unknown): string | null =>
  typeof v === 'string' && v.length > 0 ? v : null;
// ObservationCard does `JSON.parse(observation.facts)` (and concepts/files_*),
// expecting a JSON-encoded array STRING (the legacy worker row format). So these
// fields must be serialized with JSON.stringify — NOT newline-joined, which is
// not valid JSON and made the card's JSON.parse throw ("Unexpected identifier")
// and crash the whole viewer for any observation with real facts/concepts.
const strArrayToJson = (v: unknown): string | null => {
  if (!Array.isArray(v)) return null;
  const arr = v.filter(x => typeof x === 'string');
  return arr.length > 0 ? JSON.stringify(arr) : null;
};

export function adaptObservation(row: ServerObservation): Observation {
  const m = row.metadata ?? {};
  const content = row.content ?? null;
  // Server-generated observations store their prose in `content`, not in a
  // metadata `title`/`narrative` (those only exist on legacy worker rows). The
  // card renders `title` (else "Untitled") + subtitle/narrative and never shows
  // `text` directly — so without this, imported rows all read "Untitled" with an
  // empty body. Derive a title from the first line/sentence of content and put
  // the full content in `narrative` so the card body shows the observation.
  const metaTitle = str((m as any).title);
  const metaNarrative = str((m as any).narrative);
  const deriveTitle = (text: string): string => {
    const firstLine = (text.split('\n')[0] ?? '').trim();
    const sentence = (firstLine.split(/(?<=[.!?])\s/)[0] ?? '').trim();
    const base = sentence || firstLine;
    return base.length > 100 ? base.slice(0, 100).trimEnd() + '…' : base;
  };
  return {
    id: row.id as unknown as number, // viewer treats id opaquely for keys; server ids are strings
    memory_session_id: row.serverSessionId ?? '',
    project: row.projectId,
    platform_source: (str((m as any).platform_source) ?? ''),
    type: row.obsType ?? row.kind ?? 'observation',
    title: metaTitle ?? (content ? deriveTitle(content) : null),
    subtitle: str((m as any).subtitle),
    narrative: metaNarrative ?? content,
    text: content,
    facts: strArrayToJson((m as any).facts),
    concepts: strArrayToJson((m as any).concepts),
    files_read: strArrayToJson((m as any).files_read),
    files_modified: strArrayToJson((m as any).files_modified),
    prompt_number: null,
    created_at: new Date(row.createdAtEpoch).toISOString(),
    created_at_epoch: row.createdAtEpoch,
    // team-aware-ready seams + server extras (extra fields are harmless to the viewer):
    lifecycle: row.lifecycleState ?? null,
    supersededBy: row.supersededBy ?? null,
  } as unknown as Observation;
}

export function adaptObservations(rows: ServerObservation[]): Observation[] {
  return (rows ?? []).map(adaptObservation);
}
