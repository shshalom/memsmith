# Record-Intent Follow-up Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the three non-blocking minors from the record-intent final review: (1) audit-write parity on `/v1/record-intent`, (2) make the Layer-2 backstop honor the user's configured provider (not Ollama-only), (3) make `MEMSMITH_USER_NOTE_BOOST` an honest boolean toggle.

**Architecture:** Three independent fixes to existing code. #1 threads the created observation id out of the classifier so the route can audit it. #2 rewrites `providerComplete` to branch on `providerLabel`, mirroring the env-key resolution in `create-server-service.ts`. #3 converts the boost setting + `boostUserDirected` from a magnitude to a boolean.

**Tech Stack:** TypeScript, Bun test runner, the server v1 routes, the generation provider layer, the settings registry + resolver.

## Global Constraints

- Fail-open preserved everywhere: the `/v1/record-intent` route must still return `{recorded}` (never 500); an audit failure MUST NOT break that contract. `providerComplete` must never throw (HTTP error / throw / empty → `null`).
- `providerComplete` resolves API key / model / base URL from ENV, keyed by `provider.providerLabel`, mirroring `instantiateServerGenerationProvider` (`src/server/runtime/create-server-service.ts:285-322`) — because the constructed provider's apiKey/model are private and not readable off the instance.
- #2 must honor the user's configured provider automatically (the backstop already resolves it via `generationProviderHolder`); no new provider selection logic.
- #3: behavior identical when enabled (notes-first partition); only the setting shape + signature change from magnitude→boolean.
- Commit trailer on every commit: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- Never commit to main. Branch: `record-intent-followups` (off main). Nothing pushed.
- Verify with `npx tsc --noEmit` (exit 0; root tsconfig excludes tests/). Editor bun:test/.js diagnostics are noise.

**Env-key resolution to mirror (from `create-server-service.ts:285-322`, the source of truth for #2):**
- claude: `process.env.ANTHROPIC_API_KEY ?? process.env.MEMSMITH_ANTHROPIC_API_KEY ?? ''`; model `process.env.MEMSMITH_SERVER_MODEL` (default = `DEFAULT_SERVER_CLAUDE_MODEL`); endpoint `https://api.anthropic.com/v1/messages`.
- gemini: `process.env.GEMINI_API_KEY ?? process.env.MEMSMITH_GEMINI_API_KEY ?? ''`; model `MEMSMITH_SERVER_MODEL` (default `gemini-2.5-flash`); endpoint `https://generativelanguage.googleapis.com/v1/models/<model>:generateContent?key=<key>`.
- openrouter: `process.env.OPENROUTER_API_KEY ?? process.env.MEMSMITH_OPENROUTER_API_KEY ?? ''`; model `MEMSMITH_SERVER_MODEL` (default `anthropic/claude-3.5-sonnet`); base `process.env.MEMSMITH_OPENROUTER_BASE_URL ?? process.env.OPENROUTER_BASE_URL` (default OpenRouter) → `<base>/chat/completions`; header `Authorization: Bearer <key>`.
- ollama: base `process.env.MEMSMITH_OLLAMA_URL ?? process.env.OLLAMA_URL ?? 'http://localhost:11434'` → `<base>/v1/chat/completions`; model `MEMSMITH_SERVER_MODEL` (default `llama3.1:8b`); optional `Authorization: Bearer <MEMSMITH_OLLAMA_API_KEY>` only when set.

---

### Task 1: Audit-write parity on `/v1/record-intent`

**Files:**
- Modify: `src/server/routes/v1/record-intent.ts` (classifier returns the created id)
- Modify: `src/server/routes/v1/ServerV1PostgresRoutes.ts` (route calls `auditWrite` on a recorded result; backstop route at `:955-996`)
- Test: `tests/server/record-intent-endpoint.test.ts` (existing; add an assertion)

**Interfaces:**
- Consumes: `deps.write` already returns `{ id: string }`.
- Produces: `classifyAndComposeRecordIntent` now returns `{ recorded: boolean; content?: string; id?: string }` — `id` present when `recorded: true`.

Current classifier tail (`record-intent.ts`):
```ts
  await deps.write({ ... });
  return { recorded: true, content };
```
Current return type: `Promise<{ recorded: boolean; content?: string }>`.

- [ ] **Step 1: Write the failing test**

In `tests/server/record-intent-endpoint.test.ts`, add to the existing "RECORD: reply writes a marked user_note" test (which stubs `deps.write` to return `{ id: 'obs-1' }`) an assertion that the classifier surfaces the id:

```ts
const result = await classifyAndComposeRecordIntent('please remember X', deps);
expect(result.recorded).toBe(true);
expect(result.id).toBe('obs-1'); // id threaded from deps.write for audit
```
(The existing stub's `write` returns `{ id: ... }`; assert that value flows to `result.id`. If the current stub returns a fixed id, assert that exact value.)

- [ ] **Step 2: Run test to verify it fails**

Run: `~/.bun/bin/bun test tests/server/record-intent-endpoint.test.ts`
Expected: FAIL — `result.id` is undefined.

- [ ] **Step 3: Thread the id out of the classifier**

In `record-intent.ts`, change the return type to `Promise<{ recorded: boolean; content?: string; id?: string }>` and capture the write result:
```ts
  const written = await deps.write({
    projectId: deps.projectId,
    teamId: deps.teamId,
    kind: noteReq.kind as string,
    content: noteReq.content,
    metadata: noteReq.metadata as Record<string, unknown>,
    idempotencyKey: idempotencyKey,
  });
  return { recorded: true, content, id: written.id };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `~/.bun/bin/bun test tests/server/record-intent-endpoint.test.ts`
Expected: PASS.

- [ ] **Step 5: Call auditWrite in the route on a recorded result**

In `ServerV1PostgresRoutes.ts`, the backstop route (~`:987`) currently does:
```ts
          const result = await classifyAndComposeRecordIntent(body.prompt, deps);
          res.json(result);
```
Change to audit a successful record (mirroring `/v1/memories` at `:939` which calls `await this.auditWrite(req, 'memory.write', observation.id, observation.projectId)`), keeping fail-open:
```ts
          const result = await classifyAndComposeRecordIntent(body.prompt, deps);
          if (result.recorded && result.id) {
            try {
              await this.auditWrite(req, 'memory.write', result.id, projectId);
            } catch (auditErr) {
              logger.debug('SYSTEM', 'record-intent audit write failed (non-fatal)', { error: auditErr instanceof Error ? auditErr.message : String(auditErr) });
            }
          }
          res.json(result);
```
> `result.id` should NOT be exposed to the client if the response contract is `{recorded, content}` only. If exposing `id` in the JSON is undesirable, strip it before `res.json`: `res.json({ recorded: result.recorded, content: result.content })`. Decide based on the existing response shape — the existing tests assert `recorded`/`content`; do not break them. Prefer stripping `id` from the HTTP response (it is an internal audit detail), keeping the wire contract unchanged.

- [ ] **Step 6: Verify the endpoint response contract unchanged**

Run: `~/.bun/bin/bun test tests/server/record-intent-endpoint.test.ts`
Expected: PASS (existing recorded/content assertions still hold; new id assertion on the pure classifier holds).

- [ ] **Step 7: Typecheck**

Run: `npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 8: Commit**

```bash
git add src/server/routes/v1/record-intent.ts src/server/routes/v1/ServerV1PostgresRoutes.ts tests/server/record-intent-endpoint.test.ts
git commit -m "fix(record-intent): audit-write parity on /v1/record-intent

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Provider-agnostic backstop completion

**Files:**
- Modify: `src/server/generation/provider-complete.ts` (branch on providerLabel)
- Test: `tests/server/generation/provider-complete.test.ts` (existing)

**Interfaces:**
- `providerComplete(input: { provider: ServerGenerationProvider; system: string; user: string }, deps?: { fetchImpl?: typeof fetch }): Promise<string | null>` — signature UNCHANGED. Behavior extends from ollama-only to all four `providerLabel`s.

Current implementation returns `null` for any non-ollama provider (`provider-complete.ts:18`). Replace with a `switch (input.provider.providerLabel)`.

- [ ] **Step 1: Write the failing tests**

In `tests/server/generation/provider-complete.test.ts`, add tests using an injected `fetchImpl` stub (the existing test pattern) for each new branch. Each asserts the correct URL + that the parsed text is returned; and that an HTTP error → null (fail-open):

```ts
const fakeProvider = (label: string) => ({ providerLabel: label } as any);

it('openrouter: posts to /chat/completions and returns content', async () => {
  let calledUrl = '';
  const fetchImpl = (async (url: any, _init: any) => {
    calledUrl = String(url);
    return { ok: true, json: async () => ({ choices: [{ message: { content: 'OR-REPLY' } }] }) };
  }) as any;
  const out = await providerComplete({ provider: fakeProvider('openrouter'), system: 's', user: 'u' }, { fetchImpl });
  expect(calledUrl).toContain('/chat/completions');
  expect(out).toBe('OR-REPLY');
});

it('claude: posts to /v1/messages and returns text', async () => {
  let calledUrl = '';
  const fetchImpl = (async (url: any, _init: any) => {
    calledUrl = String(url);
    return { ok: true, json: async () => ({ content: [{ type: 'text', text: 'CLAUDE-REPLY' }] }) };
  }) as any;
  const out = await providerComplete({ provider: fakeProvider('claude'), system: 's', user: 'u' }, { fetchImpl });
  expect(calledUrl).toContain('/v1/messages');
  expect(out).toBe('CLAUDE-REPLY');
});

it('gemini: posts to generateContent and returns text', async () => {
  let calledUrl = '';
  const fetchImpl = (async (url: any, _init: any) => {
    calledUrl = String(url);
    return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: 'GEMINI-REPLY' }] } }] }) };
  }) as any;
  const out = await providerComplete({ provider: fakeProvider('gemini'), system: 's', user: 'u' }, { fetchImpl });
  expect(calledUrl).toContain('generateContent');
  expect(out).toBe('GEMINI-REPLY');
});

it('non-ok response returns null (fail-open) for any provider', async () => {
  const fetchImpl = (async () => ({ ok: false, status: 500, json: async () => ({}) })) as any;
  for (const label of ['ollama', 'openrouter', 'claude', 'gemini']) {
    expect(await providerComplete({ provider: fakeProvider(label), system: 's', user: 'u' }, { fetchImpl })).toBeNull();
  }
});

it('unknown provider returns null', async () => {
  expect(await providerComplete({ provider: fakeProvider('mystery'), system: 's', user: 'u' })).toBeNull();
});
```
Keep the existing ollama test (it should still pass unchanged).

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `~/.bun/bin/bun test tests/server/generation/provider-complete.test.ts`
Expected: FAIL on openrouter/claude/gemini (currently return null).

- [ ] **Step 3: Rewrite `providerComplete` with per-label branches**

```ts
// src/server/generation/provider-complete.ts
import type { ServerGenerationProvider } from './providers/shared/types.js';
import { logger } from '../../utils/logger.js';

interface Deps { fetchImpl?: typeof fetch }

// Minimal plain chat-completion using the user's configured provider — for the
// record-intent Layer-2 backstop. Reads API key / model / base URL from env,
// keyed by providerLabel, mirroring instantiateServerGenerationProvider
// (create-server-service.ts). Fail-open: any error / non-ok / empty → null.
export async function providerComplete(
  input: { provider: ServerGenerationProvider; system: string; user: string },
  deps: Deps = {},
): Promise<string | null> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const model = process.env.MEMSMITH_SERVER_MODEL;
  try {
    switch (input.provider.providerLabel) {
      case 'ollama': {
        const base = (process.env.MEMSMITH_OLLAMA_URL ?? process.env.OLLAMA_URL ?? 'http://localhost:11434').replace(/\/$/, '');
        const url = base.endsWith('/v1/chat/completions') ? base : `${base}/v1/chat/completions`;
        const apiKey = process.env.MEMSMITH_OLLAMA_API_KEY;
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
        return await openaiChat(fetchImpl, url, headers, model ?? 'llama3.1:8b', input.system, input.user);
      }
      case 'openrouter': {
        const apiKey = process.env.OPENROUTER_API_KEY ?? process.env.MEMSMITH_OPENROUTER_API_KEY ?? '';
        if (!apiKey) return null;
        const rawBase = process.env.MEMSMITH_OPENROUTER_BASE_URL ?? process.env.OPENROUTER_BASE_URL ?? 'https://openrouter.ai/api/v1';
        const base = rawBase.replace(/\/$/, '');
        const url = base.endsWith('/chat/completions') ? base : `${base}/chat/completions`;
        return await openaiChat(fetchImpl, url, { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` }, model ?? 'anthropic/claude-3.5-sonnet', input.system, input.user);
      }
      case 'claude': {
        const apiKey = process.env.ANTHROPIC_API_KEY ?? process.env.MEMSMITH_ANTHROPIC_API_KEY ?? '';
        if (!apiKey) return null;
        const res = await fetchImpl('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({
            model: model ?? 'claude-3-5-haiku-latest',
            max_tokens: 1024,
            system: input.system,
            messages: [{ role: 'user', content: input.user }],
          }),
        });
        if (!res.ok) return null;
        const data = await res.json() as { content?: Array<{ type?: string; text?: string }> };
        const text = (data.content ?? []).filter(b => b?.type === 'text').map(b => b?.text ?? '').join('').trim();
        return text || null;
      }
      case 'gemini': {
        const apiKey = process.env.GEMINI_API_KEY ?? process.env.MEMSMITH_GEMINI_API_KEY ?? '';
        if (!apiKey) return null;
        const m = model ?? 'gemini-2.5-flash';
        const url = `https://generativelanguage.googleapis.com/v1/models/${encodeURIComponent(m)}:generateContent?key=${encodeURIComponent(apiKey)}`;
        const res = await fetchImpl(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: input.system }] },
            contents: [{ role: 'user', parts: [{ text: input.user }] }],
          }),
        });
        if (!res.ok) return null;
        const data = await res.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
        const text = (data.candidates?.[0]?.content?.parts ?? []).map(p => p?.text ?? '').join('').trim();
        return text || null;
      }
      default:
        return null;
    }
  } catch (error) {
    logger.debug('SYSTEM', 'providerComplete failed (fail-open)', { error: error instanceof Error ? error.message : String(error) });
    return null;
  }
}

async function openaiChat(
  fetchImpl: typeof fetch, url: string, headers: Record<string, string>,
  model: string, system: string, user: string,
): Promise<string | null> {
  const res = await fetchImpl(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      stream: false,
    }),
  });
  if (!res.ok) return null;
  const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
  const text = (data.choices?.[0]?.message?.content ?? '').trim();
  return text || null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `~/.bun/bin/bun test tests/server/generation/provider-complete.test.ts`
Expected: PASS (existing ollama + new openrouter/claude/gemini/fail-open/unknown).

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/server/generation/provider-complete.ts tests/server/generation/provider-complete.test.ts
git commit -m "fix(record-intent): backstop honors user's configured provider (not ollama-only)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Honest boolean user-note-boost toggle

**Files:**
- Modify: `src/server/routes/v1/user-note-boost.ts` (`boostUserDirected` signature)
- Modify: the setting definition for `MEMSMITH_USER_NOTE_BOOST` (settings registry) + the resolver getter
- Modify: the call site in `resolveSearchResults` (`ServerV1PostgresRoutes.ts`)
- Test: `tests/server/user-note-boost.test.ts` (existing)

**Interfaces:**
- Produces: `boostUserDirected(ranked: PostgresObservation[], enabled: boolean): PostgresObservation[]` — notes-first partition when `enabled`, input unchanged when not.

- [ ] **Step 1: Find the setting definition + resolver getter + call site**

Run: `grep -rn "MEMSMITH_USER_NOTE_BOOST\|userNoteBoost\|boostUserDirected" src/`
Note the exact locations: the `settingKeys`/registry entry (type `number`, min 0 max 10), the `SettingsResolver` getter (returns a number), and the `resolveSearchResults` call `boostUserDirected(ranked, strength)`.

- [ ] **Step 2: Update the failing test**

In `tests/server/user-note-boost.test.ts`, change the signature usage from magnitude to boolean:
```ts
it('enabled=true stable-reorders user_note ahead of ambient', () => {
  const out = boostUserDirected(mixed, true);
  // notes first, stable within groups
  expect(out.map(o => o.kind)).toEqual(['user_note', 'user_note', 'observation', 'observation']);
});
it('enabled=false leaves order unchanged', () => {
  const out = boostUserDirected(mixed, false);
  expect(out).toEqual(mixed);
});
it('only reorders within the given set — never adds rows', () => {
  const out = boostUserDirected(mixed, true);
  expect(out.length).toBe(mixed.length);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `~/.bun/bin/bun test tests/server/user-note-boost.test.ts`
Expected: FAIL — signature still takes a number (or the boolean is coerced oddly).

- [ ] **Step 4: Change `boostUserDirected` to boolean**

```ts
export function boostUserDirected(ranked: PostgresObservation[], enabled: boolean): PostgresObservation[] {
  if (!Array.isArray(ranked) || !enabled || ranked.length < 2) return ranked;
  const notes: PostgresObservation[] = [];
  const rest: PostgresObservation[] = [];
  for (const o of ranked) (o.kind === 'user_note' ? notes : rest).push(o);
  if (notes.length === 0 || rest.length === 0) return ranked;
  return [...notes, ...rest];
}
```
Update the file's leading comment: replace "strength<=0 is a no-op" with "disabled is a no-op".

- [ ] **Step 5: Convert the setting definition to boolean**

In the settings registry entry for `MEMSMITH_USER_NOTE_BOOST`: change `type` from `'number'` to `'boolean'`, remove `min`/`max`, set the default to the boolean equivalent of the old default (old default was `1` → `true`). Update the help text to: "Float user-directed notes ahead of ambient results in retrieval (on/off)." Keep the key name `MEMSMITH_USER_NOTE_BOOST`.

- [ ] **Step 6: Update the resolver getter**

In `SettingsResolver`, change the getter that returned a number (e.g. `userNoteBoost(): number`) to return a boolean (`userNoteBoost(): boolean`) — coerce the env/override value as boolean (matching how other boolean settings are coerced in the resolver; e.g. `=== 'true'` or the existing boolean coercer). Preserve env fallback.

- [ ] **Step 7: Update the call site**

In `resolveSearchResults` (`ServerV1PostgresRoutes.ts`), change `boostUserDirected(ranked, strength)` to `boostUserDirected(ranked, this.settingsResolver.userNoteBoost(...))` — passing the boolean from the resolver (match the exact resolver-call idiom used for the adjacent settings in that function).

- [ ] **Step 8: Run tests + typecheck**

Run: `~/.bun/bin/bun test tests/server/user-note-boost.test.ts`
Expected: PASS.
Run: `npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 9: Commit**

```bash
git add src/server/routes/v1/user-note-boost.ts src/server/routes/v1/ServerV1PostgresRoutes.ts tests/server/user-note-boost.test.ts <settings-registry-file> <resolver-file>
git commit -m "fix(record-intent): MEMSMITH_USER_NOTE_BOOST is an honest on/off toggle

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Build + verify

**Files:** none (verification).

- [ ] **Step 1: Full build + sync**

Run: `npm run build-and-sync`
Expected: `Sync complete!` (no errors).

- [ ] **Step 2: Run all touched-feature tests**

Run: `~/.bun/bin/bun test tests/server/record-intent-endpoint.test.ts tests/server/generation/provider-complete.test.ts tests/server/user-note-boost.test.ts`
Expected: all PASS.

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: exit 0.

---

## Self-Review

**1. Spec coverage:**
- #1 audit parity → Task 1 (classifier returns id + route audits). ✅
- #2 provider-agnostic backstop → Task 2 (providerComplete branches on all 4 labels, env-keyed). ✅
- #3 honest boolean boost → Task 3 (signature + setting + resolver + call site). ✅
- Build/verify → Task 4. ✅

**2. Placeholder scan:** No TBD/"handle edge cases"; every code step has real code. Task 3 Step 1 instructs a grep to locate the exact registry/resolver files (their paths aren't hardcoded because the exact filenames must be confirmed live) — the implementer names them in the commit. Task 3's `<settings-registry-file>`/`<resolver-file>` in the commit are placeholders the implementer fills from Step 1's grep — acceptable since Step 1 discovers them.

**3. Type consistency:** `providerComplete` signature unchanged (Task 2). `classifyAndComposeRecordIntent` return gains `id?: string` (Task 1). `boostUserDirected(ranked, enabled: boolean)` consistent in Task 3's impl + call site + tests. `auditWrite(req, 'memory.write', id, projectId)` matches the `/v1/memories` call at `:939`. ✅
