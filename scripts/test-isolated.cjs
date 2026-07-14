#!/usr/bin/env node
// Runs each test file in its OWN `bun test` process so cross-file global-state
// pollution (mock.module is process-global; singletons persist) cannot cause
// phantom failures. This is the trustworthy CI gate; `bun test` (single-process)
// remains the fast-but-noisy dev shortcut.
const { readdirSync, statSync } = require('fs');
const { join, relative, isAbsolute } = require('path');
const { spawnSync } = require('child_process');
const root = process.cwd();
const dir = process.argv[2]
  ? (isAbsolute(process.argv[2]) ? process.argv[2] : join(root, process.argv[2]))
  : join(root, 'tests');
const BUN = process.env.BUN_BIN || (process.env.HOME + '/.bun/bin/bun');

function walk(d, acc) {
  for (const name of readdirSync(d)) {
    const p = join(d, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, acc);
    else if (/\.test\.tsx?$/.test(name)) acc.push(p);
  }
  return acc;
}

const files = walk(dir, []).sort();
const failed = [];
let ran = 0;
for (const f of files) {
  ran++;
  const r = spawnSync(BUN, ['test', f], { stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf-8' });
  if (r.status !== 0) {
    failed.push(relative(root, f));
    process.stderr.write(`FAIL ${relative(root, f)}\n${r.stderr || ''}\n`);
  }
}
console.log(`\ntest-isolated: ran ${ran} files, ${failed.length} failed`);
if (failed.length) { failed.forEach(f => console.log('  FAIL ' + f)); process.exit(1); }
process.exit(0);
