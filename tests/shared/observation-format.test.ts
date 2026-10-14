import { describe, it, expect } from 'bun:test';
import {
  formatObservationIndex,
  formatObservationContext,
  formatObservationDetails,
  clampLimit,
  SEARCH_LIMIT,
  OUTPUT_MAX_CHARS,
  DETAIL_MAX_CHARS,
} from '../../src/shared/observation-format.js';

const DAY = Date.UTC(2026, 9, 14, 12);

function generated(id: string, overrides: Record<string, unknown> = {}) {
  const title = `Title for ${id}`;
  const narrative = 'N'.repeat(1500);
  const facts = Array.from({ length: 5 }, (_, i) => `- fact ${i} ${'f'.repeat(150)}`).join('\n');
  return {
    id,
    projectId: 'p1',
    teamId: 't1',
    serverSessionId: 's1',
    kind: 'discovery',
    obsType: 'discovery',
    lifecycleState: 'active',
    quality: 80,
    content: `${title}\n\nSubtitle for ${id}\n\n${narrative}\n\n${facts}`,
    metadata: {
      title,
      subtitle: `Subtitle for ${id}`,
      narrative,
      why: 'Because it mattered.',
      files_modified: ['src/a.ts'],
      files_read: ['src/b.ts'],
      concepts: ['search'],
    },
    createdAtEpoch: DAY,
    updatedAtEpoch: DAY,
    ...overrides,
  };
}

describe('formatObservationIndex', () => {
  it('lists id, date, type, title, and a short snippet without the full body', () => {
    const text = formatObservationIndex([generated('obs-1')], { query: 'auth' });
    expect(text).toContain('[obs-1] 2026-10-14 · discovery · Title for obs-1');
    expect(text).toContain('Subtitle for obs-1');
    expect(text).not.toContain('N'.repeat(400));
    expect(text).not.toContain('fact 4');
    expect(text).toContain('observation_get');
  });

  it('keeps 25 realistic results far below the output cap', () => {
    const rows = Array.from({ length: 25 }, (_, i) => generated(`obs-${i}`));
    const text = formatObservationIndex(rows, { query: 'auth' });
    expect(text.length).toBeLessThan(12_000);
    for (let i = 0; i < 25; i++) expect(text).toContain(`[obs-${i}]`);
  });

  it('bounds each entry so oversized titles and bodies cannot blow the budget', () => {
    const rows = Array.from({ length: 25 }, (_, i) =>
      generated(`obs-${i}`, { metadata: { title: 'T'.repeat(5000) }, content: 'T'.repeat(5000) + '\n' + 'B'.repeat(50_000) }));
    const text = formatObservationIndex(rows, { query: 'auth' });
    expect(text.length).toBeLessThan(OUTPUT_MAX_CHARS);
    for (let i = 0; i < 25; i++) expect(text).toContain(`[obs-${i}]`);
  });

  it('falls back to the first content line when metadata has no title', () => {
    const row = generated('note-1', { kind: 'user_note', obsType: null, metadata: {}, content: 'Deploys need the VPN.\nMore detail here.' });
    const text = formatObservationIndex([row], { query: 'vpn' });
    expect(text).toContain('[note-1] 2026-10-14 · user_note · Deploys need the VPN.');
    expect(text).toContain('More detail here.');
  });

  it('strips stray markup tags that generation leaked into titles', () => {
    const row = generated('obs-x', { metadata: { title: 'Fix the router</parameter>' } });
    const text = formatObservationIndex([row], { query: 'router' });
    expect(text).toContain('· Fix the router');
    expect(text).not.toContain('</parameter>');
  });

  it('marks a result that a newer observation superseded', () => {
    const text = formatObservationIndex([generated('old', { supersededBy: 'new' })], { query: 'q' });
    expect(text).toContain('[old] 2026-10-14 · discovery · Title for old · superseded by new');
  });

  it('does not let a huge query echo push the output past the cap', () => {
    const text = formatObservationIndex([generated('obs-1')], { query: 'q'.repeat(25_000) });
    expect(text.length).toBeLessThan(OUTPUT_MAX_CHARS);
    expect(text).toContain('[obs-1]');
  });

  it('says so plainly when nothing matched', () => {
    expect(formatObservationIndex([], { query: 'zzz' })).toContain('No observations matched "zzz"');
  });
});

describe('formatObservationDetails', () => {
  it('returns the full body and the metadata the body does not carry', () => {
    const text = formatObservationDetails([generated('obs-1')], ['obs-1']);
    expect(text).toContain('N'.repeat(1500));
    expect(text).toContain('fact 4');
    expect(text).toContain('Because it mattered.');
    expect(text).toContain('src/a.ts');
    expect(text).not.toContain('"teamId"');
  });

  it('keeps the requested order and reports ids it could not find', () => {
    const text = formatObservationDetails([generated('b'), generated('a')], ['a', 'missing', 'b']);
    expect(text.indexOf('[a]')).toBeLessThan(text.indexOf('[b]'));
    expect(text).toContain('Not found: missing');
  });

  it('stays under the detail cap when a record carries thousands of file paths', () => {
    const a = generated('a', { metadata: { files_read: Array.from({ length: 2000 }, (_, i) => `src/dir/file-${i}.ts`) } });
    const b = generated('b', { content: 'B'.repeat(5_000) });
    const text = formatObservationDetails([a, b], ['a', 'b']);
    expect(text.length).toBeLessThanOrEqual(DETAIL_MAX_CHARS);
    expect(text).toContain('(+1980 more)');
    expect(text).toContain('B'.repeat(5_000));
  });

  it('says when a long body was cut', () => {
    const text = formatObservationDetails([generated('long', { content: 'L'.repeat(10_000) })], ['long']);
    expect(text).toContain('[truncated]');
    expect(text).not.toContain('L'.repeat(7_000));
  });

  it('stays under the detail cap when every requested record is huge', () => {
    const ids = Array.from({ length: 10 }, (_, i) => `big-${i}`);
    const rows = ids.map(id => generated(id, { content: 'C'.repeat(20_000) }));
    const text = formatObservationDetails(rows, ids);
    expect(text.length).toBeLessThanOrEqual(DETAIL_MAX_CHARS);
    expect(text).toContain('[big-0]');
    expect(text).toMatch(/more records? omitted/);
  });
});

describe('formatObservationContext', () => {
  it('packs full bodies with an id header and respects the cap', () => {
    const rows = Array.from({ length: 10 }, (_, i) => generated(`obs-${i}`, { content: 'C'.repeat(4000) }));
    const text = formatObservationContext(rows, { query: 'q' });
    expect(text.length).toBeLessThanOrEqual(OUTPUT_MAX_CHARS);
    expect(text).toContain('[obs-0] 2026-10-14 · discovery');
    expect(text).toMatch(/more results? omitted/);
  });

  it('truncates a single oversized observation instead of returning nothing', () => {
    const text = formatObservationContext([generated('big', { content: 'C'.repeat(50_000) })], { query: 'q' });
    expect(text).toContain('[big]');
    expect(text.length).toBeLessThanOrEqual(OUTPUT_MAX_CHARS);
  });
});

describe('clampLimit', () => {
  it('defaults, floors, and caps the requested limit', () => {
    expect(clampLimit(undefined, SEARCH_LIMIT)).toBe(10);
    expect(clampLimit(40, SEARCH_LIMIT)).toBe(25);
    expect(clampLimit(0, SEARCH_LIMIT)).toBe(1);
    expect(clampLimit(7.9, SEARCH_LIMIT)).toBe(7);
    expect(clampLimit('12' as unknown as number, SEARCH_LIMIT)).toBe(10);
  });
});
