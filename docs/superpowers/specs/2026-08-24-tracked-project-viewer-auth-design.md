# Viewing a tracked-but-not-joined project — design

**Status:** proposed, NOT approved. Security-sensitive: read the threat model before building.
**Branch:** `joiner-fresh-install`

## Problem

A teammate clones a converted project. The committed marker says
`runtime: "server"`, so the project belongs to a team — but this machine holds
no key for that team yet. That is the `tracked` state the joiner feature is
built on, and the Join button is the affordance for leaving it.

The dashboard cannot display such a project at all:

- The viewer authenticates with a loopback cookie carrying an **API key**
  (`ServerViewerRoutes` → `buildLocalKeyCookie`).
- `authMode` is `api-key` in a real install (verified live on the dogfood
  server), so the `local-dev` bypass branch never runs.
- `resolveViewerKeyForRequest` returns null for a project with no key — correctly,
  since the alternative is handing over a different project's credential.
- With no key there is no `authContext`, so `/v1/identity` cannot report the
  project's runtime and `canJoinFromIdentity` never sees a team project.

Net effect: **the Join button cannot render on the one machine that needs it.**

## Two rejected approaches

**Rejected: a viewer-level special case** ("render marker-only projects
read-only over loopback"). The dashboard would authenticate as one project while
displaying another — the exact view/credential disagreement behind all six
cookie bugs recorded in `tests/server/runtime/viewer-scope-contract.test.ts`.
It also needs a write exception on day one, because Join writes.

**Rejected: deriving the viewed project from the request** (`?project=` decides
scope; the credential only decides permissions). This is a design this project
already rejected on security grounds. `resolve-request-database.ts:3-12` carries
a standing prohibition:

> "It must NEVER read `req.query.projectId`, `req.body.projectId`, headers, or
> any other client-supplied field to choose a database... that would let a
> caller pick another tenant's database and is a cross-tenant data-access
> vulnerability."

Memory records the same decision (`2441d4ef`), with "allowing client-supplied
projectId to influence routing" as the rejected alternative.

## Design

Use the seam the architecture already defines. From the same prohibition
comment:

> "authContext is populated upstream (requirePostgresServerAuth) from a trusted
> source for every auth mode — **including the local-dev bypass, which funnels
> the request-supplied project id INTO authContext** before this middleware ever
> runs."

So the established pattern is: **the auth layer decides what a request may
claim; everything downstream reads `authContext` only.** The fix is a new
trusted branch in `requirePostgresServerAuth`, not a bypass around it.

### The branch

Grant a read-only `authContext` when ALL of these hold:

1. No key resolved (no bearer token, no `x-api-key`, no cookie key)
2. `isLocalhost(req)` — client IP is loopback
3. `hasLoopbackHostHeader(req)` — Host header is loopback
4. `!hasForwardedClientHeaders(req)` — no `forwarded`, `x-forwarded-for`,
   `x-forwarded-host`, `x-real-ip`
5. The request names a project (`?projectId=`), and the path recorded for that
   project in `projects.metadata` holds a marker that **names that same project**
   and says `runtime: 'server'` (or legacy `'server-beta'`)
6. `CredentialStore` holds **no** key for that marker's `teamId`

Resulting context:

```ts
{
  userId: LOCAL_OWNER_USER_ID,
  teamId: marker.teamId,
  projectId: <requested>,
  scopes: ['memories:read'],   // NO memories:write
  apiKeyId: null,
  mode: 'tracked-local-view',
  role: null,
}
```

### Why writes are blocked structurally

Verified in code, and NOT via the role check:

- `baseWrite = requirePostgresServerAuth(..., { requiredScopes: ['memories:write'] })`
  (`ServerV1PostgresRoutes.ts:236`). Omitting that scope fails every write route
  before any handler runs.
- **`requireWriteRole` would NOT block it.** `postgres-auth.ts` treats
  `role == null` as *allowed* (`const allow = role == null || roleSatisfies(role, 'member')`).
  An earlier draft of this design claimed `role: null` made it read-only; that
  was wrong. The scope list is the enforcement; the role is irrelevant here.

### Why Join still works

Joining writes **local** state — caches a key in `CredentialStore`, flips the
marker, re-points local rows. It does not require team write scope. The join
route's own guards are unchanged by this design.

## Threat model

**What this grants:** an unauthenticated loopback request can READ one project's
memories — specifically a project whose marker is physically present in a
directory on this machine and which this machine cannot otherwise open.

**Why each condition matters:**

| Condition | Removes |
|---|---|
| loopback IP + Host, no forwarded headers | remote and proxied callers |
| no key present | any interaction with authenticated flows |
| marker on local disk names the project | arbitrary project ids; the caller cannot invent a target |
| marker says `runtime: server` | local projects (they already have keys) |
| no key for that team | anything already reachable |

**No escalation surface:** the only projects reachable are ones whose marker is
already on this filesystem. An attacker who can write a marker into a directory
on your machine already has local file write, which is strictly more powerful.

**Honest cost, stated plainly:** this widens what an unauthenticated loopback
request can read, and unlike the existing local-dev bypass — gated behind
`MEMSMITH_ALLOW_LOCAL_DEV_BYPASS` and off by default — this branch would be
**active in `api-key` mode**, which is the live configuration. Any local process
on the machine could read a tracked project's memories without a credential.

Mitigating: the same is already true of every project this machine holds a key
for, because the key sits in a 0600 file readable by that same local user. The
change is narrower than it first appears — but it is a real trust-boundary
change and should be reviewed as one, not waved through.

**Deliberately NOT addressed:** multi-user machines. The whole local-dev trust
model assumes a single-user workstation, and this inherits that assumption
rather than fixing it.

## Alternative worth considering first

Move Join out of the dashboard entirely — the SessionStart banner already
recognises tracked projects with no auth ambiguity whatsoever (verified working
live). A CLI `memsmith join` or a session-level prompt sidesteps this trust
boundary rather than widening it.

Cheaper, safer, and strictly less capable: no dashboard affordance. Worth a
decision before building the above.

## Testing

- Unit: all six gate conditions, each denied individually.
- Unit: the granted context carries `memories:read` and NOT `memories:write`.
- Unit: a marker naming a DIFFERENT project than the request is refused.
- Unit: a project with a key does not take this branch.
- Integration: a write route 403s under a tracked-view context.
- Integration: `/v1/identity` reports `runtime: 'team'` and `keyPresent: false`,
  so `canJoinFromIdentity` returns true.
- Manual: the Join button renders for a cloned project and completes a join.

## Out of scope

- The stalled-generation warning (health check works; nothing surfaces it).
- Key revocation / offboarding.
- Multi-user machine hardening.
