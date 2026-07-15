// Directive-reliability harness. Measures, for each "why"-class prompt, whether
// MemSmith memory was consulted (a /v1/context result with >=1 hit exists) —
// the precondition for the directive to work. Prints a score vs. the threshold.
//
// NOTE: this harness measures RETRIEVABILITY (does memory have the answer), which
// is the necessary condition. Full behavioral measurement (did the agent actually
// consult before grepping) requires a live agent transcript; this harness is the
// automatable proxy and the gate for enabling hard mode. Documented as such.
import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const HERE = dirname(fileURLToPath(import.meta.url));
const TEAM = 'ab8e1f17-020e-4794-bae3-e59885e7df05';
const PROJ = '5fc024f0-0994-4f1d-baed-300d9b4d3416';
const cfg = JSON.parse(readFileSync(join(HERE, 'eval-set.json'), 'utf-8'));
const key = JSON.parse(readFileSync(join(homedir(), '.memsmith', 'credentials.json'), 'utf-8')).keys[TEAM];

let whyTotal = 0, whyHit = 0;
for (const p of cfg.prompts) {
  const res = await fetch('http://127.0.0.1:38879/v1/context', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId: PROJ, query: p.text, limit: 5 }),
  }).then(r => r.json()).catch(() => ({ observations: [] }));
  const hits = (res.observations ?? []).length;
  if (p.class === 'why') { whyTotal++; if (hits >= 1) whyHit++; }
  console.log(`[${p.class}] hits=${hits}  ${p.text}`);
}
const score = whyTotal ? whyHit / whyTotal : 0;
console.log(`\nwhy-class retrievability: ${whyHit}/${whyTotal} = ${(score * 100).toFixed(0)}%  (threshold ${(cfg.threshold * 100)}%)`);
console.log(score >= cfg.threshold ? 'PASS — directive-based approach viable' : 'FAIL — flip failing surface to always-memory-first (spec fallback)');
process.exit(score >= cfg.threshold ? 0 : 1);
