// SPDX-License-Identifier: Apache-2.0
//
// Choosing the server URL a convert stamps into the project marker.
//
// deriveServerUrl has an override branch — a non-empty first argument is returned
// verbatim — but nothing reached it. Its only consumer,
// makeResolveConvertContext, has zero call sites, and the live convert path calls
// deriveServerUrl(input.databaseUrl) with ONE argument
// (ServerV1PostgresRoutes.ts:1866). So the override was unreachable and the
// derivation was mandatory.
//
// That matters on AWS specifically. The API sits behind an ALB on one hostname;
// the database is RDS on a different one. Deriving from the database URL yields
//
//   postgres://cmem:pw@memsmith-prod.abc123.us-east-1.rds.amazonaws.com:5432/db
//     ->  https://memsmith-prod.abc123.us-east-1.rds.amazonaws.com
//
// which points at RDS. Nothing serves /v1 there, so the convert stamps a marker
// that breaks every later request from that project.
//
// WHY NOT JUST READ MEMSMITH_SERVER_URL. Because it is NOT unset by default:
// SettingsDefaultsManager gives it `http://127.0.0.1:<uid-derived port>`
// (settings-defaults:206). Preferring it unconditionally would point every
// convert at localhost — strictly worse than deriving from the remote host, and
// it would break silently on machines that never configured it. An explicit
// remote value must win; a localhost-shaped default must not.
import { describe, it, expect } from 'bun:test';
import { resolveConvertServerUrl } from '../../../src/server/convert/resolve-convert-server-url.js';

const RDS = 'postgres://cmem:pw@memsmith-prod.abc123.us-east-1.rds.amazonaws.com:5432/memsmith';

describe('resolveConvertServerUrl', () => {
  it('prefers the project marker serverUrl over the derived value', () => {
    // The marker is the authoritative record of where this project's server is:
    // it was written by a previous convert or join, and it is what
    // buildServerContext reads at runtime.
    expect(resolveConvertServerUrl({
      databaseUrl: RDS,
      markerServerUrl: 'https://memory.example.com',
    })).toBe('https://memory.example.com');
  });

  it('keeps a nonstandard port from the marker', () => {
    // The whole point of an override: deriveServerUrl drops the port for a
    // non-localhost host, so an API on :8443 is only expressible this way.
    expect(resolveConvertServerUrl({
      databaseUrl: RDS,
      markerServerUrl: 'https://memory.example.com:8443',
    })).toBe('https://memory.example.com:8443');
  });

  it('falls back to deriving from the database URL when no override exists', () => {
    // Unchanged behaviour for every existing install — this must not become a
    // breaking change for anyone already converted.
    expect(resolveConvertServerUrl({ databaseUrl: RDS }))
      .toBe('https://memsmith-prod.abc123.us-east-1.rds.amazonaws.com');
  });

  it('ignores a blank or whitespace-only marker serverUrl', () => {
    // A marker can carry serverUrl: "" (the field is optional and a partial write
    // is possible). An empty override must fall through, not produce an empty
    // base URL that would make every request relative.
    expect(resolveConvertServerUrl({ databaseUrl: RDS, markerServerUrl: '' }))
      .toBe('https://memsmith-prod.abc123.us-east-1.rds.amazonaws.com');
    expect(resolveConvertServerUrl({ databaseUrl: RDS, markerServerUrl: '   ' }))
      .toBe('https://memsmith-prod.abc123.us-east-1.rds.amazonaws.com');
  });

  it('uses the configured setting when the marker has none', () => {
    // MEMSMITH_SERVER_URL is the operator-facing knob for a fresh convert, where
    // no marker serverUrl exists yet.
    expect(resolveConvertServerUrl({
      databaseUrl: RDS,
      settingServerUrl: 'https://memory.example.com',
    })).toBe('https://memory.example.com');
  });

  it('REJECTS a loopback setting rather than pointing a remote convert at localhost', () => {
    // THE LOAD-BEARING GUARD. MEMSMITH_SERVER_URL defaults to
    // http://127.0.0.1:<uid port> and is therefore non-empty on virtually every
    // machine. Honouring it for a REMOTE database would stamp a marker pointing
    // at the operator's own laptop — worse than the RDS hostname, and silent.
    for (const loopback of [
      'http://127.0.0.1:38879',
      'http://localhost:38879',
      'https://localhost',
      'http://[::1]:38879',
    ]) {
      expect(resolveConvertServerUrl({ databaseUrl: RDS, settingServerUrl: loopback }))
        .toBe('https://memsmith-prod.abc123.us-east-1.rds.amazonaws.com');
    }
  });

  it('ALLOWS a loopback setting when the database is also local', () => {
    // A local-to-local convert (the rig, and a single-machine team) legitimately
    // wants the loopback URL, including a nonstandard port — which is exactly
    // what deriveServerUrl's hard-coded :38879 cannot express.
    expect(resolveConvertServerUrl({
      databaseUrl: 'postgres://u:p@127.0.0.1:55433/postgres',
      settingServerUrl: 'http://127.0.0.1:38880',
    })).toBe('http://127.0.0.1:38880');
  });

  it('prefers the marker over the setting when both are present', () => {
    // The marker is per-project and was written by an actual convert/join; the
    // setting is machine-wide. The narrower, evidence-backed value wins.
    expect(resolveConvertServerUrl({
      databaseUrl: RDS,
      markerServerUrl: 'https://from-marker.example.com',
      settingServerUrl: 'https://from-setting.example.com',
    })).toBe('https://from-marker.example.com');
  });

  it('rejects a marker value that is not a usable absolute URL', () => {
    // A hand-edited marker is the documented workaround today, so malformed
    // input is realistic. Fall back rather than stamping garbage.
    for (const bad of ['not a url', 'memory.example.com', '/v1', 'ftp://x.example.com']) {
      expect(resolveConvertServerUrl({ databaseUrl: RDS, markerServerUrl: bad }))
        .toBe('https://memsmith-prod.abc123.us-east-1.rds.amazonaws.com');
    }
  });

  it('strips a trailing slash so the value concatenates cleanly', () => {
    // Callers build `${base}/v1/...`; a trailing slash yields a double slash.
    expect(resolveConvertServerUrl({
      databaseUrl: RDS,
      markerServerUrl: 'https://memory.example.com/',
    })).toBe('https://memory.example.com');
  });

  it('never returns an empty string', () => {
    // The result is stamped into the marker and used as an HTTP base URL.
    for (const opts of [
      { databaseUrl: RDS },
      { databaseUrl: RDS, markerServerUrl: '' },
      { databaseUrl: RDS, settingServerUrl: '' },
      { databaseUrl: 'postgres://u:p@localhost:5432/db' },
    ]) {
      expect(resolveConvertServerUrl(opts).length).toBeGreaterThan(0);
    }
  });
});
