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
     AND role = 'owner' LIMIT 1
   If a row exists                                                  → 409
3. INSERT team_members (team_id, user_id, role) VALUES (:teamId, <key.user_id>, 'owner')
   ON CONFLICT DO NOTHING
4. Return { userId, role: 'owner' }
```

Step 2 and 3 run in ONE transaction with `SELECT ... FOR UPDATE` on the team
row. Two concurrent bootstraps must not both succeed — that is the whole
security property, and a check-then-act without the lock is the same race
`createMarkerIfAbsent` already documents losing.

### Key minting must set `user_id`

A key with a null `user_id` can never resolve a role no matter what
`team_members` says — `insertApiKeyHash` already learned this
(`project-identity.ts:278`: "user_id must be set too… a NULL here leaves the
role unresolvable"). So `POST /v1/keys` must stamp `user_id`, and the bootstrap
route must refuse a key whose `user_id` is null (→ 400, with a message naming
the cause rather than a generic denial).

### Convert calls it

`registerProjectKeyHash` gets one retry step: on `403 requires role owner`, call
bootstrap once, then retry. If bootstrap returns 409 the team already has an
owner and the 403 is genuine — surface it, do not loop.

## Threat model

**What this grants:** whoever holds a valid team key for a team with no owner can
become its owner.

**Why that is acceptable:** the team key is already sufficient to read and write
that team's memory. An attacker holding it does not need ownership to do damage;
they already have the data. Ownership adds member management — real, but not a
new class of access. And the key was issued deliberately by the operator.

**Why the no-existing-owner condition is load-bearing:** without it, any team
key holder could seize ownership of an established team, including demoting the
real owner. With it, the route is dead the moment a team is properly set up.

**What it does NOT do:** grant anything cross-team (the key is checked against
`:teamId`), work on a team that already has an owner, or work for a key with no
`user_id`.

**Residual risk, stated plainly:** a team whose first key leaks before the
operator bootstraps can be owned by the leaker. Mitigations available but NOT in
this design: an expiry on the bootstrap window, or an operator-set
`MEMSMITH_ALLOW_OWNER_BOOTSTRAP` flag defaulting on for self-hosted and off for
managed deployments. Worth deciding before build.

## Testing

Unit, on a pure decision function (no network):
- team with no owner + valid key → grant
- team WITH an owner → 409
- key for a different team → 403
- key with null `user_id` → 400
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
