// tests/server/services/event-payload-scrub.test.ts
import { describe, it, expect } from 'bun:test';
import { scrubEventPayload } from '../../../src/server/services/event-payload-scrub.js';

describe('scrubEventPayload', () => {
  it('strips <private> content from nested string values', () => {
    const input = {
      tool_name: 'Bash',
      tool_input: { command: 'echo <private>SECRET_TOKEN</private> done' },
      tool_response: 'ok <private>hunter2</private>',
      nested: { deep: ['keep <private>drop</private>', 'plain'] },
    };
    const out = scrubEventPayload(input) as typeof input;
    expect(JSON.stringify(out)).not.toContain('SECRET_TOKEN');
    expect(JSON.stringify(out)).not.toContain('hunter2');
    expect(JSON.stringify(out)).not.toContain('drop');
    expect(out.tool_input.command).toContain('echo');
    expect(out.tool_input.command).toContain('done');
    expect(out.nested.deep[1]).toBe('plain');
  });

  it('leaves a tag-free payload semantically unchanged', () => {
    const input = { a: 'hello', b: { c: 42, d: true, e: null } };
    const out = scrubEventPayload(input);
    expect(out).toEqual({ a: 'hello', b: { c: 42, d: true, e: null } });
  });

  it('does not mutate the original payload', () => {
    const input = { x: 'a <private>b</private> c' };
    scrubEventPayload(input);
    expect(input.x).toBe('a <private>b</private> c');
  });
});
