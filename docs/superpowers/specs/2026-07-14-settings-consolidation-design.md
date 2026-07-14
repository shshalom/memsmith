# MemSmith Settings Consolidation — Design

**Goal:** Replace the two confusing "settings" entry points (the sidebar `Settings` page and the footer ⚙ cogwheel modal) with one unified, tabbed Settings page, and add a per-setting ⓘ info tooltip that explains what each setting does and how it affects the system.

## Problem

The viewer has two things that both read as "settings":
- **Sidebar `Settings`** → `SettingsView` (server-behavior knobs via `/v1`, PG-backed) — Generation, Retrieval, Quality, Limits, plus the Identity surface (team/project/key).
- **Footer ⚙ cogwheel** → `ContextSettingsModal` — context-injection *display* prefs (`MEMSMITH_CONTEXT_*`, settings.json-backed) + a live context preview.

They serve different purposes and different stores, but the duplicate "settings" affordance is confusing, and most settings have no in-UI explanation.

## Design decisions (locked in brainstorm)

1. **Tabbed page, three tabs:** **System** (Generation / Retrieval / Quality / Limits), **Context** (display prefs + live preview), **Identity** (team / project / key). The tab layout was mocked and approved.
2. **ⓘ info affordance per setting:** a small ⓘ icon beside each setting; hover (or click on touch) shows a 1-2 sentence tooltip explaining what it does + its system effect. Reuse the existing `tooltip-trigger` pattern already in `ContextSettingsModal`.
3. **Retire the footer cogwheel:** the `ContextSettingsModal`'s content moves into the Context tab; the cogwheel button and the modal are removed.
4. **Storage stays split (Option 3):** System + Identity remain `/v1`/PG-backed; **Context prefs stay in `settings.json`** (`MEMSMITH_CONTEXT_*`) via the existing `useSettings`/`saveSettings` hook. Rationale: the `MEMSMITH_CONTEXT_*` readers are HOOK-SIDE (`src/cli/handlers/context.ts:129`, `src/utils/claude-md-utils.ts:233`, `src/cli/claude-md-commands.ts:378`) — they read `settings.json` synchronously. Migrating them to `/v1` would put a hook→server HTTP fetch on the SessionStart injection hot path (real latency/failure risk) for a speculative team-share benefit on cosmetic display prefs. Deferred — see "Deferred".

## Architecture / components

**Single page, tab-switched. No new data stores.** Each tab reads/writes its existing backing:

- **`SettingsView`** (`src/ui/viewer/views/SettingsView.tsx`) becomes the tab host. It already renders System groups (`GROUP_DEFS`) + Identity (via `fetchIdentity`). Add:
  - Tab state (`system` | `context` | `identity`), a tab bar, and three panes.
  - The **Context** pane renders the display prefs currently in `ContextSettingsModal` (the `MEMSMITH_CONTEXT_*` fields + the live preview via `useContextPreview`), wired to `useSettings`/`saveSettings` (settings.json path) — NOT to `/v1`.
- **`InfoTooltip`** — a small shared component (extract/generalize the `tooltip-trigger` from `ContextSettingsModal`): renders the ⓘ icon + hover/click tooltip. Used by every setting row across all three tabs.
- **Info copy source:**
  - System settings: reuse the `description` already on each entry in `src/server/settings/settingKeys.ts` (all 13 have `label`+`description`). Surface `description` as the ⓘ text. Where a one-liner is too terse to convey the *system effect*, extend that `description` string (single source — the API already returns it).
  - Context prefs + Identity: author ⓘ copy (1-2 sentences each) co-located with their field definitions in the viewer (these have no server registry). Keep them short and effect-focused, matching the mocked wording.
- **`App.tsx`**: remove the `ContextSettingsModal` mount + the footer cogwheel button that toggled it. The sidebar `Settings` nav item stays (now the only settings entry point).

**Files touched:**
- `src/ui/viewer/views/SettingsView.tsx` — tabs + Context pane + ⓘ on rows.
- `src/ui/viewer/components/ContextSettingsModal.tsx` — content extracted into the Context pane; the modal component is removed (or reduced to nothing and deleted).
- `src/ui/viewer/components/InfoTooltip.tsx` (new) — shared ⓘ component.
- `src/ui/viewer/App.tsx` — drop the cogwheel button + modal mount.
- `src/ui/viewer/utils/settingsData.ts` — if System ⓘ text comes from the `/v1/settings` payload, ensure `description` is included per field (it may already be); no new endpoint.
- `src/server/settings/settingKeys.ts` — extend any `description` too terse to explain the system effect (copy only, no schema change).

## Data flow

- **System tab:** `fetchSettings()` (`/v1/settings`) → render rows with values + `description` for ⓘ → edit → `patchSettings()` (`/v1`). Unchanged from today except ⓘ surfacing.
- **Context tab:** `useSettings()` reads `MEMSMITH_CONTEXT_*` (settings.json) → render toggles/number + live preview (`useContextPreview`) → `saveSettings()` writes settings.json. Same path the modal used.
- **Identity tab:** `fetchIdentity()` → read-only display + Reveal. Unchanged.

No new network calls on any hot path; the SessionStart injection reader (`context.ts`) is untouched.

## Error handling

- ⓘ tooltip is presentational; missing description → no ⓘ icon (don't render an empty tooltip).
- Context tab save failure surfaces the same way the modal's save did (existing `saveStatus` from `useSettings`).
- Removing the modal must not break `useContextPreview` consumers — the preview moves with the fields into the Context pane; confirm no other component mounts `ContextSettingsModal`.

## Testing

- **InfoTooltip:** renders the ⓘ, shows the passed text on hover/focus, renders nothing when text is empty.
- **SettingsView tabs:** each tab renders its expected groups; switching tabs shows the right pane; System rows carry the `description` as ⓘ text; Context pane renders the `MEMSMITH_CONTEXT_*` fields + preview; Identity pane renders team/project/masked key.
- **Context save path:** editing a Context pref calls the settings.json save hook (not `/v1`) — assert the save mechanism, guarding the Option-3 decision.
- **Cogwheel removed:** `App.tsx` no longer mounts `ContextSettingsModal` / renders the cogwheel button (a test or a grep-gate).
- Viewer build clean; existing viewer tests updated to the consolidated structure (don't gut coverage — the modal's field tests move to the Context-pane tests); full suite no new failures beyond baseline.

## Acceptance criteria

1. One Settings page with System / Context / Identity tabs; the footer ⚙ cogwheel and `ContextSettingsModal` are gone.
2. Every setting row has an ⓘ that shows a 1-2 sentence what-it-does + system-effect explanation on hover/click.
3. System/Identity save via `/v1`; Context prefs save via settings.json (unchanged readers, no hot-path network fetch).
4. System ⓘ text is sourced from `settingKeys.ts` `description` (single source); no duplicated copy.
5. Viewer builds; the injection/`context.ts` read path is untouched; full suite at pre-existing baseline.

## Deferred (documented follow-on, NOT this spec)

- **Migrate `MEMSMITH_CONTEXT_*` to `/v1`/PG** so all settings share one store and context prefs become team-shareable. Requires updating the hook-side readers (`context.ts`, claude-md utils) to fetch from the server — adds a fetch to the SessionStart path. Do this only when team-shareable context prefs are an actual need; until then the split store is the safer choice.
