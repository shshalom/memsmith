# Team-Mode E2E Proof Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans for the CODE tasks (1–5). Tasks 6–9 are LIVE, INTERACTIVE proofs driven by the controller + user together (NOT subagent work). Steps use checkbox (`- [ ]`) syntax.

**Goal:** A repeatable, one-command local rig that proves team mode e2e (better-auth session, two-identity attribution, wizard Convert-flip) against a throwaway Docker pgvector Postgres — with an enforced guarantee the dogfood is never touched. This is the go/no-go gate before AWS/Cognito.

**Architecture:** A shared preflight safety guard + rig bring-up/teardown scripts + a read-only snapshot/re-scope importer, then four live proofs. Code tasks (1–5) are TDD + committed; proof tasks (6–9) are executed live and recorded.

**Tech Stack:** TypeScript/Node (`.mjs` scripts), `pg` module, `pg_dump` (`~/.memsmith/pg-binaries/bin/pg_dump`), Colima + Docker Compose (pgvector/pgvector:pg17), better-auth, `bun test`.

## Global Constraints

- **Never commit to `main`;** branch `team-mode-e2e-proof` (created; spec @ `519a589d`). Rollback point: `main` @ `257c6cf5`. `--no-ff` merge w/ rollback SHA. Nothing pushed.
- **Commit trailer:** `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- **DOGFOOD ISOLATION (binding on every task):** dogfood = `~/.memsmith`, embedded PG `:55433`, HTTP `:38879`, `local` settings, ~4030 obs, identity team `ab8e1f17-020e-4794-bae3-e59885e7df05` / project `5fc024f0-0994-4f1d-baed-300d9b4d3416`. Only ever READ (via `pg_dump`), never written/converted/killed. Every rig script calls the preflight guard first.
- **Interactive steps are the USER's:** the user `!`-launches servers (mise shim blocks agent-launched bun servers), performs the browser better-auth login, creates the temp project + runs `npx memsmith` setup. The controller verifies state (curl / `pg` reads) and drives automatable scripts.
- **Test runner:** `bun test <path>`. Known-benign TS editor diagnostics (`bun:test`, `.mjs`/`.js` resolution) are false-positives. 5 pre-existing `tests/server/` failures are environmental (`ECONNREFUSED :55432`) — not this branch's concern.
- **Reuse:** `pg` module, `pg_dump`, existing convert engine, existing `/v1/*` routes.

---

### Task 1: Isolation preflight guard

**Files:**
- Create: `scripts/rig/preflight.mjs`
- Test: `tests/scripts/rig/preflight.test.ts`

**Interfaces:**
- Produces: `export function assertRigSafe({ dataDir, dbUrl, httpPort }): void` — throws (loud) if the target is the dogfood; returns void if safe. Plus a pure `export function checkRigSafe({ dataDir, dbUrl, httpPort }): { safe: boolean; reason?: string }` that `assertRigSafe` wraps (so tests assert the pure result without catching throws).

- [ ] **Step 1: Write the failing test**

```ts
// tests/scripts/rig/preflight.test.ts
import { describe, it, expect } from 'bun:test';
import { checkRigSafe } from '../../../scripts/rig/preflight.mjs';
import { homedir } from 'os';
import { join } from 'path';

const DOGFOOD_DATA = join(homedir(), '.memsmith');
const OK = { dataDir: '/tmp/ms-team-server', dbUrl: 'postgres://memsmith:pw@127.0.0.1:55440/memsmith', httpPort: 38890 };

describe('checkRigSafe', () => {
  it('rejects the dogfood data dir', () => {
    const r = checkRigSafe({ ...OK, dataDir: DOGFOOD_DATA });
    expect(r.safe).toBe(false);
    expect(r.reason).toMatch(/data dir/i);
  });
  it('rejects the dogfood data dir with a trailing slash', () => {
    expect(checkRigSafe({ ...OK, dataDir: DOGFOOD_DATA + '/' }).safe).toBe(false);
  });
  it('rejects the dogfood embedded PG port 55433', () => {
    const r = checkRigSafe({ ...OK, dbUrl: 'postgres://memsmith:memsmith-local@127.0.0.1:55433/postgres' });
    expect(r.safe).toBe(false);
    expect(r.reason).toMatch(/55433/);
  });
  it('rejects the dogfood HTTP port 38879', () => {
    const r = checkRigSafe({ ...OK, httpPort: 38879 });
    expect(r.safe).toBe(false);
    expect(r.reason).toMatch(/38879/);
  });
  it('accepts a clean /tmp + :55440 + :38890 target', () => {
    expect(checkRigSafe(OK)).toEqual({ safe: true });
  });
});
```

- [ ] **Step 2: Run test to verify it FAILS**

Run: `bun test tests/scripts/rig/preflight.test.ts`
Expected: FAIL — module `scripts/rig/preflight.mjs` does not exist.

- [ ] **Step 3: Write the guard**

```js
// scripts/rig/preflight.mjs
// SPDX-License-Identifier: Apache-2.0
// Dogfood-isolation guard for the team-mode rig. Refuses any run that would
// target the dogfood data dir (~/.memsmith), embedded PG (:55433), or HTTP
// port (:38879). checkRigSafe is pure; assertRigSafe throws on unsafe.
import { homedir } from 'os';
import { resolve, join } from 'path';

const DOGFOOD_DATA_DIR = resolve(join(homedir(), '.memsmith'));

export function checkRigSafe({ dataDir, dbUrl, httpPort }) {
  if (dataDir != null && resolve(String(dataDir)) === DOGFOOD_DATA_DIR) {
    return { safe: false, reason: `refusing: data dir resolves to the dogfood data dir (${DOGFOOD_DATA_DIR})` };
  }
  if (dbUrl != null && /:55433(\/|$|\?)/.test(String(dbUrl))) {
    return { safe: false, reason: 'refusing: DB URL targets the dogfood embedded PG (:55433)' };
  }
  if (httpPort != null && Number(httpPort) === 38879) {
    return { safe: false, reason: 'refusing: HTTP port is the dogfood server port (:38879)' };
  }
  return { safe: true };
}

export function assertRigSafe(input) {
  const r = checkRigSafe(input);
  if (!r.safe) {
    console.error(`[rig-preflight] ${r.reason}`);
    throw new Error(r.reason);
  }
}

if (import.meta.main) {
  // CLI usage: node preflight.mjs --data-dir X --db-url Y --http-port Z
  const arg = (k) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : undefined; };
  try {
    assertRigSafe({ dataDir: arg('--data-dir'), dbUrl: arg('--db-url'), httpPort: arg('--http-port') });
    console.log('[rig-preflight] OK — target is not the dogfood.');
  } catch { process.exit(1); }
}
```

- [ ] **Step 4: Run test to verify it PASSES**

Run: `bun test tests/scripts/rig/preflight.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/rig/preflight.mjs tests/scripts/rig/preflight.test.ts
git commit -m "feat(rig): dogfood-isolation preflight guard (refuse ~/.memsmith / :55433 / :38879)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: pgvector compose fix

**Files:**
- Modify: `docker-compose.yml` (line 56)

**Interfaces:** none (infra config).

- [ ] **Step 1: Change the image**

In `docker-compose.yml`, the `postgres` service (line 56): change
`image: postgres:17-alpine` → `image: pgvector/pgvector:pg17`.
Leave everything else (env, ports, volume) unchanged.

- [ ] **Step 2: Sanity-check the compose file parses**

Run: `docker compose -f docker-compose.yml config >/dev/null && echo "compose OK"` (if Colima/Docker is down this may warn about the daemon; the `config` subcommand validates YAML without a running daemon — if it errors on daemon, fall back to a YAML lint: `bunx js-yaml docker-compose.yml >/dev/null` or a `python3 -c "import yaml,sys; yaml.safe_load(open('docker-compose.yml'))"`).
Expected: no parse error.

- [ ] **Step 3: Commit**

```bash
git add docker-compose.yml
git commit -m "fix(compose): use pgvector/pgvector:pg17 so CREATE EXTENSION vector succeeds

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Snapshot + re-scope importer (the transform)

**Files:**
- Create: `scripts/rig/snapshot-and-rescope.mjs`
- Test: `tests/scripts/rig/rescope.test.ts`

**Interfaces:**
- Produces: `export function rescopeRow(row, target): row` — returns a copy of an observation row with `team_id`/`project_id` replaced by `target.teamId`/`target.projectId` (all other fields untouched). Plus `export function rescopeRows(rows, target): rows[]`.
- The live dump/restore (`pg_dump` read-only from dogfood → import into target) lives in `main()` behind `import.meta.main`, using the pure `rescope*` for the identity rewrite. Tested via the pure transform only (no live DB in unit test).

- [ ] **Step 1: Write the failing test**

```ts
// tests/scripts/rig/rescope.test.ts
import { describe, it, expect } from 'bun:test';
import { rescopeRow, rescopeRows } from '../../../scripts/rig/snapshot-and-rescope.mjs';

const DOGFOOD = { team_id: 'ab8e1f17-020e-4794-bae3-e59885e7df05', project_id: '5fc024f0-0994-4f1d-baed-300d9b4d3416' };
const TARGET = { teamId: 'temp-team-uuid', projectId: 'temp-proj-uuid' };

describe('rescopeRow', () => {
  it('rewrites team_id and project_id to the target identity', () => {
    const out = rescopeRow({ ...DOGFOOD, id: 'o1', content: 'hi', kind: 'observation' }, TARGET);
    expect(out.team_id).toBe('temp-team-uuid');
    expect(out.project_id).toBe('temp-proj-uuid');
  });
  it('never leaves the source (dogfood) identity on the row', () => {
    const out = rescopeRow({ ...DOGFOOD, id: 'o1', content: 'hi' }, TARGET);
    expect(out.team_id).not.toBe(DOGFOOD.team_id);
    expect(out.project_id).not.toBe(DOGFOOD.project_id);
  });
  it('preserves all other fields (content, kind, id, metadata)', () => {
    const src = { ...DOGFOOD, id: 'o1', content: 'decision X', kind: 'user_note', metadata: { a: 1 } };
    const out = rescopeRow(src, TARGET);
    expect(out.id).toBe('o1'); expect(out.content).toBe('decision X');
    expect(out.kind).toBe('user_note'); expect(out.metadata).toEqual({ a: 1 });
  });
  it('rescopeRows maps every row', () => {
    const out = rescopeRows([{ ...DOGFOOD, id: 'a' }, { ...DOGFOOD, id: 'b' }], TARGET);
    expect(out.every(r => r.team_id === 'temp-team-uuid' && r.project_id === 'temp-proj-uuid')).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it FAILS**

Run: `bun test tests/scripts/rig/rescope.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Write the importer**

```js
// scripts/rig/snapshot-and-rescope.mjs
// SPDX-License-Identifier: Apache-2.0
// Read-only snapshot of dogfood observations + re-scoped import into a target
// store under a FRESH (temp) identity, so copied content carries a throwaway
// identity — never the dogfood's. Dogfood is opened READ-ONLY (pg_dump / SELECT).
// The pure rescope* transforms are unit-tested; the live dump/import is in main().
import pg from 'pg';
import { assertRigSafe } from './preflight.mjs';

export function rescopeRow(row, target) {
  return { ...row, team_id: target.teamId, project_id: target.projectId };
}
export function rescopeRows(rows, target) {
  return rows.map((r) => rescopeRow(r, target));
}

async function main() {
  // Env: SOURCE_PG_URL (dogfood, read-only), TARGET_PG_URL, TARGET_TEAM_ID, TARGET_PROJECT_ID,
  //      TARGET_DATA_DIR (for the preflight assertion on the target).
  const sourceUrl = process.env.SOURCE_PG_URL || 'postgres://memsmith:memsmith-local@127.0.0.1:55433/postgres';
  const targetUrl = process.env.TARGET_PG_URL;
  const target = { teamId: process.env.TARGET_TEAM_ID, projectId: process.env.TARGET_PROJECT_ID };
  if (!targetUrl || !target.teamId || !target.projectId) {
    console.error('[snapshot] TARGET_PG_URL, TARGET_TEAM_ID, TARGET_PROJECT_ID are required');
    process.exit(1);
  }
  // Guard: the TARGET must not be the dogfood; the SOURCE is expected to BE the dogfood (read-only), so we only guard the target.
  assertRigSafe({ dataDir: process.env.TARGET_DATA_DIR, dbUrl: targetUrl, httpPort: undefined });
  if (target.teamId === 'ab8e1f17-020e-4794-bae3-e59885e7df05' || target.projectId === '5fc024f0-0994-4f1d-baed-300d9b4d3416') {
    console.error('[snapshot] refusing: target identity equals the dogfood identity');
    process.exit(1);
  }

  const src = new pg.Client({ connectionString: sourceUrl });
  const dst = new pg.Client({ connectionString: targetUrl });
  await src.connect(); await dst.connect();
  try {
    // READ-ONLY select from dogfood.
    const rows = (await src.query(
      `SELECT id, team_id, project_id, kind, content, metadata, obs_type, lifecycle_state FROM observations`,
    )).rows;
    const rescoped = rescopeRows(rows, target);
    let inserted = 0;
    await dst.query('BEGIN');
    try {
      for (const r of rescoped) {
        const res = await dst.query(
          `INSERT INTO observations (id, team_id, project_id, kind, content, metadata, obs_type, lifecycle_state)
             VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,COALESCE($8,'open'))
             ON CONFLICT (id) DO NOTHING`,
          [r.id, r.team_id, r.project_id, r.kind, r.content, JSON.stringify(r.metadata ?? {}), r.obs_type ?? null, r.lifecycle_state ?? null],
        );
        inserted += res.rowCount ?? 0;
      }
      await dst.query('COMMIT');
    } catch (e) { await dst.query('ROLLBACK'); throw e; }
    // Differentiation assertion: every imported row carries the TARGET identity.
    const bad = (await dst.query(
      `SELECT count(*)::int AS n FROM observations WHERE team_id = $1 OR project_id = $2`,
      ['ab8e1f17-020e-4794-bae3-e59885e7df05', '5fc024f0-0994-4f1d-baed-300d9b4d3416'],
    )).rows[0].n;
    console.log(`[snapshot] imported ${inserted} rows re-scoped to team=${target.teamId} project=${target.projectId}; dogfood-identity rows in target: ${bad}`);
    if (bad > 0) { console.error('[snapshot] FAIL: target holds dogfood-identity rows'); process.exit(1); }
  } finally { await src.end(); await dst.end(); }
}

if (import.meta.main) {
  main().catch((e) => { console.error('[snapshot] ERROR', e.message); process.exit(1); });
}
```

- [ ] **Step 4: Run test to verify it PASSES**

Run: `bun test tests/scripts/rig/rescope.test.ts`
Expected: PASS (4 tests). The `import.meta.main` guard ensures importing for the test does not connect to a DB.

- [ ] **Step 5: Commit**

```bash
git add scripts/rig/snapshot-and-rescope.mjs tests/scripts/rig/rescope.test.ts
git commit -m "feat(rig): read-only dogfood snapshot + re-scoped import to a fresh identity

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Rig bring-up / teardown scripts

**Files:**
- Create: `scripts/rig/team-up.sh`, `scripts/rig/team-down.sh`
- Create: `scripts/rig/README.md` (the run order + the exact `!`-launch commands the user runs)

**Interfaces:** shell scripts; call `node scripts/rig/preflight.mjs` first.

- [ ] **Step 1: Write `team-up.sh`**

```bash
#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Bring up the throwaway team-mode rig (Colima + Docker pgvector PG). Prints the
# exact command for the USER to !-launch the team server (agent can't; mise shim).
# Dogfood is never targeted — preflight enforces it.
set -euo pipefail

RIG_DATA_DIR="${RIG_DATA_DIR:-/tmp/ms-team-server}"
RIG_PG_PORT="${RIG_PG_PORT:-55440}"
RIG_HTTP_PORT="${RIG_HTTP_PORT:-38890}"
RIG_PG_USER="${RIG_PG_USER:-memsmith}"
RIG_PG_PASSWORD="${RIG_PG_PASSWORD:-rig-throwaway}"
RIG_PG_DB="${RIG_PG_DB:-memsmith}"
RIG_DB_URL="postgres://${RIG_PG_USER}:${RIG_PG_PASSWORD}@127.0.0.1:${RIG_PG_PORT}/${RIG_PG_DB}"

# Hard preflight — refuse if this would touch the dogfood.
node "$(dirname "$0")/preflight.mjs" --data-dir "$RIG_DATA_DIR" --db-url "$RIG_DB_URL" --http-port "$RIG_HTTP_PORT"

# Colima up (idempotent).
if ! colima status >/dev/null 2>&1; then colima start; fi

# Bring up ONLY the pgvector postgres service on the throwaway port.
POSTGRES_USER="$RIG_PG_USER" POSTGRES_PASSWORD="$RIG_PG_PASSWORD" POSTGRES_DB="$RIG_PG_DB" \
  docker compose up -d postgres

echo "[team-up] waiting for postgres on :${RIG_PG_PORT} ..."
# (health-check loop via pg_isready or a `pg` ping — see README; kept short here.)

cat <<EOF

[team-up] Docker pgvector PG is up on :${RIG_PG_PORT} (throwaway).
Next — YOU (!-launch, the agent can't due to the mise shim) start the team server:

  ! MEMSMITH_RUNTIME=server \\
    MEMSMITH_SERVER_DATABASE_URL="${RIG_DB_URL}" \\
    MEMSMITH_IDENTITY_PROVIDER=better-auth \\
    MEMSMITH_QUEUE_ENGINE=inline \\
    MEMSMITH_DATA_DIR="${RIG_DATA_DIR}" \\
    MEMSMITH_SERVER_PORT=${RIG_HTTP_PORT} \\
    npx memsmith server start

Dogfood untouched: still local on :38879 / :55433 / ~/.memsmith.
EOF
```

- [ ] **Step 2: Write `team-down.sh`**

```bash
#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Tear down the throwaway rig. Drops the Docker PG + volume. Prints the team
# server PID for the USER to stop it. Dogfood untouched.
set -euo pipefail
RIG_DATA_DIR="${RIG_DATA_DIR:-/tmp/ms-team-server}"

docker compose down -v || true   # -v drops the throwaway volume
PIDFILE="${RIG_DATA_DIR}/.server-beta.pid"
if [ -f "$PIDFILE" ]; then
  echo "[team-down] team server PID: $(cat "$PIDFILE") — stop it with:  ! kill $(cat "$PIDFILE")"
else
  echo "[team-down] no team-server pid file under ${RIG_DATA_DIR} (already stopped?)"
fi
echo "[team-down] Docker PG + volume dropped. Dogfood was never touched."
```

- [ ] **Step 3: Make executable + write README**

```bash
chmod +x scripts/rig/team-up.sh scripts/rig/team-down.sh
```
`scripts/rig/README.md` documents: prerequisites (Colima), the full run order (team-up → user `!`-launch → proofs → team-down), the exact env for each `!`-command, and the isolation guarantees.

- [ ] **Step 4: Verify preflight wiring (dry, safe)**

Run: `node scripts/rig/preflight.mjs --data-dir ~/.memsmith --db-url postgres://x@127.0.0.1:55433/y --http-port 38879; echo "exit=$?"`
Expected: prints refusal, `exit=1`. Then: `node scripts/rig/preflight.mjs --data-dir /tmp/ms-team-server --db-url postgres://x@127.0.0.1:55440/y --http-port 38890; echo "exit=$?"` → `OK`, `exit=0`.

- [ ] **Step 5: Commit**

```bash
git add scripts/rig/team-up.sh scripts/rig/team-down.sh scripts/rig/README.md
git commit -m "feat(rig): team-up/team-down scripts (preflight-guarded, throwaway PG, !-launch handoff)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Code gate (typecheck + rig unit tests)

**Files:** none (verification).

- [ ] **Step 1: Typecheck**

Run: `bunx tsc --noEmit -p tsconfig.json`
Expected: no errors.

- [ ] **Step 2: Rig unit tests**

Run: `bun test tests/scripts/rig/`
Expected: preflight (5) + rescope (4) green.

- [ ] **Step 3: No regression in the broader suite**

Run: `bun test tests/server/`
Expected: green modulo the known 5 `:55432` env failures. No new failures.

- [ ] **Step 4: No commit** — gate only.

---

## LIVE PROOF PHASE (Tasks 6–9) — controller + user, NOT subagents

> These are executed interactively. The controller drives automatable verification (curl / `pg` reads / script runs); the USER performs `!`-launches, the browser login, and creates the temp project. Each proof's outcome is recorded HONESTLY (pass / partial / blocked) to memory. Do NOT dispatch subagents for these.

### Task 6: Bring up the rig (P4 foundation)

- [ ] Controller runs `scripts/rig/team-up.sh` (preflight guards it).
- [ ] Controller confirms Docker pgvector PG reachable on the throwaway port and `CREATE EXTENSION vector` succeeds (via a `pg` ping — proves Task 2's fix live).
- [ ] USER `!`-launches the team server with the printed env. Controller confirms it booted (HTTP health on the rig port, schema bootstrapped).
- [ ] **Checkpoint:** dogfood still `local`, `:38879` still up, obs count unchanged (controller asserts).

### Task 7: P2 — two-identity attribution + role gating (automatable)

- [ ] Controller mints/prepares two identities (owner + a second member; and a viewer key) via `/v1/keys` + `/v1/members` against the rig server.
- [ ] Identity A writes an observation via `/v1/memories`; controller verifies the stored row has `createdByUserId = A`.
- [ ] Identity B reads it via `/v1/search`; controller verifies B sees the row and its attribution shows A.
- [ ] Controller verifies role gating end-to-end on the real store: viewer key → `POST /v1/memories` 403; member → key-mint `POST /v1/keys` 403; member → project purge 403; owner/admin → allowed. (Exercises the C4 + ownership + authorization-finish work against a real remote PG.)
- [ ] Record P2 result.

### Task 8: P1 — better-auth browser session → Principal (interactive)

- [ ] USER opens the team server's better-auth login in a browser and authenticates (create account / sign in).
- [ ] Controller verifies the established session resolves to a `Principal` with a `userId` (via an authenticated call that echoes the resolved principal, or a `pg` read of the better-auth session store + a scoped `/v1/*` call succeeding under that session).
- [ ] Record P1 result (pass / partial if the login surface needs work).

### Task 9: P3 — wizard Convert-flip on a fresh-identity temp project (mixed)

- [ ] USER creates an empty temp project directory, runs a Claude session there, runs `npx memsmith` setup (mints a FRESH identity).
- [ ] USER tells the controller the temp project path. Controller reads its marker/identity and **asserts team/project UUIDs ≠ dogfood** (halt if equal).
- [ ] Controller runs `scripts/rig/snapshot-and-rescope.mjs` with the temp project's identity as target → seeds the temp embedded PG with re-scoped real content; the script's own assertion confirms zero dogfood-identity rows landed.
- [ ] USER drives the Go Team wizard on the temp project (destination = the rig's Docker PG): copy → verify → flip.
- [ ] Controller verifies: the flip wrote the **temp project's** `<temp>/settings.json` (NOT `~/.memsmith/settings.json`); the copy counts match; the temp store now points at the Docker PG. Dogfood settings still `local`.
- [ ] Record P3 result.

### Task 10: Teardown + record the gate

- [ ] Controller runs `scripts/rig/team-down.sh`; USER `!`-stops the team server via the printed PID.
- [ ] Controller asserts the dogfood is verifiably untouched: settings still `local`, obs count intact (~4030), `:38879` still serving.
- [ ] Record to memory: each proof's pass/partial/blocked status, anything the real remote surfaced, and — if P1–P4 all pass — the explicit go-ahead for the AWS/Cognito phase.

---

## Self-Review

**Spec coverage:**
- pgvector fix → Task 2. Preflight guard → Task 1. Snapshot/re-scope → Task 3. Rig scripts → Task 4. Code gate → Task 5. ✅
- P1/P2/P3/P4 → Tasks 8/7/9/6 (+10 teardown). ✅
- Isolation contract → Task 1 (guard) + every proof's checkpoint + Task 10 assertion. ✅
- Temp-project differentiation → Task 9 (fresh-identity assertion + re-scope). ✅

**Placeholder scan:** code tasks (1–5) have complete code/tests/commands. Proof tasks (6–10) are checklists by nature (live, interactive) — each step is a concrete action + a concrete verification, not a vague "test it". The one intentional looseness: `team-up.sh`'s health-check loop is described (README) rather than inlined — acceptable for a shell convenience wrapper, and the live proof (Task 6) verifies reachability explicitly.

**Type/interface consistency:** `checkRigSafe`/`assertRigSafe` (Task 1) consumed by `snapshot-and-rescope.mjs` + `team-up.sh` (Tasks 3,4). `rescopeRow`/`rescopeRows` signatures identical in impl + test. Env var names (`RIG_*`, `TARGET_*`, `MEMSMITH_DATA_DIR`) consistent across scripts.

**Interactive/automatable split is explicit** — Tasks 1–5 are subagent-able code; Tasks 6–10 are marked controller+user live work, not subagent dispatch. This is the key structural decision the plan encodes.
