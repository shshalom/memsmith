
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

const STRIP_REGEX = new RegExp(
  `<(${TAG_NAMES.join('|')})\\b[^>]{0,256}>[\\s\\S]*?</\\1>`,
  'g'
);

export const SYSTEM_REMINDER_REGEX = /<system-reminder>[\s\S]*?<\/system-reminder>/g;

const MAX_TAG_COUNT = 100;

export function stripTags(input: string): { stripped: string; counts: Record<TagName, number> } {
  const counts: Record<TagName, number> = Object.fromEntries(
    TAG_NAMES.map(name => [name, 0])
  ) as Record<TagName, number>;

  STRIP_REGEX.lastIndex = 0; 

  let total = 0;
  const stripped = input.replace(STRIP_REGEX, (_, name: TagName) => {
    counts[name] = (counts[name] ?? 0) + 1;
    total += 1;
    return '';
  });

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
  `<(/?)(${AUTOMATED_TAGS.join('|')})(?=[\\s/>])[^<>]{0,256}>`,
  'gi',
);

const CODE_FENCE_LINE = /^[ \t]*(```|~~~)/gm;

interface Span { start: number; end: number }

function codeFences(text: string): Span[] {
  const fences: Span[] = [];
  let open = -1;
  for (const m of text.matchAll(CODE_FENCE_LINE)) {
    if (open < 0) open = m.index;
    else { fences.push({ start: open, end: m.index + m[0].length }); open = -1; }
  }
  if (open >= 0) fences.push({ start: open, end: text.length });
  return fences;
}

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

/**
 * Removes automated blocks, matched outermost-first so a block that quotes its
 * own tag is removed whole. A stray closing tag after a block of the same name
 * means that block quoted the tag, so the block extends to it; any other stray
 * closing tag is dropped. An unclosed opener runs to the end only when nothing
 * but automated blocks precedes it; elsewhere it is the user naming the tag.
 * Tags inside code fences are the user's.
 */
export function stripAutomatedContent(prompt: string): string {
  if (!prompt) return '';
  const fences = codeFences(prompt);
  let fence = 0;

  const removed: Span[] = [];
  const stacks = new Map<string, Span[]>();
  const lastOuter = new Map<string, Span>();
  for (const m of prompt.matchAll(AUTOMATED_TAG_TOKEN)) {
    while (fence < fences.length && fences[fence].end <= m.index) fence++;
    if (fence < fences.length && fences[fence].start <= m.index) continue;
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
  const merged = mergeSpans(removed);

  let firstUnclosed = Infinity;
  for (const stack of stacks.values()) {
    for (const token of stack) {
      if (token.start < firstUnclosed && !insideAny(merged, token.start)) {
        firstUnclosed = token.start;
        break;
      }
    }
  }
  if (firstUnclosed !== Infinity && !outside(prompt, merged, firstUnclosed).trim()) return '';
  return outside(prompt, merged).trim();
}
