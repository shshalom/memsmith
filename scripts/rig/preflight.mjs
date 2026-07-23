// SPDX-License-Identifier: Apache-2.0
// Dogfood-isolation guard for the team-mode rig. Refuses any run that would
// target the dogfood data dir (~/.memsmith), embedded PG (:55433), or HTTP
// port (:38879). checkRigSafe is pure; assertRigSafe throws on unsafe.
import { homedir } from 'os';
import { resolve, join } from 'path';

const DOGFOOD_DATA_DIR = resolve(join(homedir(), '.memsmith'));

export function checkRigSafe({ dataDir, dbUrl, httpPort }) {
  if (dataDir != null && resolve(String(dataDir)) === DOGFOOD_DATA_DIR) {
    return { safe: false, reason: `refusing: data dir resolves to the dogfood data dir (${DOGFOOD_DATA_DIR})` };
  }
  if (dbUrl != null && /:55433(\/|$|\?)/.test(String(dbUrl))) {
    return { safe: false, reason: 'refusing: DB URL targets the dogfood embedded PG (:55433)' };
  }
  if (httpPort != null && Number(httpPort) === 38879) {
    return { safe: false, reason: 'refusing: HTTP port is the dogfood server port (:38879)' };
  }
  return { safe: true };
}

export function assertRigSafe(input) {
  const r = checkRigSafe(input);
  if (!r.safe) {
    console.error(`[rig-preflight] ${r.reason}`);
    throw new Error(r.reason);
  }
}

if (import.meta.main) {
  // CLI usage: node preflight.mjs --data-dir X --db-url Y --http-port Z
  const arg = (k) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : undefined; };
  try {
    assertRigSafe({ dataDir: arg('--data-dir'), dbUrl: arg('--db-url'), httpPort: arg('--http-port') });
    console.log('[rig-preflight] OK — target is not the dogfood.');
  } catch { process.exit(1); }
}
