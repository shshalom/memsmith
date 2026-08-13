import { describe, it, expect } from 'bun:test';
import { checkRigSafe, assertRigSafe } from '../../../scripts/rig/preflight.mjs';
import { homedir } from 'os';
import { join } from 'path';

const DOGFOOD_DATA = join(homedir(), '.memsmith');
const OK = { dataDir: '/tmp/ms-team-server', dbUrl: 'postgres://memsmith:pw@127.0.0.1:55440/memsmith', httpPort: 38890 };

describe('checkRigSafe', () => {
  it('rejects the dogfood data dir', () => {
    const r = checkRigSafe({ ...OK, dataDir: DOGFOOD_DATA });
    expect(r.safe).toBe(false);
    expect(r.reason).toMatch(/data dir/i);
  });
  it('rejects the dogfood data dir with a trailing slash', () => {
    expect(checkRigSafe({ ...OK, dataDir: DOGFOOD_DATA + '/' }).safe).toBe(false);
  });
  it('rejects the dogfood embedded PG port 55433', () => {
    const r = checkRigSafe({ ...OK, dbUrl: 'postgres://memsmith:memsmith-local@127.0.0.1:55433/postgres' });
    expect(r.safe).toBe(false);
    expect(r.reason).toMatch(/55433/);
  });
  it('rejects the dogfood HTTP port 38879', () => {
    const r = checkRigSafe({ ...OK, httpPort: 38879 });
    expect(r.safe).toBe(false);
    expect(r.reason).toMatch(/38879/);
  });
  it('accepts a clean /tmp + :55440 + :38890 target', () => {
    expect(checkRigSafe(OK)).toEqual({ safe: true });
  });

  // The credentials file was the hole this guard did not cover: CredentialStore
  // hardcoded homedir(), so a rig with MEMSMITH_DATA_DIR=/tmp still wrote the
  // developer's REAL credentials.json. A clobbered key silently stops capture for
  // a live project, so this is a data-loss path, not a tidiness issue.
  it('rejects the dogfood credential store by explicit path', () => {
    const r = checkRigSafe({ ...OK, credentialsPath: join(DOGFOOD_DATA, 'credentials.json') });
    expect(r.safe).toBe(false);
    expect(r.reason).toMatch(/credential/i);
  });

  it('rejects a data dir that DERIVES the dogfood credential store', () => {
    // Half-isolated run: no explicit credentials path, but the data dir would
    // resolve into the dogfood store.
    const r = checkRigSafe({ dbUrl: OK.dbUrl, httpPort: OK.httpPort, dataDir: DOGFOOD_DATA });
    expect(r.safe).toBe(false);
  });

  it('accepts a credentials path derived from a throwaway data dir', () => {
    const r = checkRigSafe({ ...OK, credentialsPath: '/tmp/ms-team-server/credentials.json' });
    expect(r).toEqual({ safe: true });
  });
});

describe('assertRigSafe', () => {
  it('throws when given an unsafe input (dogfood data dir)', () => {
    const unsafe = { ...OK, dataDir: join(homedir(), '.memsmith') };
    expect(() => assertRigSafe(unsafe)).toThrow();
  });
  it('does not throw for a clean /tmp + :55440 + :38890 input', () => {
    expect(() => assertRigSafe(OK)).not.toThrow();
  });
});
