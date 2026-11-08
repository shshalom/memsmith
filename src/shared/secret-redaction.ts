// SPDX-License-Identifier: Apache-2.0
//
// Replaces secret values in captured content with `[REDACTED:<kind>]` before
// the content is spooled, stored, or sent to a generation provider.
//
// Every pattern runs in linear time on hostile input. Each pattern starts with
// a literal, so the engine skips ahead to candidates instead of testing every
// position. Token boundaries are checked after the literal or in a callback,
// and every repetition that can be followed by a failing suffix is bounded.
// Tool outputs reach megabytes, and this runs inside hooks on the user's
// critical path.

export type SecretKind =
  | 'anthropic_key'
  | 'openai_key'
  | 'github_token'
  | 'google_api_key'
  | 'aws_access_key_id'
  | 'slack_token'
  | 'npm_token'
  | 'jwt'
  | 'bearer_token'
  | 'private_key'
  | 'key'
  | 'token'
  | 'secret'
  | 'password';

const marker = (kind: SecretKind) => `[REDACTED:${kind}]`;
const MARKER_PREFIX = '[REDACTED:';

interface TokenRule {
  kind: SecretKind;
  pattern: RegExp;
  /** A preceding character in this class means the match is inside a longer word. */
  inWord?: RegExp;
  accept?: (match: string) => boolean;
}

const hasDigitAndLetter = (s: string) => /\d/.test(s) && /[A-Za-z]/.test(s);

const TOKEN_RULES: TokenRule[] = [
  {
    kind: 'private_key',
    pattern: /-----BEGIN ((?:[A-Z0-9]+ )*)PRIVATE KEY-----(?:[^-]|-(?!----)){0,65536}(?:-----END \1PRIVATE KEY-----)?/g,
  },
  { kind: 'anthropic_key', pattern: /sk-ant-[A-Za-z0-9_-]{20,}/g, inWord: /[A-Za-z0-9_-]/ },
  {
    kind: 'openai_key',
    pattern: /sk-[A-Za-z0-9_-]{20,}/g,
    inWord: /[A-Za-z0-9_-]/,
    accept: m => !m.startsWith('sk-ant-') && hasDigitAndLetter(m.slice(3)),
  },
  { kind: 'github_token', pattern: /gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{22,}/g, inWord: /[A-Za-z0-9_]/ },
  { kind: 'google_api_key', pattern: /AIza[0-9A-Za-z_-]{35}(?![A-Za-z0-9_-])/g, inWord: /[A-Za-z0-9_-]/ },
  { kind: 'aws_access_key_id', pattern: /A(?:KIA|SIA)[0-9A-Z]{16}(?![A-Za-z0-9])/g, inWord: /[A-Za-z0-9]/ },
  {
    kind: 'slack_token',
    pattern: /xox[abprs]-[A-Za-z0-9-]{10,}/g,
    inWord: /[A-Za-z0-9_-]/,
    accept: m => /\d/.test(m),
  },
  { kind: 'npm_token', pattern: /npm_[A-Za-z0-9]{36,}/g, inWord: /[A-Za-z0-9_]/ },
  {
    // The boundary lookbehind sits after the literal: a run of `eyJ` with no
    // dots must not restart the bounded segment scan at every occurrence.
    kind: 'jwt',
    pattern: /eyJ(?<![A-Za-z0-9_-]eyJ)[A-Za-z0-9_-]{8,4096}\.[A-Za-z0-9_-]{8,4096}\.[A-Za-z0-9_-]{8,4096}(?![A-Za-z0-9_-])/g,
  },
];

const BEARER = /\b(Bearer[ \t]+)([A-Za-z0-9._~+/-]{8,4096}=*)/g;

// Matches from the name's secret suffix so the scan skips to candidates; the
// rest of the name is read backward in the callback. Group 1: suffix. Group 2:
// separator. Groups 3-5: double-quoted, single-quoted, or bare value.
const ASSIGNMENT =
  /(key|token|secret|password|passwd)(?![A-Za-z0-9_])(["']?[ \t]*[:=][ \t]*)(?:"([^"\\\r\n]{0,4096})"|'([^'\\\r\n]{0,4096})'|([^\s"'`,;&(){}[\]<>]{1,4096}))/gi;

const NAME_CHAR = /[A-Za-z0-9_.-]/;
const MAX_NAME_PREFIX = 96;

function nameBefore(text: string, offset: number, suffix: string): string {
  let start = offset;
  while (start > 0 && offset - start < MAX_NAME_PREFIX && NAME_CHAR.test(text[start - 1])) start -= 1;
  return text.slice(start, offset).replace(/^[^A-Za-z_]+/, '') + suffix;
}

// Names whose `key` is an identifier or a public value, not a credential. Their
// values are often hashes, which would otherwise pass the secret-value test.
const NON_SECRET_KEY_PREFIX =
  /(?:idempotency|generation|cache|hash|lookup|query|sort|primary|foreign|partition|dedupe?|config|object|row|group|composite|unique|index|translation|storage|bucket|registry|public|license)[_.-]?$/i;

const GLUED_PREFIX = /^(?:api|access|auth|secret|private|client|refresh|session|app|master|bearer|signing|encryption)$/i;

/** The kind a secret-named field carries, or null when the name is not a secret name. */
function secretNameKind(name: string): SecretKind | null {
  const match = /(key|token|secret|password|passwd)$/i.exec(name);
  if (!match) return null;
  const suffix = match[1];
  const lower = suffix.toLowerCase();
  if (lower === 'password' || lower === 'passwd') return 'password';
  const kind = lower as 'key' | 'token' | 'secret';
  const before = name.slice(0, -suffix.length);
  if (kind === 'key' && NON_SECRET_KEY_PREFIX.test(before)) return null;
  if (before === '' || /[_.-]$/.test(before)) return kind;
  const camel = suffix[0] === suffix[0].toUpperCase() && suffix.slice(1) === suffix.slice(1).toLowerCase();
  if (camel && /[A-Za-z0-9]$/.test(before)) return kind;
  if (GLUED_PREFIX.test(before)) return kind;
  return null;
}

const PLACEHOLDERS = [
  /^<[^>]*>$/,
  /^\$\{[^}]*\}$/,
  /^\$[A-Za-z_]\w*$/,
  /^\{\{[^}]*\}\}$/,
  /^%[A-Za-z_]\w*%$/,
  /^(.)\1*$/,
  /^your[-_]/i,
];

const NON_SECRET_WORDS = new Set([
  'changeme', 'placeholder', 'redacted', 'example', 'dummy', 'sample', 'none', 'null', 'nil',
  'undefined', 'true', 'false', 'string', 'number', 'boolean', 'bool', 'str', 'int', 'any',
  'unknown', 'object', 'required', 'optional', 'secret', 'password', 'passwd', 'token', 'key',
]);

const DOTTED_IDENTIFIER = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/;
const PATH = /^(?:\/|~\/|\.\.?\/)/;

/**
 * Decides whether a value assigned to a secret-named field is a real secret.
 * A bare value is held to a stricter bar than a quoted one: in source code a
 * bare value is usually an identifier, not a literal.
 */
function isSecretValue(value: string, kind: SecretKind, quoted: boolean): boolean {
  if (value.length === 0 || value.startsWith(MARKER_PREFIX)) return false;
  if (/\s/.test(value)) return false;
  if (PLACEHOLDERS.some(p => p.test(value))) return false;
  if (NON_SECRET_WORDS.has(value.toLowerCase())) return false;
  if (DOTTED_IDENTIFIER.test(value) || PATH.test(value)) return false;
  if (kind === 'password') {
    if (value.length < 4) return false;
    return quoted || /[^A-Za-z]/.test(value);
  }
  if (/^\d+$/.test(value)) return false;
  return value.length >= 8 && (/\d/.test(value) || value.length >= 20);
}

function redactAssignments(text: string): string {
  return text.replace(
    ASSIGNMENT,
    (match, suffix: string, sep: string, dq: string | undefined, sq: string | undefined, bare: string | undefined, offset: number) => {
      const kind = secretNameKind(nameBefore(text, offset, suffix));
      if (!kind) return match;
      if (bare !== undefined) {
        if (text[offset + match.length] === '(') return match;
        return isSecretValue(bare, kind, false) ? `${suffix}${sep}${marker(kind)}` : match;
      }
      const value = dq ?? sq ?? '';
      const quote = dq !== undefined ? '"' : "'";
      return isSecretValue(value, kind, true) ? `${suffix}${sep}${quote}${marker(kind)}${quote}` : match;
    },
  );
}

/** Replaces every recognized secret in `text` with `[REDACTED:<kind>]`. Idempotent. */
export function redactSecrets(text: string): string {
  if (typeof text !== 'string' || text.length < 8) return text;
  let out = text;
  for (const rule of TOKEN_RULES) {
    const source = out;
    out = source.replace(rule.pattern, (m: string, ...rest: unknown[]) => {
      const offset = rest[rest.length - 2] as number;
      if (rule.inWord && offset > 0 && rule.inWord.test(source[offset - 1])) return m;
      return !rule.accept || rule.accept(m) ? marker(rule.kind) : m;
    });
  }
  out = out.replace(BEARER, (m, scheme: string, token: string) =>
    /\d/.test(token) || token.length >= 20 ? `${scheme}${marker('bearer_token')}` : m,
  );
  return redactAssignments(out);
}

/**
 * Returns a copy of `value` with every string redacted. A string stored under
 * a secret-named object key, such as `{ "API_KEY": "..." }`, is redacted as a
 * whole, because a JSON payload carries the name in the key, not the text.
 */
export function redactSecretsDeep<T>(value: T): T {
  return redactValue(value, null) as T;
}

function redactValue(value: unknown, key: string | null): unknown {
  if (typeof value === 'string') {
    const kind = key !== null ? secretNameKind(key) : null;
    if (kind && isSecretValue(value, kind, true)) return marker(kind);
    return redactSecrets(value);
  }
  if (Array.isArray(value)) return value.map(item => redactValue(item, null));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = redactValue(v, k);
    return out;
  }
  return value;
}
