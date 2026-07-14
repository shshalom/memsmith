# Settings Consolidation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One tabbed Settings page (System / Context / Identity) with a per-setting ⓘ info tooltip; retire the footer ⚙ cogwheel + `ContextSettingsModal`.

**Architecture:** Frontend-only consolidation. `SettingsView` becomes a 3-tab host. The cogwheel modal's content (context-display prefs + live preview) moves into the Context tab, still saving to settings.json via the existing `useSettings` hook. A shared `InfoTooltip` renders the ⓘ on every row. System ⓘ text comes from `settingKeys.ts` `description` (already exists); Context/Identity ⓘ text is authored in the viewer. No new stores, no server changes, no change to the SessionStart injection read path.

**Tech Stack:** React (viewer), TypeScript, Bun (test), existing viewer CSS classes (`settings-*`, `tooltip-trigger`).

**Spec:** `docs/superpowers/specs/2026-07-14-settings-consolidation-design.md`

## Global Constraints

- **Storage split is intentional (Option 3):** System + Identity save via `/v1` (`patchSettings`/`fetchSettings`/`fetchIdentity`); **Context prefs (`MEMSMITH_CONTEXT_*`) save via settings.json** through the existing `useSettings`/`saveSettings` hook — NOT `/v1`. Do NOT add any hook→server fetch; the SessionStart injection reader (`src/cli/handlers/context.ts`) must remain untouched.
- **ⓘ copy single-source for System:** surface the `description` field already on each `SETTING_KEYS` entry in `src/server/settings/settingKeys.ts`. Do NOT duplicate that copy in the viewer. Extend a `description` string there only if too terse to convey the system effect (copy change, no schema change).
- **Match existing viewer aesthetics:** reuse the existing `settings-*` CSS classes and the warm Claude palette (`#cc785c` accent, `#f0eee6`/`#1a1815` surfaces). Do NOT introduce a new design system or restyle unrelated components. The tab bar + ⓘ should look native to the current SettingsView. (Executor: the frontend-design skill's "match surrounding code / no generic AI slop" guidance applies — this is polish within an existing aesthetic, not a redesign.)
- **Don't gut coverage:** the modal's field tests move to the Context-pane tests; don't delete assertions.
- Never rename keep-list deps. Commit trailer `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`. Branch `settings-consolidation`. Do not push. Do NOT `git checkout <hash>` (detaches HEAD).
- Bun clean-env: `env -i HOME="$HOME" PATH=/opt/homebrew/bin:/usr/bin:/bin ~/.bun/bin/bun ...`. Viewer builds via `node scripts/build-viewer.js`; authoritative typecheck `bunx tsc --noEmit`.

---

### Task 1: `InfoTooltip` shared component

**Files:**
- Create: `src/ui/viewer/components/InfoTooltip.tsx`
- Test: `tests/viewer/info-tooltip.test.tsx` (if the viewer test setup supports component render tests; otherwise a logic-only test of the "empty text → no icon" rule — check `ls tests/viewer/` and how existing viewer components are tested first)

**Interfaces:**
- Produces: `<InfoTooltip text={string | undefined} />` — renders a ⓘ icon that reveals `text` on hover/focus; renders NOTHING when `text` is empty/undefined.

- [ ] **Step 1: Write the failing test**

Check the viewer test convention first: `ls tests/viewer/ 2>/dev/null; grep -rln "render\|@testing-library\|renderToString" tests/viewer/ | head`. If component-render tests exist, model on them. If the viewer has NO React render-test harness, write a minimal one using `react-dom/server` `renderToString` (no new deps):

Create `tests/viewer/info-tooltip.test.tsx`:

```tsx
import { describe, it, expect } from 'bun:test';
import { renderToString } from 'react-dom/server';
import { InfoTooltip } from '../../src/ui/viewer/components/InfoTooltip.js';

describe('InfoTooltip', () => {
  it('renders the info icon and the tooltip text when text is provided', () => {
    const html = renderToString(<InfoTooltip text="Blends keyword + semantic ranking." />);
    expect(html).toContain('Blends keyword + semantic ranking.');
    // the icon marker (class or aria) is present
    expect(html.toLowerCase()).toContain('info');
  });

  it('renders nothing when text is empty', () => {
    expect(renderToString(<InfoTooltip text="" />)).toBe('');
  });

  it('renders nothing when text is undefined', () => {
    expect(renderToString(<InfoTooltip text={undefined} />)).toBe('');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `env -i HOME="$HOME" PATH=/opt/homebrew/bin:/usr/bin:/bin ~/.bun/bin/bun test tests/viewer/info-tooltip.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement InfoTooltip**

Create `src/ui/viewer/components/InfoTooltip.tsx`. Generalize the existing `tooltip-trigger` pattern from `ContextSettingsModal` (the `<span className="tooltip-trigger" title={tooltip}>` idiom) into a reusable component. Use the native `title` attribute for the hover text (matches the existing pattern and needs no popover infra), plus an accessible label:

```tsx
import React from 'react';

interface InfoTooltipProps {
  text?: string;
}

// Small ⓘ affordance: explains a setting on hover/focus. Renders nothing when
// there's no text (so callers can pass an optional description unconditionally).
// Reuses the existing `tooltip-trigger` CSS + native title attribute — no popover
// infra, matches ContextSettingsModal's prior idiom.
export function InfoTooltip({ text }: InfoTooltipProps): React.ReactElement | null {
  if (!text) return null;
  return (
    <span
      className="info-tooltip tooltip-trigger"
      role="img"
      aria-label={text}
      title={text}
      tabIndex={0}
    >
      ⓘ
    </span>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `env -i HOME="$HOME" PATH=/opt/homebrew/bin:/usr/bin:/bin ~/.bun/bin/bun test tests/viewer/info-tooltip.test.tsx`
Expected: PASS (3/3).

- [ ] **Step 5: Add minimal CSS for `.info-tooltip`**

In the viewer stylesheet that defines `settings-*` / `tooltip-trigger` (find it: `grep -rln "tooltip-trigger\|settings-row-label" src/ui/ --include="*.css" --include="*.html"`), add a small rule so the ⓘ sits inline, muted, and highlights on hover (accent `#cc785c`). Keep it consistent with existing `tooltip-trigger`. If tooltip-trigger already styles it acceptably, just ensure `.info-tooltip` inherits/extends — do not restyle unrelated selectors.

- [ ] **Step 6: Commit**

```bash
git add src/ui/viewer/components/InfoTooltip.tsx tests/viewer/info-tooltip.test.tsx <the css file>
git commit -m "$(printf 'feat(settings): InfoTooltip shared component (per-setting explanation)\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

### Task 2: Tab host + System/Identity ⓘ

**Files:**
- Modify: `src/ui/viewer/views/SettingsView.tsx`
- Modify: `src/server/settings/settingKeys.ts` (only if a `description` is too terse — copy edits)
- Modify: `src/ui/viewer/utils/settingsData.ts` (only if `description` isn't already carried per field from `/v1`)
- Test: `tests/viewer/settings-view-tabs.test.tsx` (create; or extend existing SettingsView test if present)

**Interfaces:**
- Consumes: `InfoTooltip` (Task 1); existing `fetchSettings`/`fetchIdentity`/`SettingField`.
- Produces: `SettingsView` with tab state `'system' | 'context' | 'identity'`, a tab bar, and panes. The **Context** pane is a placeholder in this task (a stub `<div>`), filled in Task 3.

- [ ] **Step 1: Confirm `description` reaches the client**

Read `src/ui/viewer/utils/settingsData.ts` + the `SettingField` type. Confirm each field from `/v1/settings` carries its `description` (from `settingKeys.ts`). If it does NOT, add `description` to the `SettingField` shape and ensure the `/v1/settings` payload includes it (the server route reads `SETTING_KEYS`; the description is already there — just surface it). Document what you changed.

- [ ] **Step 2: Write the failing test**

Create `tests/viewer/settings-view-tabs.test.tsx` (model on the existing SettingsView test harness — `grep -rln "SettingsView" tests/`). Use `initialFields` (SettingsView already accepts it) to render without network:

```tsx
import { describe, it, expect } from 'bun:test';
import { renderToString } from 'react-dom/server';
import SettingsView from '../../src/ui/viewer/views/SettingsView.js';

const fields = {
  provider: { key: 'provider', value: 'ollama', type: 'enum', label: 'Generation model', description: 'Who distills your memory.' },
  searchHybrid: { key: 'searchHybrid', value: true, type: 'boolean', label: 'Hybrid search', description: 'Blend keyword + semantic ranking.' },
} as any;

describe('SettingsView tabs', () => {
  it('renders System tab with a setting description as tooltip text', () => {
    const html = renderToString(<SettingsView initialFields={fields} />);
    expect(html).toContain('System');   // tab label
    expect(html).toContain('Context');  // tab label
    expect(html).toContain('Identity'); // tab label
    expect(html).toContain('Who distills your memory.'); // System ⓘ text surfaced
  });
});
```

(If SSR of the full view is impractical because of the mount-effect fetch, assert against the tab-bar + group render with `initialFields` set so the effect early-returns — SettingsView already does `if (initialFields) return;` in its effect. Adapt the assertion to what renders deterministically; the binding assertion is: three tab labels present + a System field's description surfaced as ⓘ text.)

- [ ] **Step 3: Run test to verify it fails**

Run: `env -i HOME="$HOME" PATH=/opt/homebrew/bin:/usr/bin:/bin ~/.bun/bin/bun test tests/viewer/settings-view-tabs.test.tsx`
Expected: FAIL — no tabs yet.

- [ ] **Step 4: Add tab state + tab bar + panes**

In `SettingsView`:
- Add `const [tab, setTab] = useState<'system'|'context'|'identity'>('system');`
- Render a tab bar (reuse the nav/tab styling idiom already in the viewer; classes like `settings-tabs`/`settings-tab` — add minimal CSS if absent, matching the sidebar's active-accent treatment).
- Wrap the existing System groups (`GROUP_DEFS` → `SettingRow`s + savings strip) in the `system` pane.
- Move the existing Identity card render into the `identity` pane.
- Add a `context` pane containing a stub `<div data-testid="context-pane-stub" />` (filled in Task 3).
- In `SettingRow` (or wherever a row's label renders — line ~127 `settings-row-label`), add `<InfoTooltip text={field.description} />` next to the label so every System row gets its ⓘ. Do the same for the Identity rows with authored `text=` strings (short, effect-focused — e.g. Team ID: "The durable team this project's memory is scoped to; the base key grants access to it.").

- [ ] **Step 5: Run test to verify it passes**

Run: `env -i HOME="$HOME" PATH=/opt/homebrew/bin:/usr/bin:/bin ~/.bun/bin/bun test tests/viewer/settings-view-tabs.test.tsx`
Expected: PASS.

- [ ] **Step 6: Typecheck**

Run: `env -i HOME="$HOME" PATH=/opt/homebrew/bin:/usr/bin:/bin ~/.bun/bin/bunx tsc --noEmit 2>&1 | grep "error TS" | grep -v "bun:test\|node_modules"`
Expected: empty.

- [ ] **Step 7: Commit**

```bash
git add src/ui/viewer/views/SettingsView.tsx tests/viewer/settings-view-tabs.test.tsx src/ui/viewer/utils/settingsData.ts src/server/settings/settingKeys.ts <css>
git commit -m "$(printf 'feat(settings): tabbed SettingsView (System/Context/Identity) + info tooltips on System/Identity\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

### Task 3: Context pane (extract from the modal)

**Files:**
- Modify: `src/ui/viewer/views/SettingsView.tsx` (fill the `context` pane)
- Modify/remove: `src/ui/viewer/components/ContextSettingsModal.tsx` (content extracted)
- Test: `tests/viewer/settings-context-pane.test.tsx` (create; migrate the modal's field/behavior assertions here — don't gut them)

**Interfaces:**
- Consumes: `useContextPreview` hook, `useSettings`/`saveSettings` (the settings.json save path), `InfoTooltip`.
- Produces: the Context pane rendering the `MEMSMITH_CONTEXT_*` fields + live preview, saving to settings.json.

- [ ] **Step 1: Locate the modal's reusable innards**

Read `ContextSettingsModal.tsx` fully. It contains: `ToggleSwitch`, the `MEMSMITH_CONTEXT_*` field rows (with their existing tooltips), and the `useContextPreview` preview panel. Plan the extraction: the field rows + preview become a `ContextSettingsPane` (either a new `src/ui/viewer/components/ContextSettingsPane.tsx` or an inline section in SettingsView — prefer a small dedicated component for testability). The modal's chrome (isOpen/onClose/overlay) is dropped.

- [ ] **Step 2: Write the failing test**

Create `tests/viewer/settings-context-pane.test.tsx`. Migrate the meaningful assertions from any existing `ContextSettingsModal` test (find: `grep -rln "ContextSettingsModal" tests/`). Assert: the pane renders the context fields (e.g. "Observations to inject", a SHOW_ toggle), each carries an ⓘ, and editing a field calls the settings.json save path (`saveSettings`), NOT `/v1` `patchSettings`. Reference:

```tsx
import { describe, it, expect } from 'bun:test';
import { renderToString } from 'react-dom/server';
import { ContextSettingsPane } from '../../src/ui/viewer/components/ContextSettingsPane.js';

describe('ContextSettingsPane', () => {
  it('renders context display fields with info tooltips', () => {
    const html = renderToString(
      <ContextSettingsPane settings={{ MEMSMITH_CONTEXT_OBSERVATIONS: '50', MEMSMITH_CONTEXT_SHOW_SAVINGS_PERCENT: 'true' } as any}
        onSave={() => {}} isSaving={false} saveStatus={null} />);
    expect(html).toContain('Observations to inject');   // a context field label
    expect(html.toLowerCase()).toContain('info');        // ⓘ present
  });

  it('editing a field routes to onSave (settings.json path), not /v1', () => {
    let saved: any = null;
    // Drive an onChange through the pane's control and assert onSave receives the
    // MEMSMITH_CONTEXT_* mutation. (Use the pane's exported handler or a light
    // interaction; the binding assertion is: the settings.json onSave is the sink.)
    // Adapt to the real control wiring.
    expect(true).toBe(true); // replace with a real onSave-called assertion per the pane's API
  });
});
```

Note: the second test's placeholder MUST be replaced with a real assertion that a context-field edit calls `onSave` (the settings.json sink). If SSR can't drive an onChange, test the pane's change handler directly (extract it or call the prop). Do NOT leave a tautology.

- [ ] **Step 3: Run test to verify it fails**

Run: `env -i HOME="$HOME" PATH=/opt/homebrew/bin:/usr/bin:/bin ~/.bun/bin/bun test tests/viewer/settings-context-pane.test.tsx`
Expected: FAIL — pane not created.

- [ ] **Step 4: Extract the pane + wire into the Context tab**

- Create `ContextSettingsPane.tsx` from the modal's field rows + `useContextPreview` panel. Props: `{ settings, onSave, isSaving, saveStatus }` (same as the modal minus `isOpen`/`onClose`). Each field row uses `<InfoTooltip text={...}>` (migrate the existing `tooltip` strings; author any missing ones).
- In `SettingsView`, replace the `context` pane stub with `<ContextSettingsPane settings={...} onSave={...} .../>`. SettingsView needs access to `useSettings` — either lift `useSettings` into SettingsView, or pass the settings + saveSettings down from `App.tsx` as props. Prefer: SettingsView calls `useSettings()` itself for the context pane (keeps App clean). Confirm `useSettings` is safe to call in SettingsView.

- [ ] **Step 5: Run test to verify it passes**

Run: `env -i HOME="$HOME" PATH=/opt/homebrew/bin:/usr/bin:/bin ~/.bun/bin/bun test tests/viewer/settings-context-pane.test.tsx`
Expected: PASS (both, incl. the real onSave assertion).

- [ ] **Step 6: Typecheck**

Run: `env -i HOME="$HOME" PATH=/opt/homebrew/bin:/usr/bin:/bin ~/.bun/bin/bunx tsc --noEmit 2>&1 | grep "error TS" | grep -v "bun:test\|node_modules"`
Expected: empty.

- [ ] **Step 7: Commit**

```bash
git add src/ui/viewer/components/ContextSettingsPane.tsx src/ui/viewer/views/SettingsView.tsx tests/viewer/settings-context-pane.test.tsx
git commit -m "$(printf 'feat(settings): Context pane in Settings tab (extracted from cogwheel modal)\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

### Task 4: Retire the cogwheel + modal; build & verify

**Files:**
- Modify: `src/ui/viewer/App.tsx` (remove modal mount + cogwheel toggle)
- Remove: `src/ui/viewer/components/ContextSettingsModal.tsx` (once nothing imports it)
- Migrate/remove: any `ContextSettingsModal` test file (its assertions now live in the Context-pane test)

**Interfaces:**
- Consumes: the Context pane now lives in SettingsView (Task 3).
- Produces: a viewer with a single Settings entry point.

- [ ] **Step 1: Remove the modal mount + cogwheel from App.tsx**

In `src/ui/viewer/App.tsx`: remove the `<ContextSettingsModal .../>` mount (~line 81), the `import { ContextSettingsModal }` (line 3), and the cogwheel button + its `contextPreviewOpen`/`toggleContextPreview` state that toggled it (grep them: `grep -nE "contextPreview|toggleContextPreview|ContextSettingsModal" src/ui/viewer/App.tsx`). Leave the LogsDrawer/console button and everything else intact.

- [ ] **Step 2: Confirm nothing else imports the modal, then delete it**

Run: `grep -rn "ContextSettingsModal" src/ tests/ --include="*.ts" --include="*.tsx" | grep -v "ContextSettingsPane"`
Expected: only the (now-removed) test file, if any. If clean, `git rm src/ui/viewer/components/ContextSettingsModal.tsx` and remove/rewrite its test to point at `ContextSettingsPane` (migrate assertions already done in Task 3 — delete the dead modal test).

- [ ] **Step 3: Typecheck + viewer build**

Run: `env -i HOME="$HOME" PATH=/opt/homebrew/bin:/usr/bin:/bin ~/.bun/bin/bunx tsc --noEmit 2>&1 | grep "error TS" | grep -v "bun:test\|node_modules"` → empty.
Run: `env -i HOME="$HOME" PATH=/opt/homebrew/bin:/usr/bin:/bin ~/.bun/bin/node scripts/build-viewer.js 2>&1 | tail -5` → builds clean.

- [ ] **Step 4: Grep-gate — cogwheel/modal gone**

Run: `grep -rn "ContextSettingsModal\|contextPreviewOpen\|toggleContextPreview" src/ui/ --include="*.tsx" | grep -v "ContextSettingsPane"`
Expected: ZERO matches.

- [ ] **Step 5: Viewer test suite regression**

Run: `env -i HOME="$HOME" PATH=/opt/homebrew/bin:/usr/bin:/bin ~/.bun/bin/bun test tests/viewer/ 2>&1 | tail -6`
Expected: all viewer tests pass (incl. the 3 new); no orphaned ContextSettingsModal test failing.

- [ ] **Step 6: Commit**

```bash
git add src/ui/viewer/App.tsx
git rm src/ui/viewer/components/ContextSettingsModal.tsx  # if confirmed unused
# stage any removed/rewritten modal test
git commit -m "$(printf 'feat(settings): retire footer cogwheel + ContextSettingsModal (single Settings entry point)\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

## Final: build-and-sync + full regression

- `env -i HOME="$HOME" PATH=/opt/homebrew/bin:/usr/bin:/bin ~/.bun/bin/bunx tsc --noEmit` → clean.
- `env -i HOME="$HOME" PATH=/opt/homebrew/bin:/usr/bin:/bin:$HOME/.bun/bin npm run build-and-sync` → "Sync complete!"; `.mcp.json` still in marketplace (regression check for the earlier sync fix); no worker-service.cjs resurrection.
- Full suite: no new failures beyond the pre-existing ~29 baseline.

## Notes for the executor

- Tasks chain: 2 uses 1; 3 fills the stub 2 created; 4 removes what 3 replaced. Do them in order.
- The one correctness rule: Context prefs save to **settings.json** (via `useSettings`/`saveSettings`), never `/v1` — and `src/cli/handlers/context.ts` (the injection reader) is NOT touched.
- Match the existing viewer aesthetic; the tab bar and ⓘ should feel native. No new design system.
- If SSR-based component tests prove impractical in this viewer's test setup, STOP and report — don't fall back to tautological assertions.
