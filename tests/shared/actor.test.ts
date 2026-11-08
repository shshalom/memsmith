import { describe, expect, it } from 'bun:test';
import { derivedActorMetadata, parseActor, resolveActor, type ActorSource } from '../../src/shared/actor.js';

const source = (env: string | undefined, setting?: string): ActorSource => ({ env: () => env, setting: () => setting });

describe('parseActor', () => {
  it('trims the name and treats blank as unset', () => {
    expect(parseActor('  reviewer  ')).toEqual({ ok: true, actor: 'reviewer' });
    expect(parseActor('   ')).toEqual({ ok: true, actor: null });
    expect(parseActor(undefined)).toEqual({ ok: true, actor: null });
  });

  it('accepts 64 characters and rejects 65', () => {
    expect(parseActor('a'.repeat(64))).toEqual({ ok: true, actor: 'a'.repeat(64) });
    expect(parseActor('a'.repeat(65)).ok).toBe(false);
  });

  it('rejects control characters, which would forge lines in text output', () => {
    expect(parseActor('rev\niewer').ok).toBe(false);
    expect(parseActor('rev\u001b[31m').ok).toBe(false);
    expect(parseActor('rev\u0085x').ok).toBe(false);
  });
});

describe('resolveActor', () => {
  it('prefers MEMSMITH_ACTOR over the settings default and the subagent type', () => {
    expect(resolveActor({ agentId: 'a1', agentType: 'Explore' }, source('reviewer', 'default-actor'))).toBe('reviewer');
  });

  it('uses the settings default when the environment does not set one', () => {
    expect(resolveActor({}, source(undefined, 'default-actor'))).toBe('default-actor');
    expect(resolveActor({}, source('  ', 'default-actor'))).toBe('default-actor');
  });

  it('falls back to the subagent type for an event from a subagent', () => {
    expect(resolveActor({ agentId: 'a1', agentType: 'code-reviewer' }, source(undefined))).toBe('code-reviewer');
  });

  it('does not treat a main session started with --agent as a subagent', () => {
    expect(resolveActor({ agentType: 'code-reviewer' }, source(undefined))).toBeNull();
  });

  it('ignores an invalid configured actor and falls through to the subagent type', () => {
    expect(resolveActor({ agentId: 'a1', agentType: 'Explore' }, source('bad\nname'))).toBe('Explore');
    expect(resolveActor({}, source('x'.repeat(65)))).toBeNull();
  });
});

describe('derivedActorMetadata', () => {
  it('sets actor only when exactly one distinct actor took part', () => {
    expect(derivedActorMetadata(['reviewer', 'reviewer', undefined])).toEqual({ actor: 'reviewer', actors: ['reviewer'] });
    expect(derivedActorMetadata(['reviewer', 'Explore', 'reviewer'])).toEqual({ actors: ['reviewer', 'Explore'] });
    expect(derivedActorMetadata([undefined, null, ''])).toEqual({});
  });
});
