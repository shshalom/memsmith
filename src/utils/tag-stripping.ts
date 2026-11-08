
import { logger } from './logger.js';

const TAG_NAMES = [
  'private',
  'memsmith-context',
  'system_instruction',
  'system-instruction',
  'persisted-output',
  'system-reminder',
] as const;
type TagName = (typeof TAG_NAMES)[number];

const OPENER_NAME_REGEX = new RegExp(`<(${TAG_NAMES.join('|')})\\b`, 'g');

export const SYSTEM_REMINDER_REGEX = /<system-reminder>[\s\S]*?<\/system-reminder>/g;

const MAX_TAG_COUNT = 100;

export function stripTags(input: string): { stripped: string; counts: Record<TagName, number> } {
  const counts: Record<TagName, number> = Object.fromEntries(
    TAG_NAMES.map(name => [name, 0])
  ) as Record<TagName, number>;

  // Same output as replacing /<(tags)\b[^>]*>[\s\S]*?<\/\1>/g, in linear
  // time: the regex rescanned to the end for every opener without a close, and
  // for every opener whose `>` lay far ahead. An opener ends at the next `>`;
  // a tag with no close after one opener has none after any later opener.
  const unclosable = new Set<TagName>();
  const opener = new RegExp(OPENER_NAME_REGEX);
  let nextGt = -1;
  let total = 0;
  let kept = 0;
  let stripped = '';
  let m: RegExpExecArray | null;
  while ((m = opener.exec(input)) !== null) {
    const name = m[1] as TagName;
    if (nextGt < opener.lastIndex) nextGt = input.indexOf('>', opener.lastIndex);
    if (nextGt < 0) break;
    const close = unclosable.has(name) ? -1 : input.indexOf(`</${name}>`, nextGt + 1);
    if (close < 0) {
      unclosable.add(name);
      opener.lastIndex = m.index + 1;
      continue;
    }
    stripped += input.slice(kept, m.index);
    kept = close + name.length + 3;
    opener.lastIndex = kept;
    counts[name] += 1;
    total += 1;
  }
  stripped += input.slice(kept);

  if (total > MAX_TAG_COUNT) {
    logger.warn('SYSTEM', 'tag count exceeds limit', undefined, {
      tagCount: total,
      maxAllowed: MAX_TAG_COUNT,
      contentLength: input.length,
    });
  }

  return { stripped: stripped.trim(), counts };
}

export function stripMemoryTags(content: string): string {
  return stripTags(content).stripped;
}

const PROTOCOL_ONLY_TAGS = ['task-notification'] as const;

const PROTOCOL_ONLY_REGEX = new RegExp(
  `^\\s*<(${PROTOCOL_ONLY_TAGS.join('|')})\\b[^>]*>(?:(?!<\\1\\b|</\\1\\b)[\\s\\S])*</\\1>\\s*$`,
);

const MAX_PROTOCOL_PAYLOAD_BYTES = 256 * 1024;

export function isInternalProtocolPayload(text: string): boolean {
  if (!text) return false;
  if (text.length > MAX_PROTOCOL_PAYLOAD_BYTES) return false;
  return PROTOCOL_ONLY_REGEX.test(text);
}

// Blocks a harness or another agent puts into a prompt. Slash-command args are
// the user's text, but a slash command never asks about past work.
const AUTOMATED_TAGS = [
  'task-notification',
  'system-reminder',
  'teammate-message',
  'cross-session-message',
  'user-prompt-submit-hook',
  'ide_opened_file',
  'ide_selection',
  'bash-notification',
  'local-command-stdout',
  'local-command-stderr',
  'local-command-caveat',
  'bash-input',
  'bash-stdout',
  'bash-stderr',
  'command-name',
  'command-message',
  'command-args',
] as const;

const AUTOMATED_TAG_TOKEN = new RegExp(
  `<(/?)(${AUTOMATED_TAGS.join('|')})(?=[\\s/>])[^<>]*>`,
  'gi',
);

const CODE_FENCE_LINE = /^[ \t]*(```|~~~)/gm;

interface Span { start: number; end: number }

function mergeSpans(spans: Span[]): Span[] {
  spans.sort((a, b) => a.start - b.start);
  const merged: Span[] = [];
  for (const span of spans) {
    const last = merged[merged.length - 1];
    if (last && span.start <= last.end) last.end = Math.max(last.end, span.end);
    else merged.push({ ...span });
  }
  return merged;
}

function insideAny(spans: Span[], i: number): boolean {
  let lo = 0;
  let hi = spans.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (i < spans[mid].start) hi = mid - 1;
    else if (i >= spans[mid].end) lo = mid + 1;
    else return true;
  }
  return false;
}

/** Text before `to` that no span covers; spans are sorted and disjoint. */
function outside(text: string, spans: Span[], to = text.length): string {
  let pos = 0;
  let out = '';
  for (const span of spans) {
    if (span.start >= to) break;
    out += text.slice(pos, span.start);
    pos = Math.max(pos, span.end);
  }
  return pos < to ? out + text.slice(pos, to) : out;
}

/** Fence spans over text outside `blocks`; an unclosed fence runs to the end. */
function userFences(text: string, blocks: Span[]): Span[] {
  const fences: Span[] = [];
  let open = -1;
  for (const m of text.matchAll(CODE_FENCE_LINE)) {
    if (insideAny(blocks, m.index)) continue;
    if (open < 0) open = m.index;
    else { fences.push({ start: open, end: m.index + m[0].length }); open = -1; }
  }
  if (open >= 0) fences.push({ start: open, end: text.length });
  return fences;
}

/**
 * Removes automated blocks in two passes. Pass 1 pairs tags outermost-first and
 * ignores fences, because a block's payload can quote its own tag inside one. A
 * stray closing tag after a block of the same name means that block quoted the
 * tag, so the block extends to it; any other stray closing tag is dropped. Pass 2
 * finds fences in the text left outside every block and keeps any block that
 * starts inside one: the user quoted it. An unclosed opener runs to the end only
 * when nothing but automated blocks precedes it; elsewhere it is the user naming
 * the tag.
 */
export function stripAutomatedContent(prompt: string): string {
  if (!prompt) return '';
  const removed: Span[] = [];
  const stacks = new Map<string, Span[]>();
  const lastOuter = new Map<string, Span>();
  for (const m of prompt.matchAll(AUTOMATED_TAG_TOKEN)) {
    const token = { start: m.index, end: m.index + m[0].length };
    const name = m[2].toLowerCase();
    const stack = stacks.get(name) ?? [];
    stacks.set(name, stack);
    if (m[1] !== '/') { stack.push(token); continue; }
    const opener = stack.pop();
    const outer = lastOuter.get(name);
    if (opener) {
      const span = { start: opener.start, end: token.end };
      removed.push(span);
      if (stack.length === 0) lastOuter.set(name, span);
    } else if (outer) {
      outer.end = token.end;
    } else {
      removed.push(token);
    }
  }
  const candidates = mergeSpans(removed);
  const fences = userFences(prompt, candidates);
  const blocks = candidates.filter(b => !insideAny(fences, b.start));

  let firstUnclosed = Infinity;
  for (const stack of stacks.values()) {
    for (const token of stack) {
      if (token.start < firstUnclosed && !insideAny(blocks, token.start)) {
        firstUnclosed = token.start;
        break;
      }
    }
  }
  if (firstUnclosed !== Infinity && !outside(prompt, blocks, firstUnclosed).trim()) return '';
  return outside(prompt, blocks).trim();
}
