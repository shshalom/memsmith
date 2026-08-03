// SPDX-License-Identifier: Apache-2.0
//
// Every control in the Context pane must actually control something.
//
// The pane rendered nine MEMSMITH_CONTEXT_* fields. EIGHT had no reader: they
// were consumed by the legacy worker's context-generator, deleted in a41c8578
// ("remove worker HTTP core + service"). The settings outlived the code that
// read them, so a user could change a value, watch it save, and have it change
// nothing — which is why the tab read as "not usable or not complete".
//
// Worse, the inverse also existed: MEMSMITH_CONTEXT_SHOW_TERMINAL_OUTPUT IS read
// (context.ts:149) and had no control at all. A working setting with no way to
// reach it, sitting beside controls that reached nothing.
//
// A dead setting is worse than a missing one: it looks like a lever, so the user
// spends time deciding what to set it to, then wondering why nothing changed.
// This guard is structural — it walks the pane's fields and requires each to
// have a reader outside the UI/defaults layer.
import { describe, it, expect } from 'bun:test';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

const REPO = join(import.meta.dir, '..', '..');
const read = (rel: string) => readFileSync(join(REPO, rel), 'utf-8');

/** Every .ts/.tsx under src/, minus the layers that only DECLARE settings. */
function runtimeSources(): string[] {
  const out: string[] = [];
  const skip = /ui\/viewer\/types\.ts|ui\/viewer\/constants\/settings\.ts|SettingsDefaultsManager\.ts|ContextSettingsPane\.tsx/;
  const walk = (dir: string) => {
    for (const e of readdirSync(dir)) {
      if (e === 'node_modules' || e.startsWith('.')) continue;
      const full = join(dir, e);
      if (statSync(full).isDirectory()) { walk(full); continue; }
      if (!/\.tsx?$/.test(full) || skip.test(full)) continue;
      out.push(full);
    }
  };
  walk(join(REPO, 'src'));
  return out;
}

/** Keys the pane renders a control for. */
function paneKeys(): string[] {
  const src = read('src/ui/viewer/components/ContextSettingsPane.tsx');
  // Only real usages — comments explaining removals name the dead keys too.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  return [...new Set(Array.from(code.matchAll(/MEMSMITH_CONTEXT_[A-Z_]+/g), m => m[0]))];
}

describe('Context pane controls are wired to something', () => {
  const sources = runtimeSources().map(f => readFileSync(f, 'utf-8')).join('\n');

  it('renders at least one control (guard against an empty pane)', () => {
    expect(paneKeys().length).toBeGreaterThan(0);
  });

  it('EVERY rendered control has a runtime reader', () => {
    const orphans = paneKeys().filter(k => !sources.includes(k));
    // Named, not counted: a new orphan should be obvious from the failure.
    expect(orphans).toEqual([]);
  });

  it('the six worker-era display toggles are gone', () => {
    // They were removed rather than revived: the banner they rendered lines in
    // went with the worker, and the dashboard reports cost/savings properly now.
    const pane = read('src/ui/viewer/components/ContextSettingsPane.tsx')
      .replace(/\/\*[\s\S]*?\*\//g, '');
    for (const dead of [
      'MEMSMITH_CONTEXT_SHOW_READ_TOKENS',
      'MEMSMITH_CONTEXT_SHOW_WORK_TOKENS',
      'MEMSMITH_CONTEXT_SHOW_SAVINGS_AMOUNT',
      'MEMSMITH_CONTEXT_SHOW_SAVINGS_PERCENT',
      'MEMSMITH_CONTEXT_SHOW_LAST_SUMMARY',
      'MEMSMITH_CONTEXT_SHOW_LAST_MESSAGE',
    ]) {
      expect({ key: dead, present: pane.includes(dead) }).toEqual({ key: dead, present: false });
    }
  });

  it('exposes SHOW_TERMINAL_OUTPUT, which was live but unreachable', () => {
    const pane = read('src/ui/viewer/components/ContextSettingsPane.tsx');
    expect(pane).toContain('MEMSMITH_CONTEXT_SHOW_TERMINAL_OUTPUT');
    // And it must still be the setting the handler reads.
    expect(read('src/cli/handlers/context.ts')).toContain('MEMSMITH_CONTEXT_SHOW_TERMINAL_OUTPUT');
  });
});

describe('SESSION_COUNT actually changes the injected count', () => {
  const handler = read('src/cli/handlers/context.ts');

  it('SessionStart reads the setting instead of a hardcoded constant', () => {
    // It was `limit: args.limit ?? SESSION_START_RECENT_LIMIT` — a fixed 10 —
    // while a control for exactly this number sat in Settings doing nothing.
    expect(handler).toContain('resolveSessionStartLimit(settings.MEMSMITH_CONTEXT_SESSION_COUNT)');
  });

  it('clamps rather than trusting the value', () => {
    expect(handler).toContain('MIN_SESSION_OBSERVATIONS');
    expect(handler).toContain('MAX_SESSION_OBSERVATIONS');
  });
});
