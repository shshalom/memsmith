// tests/plugin/hooks-record-intent.test.ts
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs'; import { join } from 'path';
const hooks = JSON.parse(readFileSync(join(process.cwd(), 'plugin/hooks/hooks.json'), 'utf-8'));
const cmds = (ev: string) => (hooks.hooks[ev] ?? []).flatMap((g: any) => (g.hooks ?? []).map((h: any) => h.command as string));
describe('record-intent hook wired', () => {
  it('UserPromptSubmit runs record-intent', () => {
    expect(cmds('UserPromptSubmit').some(c => c.includes('hook claude-code record-intent'))).toBe(true);
  });
});
