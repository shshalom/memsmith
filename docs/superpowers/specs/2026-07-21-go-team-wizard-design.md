# Go Team Wizard — Design

**Status:** Design (2026-07-21). Spec #2 of the team-mode phase, consuming the merged Identity Core (Spec #1, `2026-07-20-identity-core-design.md`). One full-stack feature: a **Convert engine** (backend) + the **overlay wizard UI** (dashboard). Sibling to the Content Moderation spec (`2026-07-21-content-moderation-design.md`); build order between the two is the user's call.

---

## Motivation

Identity Core made "a team" real (identities, roles, membership, attribution) but left the **transition** unbuilt: a solo `local` user has no guided way to turn their embedded-Postgres project into a shared team store. Today "going team" means hand-editing `MEMSMITH_SERVER_DATABASE_URL`, manually moving data, and hoping. This wizard makes the conversion a safe, guided, non-destructive flow.

The runtime already supports both ends: `MEMSMITH_RUNTIME=local` (embedded Postgres at `127.0.0.1:55433`, role `memsmith`, data dir `~/.memsmith/pgdata`) and `MEMSMITH_RUNTIME=server` (same engine pointed at a remote Postgres via `MEMSMITH_SERVER_DATABASE_URL`, per `src/storage/postgres/config.ts`). The wizard's job is to (1) validate a remote Postgres is fit to be a team store, (2) copy local data into it safely, (3) flip the runtime to point at it, and (4) establish the human owner identity — all without risking the local data.

## Scope

**In:**
- **Convert engine (backend):**
  - **Test Connection probe** — validate a Postgres URL as a team store (connectivity + fitness), returning a checklist result. New `/v1` endpoint(s).
  - **Convert (data mover)** — copy local → remote (idempotent upsert by ID), verify, then flip the runtime. Re-stamp attribution. New `/v1` endpoint(s).
- **Overlay wizard UI (dashboard):** a modal overlay launched from a "GO TEAM" button on the local dashboard; steps `Welcome → Destination → Convert → Sign-in → Invite → Done`. Figma is the visual truth (fileKey `qz6xdzhC90iINaFAUqvRmO`).
- Consumes Identity Core's better-auth provider (Sign-in), `team_members` / roles (owner), `createdByUserId` attribution (re-stamp), and `/v1/members` (Invite link-out).

**Out (explicitly, own specs):**
- **Email invitations** ("add users by email") — invite record + token + expiry table, email-send infra, redemption → better-auth signup → auto-join with pre-assigned role. This is **Spec #3 (Team Invitations)**, consciously parked in Identity Core's "Out" list. It will *upgrade* this wizard's Invite step; the Invite step is built as a growable component so it slots in without rework.
- **Content moderation** (`<private>` / incognito) — sibling spec. The wizard assumes capture-suppression lands separately; until then the Convert warning is the interim safety net.
- **A per-observation stored "private" flag** — the only thing that would add a real predicate to the Convert copy's filter-F.
- OIDC/Cognito identity adapter; attribution dashboard views.

## Global Constraints

- **Non-destructive.** The local embedded Postgres data (`~/.memsmith/pgdata`) is **never mutated or deleted** by conversion. The flip is a config change; rollback = flip back to local. Deletion is always explicit and user-initiated, never by the wizard.
- **Copy → verify → flip, in that order.** The runtime flips to the remote store **only after** the copy is verified. Any failure before the flip leaves the user fully on local with nothing lost.
- **Idempotent + resumable.** The copy upserts by ID (remote-wins on conflict); re-running continues safely after a partial failure. Never half-flips.
- **Test Connection is a pure infrastructure probe.** It touches no identity and no project — only "is this a valid Postgres fit to be a team store." Identity/project come later (Sign-in).
- **Convert copies `rows matching filter F`, `F` default = all rows.** This is the privacy extension point (the "filter-F seam"): capture-time moderation needs zero wizard change; a future stored-but-private model is just a new predicate for F.
- **Convert-all + honest warning.** With no stored-private model today, Convert copies everything and shows a clear, count-backed warning ("All N local memories become visible to your team"), noting it assumes capture-suppression lands separately.
- **First real member = owner.** Converting your own local project makes you (the signing-in human) the team **owner**.
- **Attribution honesty.** Pre-conversion memories are re-stamped from `local-owner` to the new owner's real user id during the copy, so team views attribute the history correctly to a real user (no phantom `local-owner`).
- **Consume Identity Core; don't rebuild it.** Reuse the better-auth provider, `team_members`/roles, `createdByUserId`, `/v1/members`. Add no new identity machinery.
- **Figma is the visual truth.** Overlay entry, card layout, color language (cream card; **teal** = secondary/utility e.g. Begin, Test Connection; **terracotta** = primary/forward e.g. Next). Logo is a placeholder (polish later).
- **Commit trailer** on every commit: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`. **Never commit to main;** work on a branch. Nothing pushed.

---

## Architecture

```
Local dashboard
   │  click "GO TEAM"
   ▼
Modal overlay (dims local view; close → back to local)  ── converting THIS project
   │
   ├─ Welcome ──────────► Begin (teal)
   │
   ├─ Destination ──────► Postgres URL + Test Connection (teal)
   │       │                     │
   │       │                     ▼  POST /v1/convert/test-connection
   │       │              ┌─────────────────────────────────────────┐
   │       │              │ connectivity gate: reachable + authenticate│
   │       │              │ fitness gate: writable / pgvector /        │
   │       │              │               version / schema-ready       │
   │       │              │ → checklist result (green/red per check)   │
   │       │              │ fixable gap → offer one-click fix or       │
   │       │              │               instruct-only fallback       │
   │       │              └─────────────────────────────────────────┘
   │       ▼  Next (terracotta) unlocks only when all-green
   │
   ├─ Sign-in ──────────► better-auth create-or-sign-in → OWNER  (identity captured here;
   │                                                              see sequencing note)
   │
   ├─ Convert ──────────► POST /v1/convert/migrate
   │       ┌─────────────────────────────────────────────────────┐
   │       │ 1. COPY  local → remote, filter F (default all),      │
   │       │          idempotent upsert by id, re-stamp            │
   │       │          createdByUserId local-owner → owner          │
   │       │ 2. VERIFY counts / integrity match                    │
   │       │ 3. FLIP  runtime → remote (only if verify passed)     │
   │       │ live phased progress: Copying / Verifying / Switching │
   │       │ local PG kept untouched as backup                     │
   │       └─────────────────────────────────────────────────────┘
   │
   ├─ Invite (optional) ► base key + "how teammates join" + link to /v1/members view
   │
   └─ Done
```

**Sequencing note (spec must honor):** the attribution re-stamp in Convert needs the owner's real user id. So although the Figma card order is `Welcome → Destination → Convert → Sign-in → Invite`, the **identity must be captured before Convert's re-stamp commits**. Resolution: the Sign-in identity is established before the Convert copy runs (either Sign-in is presented before Convert, or its identity is captured and Convert consumes it). The implementation plan must make Convert depend on a resolved owner user id, not run before it exists. Visual card order may stay as Figma shows; the *data dependency* is what matters.

## Components

### 1. Test Connection probe — new (`POST /v1/convert/test-connection`)
- Input: a Postgres connection URL. Output: a checklist result `{ connectivity: {reachable, authenticates}, fitness: {writable, pgvector, versionOk, schemaReady}, fixable?: [...] }`.
- **Connectivity gate:** open a connection with the given credentials.
- **Fitness gate (only if connectivity passes):** writable (not a read-only replica — attempt a temp write), `vector` extension present (or installable), Postgres version ≥ floor, schema absent (fresh) or a compatible MemSmith schema (safe to upsert).
- Touches no identity/project. Pure infra diagnosis.
- **Fixable gaps:** if a fitness check fails but is fixable and MemSmith has permission (e.g. `CREATE EXTENSION vector`, create schema), the response marks it fixable so the UI can offer one-click setup; otherwise the response carries instruct-only guidance (copy-paste command for a DBA).

### 2. Convert data mover — new (`POST /v1/convert/migrate`)
- **Copy:** read local rows (observations, embeddings, sessions, and any team/project-scoped tables required for a coherent store) matching **filter F** (default: all rows) and **upsert by id** into the remote (remote-wins on conflict — safe re-run, safe join of an existing team store). Re-stamp `createdByUserId` from `local-owner` to the resolved owner user id during the copy.
- **Verify:** compare row counts / integrity between local and remote for the copied scope. Mismatch → do **not** flip; report and offer Resume.
- **Flip:** on verify success, switch the runtime to point at the remote (`MEMSMITH_RUNTIME=server` + `MEMSMITH_SERVER_DATABASE_URL`). Local data untouched.
- **Progress:** stream/report phases (`Copying observations` / `Verifying` / `Switching over`) with a count/percent for the live phased progress UI.
- **Resumable:** because the copy upserts by id, a re-run after failure continues where it stopped.

### 3. Overlay wizard UI — new (dashboard)
- **GO TEAM button** on the local dashboard → transitions into a modal overlay dimming the local view; closing returns to local.
- **Welcome card:** branded (orbital logo placeholder), teal **Begin**.
- **Destination card:** left text column (title, explainer, `POSTGRES CONNECTION URL` input, teal **Test Connection**) + right dark hero panel; terracotta **Next** unlocks only when the checklist is all-green. Renders the checklist result and any one-click fix / instructions.
- **Convert card:** live phased progress + the count-backed convert-all warning; dark hero + terracotta forward.
- **Sign-in card:** better-auth create-or-sign-in; establishes the owner identity.
- **Invite card (optional):** shows the team base key + "how teammates join" explainer + link to the members view. Built as a **growable component** so email-invite (Spec #3) can replace/extend it without restructuring the wizard.
- **Done card:** confirmation; you're now a team.

### 4. Identity consumption — reuse Identity Core (no new machinery)
- Sign-in via the better-auth provider; first real member made **owner** in `team_members`.
- Attribution re-stamp uses `createdByUserId` (the field Identity Core added).
- Invite links out to the existing `/v1/members` surface.

## Data Flow

- **Solo local → team:** GO TEAM → Test Connection (green) → Sign-in (owner identity) → Convert (copy→verify→flip, re-stamp) → Invite (base key) → Done. Local PG remains as backup.
- **Failure before flip:** stays on local; Resume continues the idempotent copy.
- **Rollback:** flip runtime back to local (config change); local data was never touched.

## Error Handling & Failure Modes

| Situation | Behavior |
|---|---|
| Connectivity fails | Checklist shows red on reachable/authenticate; Next stays locked; user fixes URL/creds and re-tests |
| Fitness gap, fixable + permitted | Offer one-click setup (e.g. `CREATE EXTENSION vector`) |
| Fitness gap, not permitted | Instruct-only: show the exact command for a DBA; Next stays locked |
| Copy fails partway | Stay fully on local (never flipped); show what failed + **Resume** (idempotent upsert continues) |
| Verify mismatch | Do **not** flip; report; offer Resume |
| Remote already has data | Idempotent upsert (remote-wins) — safe join, no clobber |
| Sign-in fails | Cannot become owner; Convert's re-stamp blocked (depends on owner id); stay on local |
| User closes overlay mid-flow | Back to local; nothing committed until flip |

**Invariant:** the runtime is never left half-converted; a failure anywhere before the flip leaves a fully working local store with nothing lost.

## Testing

1. **Test probe:** each check reports correctly — reachable/auth pass+fail; writable vs read-only replica; pgvector present/absent (+fixable marking); version below/above floor; schema fresh vs compatible vs incompatible.
2. **One-click fix:** fixable-gap path installs pgvector / creates schema when permitted; falls back to instructions when not.
3. **Convert idempotency:** running the copy twice yields the same remote state (no duplicates); re-run after simulated mid-copy failure resumes and completes.
4. **Verify-blocks-flip:** a forced verify mismatch does not flip the runtime; state stays on local.
5. **Attribution re-stamp:** copied rows carry the owner's real `createdByUserId`, not `local-owner`.
6. **Local untouched:** after a successful flip, the local PG data is byte-unchanged; flipping back restores the local store.
7. **Owner establishment:** Sign-in makes the first real member the team owner in `team_members`.
8. **UI:** Next locked until checklist all-green; overlay open/close returns to local; progress phases render.
9. **Live acceptance:** dogfood a real `local → remote` conversion against a test Postgres — verify per-user attribution, the flip, resume-after-failure, and rollback (flip back to local).

## Acceptance Criteria

1. `POST /v1/convert/test-connection` validates a Postgres URL across connectivity + fitness and returns a checklist; fixable gaps are marked (one-click where permitted, instructions otherwise); the probe touches no identity/project.
2. `POST /v1/convert/migrate` copies local → remote (idempotent upsert by id, filter F default all), verifies, and flips **only** on verify success; local data is never mutated/deleted.
3. Convert re-stamps `createdByUserId` from `local-owner` to the resolved owner user id.
4. Any failure before the flip leaves the user fully on local; the copy is resumable.
5. The wizard overlay implements `Welcome → Destination → Convert → Sign-in → Invite → Done` per Figma; Next unlocks only on an all-green checklist; the convert-all warning is shown with a real count.
6. Sign-in establishes the signing-in human as the team owner; the Invite step surfaces the base key + members link and is a growable component (email-invite-ready).
7. The Convert copy is written as `copy rows matching filter F` with F defaulting to all rows (the filter-F seam).
8. `src` typecheck clean; touched/added test files green; nothing pushed; work on a branch.

## Deferred (own specs)
- Email invitations (Spec #3 — Team Invitations): invite record + token + email-send + redemption; upgrades the Invite step.
- Content moderation (`<private>` / incognito) — sibling spec; makes convert-all fully safe.
- Per-observation stored "private" flag — the only future addition of a real predicate to filter F.
- OIDC/Cognito adapter; attribution dashboard views.
