// SPDX-License-Identifier: Apache-2.0
// Combines the existing session-start context with an optional team-memory
// injection block, keeping the team block at the TOP (highest-attention start
// position) and the existing context below. Pure and side-effect-free.
export function appendTeamMemoryInjection(existingContext: string, injectionBlock: string): string {
  const a = (injectionBlock ?? '').trim();
  const b = (existingContext ?? '').trim();
  if (!a) return b;          // nothing to inject -> unchanged
  if (!b) return a;          // no existing context -> just the injection
  return `${a}\n\n${b}`;     // team memory first, then existing context
}
