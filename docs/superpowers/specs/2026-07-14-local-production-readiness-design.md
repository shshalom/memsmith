# Local Production Readiness — Design

**Goal:** Bring the `local` runtime to a state the user can **install, use, and test hands-off** — with a **trustworthy test suite** as the gate. No push/release/CI (explicitly out of scope: "install it without pushing or the release noise").

## Context (from Phase-1 systematic debugging)

Running `bun test` shows ~27 failures, which looked alarming. Debugging established the truth: running all 224 test files **each in its own process** yields **exactly 2 real failures**. The other ~25 are **cross-file pollution** — Bun runs the whole suite in one process, and some files leak global state (`mock.module` is process-global and survives restore; singletons like telemetry/settings persist). The code is largely sound; the **suite is the untrustworthy part**, and an untrustworthy gate is itself a production blocker.

Separately, `local` "works only when hand-nursed": every run required manually exporting `MEMSMITH_LOCAL_DEV_TEAM_ID`/`PROJECT_ID` (the dogfood uuids), and the dashboard showed "no data" when they were unset. Root cause (traced): `src/server/runtime/local-runtime.ts:51-52` reads those env vars and **defaults to the literal `'local'`**, while the migrated data lives under the project's durable uuid identity. That env value threads through `ServerService` → dashboard → viewer, so both cold-boot scope and viewer scope mismatch the data.

## Scope

**In (A + B):**
- **A — Trustworthy test suite:** a per-file isolated test runner as the gate + fix the identified leaker(s) so `bun test` is usable day-to-day + fix the 2 genuine failures.
- **B — Hands-off usability:** the local runtime resolves its identity from the project **marker** (`.memsmith/project.json`), not the env-default-`'local'` trap — fixing cold-start auto-boot AND the viewer "no data" together. Verified by a real cold-install → use walkthrough.

**Out:** version bump, `git push`, CI setup, publishing (the "release noise").

---

## Part A — Trustworthy test suite

### A1. Per-file isolated test runner (the gate)
- Add `scripts/test-isolated.cjs` (or `.mjs`): enumerate every `tests/**/*.test.ts(x)`, run each in its **own** `bun test <file>` process, aggregate pass/fail, exit non-zero if any file fails. Print a summary + the list of any failing files.
- Wire it as an npm script, e.g. `"test:ci": "node scripts/test-isolated.cjs"`. This is the **trustworthy gate**.
- Keep the existing `"test": "bun test"` as the **fast (noisy) dev shortcut** — documented as such.
- Proven baseline: this run yields exactly 2 real failures today (which A3/A4 fix → 0).
- Acceptable cost: slower wall-clock (many process starts). That's the price of isolation; the gate correctness is worth it.

### A2. Fix the identified leaker(s) (bounded)
- Bisect to find which test file(s) leak global state into others (candidate: a `mock.module(...)` that isn't restored in `afterAll`, or a mutated process-wide singleton). The known pattern from this session: `runtime-selector.test.ts` mocks `hook-settings`/`logger` process-globally.
- Fix the clear leakers at the source (restore mocks in `afterAll`, reset singletons) so single-process `bun test` gets cleaner.
- **Bounded effort:** fix the leakers found with reasonable bisection; do NOT open-endedly hunt every last one. The per-file gate (A1) is the guarantee; A2 is day-to-day ergonomics. Document any known-remaining leaker.

### A3. Fix `adaptObservation` null-title bug
- `tests/viewer/server-adapter.test.ts`: "missing metadata degrades to empty, never throws" fails — an observation with no metadata yields a non-empty `title` when it should be `null`/`''`.
- Fix `adaptObservation` (in the viewer server-adapter) so a bare observation degrades `title` to `null`/`''`. Test already exists; make it pass.

### A4. Fix the one spawn-env violation
- `src/server/dashboard/spend.ts:75` spawns the `ccusage` child with `env: { ...process.env, ...extraEnv }` — raw `process.env`, which the `spawn-env discipline` guard (`scripts/check-spawn-env-discipline.cjs`) correctly flags.
- Fix: `env: { ...sanitizeEnv(process.env), ...extraEnv }` using `sanitizeEnv` from `src/supervisor/env-sanitizer.ts` (signature `sanitizeEnv(env = process.env)`). Verify the ccusage spawn still works after sanitizing (ccusage needs PATH/HOME, which sanitizeEnv preserves). The guard test then passes honestly.

---

## Part B — Hands-off usability (the linchpin)

### B1. Runtime resolves identity from the marker
- **New precedence for local team/project identity: env (if set) > project marker > mint-new.**
- In `src/server/runtime/local-runtime.ts` (the `defaultRunImport` scope at :51-52 and wherever the runtime hands `localDevTeamId`/`localDevProjectId` to `ServerService`): instead of `process.env.MEMSMITH_LOCAL_DEV_TEAM_ID || 'local'`, resolve via:
  1. If `MEMSMITH_LOCAL_DEV_TEAM_ID`/`PROJECT_ID` env are set → use them (test/override escape hatch).
  2. Else read the project marker `.memsmith/project.json` at `MEMSMITH_PROJECT_CWD ?? cwd` (the same marker `ensureProjectIdentity` writes) → use its `teamId`/`projectId`.
  3. Else mint via `ensureProjectIdentity(pool, cwd)` (which writes the marker) → use the new ids.
- Reuse the existing identity module (`src/services/identity/project-identity.ts`) — do not duplicate marker-reading logic. Extract a small shared resolver if needed (e.g. `resolveLocalScope(cwd, pool)`), so `local-runtime`, `ServerService`, and the dashboard all agree.
- Result: on cold boot with no env, the runtime scopes to the project's **real durable identity** (where the data is) — not `'local'`. Auto-boot "just works," and the viewer (which reads `localDevTeamId` from the same resolution) shows the data.

### B2. Viewer/dashboard scope follows the same resolution
- The dashboard's `localDevTeamId` (`src/server/dashboard/routes.ts:141,158`) and `ServerService`'s (`:189,210,234`) already come from the graph/options; ensure they're populated from B1's resolver (marker-derived), not a separate env read. Once B1 feeds the runtime the marker identity, the viewer inherits it. Confirm no independent env-`'local'` path remains for the viewer scope.

### B3. Cold-install → use walkthrough (the acceptance proof)
- The real bar: from a clean state, the plugin installs and a fresh session boots the runtime auto-scoped to the project, and recall/dashboard show the project's memory — **with zero manual env exports**.
- Verify end-to-end (documented steps): stop all hand-run instances → clear the `MEMSMITH_LOCAL_DEV_*` env → trigger the session-init/SessionStart boot path the plugin actually uses → confirm the server comes up scoped to the marker identity → confirm `/api/observations` (viewer) and `/v1/search` (recall) return the project's data without any manual env. This walkthrough IS the definition of done for B.

---

## Architecture / data flow

No new services. One new concept: a **single local-scope resolver** (`env > marker > mint`) that replaces the scattered `MEMSMITH_LOCAL_DEV_* || 'local'` reads. Runtime boot, server auth-context, and viewer scope all consume it, so identity is consistent from cold boot through recall through the dashboard.

Test infrastructure gains a per-file isolated runner alongside the existing single-process `bun test`.

## Error handling

- **Marker present but PG rows missing** (fresh DB / cloned repo): the resolver mints/upserts via `ensureProjectIdentity` (idempotent) so rows exist — same self-heal already built.
- **No pool available at boot** for minting: fall back to reading the marker for ids without DB writes; if neither env nor marker exists and no pool, fall back to `'local'` (preserves today's behavior as the last resort) and log once.
- **sanitizeEnv breaks ccusage**: if the sanitized env drops something ccusage needs, add it to the preserved set (verify PATH/HOME survive) — do not revert to raw env.
- Per-file runner: a file that crashes (not just fails) is reported as a failure, not silently skipped.

## Testing

- **A1 runner:** a smoke test / self-check that the runner enumerates all test files and its exit code reflects aggregate failures (e.g. it fails when pointed at a deliberately-failing fixture).
- **A3:** the existing `adaptObservation` test passes.
- **A4:** the `spawn-env discipline` guard test passes (0 violations).
- **B1 resolver:** unit test the precedence — env set → env wins; env unset + marker present → marker ids; neither + pool → mints and writes marker. (Fake pool + temp cwd, like the existing identity tests.)
- **B3:** the cold-install walkthrough is a manual/scripted acceptance run (documented), not a unit test — it validates the integrated path.
- **Gate:** `test:ci` (per-file) is GREEN (0 real failures) after A3+A4. `bun test` fail-count materially reduced by A2 (document any residual known leaker).

## Acceptance criteria

1. `node scripts/test-isolated.cjs` (per-file gate) runs every test file isolated and exits 0 — the suite is trustworthy.
2. The 2 genuine failures (`adaptObservation`, `spend.ts` spawn-env) are fixed; guard passes honestly.
3. Known leaker(s) fixed so single-process `bun test` is materially cleaner (residual documented).
4. Local runtime cold-boots (no manual `MEMSMITH_LOCAL_DEV_*` env) auto-scoped to the project marker's identity.
5. The viewer/dashboard and `/v1` recall show the project's data on that cold boot — the "no data" mismatch cannot recur.
6. A documented cold-install → use walkthrough passes hands-off.
7. Nothing pushed; no version bump; no CI/publish.

## Deferred (not this spec)
- Release: version bump, push to origin, CI pipeline, marketplace publish.
- The `/v1` migration of `MEMSMITH_CONTEXT_*` context prefs (separate earlier-deferred follow-on).
- Server/team-mode readiness (the next subsystem after local is usable).
