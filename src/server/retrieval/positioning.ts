// SPDX-License-Identifier: Apache-2.0
// Places highest-ranked snippets at the start AND end of the injected block,
// pushing weaker ones to the middle (mitigates "lost in the middle").
export function positionForInjection(items: string[], maxItems = 5): string {
  const top = items.slice(0, maxItems);
  if (top.length === 0) return '';
  if (top.length <= 2) return top.map(t => `- ${t}`).join('\n') + '\n';
  const [first, second, ...rest] = top;      // first = best, second = 2nd best
  const ordered = [first, ...rest, second];   // best at head, 2nd-best at tail, rest in middle
  return ordered.map(t => `- ${t}`).join('\n') + '\n';
}
