// SPDX-License-Identifier: Apache-2.0
//
// Abstention benchmark — can memory say "I don't know"?
//
// Every retrieval benchmark in this repo and in the reference systems measures
// RANKING on questions that have answers. None contains a question the corpus
// cannot answer, so a system that always returns its top-N scores perfectly
// while being unable to ever abstain. This harness measures the missing half.
//
// Design notes that matter for trusting the output:
//  - Positive labels come from independent full-text search, not from opinion.
//    A candidate positive with zero FTS hits is DISCARDED, not counted.
//  - Negatives are split into off-domain (foreign vocabulary) and in-domain
//    (this project's vocabulary, no recorded answer). An earlier measurement
//    reported 100% specificity on off-domain only; the same rule scored 26.7%
//    in-domain. Blending them hides the failure mode that matters.
//  - Several candidate rules are scored side by side so the comparison is
//    honest rather than a single number defended after the fact.
import pg from 'pg';
import { readFileSync } from 'fs';
import { join } from 'path';
import { embed } from '../../src/server/generation/embedder.js';

const DB = process.env.MEMSMITH_ABSTENTION_DB
  ?? 'postgres://memsmith:memsmith-local@127.0.0.1:55433/postgres';
const PROJECT = process.env.MEMSMITH_ABSTENTION_PROJECT
  ?? '5fc024f0-0994-4f1d-baed-300d9b4d3416';
const TEAM = process.env.MEMSMITH_ABSTENTION_TEAM
  ?? 'ab8e1f17-020e-4794-bae3-e59885e7df05';

interface Probe {
  q: string;
  /** cosine distance of the nearest embedding, or null when the corpus is empty */
  top: number | null;
  /** mean distance of the top 5 — cluster agreement rather than a single point */
  mean5: number | null;
  /** how much closer the top hit is than the corpus average (higher = more distinctive) */
  margin: number | null;
  /** independent lexical evidence */
  fts: number;
}

const pool = new pg.Pool({ connectionString: DB });

async function probe(q: string): Promise<Probe> {
  const ftsRes = await pool.query(
    `SELECT count(*)::int n FROM observations
      WHERE project_id=$1 AND team_id=$2
        AND to_tsvector('english', content) @@ websearch_to_tsquery('english', $3)`,
    [PROJECT, TEAM, q],
  );
  const fts = Number(ftsRes.rows[0].n);

  const qvec = '[' + (await embed(q)).join(',') + ']';
  const near = await pool.query(
    `SELECT (embedding_vec OPERATOR(public.<=>) $3::public.vector) d
       FROM observations
      WHERE project_id=$1 AND team_id=$2 AND embedding_vec IS NOT NULL
      ORDER BY 1 LIMIT 5`,
    [PROJECT, TEAM, qvec],
  );
  if (near.rows.length === 0) return { q, top: null, mean5: null, margin: null, fts };

  const ds = near.rows.map((r: { d: unknown }) => Number(r.d));
  const avgRes = await pool.query(
    `SELECT avg(embedding_vec OPERATOR(public.<=>) $3::public.vector) a
       FROM observations
      WHERE project_id=$1 AND team_id=$2 AND embedding_vec IS NOT NULL`,
    [PROJECT, TEAM, qvec],
  );
  const corpusAvg = Number(avgRes.rows[0].a);
  return {
    q,
    top: ds[0]!,
    mean5: ds.reduce((a, b) => a + b, 0) / ds.length,
    // A real question is distinctively closer than the corpus average; an
    // unanswerable one is only marginally closer than everything else.
    margin: corpusAvg - ds[0]!,
    fts,
  };
}

/** A candidate abstention rule: true = "memory has an answer". */
interface Rule { name: string; hasAnswer: (p: Probe) => boolean }

const RULES: Rule[] = [
  { name: 'current (always answers)', hasAnswer: () => true },
  { name: 'vector <= 0.55', hasAnswer: p => p.top !== null && p.top <= 0.55 },
  { name: 'vector <= 0.50', hasAnswer: p => p.top !== null && p.top <= 0.50 },
  { name: 'fts > 0 only', hasAnswer: p => p.fts > 0 },
  { name: 'union (vec<=0.55 OR fts>0)', hasAnswer: p => (p.top !== null && p.top <= 0.55) || p.fts > 0 },
  { name: 'AND (vec<=0.60 AND fts>0)', hasAnswer: p => p.top !== null && p.top <= 0.60 && p.fts > 0 },
  { name: 'mean5 <= 0.60', hasAnswer: p => p.mean5 !== null && p.mean5 <= 0.60 },
  { name: 'margin >= 0.35', hasAnswer: p => p.margin !== null && p.margin >= 0.35 },
  { name: 'margin >= 0.40', hasAnswer: p => p.margin !== null && p.margin >= 0.40 },
  { name: 'fts>0 OR margin>=0.40', hasAnswer: p => p.fts > 0 || (p.margin !== null && p.margin >= 0.40) },
];

async function main(): Promise<void> {
  const set = JSON.parse(readFileSync(join(import.meta.dir, 'eval-set.json'), 'utf-8')) as {
    passBar: { recall: number; inDomainSpecificity: number; heldOutRecall: number };
    positives: string[];
    negatives: Record<string, string[]>;
    heldOutPositives: { questions: string[] };
  };

  const positives: Probe[] = [];
  let discarded = 0;
  for (const q of set.positives) {
    const p = await probe(q);
    // Ground truth, not opinion: no lexical evidence -> not a usable positive.
    if (p.fts === 0) { discarded += 1; continue; }
    positives.push(p);
  }

  const negatives: Record<string, Probe[]> = {};
  for (const [tier, qs] of Object.entries(set.negatives)) {
    negatives[tier] = [];
    for (const q of qs) {
      const p = await probe(q);
      // A "negative" the corpus actually discusses is mislabelled — drop it.
      if (p.fts > 0) continue;
      negatives[tier]!.push(p);
    }
  }

  // Held-out positives: answers exist, but the wording avoids corpus vocabulary.
  // The main positives are LABELLED by FTS, so any FTS-dependent rule scores
  // 100% recall on them by construction. This set is the anti-circularity gate —
  // without it, "fts > 0" appears to score a perfect 100%/100%.
  const heldOut: Probe[] = [];
  for (const q of set.heldOutPositives.questions) heldOut.push(await probe(q));

  console.log(`positives n=${positives.length} (discarded ${discarded} with no FTS ground truth)`);
  console.log(`held-out positives n=${heldOut.length} (answers exist; corpus vocabulary avoided)`);
  for (const [tier, ps] of Object.entries(negatives)) console.log(`negatives[${tier}] n=${ps.length}`);
  console.log();

  const pad = (s: string, n: number) => s.padEnd(n);
  const pctStr = (x: number) => `${(x * 100).toFixed(1)}%`.padStart(6);
  const tiers = Object.keys(negatives);
  console.log(pad('rule', 28) + pad('recall', 8) + pad('held-out', 10) + tiers.map(t => pad(`spec[${t}]`, 18)).join(''));
  console.log('-'.repeat(28 + 8 + 10 + tiers.length * 18));

  const results: Array<{ rule: string; recall: number; held: number; spec: Record<string, number> }> = [];
  for (const rule of RULES) {
    const recall = positives.filter(p => rule.hasAnswer(p)).length / positives.length;
    const held = heldOut.length ? heldOut.filter(p => rule.hasAnswer(p)).length / heldOut.length : NaN;
    const spec: Record<string, number> = {};
    for (const t of tiers) {
      const ps = negatives[t]!;
      spec[t] = ps.length ? ps.filter(p => !rule.hasAnswer(p)).length / ps.length : NaN;
    }
    results.push({ rule: rule.name, recall, held, spec });
    console.log(pad(rule.name, 28) + pctStr(recall) + '  ' + pad(pctStr(held), 10)
      + tiers.map(t => pad(pctStr(spec[t]!), 18)).join(''));
  }

  const bar = set.passBar;
  console.log(`\nPASS BAR: recall >= ${pctStr(bar.recall)}, held-out >= ${pctStr(bar.heldOutRecall)}, spec[in-domain] >= ${pctStr(bar.inDomainSpecificity)}`);
  const passing = results.filter(r =>
    r.recall >= bar.recall
    && r.held >= bar.heldOutRecall
    && (r.spec['in-domain'] ?? 0) >= bar.inDomainSpecificity);
  if (passing.length === 0) {
    console.log('NO RULE PASSES. Abstention stays disabled — shipping a failing rule would');
    console.log('make real questions falsely report "no memory found", which is worse than noise.');
  } else {
    for (const r of passing) console.log(`PASS: ${r.rule}`);
  }
  await pool.end();
}

if (import.meta.main) {
  main().catch(err => { console.error(err); process.exit(1); });
}
