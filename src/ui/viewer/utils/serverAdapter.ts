import type { Observation } from '../types.js';

export type ServerObservation = {
  id: string; projectId: string; teamId: string; serverSessionId: string | null;
  kind: string; content: string; metadata: Record<string, unknown>;
  obsType?: string | null; lifecycleState?: string | null;
  createdAtEpoch: number; updatedAtEpoch: number; supersededBy?: string | null;
};

const str = (v: unknown): string | null =>
  typeof v === 'string' && v.length > 0 ? v : null;
const strArrayToString = (v: unknown): string | null =>
  Array.isArray(v) ? v.filter(x => typeof x === 'string').join('\n') || null : null;

export function adaptObservation(row: ServerObservation): Observation {
  const m = row.metadata ?? {};
  return {
    id: row.id as unknown as number, // viewer treats id opaquely for keys; server ids are strings
    memory_session_id: row.serverSessionId ?? '',
    project: row.projectId,
    platform_source: (str((m as any).platform_source) ?? ''),
    type: row.obsType ?? row.kind ?? 'observation',
    title: str((m as any).title),
    subtitle: str((m as any).subtitle),
    narrative: str((m as any).narrative),
    text: row.content ?? null,
    facts: strArrayToString((m as any).facts),
    concepts: strArrayToString((m as any).concepts),
    files_read: strArrayToString((m as any).files_read),
    files_modified: strArrayToString((m as any).files_modified),
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
