# Abstention Benchmark

**The gate no standard benchmark provides: can memory say "I don't know"?**

Run: `bun bench/abstention/run.ts` (requires the local server and the dogfood corpus).

## Why this exists

Every retrieval benchmark in this repo and in the reference systems — LongMemEval,
LoCoMo, ConvoMem, MemBench — is built from questions that **have answers**. They
measure whether the right document is ranked highly (recall@k, MRR). None of them
contains a single question the corpus cannot answer.

That means a system which *always* returns its top-N scores perfectly on all of
them while being unable to ever say "no". MemSmith scores R@5 = 0.9643 on
LongMemEval-S and still returns five confident, unrelated observations when asked
"why is the sky blue".

Ranking is measured. Abstention is not. This harness measures abstention.

## What it measures

Two populations, both against the live dogfood corpus:

- **POSITIVES** — natural questions with a real recorded answer. Labelled by
  independent full-text search, not by opinion: if FTS finds nothing, the question
  is discarded rather than counted.
- **NEGATIVES** — questions with no recorded answer, split into two difficulty
  tiers, because they are not equally hard:
  - `off-domain`: foreign vocabulary (kubernetes, sourdough). Easy.
  - `in-domain`: **this project's own vocabulary**, about things never decided
    ("how do we shard the embedded postgres across machines"). Hard, and the
    case that actually matters — these produce confident-looking distances.

Reporting both tiers separately is deliberate. An earlier measurement in this
project reported 100% specificity using only off-domain negatives; against
in-domain negatives the same rule scored 26.7%. A single blended number hides
exactly the failure mode worth knowing about.

## Metrics

- **recall** — fraction of POSITIVES where the rule says "memory has an answer".
  A miss here is a false "no memory found", which is worse than noise: it stops
  the agent from looking.
- **specificity** — fraction of NEGATIVES where the rule says "no answer".
  A miss here is the current bug: unrelated memory injected under a header
  asserting it is relevant.

Both are reported per negative tier. The headline gate uses in-domain.

## Pass bar

`in-domain specificity >= 0.80` at `recall >= 0.95`.

Rationale: a false positive (injecting misleading memory) is worse than a false
negative (status quo noise), but a rule that drops real answers is worse than
both — it makes the agent stop consulting memory. Recall is therefore the harder
constraint and is checked first.

No rule has passed this bar yet. The current best measured is 26.7% in-domain
specificity, which is why abstention is NOT enabled.
