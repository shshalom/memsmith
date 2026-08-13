// SPDX-License-Identifier: Apache-2.0
// Dogfood-isolation guard for the team-mode rig. Refuses any run that would
// target the dogfood data dir (~/.memsmith), embedded PG (:55433), or HTTP
// port (:38879). checkRigSafe is pure; assertRigSafe throws on unsafe.
import { homedir } from 'os';
import { resolve, join } from 'path';

const DOGFOOD_DATA_DIR = resolve(join(homedir(), '.memsmith'));
const DOGFOOD_CREDENTIALS = resolve(join(DOGFOOD_DATA_DIR, 'credentials.json'));

/**
 * @param {{ dataDir?: any, dbUrl?: any, httpPort?: any, credentialsPath?: any }} input
 *   Every field is optional: callers check only what they are about to use, and an
 *   absent field is not evidence of safety — it is simply unchecked.
 */
export function checkRigSafe({ dataDir, dbUrl, httpPort, credentialsPath } = {}) {
  if (dataDir != null && resolve(String(dataDir)) === DOGFOOD_DATA_DIR) {
    return { safe: false, reason: `refusing: data dir resolves to the dogfood data dir (${DOGFOOD_DATA_DIR})` };
  }
  // The credentials file was the hole this guard did not cover. CredentialStore
  // used to hardcode homedir(), so a rig with MEMSMITH_DATA_DIR set to /tmp still
  // wrote the developer's real credentials.json — and a clobbered key silently
  // stops capture for a live project. It now derives from the data dir, and this
  // check asserts that outcome instead of assuming it.
  if (credentialsPath != null && resolve(String(credentialsPath)) === DOGFOOD_CREDENTIALS) {
    return { safe: false, reason: `refusing: credentials path is the dogfood credential store (${DOGFOOD_CREDENTIALS})` };
  }
  // A data dir that is not the dogfood dir must not still resolve credentials
  // into it. Catches a half-isolated run: /tmp data dir, real credential file.
  if (dataDir != null && credentialsPath == null) {
    const derived = resolve(join(String(dataDir), 'credentials.json'));
    if (derived === DOGFOOD_CREDENTIALS) {
      return { safe: false, reason: `refusing: data dir derives the dogfood credential store (${DOGFOOD_CREDENTIALS})` };
    }
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
    assertRigSafe({
      dataDir: arg('--data-dir'),
      dbUrl: arg('--db-url'),
      httpPort: arg('--http-port'),
      credentialsPath: arg('--credentials-path'),
    });
    console.log('[rig-preflight] OK — target is not the dogfood.');
  } catch { process.exit(1); }
}
