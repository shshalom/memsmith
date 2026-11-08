// SPDX-License-Identifier: Apache-2.0
//
// Replaces secret values in captured content with `[REDACTED:<kind>]` before
// the content is spooled, stored, or sent to a generation provider.
//
// Every pattern runs in linear time on hostile input. Each pattern starts with
// a literal or \b, so the engine skips ahead to candidates instead of testing
// every position. Token boundaries are checked in a callback, not with a
// lookbehind: any lookbehind makes the engine several times slower per
// megabyte. A repetition is unbounded only where its character class stops at
// the delimiter that follows it, so no start position is rescanned.
// Tool outputs reach megabytes, and this runs inside hooks on the user's
// critical path.

export type SecretKind =
  | 'anthropic_key'
  | 'openai_key'
  | 'stripe_key'
  | 'github_token'
  | 'gitlab_token'
  | 'huggingface_token'
  | 'google_api_key'
  | 'aws_access_key_id'
  | 'slack_token'
  | 'npm_token'
  | 'jwt'
  | 'bearer_token'
  | 'authorization'
  | 'private_key'
  | 'key'
  | 'token'
  | 'secret'
  | 'password'
  | 'circular'
  | 'unserializable';

// `camel_pass` is a name such as `dbPass`. Its values are held to a stricter
// bar than other password names, and it is reported as `password`.
type NameKind = SecretKind | 'camel_pass';

const marker = (kind: NameKind) => `[REDACTED:${kind === 'camel_pass' ? 'password' : kind}]`;
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
    // Without an END line the block ends at the first quote or blank line, so
    // a truncated key cannot erase the text that follows it.
    kind: 'private_key',
    pattern: /-----BEGIN ((?:[A-Z0-9]+ )*)PRIVATE KEY( BLOCK)?-----(?:\r?\n)?(?:[^-"'\n]|\n(?![ \t]*\r?\n)|-(?!----))*(?:-----END \1PRIVATE KEY\2-----)?/g,
  },
  { kind: 'anthropic_key', pattern: /sk-ant-[A-Za-z0-9_-]{20,}/g, inWord: /[A-Za-z0-9_-]/ },
  {
    kind: 'openai_key',
    pattern: /sk-[A-Za-z0-9_-]{20,}/g,
    inWord: /[A-Za-z0-9_-]/,
    accept: m => !m.startsWith('sk-ant-') && hasDigitAndLetter(m.slice(3)),
  },
  { kind: 'stripe_key', pattern: /[sr]k_(?:live|test)_[A-Za-z0-9]{16,}/g, inWord: /[A-Za-z0-9_]/ },
  { kind: 'github_token', pattern: /gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{22,}/g, inWord: /[A-Za-z0-9_]/ },
  { kind: 'gitlab_token', pattern: /glpat-[A-Za-z0-9_-]{20,}/g, inWord: /[A-Za-z0-9_-]/ },
  {
    kind: 'huggingface_token',
    pattern: /hf_[A-Za-z0-9]{30,}/g,
    inWord: /[A-Za-z0-9_]/,
    accept: m => hasDigitAndLetter(m.slice(3)),
  },
  { kind: 'google_api_key', pattern: /AIza[0-9A-Za-z_-]{35}(?![A-Za-z0-9_-])/g, inWord: /[A-Za-z0-9_-]/ },
  { kind: 'aws_access_key_id', pattern: /A(?:KIA|SIA)[0-9A-Z]{16}(?![A-Za-z0-9])/g, inWord: /[A-Za-z0-9]/ },
  {
    kind: 'slack_token',
    pattern: /xox[abprs]-[A-Za-z0-9-]{10,}/g,
    inWord: /[A-Za-z0-9_-]/,
    accept: m => /\d/.test(m),
  },
  { kind: 'npm_token', pattern: /npm_[A-Za-z0-9]{36,}/g, inWord: /[A-Za-z0-9_]/ },
];

// A JWT is found in two steps. JWT_RUN consumes a whole run of token and dot
// characters in one pass, so a dot-free run full of `-eyJ` is scanned once
// instead of once per occurrence. JWT_AT then tries only the `eyJ` positions
// that start a token: each try reads at most three dot-separated segments.
const JWT_RUN = /eyJ[A-Za-z0-9_.-]*/g;
const JWT_AT = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/y;
const TOKEN_CHAR = /[A-Za-z0-9_-]/;

function redactJwts(text: string): string {
  return text.replace(JWT_RUN, (run: string, offset: number) => {
    if (!run.includes('.')) return run;
    let out = '';
    let copied = 0;
    let at = 0;
    while (at !== -1) {
      const before = at === 0 ? text[offset - 1] : run[at - 1];
      if (before === undefined || !TOKEN_CHAR.test(before)) {
        JWT_AT.lastIndex = at;
        const jwt = JWT_AT.exec(run);
        if (jwt) {
          out += run.slice(copied, at) + marker('jwt');
          copied = at + jwt[0].length;
          at = run.indexOf('eyJ', copied);
          continue;
        }
      }
      at = run.indexOf('eyJ', at + 3);
    }
    return out + run.slice(copied);
  });
}

const looksLikeToken = (token: string) => /\d/.test(token) || token.length >= 20;

const BEARER = /\b(Bearer[ \t]+)([A-Za-z0-9._~+/-]{8,}=*)/g;

const AUTHORIZATION =
  /\b(Authorization\\?["']?[ \t]*[:=][ \t]*\\?["']?)(?:(Basic|Token|Digest|Negotiate|NTLM)([ \t]+))?([A-Za-z0-9._~+/-]{8,}=*)/gi;

// Without a scheme, an Authorization value must look opaque: a config flag
// such as `authorization: enabled_for_users_2024` has digits too.
const looksLikeOpaqueToken = (token: string) =>
  /\d/.test(token) && /[A-Za-z]/.test(token) &&
  (token.includes('_') ? token.length >= 20 && !isWordList(token) : token.length >= 16);

/** True for a value such as `enabled_for_users_2024`: short words, numbers, or version tags. */
function isWordList(token: string): boolean {
  return token.split('_').every(part => part.length <= 4 || /^(?:[A-Za-z]{1,12}|\d{1,8})$/.test(part));
}

const CONNECTION_PASSWORD = /:\/\/([^\s:/@"'<>]{0,256}:)([^\s/@"'<>]+)(?=@)/g;

const FLAG = /-(-?[A-Za-z][A-Za-z0-9_-]{0,63}[ \t]+)(?:"((?:[^"\\\r\n]|\\.)*)"|'([^'\r\n]*)'|([^\s"'`;&|()<>\\-][^\s"'`;&|()<>]*))/g;

// Applies only to a netrc entry with a login, on one line or several, so prose
// such as `password manager2` is left alone.
const NETRC_ENTRY = /\b(?:machine\s+\S+|default)((?:\s+(?:login|account|port)\s+\S+)+)\s+password\s+(\S+)/g;

const NPM_AUTH = /(_auth(?:Token)?|_password)([ \t]+)([^\s"'`;&|()<>\\][^\s"'`;&|()<>]*)/g;

// Matches from the name's secret suffix so the scan skips to candidates; the
// rest of the name is read backward in the callback. Group 1: suffix. Group 2:
// separator. Groups 3-6: escaped-quoted, double-quoted, single-quoted, or bare
// value. Values are unbounded: a capped value leaves the rest of a long secret
// in place, and every value class stops at its own delimiter.
const ASSIGNMENT =
  /(key_base|key|token|secret|password|passwd|pass)(?![A-Za-z0-9_])(\\?["']?[ \t]*[:=][ \t]*)(?:\\"((?:[^"\\\r\n]|\\(?!")[^\r\n])*)\\"|"((?:[^"\\\r\n]|\\.)*)"|'((?:[^'\\\r\n]|\\.)*)'|([^\s"'`,;&(){}[\]<>\\]+))/gi;

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

// Pagination cursors and model token settings, not credentials.
// Graphics and build passes, not credentials.
const NON_SECRET_PASS_PREFIX =
  /(?:render|shadow|depth|blur|bloom|post|light|lighting|geometry|gbuffer|compute|draw|composite|first|second|final|multi|single|compile|lint|build|test|by|sur|com)$/i;

const NON_SECRET_TOKEN_PREFIX =
  /(?:next|page|continuation|pagination|cursor|sync|resume|max|min|num|total|input|output|prompt|completion|stop|eos|bos|pad|unk|special)[_.-]?$/i;

const GLUED_PREFIX = /^(?:api|access|auth|secret|private|client|refresh|session|app|master|bearer|signing|encryption)$/i;

/** The kind a secret-named field carries, or null when the name is not a secret name. */
function secretNameKind(name: string): NameKind | null {
  const match = /(key_base|key|token|secret|password|passwd|pass)$/i.exec(name);
  if (!match) return null;
  const suffix = match[1];
  const lower = suffix.toLowerCase();
  if (lower === 'password' || lower === 'passwd') return 'password';
  if (lower === 'pass') {
    if (/(?:^|[_.-])pass$/i.test(name)) return 'password';
    const before = name.slice(0, -suffix.length);
    return suffix === 'Pass' && /[a-z0-9]$/.test(before) && !NON_SECRET_PASS_PREFIX.test(before) ? 'camel_pass' : null;
  }
  const kind: SecretKind = lower === 'pass' ? 'password' : lower === 'key_base' ? 'key' : (lower as 'key' | 'token' | 'secret');
  const before = name.slice(0, -suffix.length);
  if (kind === 'key' && (before === '' || NON_SECRET_KEY_PREFIX.test(before))) return null;
  if (kind === 'token' && NON_SECRET_TOKEN_PREFIX.test(before)) return null;
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
const FILE_PATH = /\/.*\.[A-Za-z][A-Za-z0-9]{0,7}$/;
const SECRET_WORD = /pass|key|token|secret/i;

/**
 * A quoted value of three or more plain words that reads like a sentence, such
 * as `"Forgot your login details?"`, is a UI label. A passphrase made only of
 * lowercase words, or one with digits or symbols, is not.
 */
function looksLikeLabel(value: string): boolean {
  const text = value.trim();
  if (text.split(/\s+/).length < 3) return false;
  if (!/^[A-Za-z\s]+$/.test(text.replace(/[.?!,:;'"()-]+/g, ''))) return false;
  return /^[A-Z]/.test(text) || /[.?!:]$/.test(text);
}

/**
 * Decides whether a value assigned to a secret-named field is a real secret.
 * A bare value is held to a stricter bar than a quoted one: in source code a
 * bare value is usually an identifier, not a literal. A quoted value with
 * spaces is a passphrase unless it names the field, as a UI label does.
 */
function isSecretValue(value: string, kind: NameKind, quoted: boolean): boolean {
  if (value.length === 0 || value.startsWith(MARKER_PREFIX)) return false;
  if (PLACEHOLDERS.some(p => p.test(value))) return false;
  if (NON_SECRET_WORDS.has(value.toLowerCase())) return false;
  if (/\s/.test(value)) {
    if (!quoted || /[\r\n]/.test(value) || SECRET_WORD.test(value) || value.length < 8) return false;
    return !looksLikeLabel(value);
  }
  if (DOTTED_IDENTIFIER.test(value) || PATH.test(value) || FILE_PATH.test(value)) return false;
  if (kind === 'camel_pass') return value.length >= 6 && /[^A-Za-z]/.test(value);
  if (kind === 'password') {
    if (value.length < 4) return false;
    return quoted || /[^A-Za-z]/.test(value);
  }
  if (/^\d+$/.test(value)) return false;
  return value.length >= 8 && (/\d/.test(value) || value.length >= 20);
}

// A bare `pass` is also an ordinary word in test output ("first pass: 12/27",
// "PASS: 98%"). After `pass:`, an unquoted count, fraction, or percentage is a
// result, not a password.
const PASS_RESULT = /^\d+(?:[/.]\d+)?%?$/;

function redactAssignments(text: string): string {
  return text.replace(
    ASSIGNMENT,
    (match, suffix: string, sep: string, esc: string | undefined, dq: string | undefined, sq: string | undefined, bare: string | undefined, offset: number) => {
      const name = nameBefore(text, offset, suffix);
      if (name.toLowerCase() === 'pass' && bare !== undefined && sep.includes(':') && PASS_RESULT.test(bare)) return match;
      const kind = secretNameKind(name);
      if (!kind) return match;
      if (bare !== undefined) {
        if (text[offset + match.length] === '(') return match;
        return isSecretValue(bare, kind, false) ? `${suffix}${sep}${marker(kind)}` : match;
      }
      const value = esc ?? dq ?? sq ?? '';
      const quote = esc !== undefined ? '\\"' : dq !== undefined ? '"' : "'";
      return isSecretValue(value, kind, true) ? `${suffix}${sep}${quote}${marker(kind)}${quote}` : match;
    },
  );
}

function redactFlags(text: string): string {
  return text.replace(FLAG, (match, prefix: string, dq: string | undefined, sq: string | undefined, bare: string | undefined, offset: number) => {
    if (offset > 0 && /[\w-]/.test(text[offset - 1])) return match;
    const kind = secretNameKind(prefix.trim().replace(/^-/, ''));
    if (!kind) return match;
    const quoted = bare === undefined;
    const value = dq ?? sq ?? bare ?? '';
    if (!isSecretValue(value, kind, quoted)) return match;
    const quote = dq !== undefined ? '"' : sq !== undefined ? "'" : '';
    return `-${prefix}${quote}${marker(kind)}${quote}`;
  });
}

const MAX_PASSES = 3;

/**
 * Replaces every recognized secret in `text` with `[REDACTED:<kind>]`.
 * A redaction can expose a new candidate for a rule that already ran, so the
 * rules repeat until the text stops changing, which makes the result
 * idempotent.
 */
export function redactSecrets(text: string): string {
  if (typeof text !== 'string' || text.length < 8) return text;
  let out = text;
  for (let pass = 0; pass < MAX_PASSES; pass += 1) {
    const next = redactOnce(out);
    if (next === out) break;
    out = next;
  }
  return out;
}

function redactOnce(text: string): string {
  let out = text;
  for (const rule of TOKEN_RULES) {
    const source = out;
    out = source.replace(rule.pattern, (m: string, ...rest: unknown[]) => {
      const offset = rest[rest.length - 2] as number;
      if (rule.inWord && offset > 0 && rule.inWord.test(source[offset - 1])) return m;
      return !rule.accept || rule.accept(m) ? marker(rule.kind) : m;
    });
  }
  out = redactJwts(out);
  out = out.replace(BEARER, (m, scheme: string, token: string) =>
    looksLikeToken(token) ? `${scheme}${marker('bearer_token')}` : m,
  );
  out = out.replace(AUTHORIZATION, (m, prefix: string, scheme: string | undefined, space: string | undefined, token: string) => {
    const secret = scheme ? looksLikeToken(token) : looksLikeOpaqueToken(token);
    return secret ? `${prefix}${scheme ?? ''}${space ?? ''}${marker('authorization')}` : m;
  });
  out = out.replace(CONNECTION_PASSWORD, (m, user: string, password: string, offset: number, source: string) =>
    offset > 0 && /[A-Za-z0-9]/.test(source[offset - 1]) && isSecretValue(password, 'password', true)
      ? `://${user}${marker('password')}`
      : m,
  );
  out = redactFlags(out);
  out = out.replace(NETRC_ENTRY, (m, fields: string, password: string) =>
    /\blogin\s/.test(fields) && isSecretValue(password, 'password', true)
      ? `${m.slice(0, m.length - password.length)}${marker('password')}`
      : m,
  );
  out = out.replace(NPM_AUTH, (m, name: string, space: string, value: string, offset: number, source: string) => {
    if (offset > 0 && /[A-Za-z0-9]/.test(source[offset - 1])) return m;
    const kind: SecretKind = name === '_password' ? 'password' : 'token';
    return isSecretValue(value, kind, false) ? `${name}${space}${marker(kind)}` : m;
  });
  return redactAssignments(out);
}

/**
 * Returns a copy of `value` with every string redacted. A string stored under
 * a secret-named object key, such as `{ "API_KEY": "..." }`, is redacted as a
 * whole, because a JSON payload carries the name in the key, not the text.
 * The copy has the shape `JSON.stringify` would produce: `toJSON` is applied
 * and other non-plain objects become their own enumerable properties.
 *
 * Never returns unredacted content. If the walk throws, the value is
 * stringified and redacted as text; if that fails too, a marker replaces it.
 */
export function redactSecretsDeep<T>(value: T): T {
  try {
    return redactValue(value, null, new Set()) as T;
  } catch {
    try {
      const json = JSON.stringify(value);
      return (json === undefined ? marker('unserializable') : redactSecrets(json)) as T;
    } catch {
      return marker('unserializable') as T;
    }
  }
}

function redactValue(value: unknown, key: string | null, ancestors: Set<object>): unknown {
  if (typeof value === 'string') {
    const kind = key !== null ? secretNameKind(key) : null;
    if (kind && isSecretValue(value, kind, true)) return marker(kind);
    return redactSecrets(value);
  }
  if (!value || typeof value !== 'object') return value;
  if (ancestors.has(value)) return marker('circular');
  const toJSON = (value as { toJSON?: unknown }).toJSON;
  if (typeof toJSON === 'function') {
    ancestors.add(value);
    const result = redactValue(toJSON.call(value, key ?? ''), key, ancestors);
    ancestors.delete(value);
    return result;
  }
  ancestors.add(value);
  let out: unknown;
  if (Array.isArray(value)) {
    out = value.map(item => redactValue(item, null, ancestors));
  } else {
    const copy: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      Object.defineProperty(copy, k, { value: redactValue(v, k, ancestors), enumerable: true, writable: true, configurable: true });
    }
    out = copy;
  }
  ancestors.delete(value);
  return out;
}
