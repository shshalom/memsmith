// SPDX-License-Identifier: Apache-2.0
//
// Deterministic L0–L3 tiered rendering of observations for budget-constrained
// injection. No LLM: each tier is a selection of the structured fields already
// stored in observation metadata (title/subtitle/facts/why); L3 is the full
// rendered content. Graceful, never-throw degrade on missing/malformed fields.

export type Tier = 0 | 1 | 2 | 3;
export type TierInput = { content: string; metadata: Record<string, unknown> };

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : null;
}
function strArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0) : [];
}
function firstLine(content: string): string {
  const i = content.indexOf('\n');
  return (i === -1 ? content : content.slice(0, i)).trim();
}

export function renderAtTier(obs: TierInput, tier: Tier): string {
  try {
    if (tier >= 3) return obs.content;
    const m = obs.metadata ?? {};
    const title = str(m.title);
    // L0 base: title (+ subtitle), else first line of content.
    let head: string;
    if (title) {
      const subtitle = str(m.subtitle);
      head = subtitle ? `${title} — ${subtitle}` : title;
    } else {
      head = firstLine(obs.content);
    }
    if (tier === 0) return head;

    const facts = strArray(m.facts);
    const withFacts = facts.length > 0 ? `${head}\n${facts.map(f => `- ${f}`).join('\n')}` : head;
    if (tier === 1) return withFacts;

    const why = str(m.why);
    return why ? `${withFacts}\nWhy: ${why}` : withFacts;
  } catch {
    // Never throw — fall back to full content.
    return obs.content;
  }
}

export function tierToBudget(
  ranked: TierInput[],
  opts: { maxChars: number; maxItems: number },
): string[] {
  const items = ranked.slice(0, Math.max(0, opts.maxItems));
  if (items.length === 0) return [];
  const tiers: Tier[] = items.map(() => 3);
  const joinedLen = (arr: string[]) => arr.reduce((s, x) => s + x.length, 0) + Math.max(0, arr.length - 1); // '\n' separators
  const render = () => items.map((it, i) => renderAtTier(it, tiers[i]));

  // Step down the lowest-ranked item still above L0 until we fit or all at L0.
  while (joinedLen(render()) > opts.maxChars) {
    let stepped = false;
    for (let i = items.length - 1; i >= 0; i--) {
      if (tiers[i] > 0) { tiers[i] = (tiers[i] - 1) as Tier; stepped = true; break; }
    }
    if (!stepped) break; // everyone at L0
  }

  let out = render();
  // Still over with all at L0: drop trailing items one at a time.
  while (out.length > 1 && joinedLen(out) > opts.maxChars) {
    out = out.slice(0, out.length - 1);
  }
  // A single remaining item that still overflows: hard-slice it.
  if (out.length === 1 && out[0].length > opts.maxChars) {
    out = [out[0].slice(0, opts.maxChars)];
  }
  return out;
}
