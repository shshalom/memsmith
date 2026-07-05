# Onboarding a Teammate to the Shared claude-mem Brain

This runbook walks through giving a new teammate their own scoped API key, pointing their claude-mem client at the shared server, and verifying that observations captured by one agent are recalled by another.

---

## Prerequisites

- The shared claude-mem server is running and reachable (e.g. `https://mem.example.com`).
- You have a write-scoped key (`memories:write` scope) for the admin or team lead — this is the `writeAuth` key used to mint new keys.
- The teammate has claude-mem installed locally (`npm install -g claude-mem` or the Claude Code plugin installed).

---

## Step 1: Mint a Scoped API Key for the Teammate

Run this from any machine that can reach the server. Replace `ADMIN_KEY` with the write-auth key held by the team lead.

```bash
curl -s -X POST https://mem.example.com/v1/keys \
  -H "Authorization: Bearer ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "alice-agent",
    "teamId": "team-acme",
    "projectId": "proj-platform",
    "scopes": ["memories:read", "memories:write"]
  }'
```

Example response:

```json
{
  "id": "key_01J2EXAMPLE",
  "name": "alice-agent",
  "key": "cmem_aAbBcCdDeEfFgGhHiIjJkKlLmMnNoOpPqQrRsStTuUvVwWxXyYzZ",
  "teamId": "team-acme",
  "projectId": "proj-platform",
  "scopes": ["memories:read", "memories:write"],
  "createdAt": "2026-07-04T00:00:00.000Z"
}
```

**The raw key is shown once.** Copy it and send it to the teammate via a secure channel (1Password, encrypted DM, etc.). The server stores only a SHA-256 hash.

For a read-only observer (e.g. a CI agent that only queries memory):

```bash
curl -s -X POST https://mem.example.com/v1/keys \
  -H "Authorization: Bearer ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "ci-reader",
    "teamId": "team-acme",
    "projectId": "proj-platform",
    "scopes": ["memories:read"]
  }'
```

---

## Step 2: Configure the Teammate's claude-mem Client

The teammate needs to point their local claude-mem client at the shared server rather than the default local SQLite worker.

### Option A — Fetch the MCP config block automatically

The server returns a paste-ready config block:

```bash
curl -s https://mem.example.com/v1/connect \
  -H "Authorization: Bearer cmem_TEAMMATE_KEY"
```

This returns a JSON snippet ready to paste into `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or the equivalent `mcpServers` block in the Claude Code config.

### Option B — Set environment variables directly

Add the following to the teammate's shell profile (`.zshrc`, `.bashrc`, or a `.env` loaded by their claude-mem config):

```bash
export CLAUDE_MEM_SERVER_URL="https://mem.example.com"
export CLAUDE_MEM_API_KEY="cmem_TEAMMATE_KEY"
export CLAUDE_MEM_TEAM_ID="team-acme"
export CLAUDE_MEM_PROJECT_ID="proj-platform"
```

Restart Claude Code (or reload the MCP server) after setting these.

### Verify the connection

```bash
curl -s https://mem.example.com/healthz
# { "status": "ok" }

curl -s https://mem.example.com/v1/observations?limit=1 \
  -H "Authorization: Bearer cmem_TEAMMATE_KEY"
# Returns an array (possibly empty on a fresh project) — a 200 confirms auth works.
```

---

## Step 3: Shared Brain Verification Test

This test proves that an observation captured by Teammate A's agent is recalled by Teammate B's agent — the shared brain working end-to-end.

### 3a. Teammate A captures an observation

Teammate A (or their agent) submits a unique, searchable observation. The fact must be specific enough that a false positive from Teammate B's local history is impossible.

```bash
# Run as Teammate A
export ALICE_KEY="cmem_ALICE_KEY_HERE"

curl -s -X POST https://mem.example.com/v1/observations \
  -H "Authorization: Bearer $ALICE_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Auth middleware: JWT RS256 keys rotate every 24 h via JWKS endpoint",
    "content": "The platform auth middleware fetches JWKS from https://auth.example.com/.well-known/jwks.json and caches public keys for 24 hours. Rotate by bumping the kid suffix; old sessions drain within the cache TTL. Discovered during the 2026-07-04 on-call handoff.",
    "teamId": "team-acme",
    "projectId": "proj-platform"
  }'
```

Expected response:

```json
{ "id": "obs_01J2EXAMPLE", "title": "Auth middleware: JWT RS256 keys rotate every 24 h via JWKS endpoint", ... }
```

### 3b. Teammate B searches for the observation

Teammate B (or their agent) issues a hybridSearch using semantically related terms — not an exact string match — to prove both vector and FTS retrieval paths work.

```bash
# Run as Teammate B — a different key, same teamId + projectId
export BOB_KEY="cmem_BOB_KEY_HERE"

curl -s -X POST https://mem.example.com/v1/search \
  -H "Authorization: Bearer $BOB_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "JWT public key rotation JWKS cache auth service",
    "teamId": "team-acme",
    "projectId": "proj-platform",
    "limit": 5
  }'
```

### 3c. Expected result

The observation captured by Teammate A appears in the results. Example:

```json
[
  {
    "id": "obs_01J2EXAMPLE",
    "title": "Auth middleware: JWT RS256 keys rotate every 24 h via JWKS endpoint",
    "score": 0.87,
    "teamId": "team-acme",
    "projectId": "proj-platform"
  },
  ...
]
```

A non-empty result list with the correct `id` and `teamId`/`projectId` confirms:

1. The shared Postgres backend is receiving writes from Teammate A.
2. The embedder encoded Teammate A's observation into `embedding_vec(384)`.
3. `hybridSearch` (FTS + pgvector RRF) is returning it to Teammate B's scoped query.
4. Scoped auth is enforcing the correct `teamId`/`projectId` boundary — Teammate B's key can only see observations in the same team/project scope.

If the observation does not appear, check:

```bash
# Confirm the observation exists at the storage layer
curl -s "https://mem.example.com/v1/observations/obs_01J2EXAMPLE" \
  -H "Authorization: Bearer $BOB_KEY"

# Check worker logs for embedding errors (Fargate CloudWatch)
aws logs tail /ecs/claude-mem-worker --since 5m --follow
```

---

## Revoking Access

If a teammate leaves or a key is compromised, revoke it immediately:

```bash
curl -s -X DELETE https://mem.example.com/v1/keys/key_01J2EXAMPLE \
  -H "Authorization: Bearer ADMIN_KEY"
```

Revocation is enforced on every subsequent request — there is no in-memory cache to drain.
