// SPDX-License-Identifier: Apache-2.0
//
// Deterministic L0–L3 tiered rendering of observations for budget-constrained
// injection. No LLM: each tier is a selection of the structured fields already
// stored in observation metadata (title/subtitle/facts/why); L3 is the full
// rendered content. Graceful, never-throw degrade on missing/malformed fields.

export type Tier = 0 | 1 | 2 | 3;
export type TierInput = { content: string; metadata: Record<string, unknown> };

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim().length > 0 ? v : null;
}
function strArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length > 0) : [];
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
