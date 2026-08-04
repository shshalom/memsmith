// SPDX-License-Identifier: Apache-2.0
//
// Which server URL a convert stamps into the project marker.
//
// deriveServerUrl already has an override branch — a non-empty first argument is
// returned verbatim — but nothing reached it: its only consumer,
// makeResolveConvertContext, has zero call sites, and the live convert path
// called deriveServerUrl(input.databaseUrl) with ONE argument. So the derivation
// was mandatory, and on a real deployment it is wrong.
//
// THE AWS CASE. The API is behind an ALB on one hostname; the database is RDS on
// another. Deriving from the database URL keeps the DATABASE host and drops the
// port:
//
//   postgres://cmem:pw@memsmith-prod.abc.us-east-1.rds.amazonaws.com:5432/db
//     ->  https://memsmith-prod.abc.us-east-1.rds.amazonaws.com
//
// Nothing serves /v1 there, so the convert stamps a marker that breaks every
// later request from that project. Before this, the only remedy was hand-editing
// .memsmith/project.json afterwards.
//
// PRECEDENCE, narrowest and best-evidenced first:
//   1. the project marker's serverUrl — per-project, and written by an actual
//      previous convert or join, so it reflects observed reality
//   2. MEMSMITH_SERVER_URL — machine-wide operator configuration
//   3. deriveServerUrl(databaseUrl) — unchanged fallback, so no existing install
//      changes behaviour
//
// WHY (2) NEEDS A GUARD. MEMSMITH_SERVER_URL is NOT unset by default:
// SettingsDefaultsManager gives it `http://127.0.0.1:<uid-derived port>`. Reading
// it unconditionally would point every remote convert at the operator's own
// laptop — worse than the RDS hostname and completely silent. So a loopback
// setting is honoured only when the DATABASE is also local, which is the rig and
// the single-machine team; for a remote database it is discarded.

import { deriveServerUrl } from './convert-context.js';

export interface ResolveConvertServerUrlInput {
  /** The destination database URL the convert is running against. */
  databaseUrl: string;
  /** serverUrl from this project's marker, if it already has one. */
  markerServerUrl?: string | null;
  /** MEMSMITH_SERVER_URL, if configured. Beware: it has a localhost default. */
  settingServerUrl?: string | null;
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/** An http(s) absolute URL we can use as a base. Anything else is unusable. */
function asBaseUrl(value: string | null | undefined): URL | null {
  const raw = value?.trim();
  if (!raw) return null;
  try {
    const u = new URL(raw);
    // Only http(s): a postgres:// or ftp:// value here is a configuration
    // mistake, and stamping it would produce a marker no client can use.
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (!u.hostname) return null;
    return u;
  } catch {
    // Not an absolute URL — e.g. a bare hostname or a path. A hand-edited marker
    // is the documented workaround today, so malformed input is realistic.
    return null;
  }
}

function isLoopback(u: URL): boolean {
  return LOOPBACK_HOSTS.has(u.hostname);
}

/** Callers build `${base}/v1/...`, so a trailing slash would double up. */
function normalise(u: URL): string {
  return `${u.protocol}//${u.host}`;
}

/**
 * Resolve the server URL for a convert, preferring explicit configuration over
 * derivation.
 *
 * Never returns an empty string: the result is stamped into the project marker
 * and used as an HTTP base URL, so the derivation is always available as a floor.
 */
export function resolveConvertServerUrl(input: ResolveConvertServerUrlInput): string {
  const derived = deriveServerUrl(input.databaseUrl);

  // 1. The marker wins. It is per-project and was written by a real convert or
  // join, so it is the narrowest and best-evidenced value available. Not
  // loopback-guarded: if a project's own marker says localhost, that project
  // genuinely is local.
  const marker = asBaseUrl(input.markerServerUrl);
  if (marker) return normalise(marker);

  // 2. Machine-wide configuration, guarded. See the header: this setting has a
  // localhost default, so honouring it for a REMOTE database would silently
  // point the convert at the operator's own machine.
  const setting = asBaseUrl(input.settingServerUrl);
  if (setting) {
    const databaseIsLocal = derived.includes('127.0.0.1') || derived.includes('localhost');
    if (!isLoopback(setting) || databaseIsLocal) return normalise(setting);
  }

  // 3. Unchanged fallback, so nothing that works today changes.
  return derived;
}
