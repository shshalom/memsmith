# Becoming the owner of your own team, over HTTPS — design

**Status:** proposed, NOT approved. Changes who may become an owner on a remote team server; read the threat model.
**Branch:** `joiner-fresh-install`

## The requirement, from the product owner

> "The whole point is that a user won't need to use VPN and/or login into AWS to
> mint keys."

Today they must. That is the gap.

## The chicken-and-egg

A user converts their local project to a team server. Convert calls
`POST /v1/convert/register-key`, which is `requireRole('owner')`. Role is
resolved on the REMOTE:

```
requireRole → getMemberRole(teamId, userId)   ← reads remote team_members
              (postgres-auth.ts:447)
```

The team key they were given authenticates fine but its `user_id` has **no
`team_members` row on the remote**, so its role is null and every role-gated
route is closed. Measured live against the AWS deployment:

```
POST /v1/convert/register-key  → 403 {"error":"Forbidden","message":"requires role owner"}
GET  /v1/members               → 403 {"error":"Forbidden","message":"requires role member"}
```

Not even `member`. The key belongs to nobody.

And there is no way out over HTTP:

| Route | Requires |
|---|---|
| `POST /v1/keys` (mint a key) | `admin` |
| `POST /v1/members` (add a member) | `admin` |
| `PATCH /v1/members/:userId` (grant a role) | `admin` |
| `POST /v1/convert/register-key` | `owner` |
| `POST /v1/join` (owner half) | `owner` |

**Minting a role-bearing key requires `admin`; becoming `admin` requires a
role-bearing key.** The only existing escape is
`server api-key create --user <id> --role owner`, a CLI that connects DIRECTLY
to Postgres — impossible against a private RDS without VPN or an in-VPC ECS
task. Memory recorded this on 2026-08-13 as "no bootstrapped admin key exists,
creating a chicken-and-egg problem"; the ECS bootstrap task was logged as a
workaround, never a fix.

## What already works locally, and why it is the model

`ensureProjectIdentity` establishes the machine's user as owner of the team it
mints (`project-identity.ts:212`):

```sql
INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'owner')
  ON CONFLICT (team_id, user_id) DO UPDATE SET role = 'owner'
  WHERE team_members.role <> 'owner'
```

Verified on Project A: `team_members = [{user_id: 'local-owner', role: 'owner'}]`.
So the user genuinely IS the owner of their own project — locally. That
assertion simply never reaches the remote, and convert is the moment it needs
to.

The rule that governs locally is **first-writer-establishes-owner**: whoever
creates a team owns it. This design carries the same rule across the wire,
under the one condition that makes it safe.

## Design

### The condition

A team key is proof of nothing about identity today, but it IS proof of
authorization — the team's operator issued it. So:

> A caller holding a valid team key MAY establish itself as `owner` of that
> team, **only when the team has no owner yet.**

Once an owner exists, the route refuses and the existing `admin` path governs.
That makes it a genuine bootstrap: usable exactly once per team, by whoever the
operator gave the key to.

### The route

`POST /v1/teams/:teamId/bootstrap-owner`

Auth: a valid team key for `:teamId` (no role required — that is the point).

```
1. Authenticate the key. Reject if it is not for :teamId.          → 403
2. SELECT 1 FROM team_members WHERE team_id = :teamId
     AND role = 'owner' LIMIT 1        -- FOR UPDATE on the team row
   If a row exists                                                  → 409
3. userId = key.user_id ?? newId()
   If the key had none: UPDATE api_keys SET user_id = userId
                          WHERE key_hash = <hash> AND user_id IS NULL
4. INSERT team_members (team_id, user_id, role) VALUES (:teamId, userId, 'owner')
   ON CONFLICT DO NOTHING
5. Return { userId, role: 'owner' }
```

Step 2 and 3 run in ONE transaction with `SELECT ... FOR UPDATE` on the team
row. Two concurrent bootstraps must not both succeed — that is the whole
security property, and a check-then-act without the lock is the same race
`createMarkerIfAbsent` already documents losing.

### Key minting must set `user_id` — and bootstrap must BACKFILL it

A key with a null `user_id` can never resolve a role no matter what
`team_members` says — `insertApiKeyHash` already learned this
(`project-identity.ts:278`: "user_id must be set too… a NULL here leaves the
role unresolvable"). `POST /v1/keys` accepts only `{label, expiresInDays}` and
`createApiKey` writes `input.userId ?? null` (`auth.ts:91`), so **every key
minted without an explicit `--user` has a NULL `user_id`.**

**REVIEW CORRECTION.** An earlier draft of this design had the bootstrap route
REFUSE such a key with a 400. That was wrong, and it would have shipped a route
that cannot help the only key a real user actually holds: the live AWS key was
minted without `--user`, so it has a null `user_id`, so the 400 branch would
have fired on the exact case this feature exists for. The route would have been
correct, tested, and useless.

The route must **assign** the `user_id`, not demand it. It already holds the key,
so it can stamp the row — and there is precedent doing exactly this for exactly
this reason (`project-identity.ts:353`, `UPDATE api_keys SET user_id = $1 …
WHERE user_id IS NULL`, whose comment explains that a key minted before owner
establishment is otherwise "permanently unable to use owner-gated features").

So step 3 becomes: if the key's `user_id` is null, generate one, stamp it onto
the `api_keys` row, and use it for the membership insert — all inside the same
transaction as the ownership check, so a failure leaves neither half applied.

### Convert calls it

`registerProjectKeyHash` gets one retry step: on `403 requires role owner`, call
bootstrap once, then retry. If bootstrap returns 409 the team already has an
owner and the 403 is genuine — surface it, do not loop.

## Threat model

**What this grants:** whoever holds a valid team key for a team with no owner can
become its owner.

**Corrected assessment.** An earlier draft of this section said ownership "adds
member management — real, but not a new class of access." That understated it,
and the softer wording is the kind that gets a security change waved through.

Measured against the live deployment, a leaked team key ALREADY has:

```
POST /v1/search  → 200   read all of the team's memory
POST /v1/events  → 201   write into the team's memory
```

But it CANNOT reach these, and ownership hands over every one:

```
POST   /v1/keys                        mint further credentials
POST   /v1/members                     add members
PATCH  /v1/members/:userId             change roles — including demoting the real owner
DELETE /v1/members/:userId             remove members
DELETE /v1/projects/:projectId/memory  DESTROY the team's memory
```

Two of those are qualitatively different from data access, not merely more of
it. Minting keys is PERSISTENCE that survives revoking the leaked key. And
`DELETE …/memory` is DESTRUCTION — the one action this product exists to prevent.

So within the bootstrap window this feature converts "an attacker can read and
write your memory" into "an attacker can own your team, lock you out, and delete
everything." That escalation is created by this design; it is not pre-existing.
Both mitigations below are therefore REQUIRED, not optional.

**Why the no-existing-owner condition is load-bearing:** without it, any team
key holder could seize ownership of an established team, including demoting the
real owner. With it, the route is dead the moment a team is properly set up.

**What it does NOT do:** grant anything cross-team (the key is checked against
`:teamId`), work on a team that already has an owner, or work for a key with no
`user_id`.

### Both mitigations are part of this design

**1. Operator flag — `MEMSMITH_ALLOW_OWNER_BOOTSTRAP`.** The route returns 404
unless explicitly enabled. 404 rather than 403 so a disabled deployment does not
advertise the endpoint's existence. Default OFF: a managed deployment must opt
in, so the escalation exists only where an operator chose it.

**2. Bootstrap window — `MEMSMITH_OWNER_BOOTSTRAP_WINDOW_MINUTES`, default 60.**
The route refuses once the team row is older than the window (→ 410 Gone).
Ownership is a setup-time act; a team that has existed for days and still has no
owner is not mid-setup, it is misconfigured — and leaving the door open for it
is what turns a narrow window into a standing vulnerability.

Together: the door is shut unless an operator opened it, and it closes by itself
even if they forget. Either alone leaves a hole — the flag can be left on
forever, and the window applies to every team on a deployment that never wanted
this at all.

**Residual risk that remains:** a team whose first key leaks WITHIN the window on
a deployment that has opted in can be owned by the leaker. That is the irreducible
core of the feature: possession of the key during setup is the only signal the
remote has. Shrink the window to reduce it.

## Testing

Unit, on a pure decision function (no network):
- team with no owner + valid key → grant
- team WITH an owner → 409
- key for a different team → 403
- **key with null `user_id` → GRANT, and the key row is stamped.** This is the
  live AWS key's actual state, so a test asserting 400 here would have locked in
  the bug the review caught.
- key that already has a `user_id` → grant, and that id is REUSED, not replaced
- concurrent bootstrap: exactly one grant (transaction + row lock)

Integration:
- `POST /v1/convert/register-key` → 403, bootstrap, retry → 200
- second bootstrap attempt on the same team → 409
- full convert of a local project to a fresh team, no AWS credentials in the
  loop at any point

Manual (the actual acceptance test): a user with **no AWS access** converts a
local project to the AWS deployment using only the server URL and a team key.

## Out of scope

- How the operator obtains the very first team key. Assumed handed over
  out-of-band (a signup flow, an invite email, a console). This design starts
  from "the user has a key".
- Revocation and offboarding.
- The `role: null` treated as member-equivalent in `requireWriteRole`
  (`postgres-auth.ts:69`) — a separate question this design does not touch.
