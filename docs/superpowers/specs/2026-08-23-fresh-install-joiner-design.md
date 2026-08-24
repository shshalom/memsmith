# Fresh-install joiner path — design

**Status:** built 2026-08-23 — verified locally, NOT yet verified against the live AWS team
**Branch:** `joiner-fresh-install`

## Build result

All five items implemented. Full suite: 2990 pass / 10 fail, and the failing
list is byte-identical to the branch-point baseline — zero regressions.

Verified against a real git clone (`/tmp/joiner-origin` → `/tmp/joiner-clone`,
isolated `MEMSMITH_DATA_DIR`):

| Step | Result |
|---|---|
| Before convert | marker does not ship |
| After convert | `git add -A` stages the marker; `credentials.json` and `.bak` stay out |
| Clone, no key | state `tracked`, runtime **local**, Join button shown |
| Notice | names project + server, states capture is local until join |
| After join | state `joined`, runtime `server`, Join button hidden |
| Dogfood | `credentials.json` sha256 unchanged (`7eee46d2…`) |

Still unproven, and only provable against the live team server: that a tracked
clone's observations actually land locally during a real session, and that the
pre-join sync prompt behaves correctly on join.

## Problem

A teammate clones a repo whose project has been converted to team mode, installs
MemSmith, and expects it to recognize the existing project identity and let them
join. Today none of that happens:

1. `<project>/.memsmith/` is gitignored (`.gitignore:59`), so the clone receives
   **no marker at all** and mints a fresh, unrelated local identity.
2. `install.ts` (1,922 lines) contains zero references to the marker. It never
   looks for an existing identity.
3. If a marker *were* present with `runtime: "server"`, `selectRuntime`
   (`runtime-selector.ts:53`) would flip the clone to team mode immediately.
   With no key in `CredentialStore`, every hook then logs
   `[server-fallback] reason=missing_api_key` and **silently drops
   observations** — the dark-capture failure this codebase treats as its worst.
4. The dashboard Join button gates on `resolveRuntime(projectId)`, which reads
   the **local** Postgres. A fresh clone has no row there, so runtime resolves
   `'local'` and the button never appears — invisible on precisely the machine
   that needs it.

## Product rule

From the product owner, verbatim:

> Identity is per project unless identity already exists — otherwise how does a
> user suppose to join a project. If identity exists and the user didn't join,
> then the work is offline / local. That also is how we can promote the join
> button — by knowing that the project is tracked. So while the user is not
> joined the observations will be local, until he joins. Minting identity is
> when one does not exist.

This completes, rather than overturns, the July decision at `8f6f37ad` which
gitignored the marker on the reasoning that each checkout "recognizes or mints
its own." Only *mint* was ever built. Its stated `env>marker>mint` precedence
does not exist — `project-identity.ts` reads no environment variable. This
design builds the missing *recognize* half.

## What already works (verified, do not rebuild)

- **Marker adoption.** `ensureProjectIdentity` (`project-identity.ts:231`) reads
  the marker and adopts `teamId`/`projectId` when present; it mints only when
  `existing` is null.
- **Team re-point on join.** `repointProjectDatabaseTeam`
  (`repoint-local-key.ts:61`) detaches children, moves `projects.team_id`, and
  re-attaches, in one transaction — handling all six composite FKs to
  `projects(id, team_id)` (`schema.ts:287,302,351,370,405,422`). It discovers
  present tables via `information_schema` rather than assuming them.
- **Marker adopts the joined team.** `applyConvertJoin:96` passes
  `teamId: join.teamId` to `writeProjectRuntime`, because `buildServerContext`
  resolves the credential by the *marker's* `teamId`.
- **Write-side key guard.** `applyConvertJoin:36` refuses to flip a marker to
  server mode without a resolvable key.
- **HTTPS join.** `join-service.ts:114` dual-accepts an HTTPS URL via
  `isHttpUrl`. The `JoinTeamModal` field labelled "Database URL" already accepts
  an HTTPS endpoint; the label is inaccurate, not the code.

## Design

### Core abstraction

One predicate, derived from two facts already on disk, consumed everywhere:

```
readProjectMarker(cwd) ─┐
                        ├─► projectJoinState() ─► 'untracked' | 'tracked' | 'joined'
CredentialStore ────────┘
```

| State | Meaning | Runtime |
|---|---|---|
| `untracked` | no marker, or marker without `runtime: 'server'` | per settings (local) |
| `tracked` | marker says server, **no key** for its `teamId` | **local** |
| `joined` | marker says server, key present | server |

`tracked` is the new state. It is what a fresh clone is, and what makes the Join
button meaningful.

### Components

**1. `projectJoinState` — new: `src/services/identity/join-state.ts`**

Pure function over a marker and a key lookup, both injected. No I/O of its own,
so all four states are directly testable.

**2. `selectRuntime` gate — modify `runtime-selector.ts:53`**

```ts
if (marker?.runtime === 'server') {
  return hasKeyFor(marker.teamId) ? 'server' : 'local';
}
```

This is the data-loss fix: the read side now enforces the same invariant
`applyConvertJoin:36` enforces on the write side.

**Call-site audit — completed, no change needed.** `mcp-server.ts:76` and `:768`
call `selectRuntime()` with no cwd, which was flagged as a possible
wrong-project read. Verified otherwise: the MCP server is spawned per project by
the IDE with inherited cwd (`plugin/.mcp.json` launcher computes
`const d=process.cwd()` and spawns with `stdio:'inherit'`), so `process.cwd()`
*is* the project directory. `buildServerContext()` on the adjacent line already
depends on the same fallback. Both sites are correct as written.

**3. Convert writes the un-ignore rule — modify the convert flow**

Appends to the **converted project's** `.gitignore`, idempotently:

```
.memsmith/*
!.memsmith/project.json
```

Two mechanical requirements:
- Git cannot un-ignore a file inside an ignored *directory*. The existing
  `.memsmith/` line must become `.memsmith/*` for the negation to take effect.
- The sibling `project.json.orphan-*.bak` must stay ignored — hence `*` plus a
  single negation rather than removing the rule.

**MemSmith's own `.gitignore` is not touched.** It is a local project; its
marker holds the dogfood identity
(`projectId 5fc024f0-0994-4f1d-baed-300d9b4d3416`), which must never ship in the
shared repo. Only a project that has actually converted gets the rule, because
only then is the identity genuinely shared.

**4. Install recognition — modify `install.ts`**

When run inside a directory whose state is `tracked`, report the project and
offer to join. Non-interactive runs report and continue without prompting.
Placement of the prompt is provisional; the product owner has deferred exact
button and screen placement to a later pass.

**5. Join button gates on the marker — modify `DashboardView.tsx:113`**

`buildIdentityPayload` (`identity-payload.ts:43`) already computes
`keyPresent: Boolean(store.resolveKeyForTeam(teamId))`. Combined with the
existing `runtime` field this is the whole predicate, so the endpoint change is
near-zero:

```ts
canJoinFromIdentity  ->  isTeam && !keyPresent
```

This also drops the `role !== 'owner'` proxy. An owner holds the key, so
`keyPresent` is true and no button renders — excluded by the actual reason
rather than by inferring intent from a role that resolves `null` in exactly the
new-member case.

### Error handling

**Every failure path resolves `local`.** Unreadable marker, unreadable
credential store, missing key — all fall to local, which captures to the local
database and loses nothing. The failure this design refuses is the inverse:
server mode with no credential, which drops observations silently.

`.gitignore` writing is best-effort. Convert has already succeeded by then, so a
write failure must not be reported as a failed convert; it emits the manual
`git add -f .memsmith/project.json` instruction instead.

### Risk accepted

`selectRuntime` has 8+ call sites, including the runtime boot path
(`ServerService.ts:589`) and the capture gate (`observation.ts:150`). Adding a
credential read widens its blast radius: a bug there affects capture everywhere,
not just clones. It remains the correct location — it is the single choke point
where "marker says server" becomes "actually server" — and the fail-to-local
rule bounds the damage. `CredentialStore` reads are lock-free and atomic
(`credential-store.ts:67`), so the added cost is one small file read.

## Testing

Unit:
- `projectJoinState` — all four states.
- `selectRuntime` — **a `tracked` clone resolves `local` even though its marker
  says `server`.** This is the regression that matters most.
- `.gitignore` writer — idempotent; does not disturb the `.bak` sibling.
- `canJoinFromIdentity` — button shows for `tracked`, hides for `joined` and
  `untracked`.

End-to-end (the actual proof, run manually against the live AWS team):
1. Clone a converted project into a fresh directory with an empty
   `CredentialStore`.
2. Confirm the marker is present and capture goes **local** — no
   `missing_api_key` in the log, no dropped observations.
3. Confirm the Join button appears.
4. Join with a team key; confirm the flip to server mode and that the pre-join
   local observations are handled per the sync prompt.

Unit tests cannot prove items 2 and 4. This session has repeatedly produced code
that typechecked, passed tests, and was still wrong (the import that re-homed
rows, the wrong pool, the destination key overwriting the project's key), so the
e2e run is a required gate, not a nicety.

## Out of scope

- Exact placement and visual design of the Join button and install prompt —
  deferred by the product owner to a later pass.
- Pre-join observation sync mechanics. The plumbing exists
  (`repointProjectDatabaseTeam`); the remaining work is the prompt and the
  decision it encodes. Prior decision on record: silent auto-join when the
  machine already holds a cached key, prompt when it is a new clone.
- Relabelling the `JoinTeamModal` "Database URL" field, which accepts HTTPS
  today.
- The dogfood project (`5fc024f0-0994-4f1d-baed-300d9b4d3416`) is not touched by
  any part of this work.
