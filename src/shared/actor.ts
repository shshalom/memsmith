import { loadFromFileOnce } from './hook-settings.js';
import { logger } from '../utils/logger.js';

export const ACTOR_MAX_CHARS = 64;

export type ActorParse =
  | { ok: true; actor: string | null }
  | { ok: false; reason: string };

// Control characters forge lines, line separators and bidi controls disguise or
// reorder the name, the middle dot separates fields in the index line, and a
// comma separates names in a list of actors.
// eslint-disable-next-line no-control-regex
const FORBIDDEN_CHARS = /[\u0000-\u001f\u007f-\u009f\u00b7\u2028\u2029\u202a-\u202e\u2066-\u2069,]/;

export function parseActor(raw: unknown): ActorParse {
  if (raw === undefined || raw === null) return { ok: true, actor: null };
  if (typeof raw !== 'string') return { ok: false, reason: 'the actor must be a string' };
  const actor = raw.trim();
  if (actor.length === 0) return { ok: true, actor: null };
  if (actor.length > ACTOR_MAX_CHARS) {
    return { ok: false, reason: `the actor must be at most ${ACTOR_MAX_CHARS} characters (got ${actor.length})` };
  }
  if (FORBIDDEN_CHARS.test(actor)) {
    return { ok: false, reason: 'the actor must not contain control, line-separator, or bidi characters, a middle dot (·), or a comma' };
  }
  return { ok: true, actor };
}

export interface ActorSource {
  env: () => string | undefined;
  setting: () => string | undefined;
}

export const defaultActorSource: ActorSource = {
  env: () => process.env.MEMSMITH_ACTOR,
  setting: () => loadFromFileOnce().MEMSMITH_ACTOR,
};

// A set but empty MEMSMITH_ACTOR opts the session out of the settings default.
function configuredActorRaw(source: ActorSource): unknown {
  const env = source.env();
  if (env !== undefined) return env;
  try {
    return source.setting();
  } catch {
    return undefined;
  }
}

/** The configured actor, or an error describing why the configured value is unusable. */
export function configuredActor(source: ActorSource = defaultActorSource): ActorParse {
  return parseActor(configuredActorRaw(source));
}

/**
 * The actor to stamp on a capture. MEMSMITH_ACTOR wins; otherwise a Claude Code
 * subagent is named by its type. Claude Code sends agent_type for a main session
 * started with --agent too, so agent_id is what marks a subagent.
 */
export function resolveActor(
  input: { agentId?: string; agentType?: string } = {},
  source: ActorSource = defaultActorSource,
): string | null {
  const configured = configuredActor(source);
  if (!configured.ok) {
    warnInvalidOnce(configured.reason);
  } else if (configured.actor) {
    return configured.actor;
  }
  if (input.agentId && input.agentType) {
    const fallback = parseActor(input.agentType);
    if (fallback.ok) return fallback.actor;
  }
  return null;
}

const warned = new Set<string>();

function warnInvalidOnce(reason: string): void {
  if (warned.has(reason)) return;
  warned.add(reason);
  logger.warn('HOOK', `MEMSMITH_ACTOR ignored: ${reason}`);
}

export function actorField(actor: string | null | undefined): { actor?: string } {
  return actor ? { actor } : {};
}

export function actorsOf(record: { metadata?: unknown } | null | undefined): string[] {
  const metadata = record?.metadata;
  if (!metadata || typeof metadata !== 'object') return [];
  const { actor, actors } = metadata as { actor?: unknown; actors?: unknown };
  const list = Array.isArray(actors) ? actors.filter((a): a is string => typeof a === 'string' && a.length > 0) : [];
  if (typeof actor === 'string' && actor.length > 0 && !list.includes(actor)) list.unshift(actor);
  return list;
}

/**
 * Metadata for a record derived from several captures. `actors` lists every
 * distinct named actor. `actor` is set only when one actor wrote every source;
 * when some sources have no actor, `unattributed` says so instead.
 */
export function derivedActorMetadata(
  actors: Iterable<unknown>,
): { actor?: string; actors?: string[]; unattributed?: true } {
  const distinct: string[] = [];
  let unattributed = false;
  for (const raw of actors) {
    const parsed = parseActor(raw);
    if (!parsed.ok || !parsed.actor) unattributed = true;
    else if (!distinct.includes(parsed.actor)) distinct.push(parsed.actor);
  }
  if (distinct.length === 0) return {};
  if (unattributed) return { actors: distinct, unattributed: true };
  if (distinct.length === 1) return { actor: distinct[0], actors: distinct };
  return { actors: distinct };
}

export function payloadActor(payload: unknown): unknown {
  return payload && typeof payload === 'object' && !Array.isArray(payload)
    ? (payload as { actor?: unknown }).actor
    : undefined;
}

export function parseActorOrNull(raw: unknown): string | null {
  const parsed = parseActor(raw);
  return parsed.ok ? parsed.actor : null;
}

export function matchesActor(record: { metadata?: unknown }, actor: string): boolean {
  return actorsOf(record).includes(actor);
}
