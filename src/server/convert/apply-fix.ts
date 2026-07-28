// SPDX-License-Identifier: Apache-2.0
//
// One-click remediation for a fixable destination gap.
//
// The Go Team wizard unlocks Next only when every fitness check is green, and
// pgvector is absent from essentially every fresh Postgres a team would bring.
// Without a way to install it from the UI the wizard deadlocked on its own
// normal path: the spec's "one-click fix" was never built, leaving only the
// instruct-only fallback meant for databases we lack permission on.
//
// Deliberately narrow: this applies a single known-safe, idempotent DDL
// statement. It is reached only from the owner-gated convert routes, and only
// for a gap the probe already confirmed is both available and permitted.

export interface ApplyFixDeps {
  runQuery: (url: string, sql: string) => Promise<{ rows: Array<Record<string, unknown>> }>;
}

export interface ApplyFixResult {
  ok: boolean;
  error?: string;
}

export async function applyPgvectorFix(url: string, deps: ApplyFixDeps): Promise<ApplyFixResult> {
  try {
    // IF NOT EXISTS keeps this safe to re-run — the wizard is resumable, and a
    // user may click fix after another path already installed the extension.
    await deps.runQuery(url, 'CREATE EXTENSION IF NOT EXISTS vector');
    return { ok: true };
  } catch (e) {
    // Surface the database's own message. "permission denied to create
    // extension" is the actionable case a DBA needs to see verbatim.
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
