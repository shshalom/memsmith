# Retrieval-First Reliability Harness

Run: `node bench/retrieval-first/run.mjs` (requires the local server on :38879 and the dogfood key).

Measures why-class retrievability (does memory hold the answer for why/decision prompts).
Threshold: 90% (in eval-set.json). Below threshold → per the design spec, flip the failing
surface to always-memory-first (query memory for everything, files always fallback).

This is the automatable proxy for directive reliability. Full behavioral measurement
(did the agent consult memory before grepping) requires live agent transcripts and is a
manual follow-up; this gate covers the necessary precondition.
