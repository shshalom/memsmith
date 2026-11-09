// SPDX-License-Identifier: Apache-2.0
//
// Deliver events that capture had to buffer while the server was unreachable.
//
// A spool nobody drains is just a slower way to lose data, so this is the other
// half of capture-spool.ts: on session start, replay whatever was buffered.
//
// THE ORDERING RULE IS LOAD-BEARING: the spool is cleared only AFTER every event
// is delivered. Clearing first, or clearing on partial success, would destroy
// exactly the events this mechanism exists to protect. When in doubt the spool is
// KEPT and replayed next session — delivery is idempotent by source id, so a
// duplicate is harmless while a deletion is permanent.

export interface FlushDeps {
  read: () => unknown[];
  send: (event: unknown) => Promise<void>;
  clear: () => void;
  /** Attribution for events spooled before this project's identity existed. */
  projectId?: string | null;
}

export async function flushSpooledEvents(
  deps: FlushDeps,
): Promise<{ delivered: number; failed: number }> {
  let events: unknown[];
  try {
    events = deps.read();
  } catch {
    // A bad spool must not break session start.
    return { delivered: 0, failed: 0 };
  }
  if (events.length === 0) return { delivered: 0, failed: 0 };

  let delivered = 0;
  let failed = 0;

  for (const raw of events) {
    try {
      // Cold-boot drops carry projectId null — the marker did not exist yet.
      // On replay the project IS known, so the event can finally be attributed
      // rather than discarded as unroutable.
      const event = (raw && typeof raw === 'object')
        ? { ...(raw as Record<string, unknown>),
            projectId: (raw as { projectId?: unknown }).projectId ?? deps.projectId ?? null }
        : raw;
      await deps.send(event);
      delivered += 1;
    } catch {
      failed += 1;
    }
  }

  // Only clear when EVERYTHING landed. A partial clear loses the remainder.
  if (failed === 0) {
    try {
      deps.clear();
    } catch {
      // A spool that cannot be cleared is replayed next session; delivery is
      // idempotent, so duplicates are preferable to loss.
    }
  }

  return { delivered, failed };
}
