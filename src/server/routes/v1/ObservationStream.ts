// SPDX-License-Identifier: Apache-2.0
// In-process SSE fan-out for new observations. Best-effort: a broken subscriber
// is dropped, never throws into the publisher (generation path must not break).
//
// Scoped per project. The fan-out used to be process-wide, which was a latent
// no-op while a server only ever held one project; per-project databases make
// projects genuinely concurrent, and an SSE frame carries full observation
// content, so an unscoped fan-out is a cross-project content leak.
//
// A subscriber's scope comes from its authenticated identity, never from
// anything the client sends — the same rule the database routing follows.
type SseResponse = { write: (chunk: string) => void; writableEnded?: boolean };
export type StreamEvent = { type: 'initial_load' | 'new_observation'; observation?: unknown };
export type StreamScope = { teamId: string; projectId: string };

type Subscriber = { res: SseResponse; scope: StreamScope };

// The published observation's own scope. Read defensively: `observation` is
// typed `unknown`, and a shape without a projectId must fail closed.
function scopeOf(event: StreamEvent): { teamId: string; projectId: string } | null {
  const obs = event.observation as { teamId?: unknown; projectId?: unknown } | undefined;
  if (!obs || typeof obs.projectId !== 'string' || obs.projectId.length === 0) return null;
  return {
    teamId: typeof obs.teamId === 'string' ? obs.teamId : '',
    projectId: obs.projectId,
  };
}

export class ObservationStream {
  private subscribers = new Set<Subscriber>();

  subscribe(res: SseResponse, scope: StreamScope): () => void {
    const entry: Subscriber = { res, scope };
    this.subscribers.add(entry);
    return () => { this.subscribers.delete(entry); };
  }

  publish(event: StreamEvent): void {
    const eventScope = scopeOf(event);
    // No resolvable project → nobody can be shown to own it. Withhold rather
    // than broadcast; a dropped event is cheap, a leaked one is not.
    if (!eventScope) return;

    const frame = `data: ${JSON.stringify(event)}\n\n`;
    for (const sub of [...this.subscribers]) {
      if (sub.scope.projectId !== eventScope.projectId) continue;
      try {
        if (sub.res.writableEnded) { this.subscribers.delete(sub); continue; }
        sub.res.write(frame);
      } catch { this.subscribers.delete(sub); }
    }
  }

  static instance = new ObservationStream();
}
