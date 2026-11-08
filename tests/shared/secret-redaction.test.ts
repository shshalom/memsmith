// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'bun:test';
import { redactSecrets, redactSecretsDeep } from '../../src/shared/secret-redaction.js';

// Fake values are assembled at runtime so the repository never holds a
// literal that a secret scanner flags.
const fill = (prefix: string, length: number, body = 'FAKE0test9') =>
  prefix + body.repeat(Math.ceil(length / body.length)).slice(0, length);

const FAKE = {
  anthropic: fill('sk-ant-api03-', 40),
  openai: fill('sk-', 48),
  openaiProject: fill('sk-proj-', 60),
  ghp: fill('ghp_', 36),
  gho: fill('gho_', 36),
  ghu: fill('ghu_', 36),
  ghs: fill('ghs_', 36),
  ghr: fill('ghr_', 36),
  githubPat: fill('github_pat_', 60),
  google: fill('AIza', 35),
  awsAccessKeyId: fill('AKIA', 16, 'FAKE0TEST9'),
  awsSessionKeyId: fill('ASIA', 16, 'FAKE0TEST9'),
  awsSecret: fill('', 40, 'fAkE0SeCrEt9/+'),
  slack: fill('xoxb-', 40, 'FAKE0-test9'),
  npm: fill('npm_', 36),
  bearer: fill('', 32, 'fakeBearer0Token9'),
  jwt: ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiJmYWtlLXVzZXIifQ', 'ZmFrZS1zaWduYXR1cmUtdGVzdA'].join('.'),
};

describe('redactSecrets: provider token patterns', () => {
  const cases: Array<[string, string, string]> = [
    ['Anthropic key', FAKE.anthropic, 'anthropic_key'],
    ['OpenAI key', FAKE.openai, 'openai_key'],
    ['OpenAI project key', FAKE.openaiProject, 'openai_key'],
    ['GitHub ghp_', FAKE.ghp, 'github_token'],
    ['GitHub gho_', FAKE.gho, 'github_token'],
    ['GitHub ghu_', FAKE.ghu, 'github_token'],
    ['GitHub ghs_', FAKE.ghs, 'github_token'],
    ['GitHub ghr_', FAKE.ghr, 'github_token'],
    ['GitHub fine-grained PAT', FAKE.githubPat, 'github_token'],
    ['Google API key', FAKE.google, 'google_api_key'],
    ['AWS access key ID (AKIA)', FAKE.awsAccessKeyId, 'aws_access_key_id'],
    ['AWS access key ID (ASIA)', FAKE.awsSessionKeyId, 'aws_access_key_id'],
    ['Slack token', FAKE.slack, 'slack_token'],
    ['npm token', FAKE.npm, 'npm_token'],
    ['JWT', FAKE.jwt, 'jwt'],
  ];

  for (const [label, secret, kind] of cases) {
    it(`redacts a bare ${label} and keeps the surrounding text`, () => {
      const out = redactSecrets(`the value is ${secret} (printed twice: ${secret}).`);
      expect(out).not.toContain(secret);
      expect(out).toBe(`the value is [REDACTED:${kind}] (printed twice: [REDACTED:${kind}]).`);
    });
  }

  it('does not let the OpenAI rule claim an Anthropic key', () => {
    expect(redactSecrets(FAKE.anthropic)).toBe('[REDACTED:anthropic_key]');
  });
});

describe('redactSecrets: bearer tokens', () => {
  it('redacts an Authorization header value and keeps the header and scheme', () => {
    expect(redactSecrets(`curl -H "Authorization: Bearer ${FAKE.bearer}" https://api.example.com`))
      .toBe('curl -H "Authorization: Bearer [REDACTED:bearer_token]" https://api.example.com');
  });

  it('redacts a bare Bearer token', () => {
    expect(redactSecrets(`token was Bearer ${FAKE.bearer}`)).toBe('token was Bearer [REDACTED:bearer_token]');
  });

  it('leaves prose about bearer tokens and shell placeholders intact', () => {
    for (const text of [
      'Bearer tokens expire after an hour.',
      'Authorization: Bearer $TOKEN',
      'Authorization: Bearer ${API_TOKEN}',
      'Authorization: Bearer <token>',
    ]) {
      expect(redactSecrets(text)).toBe(text);
    }
  });
});

describe('redactSecrets: PEM private keys', () => {
  it('redacts the whole block and keeps text around it', () => {
    const pem = [
      '-----BEGIN RSA PRIVATE KEY-----',
      'MIIEFAKEFAKEFAKEtestONLYnotARealKey0000000000000000000000000000',
      'FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE00',
      '-----END RSA PRIVATE KEY-----',
    ].join('\n');
    const out = redactSecrets(`before\n${pem}\nafter`);
    expect(out).toBe('before\n[REDACTED:private_key]\nafter');
  });

  it('redacts an OPENSSH key block', () => {
    const pem = '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEFAKE\n-----END OPENSSH PRIVATE KEY-----';
    expect(redactSecrets(pem)).toBe('[REDACTED:private_key]');
  });

  it('leaves a public key block intact', () => {
    const pub = '-----BEGIN PUBLIC KEY-----\nMFkwFAKEpublic\n-----END PUBLIC KEY-----';
    expect(redactSecrets(pub)).toBe(pub);
  });
});

describe('redactSecrets: named assignments keep the name', () => {
  const value = 'fAkEvAlUe0123456789xyz';
  const cases: Array<[string, string, string]> = [
    ['env', `MY_SERVICE_API_KEY=${value}`, 'MY_SERVICE_API_KEY=[REDACTED:key]'],
    ['export', `export GITLAB_TOKEN=${value}`, 'export GITLAB_TOKEN=[REDACTED:token]'],
    ['quoted env', `CLIENT_SECRET="${value}"`, 'CLIENT_SECRET="[REDACTED:secret]"'],
    ['JSON', `{"db_password": "${value}"}`, '{"db_password": "[REDACTED:password]"}'],
    ['JSON camelCase', `{"apiKey":"${value}"}`, '{"apiKey":"[REDACTED:key]"}'],
    ['YAML', `smtp:\n  passwd: ${value}\n`, 'smtp:\n  passwd: [REDACTED:password]\n'],
    ['code with spaces', `access_token = '${value}'`, "access_token = '[REDACTED:token]'"],
    ['lower-case glued', `apikey: ${value}`, 'apikey: [REDACTED:key]'],
    ['URL query', `https://x.example.com/cb?token=${value}&next=1`, 'https://x.example.com/cb?token=[REDACTED:token]&next=1'],
  ];
  for (const [label, input, expected] of cases) {
    it(`redacts the value of a ${label} assignment`, () => {
      expect(redactSecrets(input)).toBe(expected);
    });
  }

  it('redacts an aws_secret_access_key assignment', () => {
    expect(redactSecrets(`aws_secret_access_key = ${FAKE.awsSecret}`))
      .toBe('aws_secret_access_key = [REDACTED:key]');
  });

  it('redacts a short password, because password names carry a lower bar', () => {
    expect(redactSecrets('PGPASSWORD=hunter42 psql')).toBe('PGPASSWORD=[REDACTED:password] psql');
  });

  it('keeps the specific kind when a named value is a known token', () => {
    expect(redactSecrets(`ANTHROPIC_API_KEY=${FAKE.anthropic}`)).toBe('ANTHROPIC_API_KEY=[REDACTED:anthropic_key]');
  });
});

describe('redactSecrets: false-positive guards', () => {
  const intact = [
    'The monkey ate a banana.',
    'monkey: banana',
    'turkey=sandwich12345678',
    'commit 3f2c1a9b8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c3b fixed the bug',
    'session 123e4567-e89b-12d3-a456-426614174000 started',
    'edited /Users/alex/project/src/api/keys/token-store.ts',
    'API_KEY=<your-key>',
    'API_KEY=xxx',
    'API_KEY=xxxxxxxxxxxxxxxx',
    'API_KEY=${ANTHROPIC_API_KEY}',
    'API_KEY=$ANTHROPIC_API_KEY',
    'API_KEY=',
    'API_KEY=""',
    'const apiKey = process.env.ANTHROPIC_API_KEY;',
    'apiKey: string;',
    'password: string',
    '"primaryKey": true',
    'sortKey: "createdAt"',
    '"password": "Enter your password"',
    'SSH_KEY=~/.ssh/id_ed25519',
    'max_token: 4096',
    'skip the task-runner-configuration-for-production step',
    'run scikit-learn with sk-learn-compatible estimators',
    'ANTHROPIC_API_KEY=[REDACTED:anthropic_key]',
    '{"idempotencyKey": "3f2c1a9b8e7d6c5b4a3f2e1d0c9b8a7f"}',
    'cache_key=user-profile-v2-20261108',
    'PUBLIC_KEY=MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEfake0public9',
  ];
  for (const text of intact) {
    it(`leaves ${JSON.stringify(text)} intact`, () => {
      expect(redactSecrets(text)).toBe(text);
    });
  }

  it('is idempotent', () => {
    const once = redactSecrets(`KEY=${FAKE.openai} and Bearer ${FAKE.bearer}`);
    expect(redactSecrets(once)).toBe(once);
  });
});

describe('redactSecretsDeep', () => {
  it('redacts strings inside nested objects and arrays and keeps other values', () => {
    const payload = {
      tool_name: 'Bash',
      tool_input: { command: `echo ${FAKE.ghp}`, timeout: 1000, flags: [`--token=${FAKE.npm}`, true, null] },
      tool_response: { stdout: [`line ${FAKE.anthropic}`], exitCode: 0 },
    };
    const out = redactSecretsDeep(payload);
    const text = JSON.stringify(out);
    for (const secret of [FAKE.ghp, FAKE.npm, FAKE.anthropic]) expect(text).not.toContain(secret);
    expect(out).toEqual({
      tool_name: 'Bash',
      tool_input: { command: 'echo [REDACTED:github_token]', timeout: 1000, flags: ['--token=[REDACTED:npm_token]', true, null] },
      tool_response: { stdout: ['line [REDACTED:anthropic_key]'], exitCode: 0 },
    });
  });

  it('redacts a string value whose object key names a secret', () => {
    const out = redactSecretsDeep({ env: { DATABASE_PASSWORD: 'hunter42', HOME: '/home/alex' }, apiKey: 'fAkEvAlUe0123456789xyz' });
    expect(out).toEqual({ env: { DATABASE_PASSWORD: '[REDACTED:password]', HOME: '/home/alex' }, apiKey: '[REDACTED:key]' });
  });

  it('leaves identifier keys such as idempotencyKey intact', () => {
    const input = { idempotencyKey: '3f2c1a9b8e7d6c5b4a3f2e1d0c9b8a7f', generationKey: 'gen-0123456789' };
    expect(redactSecretsDeep(input)).toEqual(input);
  });

  it('leaves placeholder values under secret-named keys intact', () => {
    const input = { API_KEY: '${API_KEY}', token: '', password: 'xxx' };
    expect(redactSecretsDeep(input)).toEqual(input);
  });

  it('does not mutate the input', () => {
    const input = { command: `echo ${FAKE.ghp}` };
    redactSecretsDeep(input);
    expect(input.command).toContain(FAKE.ghp);
  });
});

describe('redactSecrets: performance', () => {
  const MB = 1024 * 1024;
  const inputs: Array<[string, string]> = [
    ['ordinary text', 'The build passed after the API_KEY change; see /src/a.ts line 42.\n'.repeat(MB / 64)],
    ['one long token-alphabet run', 'a'.repeat(MB)],
    ['repeated eyJ prefixes with no dots', 'eyJ'.repeat(MB / 3)],
    ['repeated sk- prefixes', 'sk-'.repeat(MB / 3)],
    ['repeated assignment names with no value', 'A_KEY='.repeat(MB / 6)],
    ['an unterminated PEM header', `-----BEGIN PRIVATE KEY-----\n${'Q'.repeat(MB)}`],
    ['repeated Bearer words', 'Bearer '.repeat(MB / 7)],
    ['an unclosed quoted value', `api_key="${'a'.repeat(MB)}`],
    ['repeated unclosed quoted assignments', 'key:"'.repeat(MB / 5)],
    ['repeated scheme separators with no @', `x://u:${'p'.repeat(MB)}`],
    ['repeated short flags', '--a '.repeat(MB / 4)],
    ['repeated Authorization headers', 'Authorization: '.repeat(MB / 15)],
    ['repeated PEM headers', '-----BEGIN PRIVATE KEY-----'.repeat(MB / 27)],
    ['a long escaped run', '\\'.repeat(MB / 2)],
  ];
  for (const [label, input] of inputs) {
    it(`redacts 1 MB of ${label} in under 200 ms`, () => {
      const started = performance.now();
      redactSecrets(input);
      expect(performance.now() - started).toBeLessThan(200);
    });
  }
});

describe('redactSecrets: values longer than any fixed cap', () => {
  const long = (n: number) => fill('', n, 'fAkE0bAsE64/+9');

  it('redacts a 4500-character quoted value in full', () => {
    expect(redactSecrets(`GCP_SA_KEY="${long(4500)}" next`)).toBe('GCP_SA_KEY="[REDACTED:key]" next');
  });

  it('redacts a 4500-character bare value in full', () => {
    expect(redactSecrets(`GCP_SA_KEY=${long(4500)} next`)).toBe('GCP_SA_KEY=[REDACTED:key] next');
  });

  it('redacts a 4200-character bearer token in full', () => {
    expect(redactSecrets(`Authorization: Bearer ${fill('', 4200, 'fAkE0tOkEn9')} next`))
      .toBe('Authorization: Bearer [REDACTED:bearer_token] next');
  });

  it('redacts a JWT with a 5000-character segment', () => {
    const jwt = `eyJhbGciOiJIUzI1NiJ9.eyJ${fill('', 5000, 'ZmFrZQ9')}.ZmFrZS1zaWduYXR1cmUtdGVzdA`;
    expect(redactSecrets(`jwt ${jwt} end`)).toBe('jwt [REDACTED:jwt] end');
  });
});

describe('redactSecrets: more credential formats', () => {
  const cases: Array<[string, string, string]> = [
    ['connection string password', 'postgres://app_user:fAkEpAss42@db.internal:5432/app', 'postgres://app_user:[REDACTED:password]@db.internal:5432/app'],
    ['connection string with empty user', 'redis://:fAkEpAss42@cache:6379', 'redis://:[REDACTED:password]@cache:6379'],
    ['--api-key flag', 'mytool --api-key fAkE0123456789abcdef --verbose', 'mytool --api-key [REDACTED:key] --verbose'],
    ['--password flag', 'mysql --password hunter42 -h db', 'mysql --password [REDACTED:password] -h db'],
    ['--token flag after another flag', 'cli --verbose --token fAkE0123456789abcdef', 'cli --verbose --token [REDACTED:token]'],
    ['Authorization: token', 'Authorization: token fAkE0123456789abcdef', 'Authorization: token [REDACTED:authorization]'],
    ['Authorization: Basic', '"Authorization": "Basic ZmFrZTp1c2VyMTIz"', '"Authorization": "Basic [REDACTED:authorization]"'],
    ['.netrc password', 'machine api.example.com login alex password fAkEpass42', 'machine api.example.com login alex password [REDACTED:password]'],
    ['SECRET_KEY_BASE', `SECRET_KEY_BASE=${fill('', 64, 'fake0123456789ab')}`, 'SECRET_KEY_BASE=[REDACTED:key]'],
    ['*_PASS', 'SMTP_PASS=hunter42', 'SMTP_PASS=[REDACTED:password]'],
    ['quoted passphrase', 'DB_PASSWORD="correct horse battery staple"', 'DB_PASSWORD="[REDACTED:password]"'],
    ['escaped JSON', '{\\"api_key\\":\\"fAkEvAlUe0123456789xyz\\"}', '{\\"api_key\\":\\"[REDACTED:key]\\"}'],
    ['value with an escaped backslash', '{"password": "fake\\\\pass42"}', '{"password": "[REDACTED:password]"}'],
  ];
  for (const [label, input, expected] of cases) {
    it(`redacts a ${label}`, () => {
      expect(redactSecrets(input)).toBe(expected);
    });
  }

  const tokens: Array<[string, string, string]> = [
    ['Stripe live secret key', fill('sk_live_', 24), 'stripe_key'],
    ['Stripe test restricted key', fill('rk_test_', 24), 'stripe_key'],
    ['GitLab token', fill('glpat-', 20), 'gitlab_token'],
    ['Hugging Face token', fill('hf_', 34), 'huggingface_token'],
  ];
  for (const [label, secret, kind] of tokens) {
    it(`redacts a ${label}`, () => {
      expect(redactSecrets(`value ${secret} end`)).toBe(`value [REDACTED:${kind}] end`);
    });
  }

  it('redacts a PGP private key block', () => {
    const block = '-----BEGIN PGP PRIVATE KEY BLOCK-----\n\nlQOYBFAKEfakeFAKE0000\n=FAKE\n-----END PGP PRIVATE KEY BLOCK-----';
    expect(redactSecrets(`a\n${block}\nb`)).toBe('a\n[REDACTED:private_key]\nb');
  });

  it('stops an unterminated PEM block at the first blank line', () => {
    expect(redactSecrets('-----BEGIN PRIVATE KEY-----\nMIIfakeFAKE0000\n\nThe next paragraph stays.'))
      .toBe('[REDACTED:private_key]\n\nThe next paragraph stays.');
  });

  it('stops an unterminated PEM block at the first quote', () => {
    expect(redactSecrets('{"k": "-----BEGIN PRIVATE KEY-----\\nMIIfake", "other": "kept"}'))
      .toBe('{"k": "[REDACTED:private_key]", "other": "kept"}');
  });
});

describe('redactSecrets: review false-positive guards', () => {
  const intact = [
    '{"key": "row-12345678"}',
    'items.map(item => <Row key={item.id} />)',
    'Key: Enter',
    '"nextToken": "AAEAAWZha2UwMTIzNDU2Nzg5"',
    'pageToken=CAoQAA1234abcd',
    'cursor_token: c2Vjb25kLXBhZ2UtMTIzNA',
    'SSL_KEY=certs/server-2024.key',
    'ssl_key: config/tls/server.pem',
    'postgres://app_user:${DB_PASSWORD}@db.internal/app',
    'see https://github.com/org/repo and http://localhost:3000/x',
    'mytool --token-file ~/.config/token --verbose',
    'git commit --password-reset-flow docs',
    'The password reset email expired.',
    'bypass: true',
  ];
  for (const text of intact) {
    it(`leaves ${JSON.stringify(text)} intact`, () => {
      expect(redactSecrets(text)).toBe(text);
    });
  }
});

describe('redactSecretsDeep: hostile shapes', () => {
  it('replaces a cycle with a marker instead of recursing forever', () => {
    const node: Record<string, unknown> = { name: 'root', token_value: 'x' };
    node.self = node;
    expect(redactSecretsDeep(node)).toEqual({ name: 'root', token_value: 'x', self: '[REDACTED:circular]' });
  });

  it('keeps an own __proto__ key as data and does not change the prototype', () => {
    const input = JSON.parse(`{"__proto__": {"apiKey": "fAkEvAlUe0123456789xyz"}, "a": 1}`);
    const out = redactSecretsDeep(input) as Record<string, unknown>;
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(out, '__proto__')).toBe(true);
    expect(JSON.stringify(out)).toBe('{"__proto__":{"apiKey":"[REDACTED:key]"},"a":1}');
  });

  it('serializes non-plain objects the way JSON.stringify would', () => {
    const when = new Date('2026-11-08T00:00:00.000Z');
    const out = redactSecretsDeep({ when, map: new Map([['k', 'v']]), buf: Buffer.from('hi') });
    expect(JSON.stringify(out)).toBe(JSON.stringify({ when, map: {}, buf: Buffer.from('hi') }));
  });

  it('never returns unredacted content when the walk throws', () => {
    const hostile = { command: `echo ${FAKE.ghp}` } as Record<string, unknown>;
    Object.defineProperty(hostile, 'boom', { enumerable: true, get() { throw new Error('getter failed'); } });
    const out = redactSecretsDeep(hostile);
    expect(JSON.stringify(out) ?? '').not.toContain(FAKE.ghp);
  });

  it('redacts a passphrase under a secret-named key', () => {
    expect(redactSecretsDeep({ password: 'correct horse battery staple', label: 'Enter your password' }))
      .toEqual({ password: '[REDACTED:password]', label: 'Enter your password' });
  });
});

describe('redactSecrets: re-review fixes', () => {
  it('redacts a multi-line .netrc entry and a default entry', () => {
    expect(redactSecrets('machine api.example.com\n  login alex\n  password fAkEpass42\n'))
      .toBe('machine api.example.com\n  login alex\n  password [REDACTED:password]\n');
    expect(redactSecrets('default login alex password fAkEpass42'))
      .toBe('default login alex password [REDACTED:password]');
  });

  it('redacts an npm _authToken set with a space', () => {
    expect(redactSecrets('npm config set //registry.npmjs.org/:_authToken fAkE0123-4567-89ab-cdef'))
      .toBe('npm config set //registry.npmjs.org/:_authToken [REDACTED:token]');
  });

  it('redacts an Authorization: Negotiate value', () => {
    expect(redactSecrets('Authorization: Negotiate YIIFAKEfake0123456789'))
      .toBe('Authorization: Negotiate [REDACTED:authorization]');
  });

  it('redacts an Authorization value without a scheme when it looks like a token', () => {
    expect(redactSecrets('Authorization: fAkE0123AbCd4567EfGh')).toBe('Authorization: [REDACTED:authorization]');
  });

  it('keeps a passphrase with digits or symbols redacted', () => {
    expect(redactSecretsDeep({ forgotPassword: 'Correct horse 42 staple!' })).toEqual({ forgotPassword: '[REDACTED:password]' });
  });

  it('is idempotent when one redaction exposes another candidate', () => {
    for (const text of [
      'password @Authorization: Authorization: pw1234567',
      'machine m login l password @Authorization: Authorization: pw1234567',
      `KEY=Bearer ${FAKE.bearer} --token Authorization: fAkE0123AbCd4567EfGh`,
    ]) {
      const once = redactSecrets(text);
      expect(redactSecrets(once)).toBe(once);
    }
  });

  const intact = [
    'password strength: weak',
    'password reset-link',
    'password manager2',
    'Use a password manager2 for this.',
    'docker build --secret id=mysecret,src=./secret.txt .',
    'renderPass: pipeline2024',
    'authorization: enabled_for_users_2024',
    '"forgotPassword": "Forgot your login details?"',
  ];
  for (const text of intact) {
    it(`leaves ${JSON.stringify(text)} intact`, () => {
      expect(redactSecrets(text)).toBe(text);
    });
  }

  it('leaves a sentence-like label under a password key intact', () => {
    const input = { forgotPassword: 'Forgot your login details?', confirmPassword: 'Type it again to confirm' };
    expect(redactSecretsDeep(input)).toEqual(input);
  });
});

describe('redactSecrets: every pattern on a 1 MB run of its own start token', () => {
  const MB = 1024 * 1024;
  const starts = [
    '-eyJabcdefgh', 'eyJabcdefgh', '.eyJabcdefgh', 'eyJabcdefgh.eyJabcdefgh-', 'sk-ant-', 'sk-', 'sk_live_', 'rk_test_',
    'ghp_', 'github_pat_', 'glpat-', 'hf_', 'AIza', 'AKIA', 'xoxb-', 'npm_',
    '-----BEGIN PRIVATE KEY-----', '-----BEGIN PGP PRIVATE KEY BLOCK-----\n', 'Bearer ', 'Bearer a',
    'Authorization: ', 'Authorization: Basic ', 'Authorization:"', '://u:', 'x://u:p', '://',
    '--token ', '--token "', "--token '", '-a-', 'password ', 'machine m login l password ', 'machine ',
    '_authToken ', 'api_key="', "api_key='", 'api_key=\\"', 'api_key=', 'key:\\"', 'password:"a ', '\\',
  ];
  for (const start of starts) {
    it(`handles 1 MB of ${JSON.stringify(start)} in under 200 ms`, () => {
      const input = start.repeat(Math.ceil(MB / start.length));
      const began = performance.now();
      redactSecrets(input);
      expect(performance.now() - began).toBeLessThan(200);
    });
  }
});

describe('redactSecrets: final follow-ups', () => {
  it('redacts camelCase Pass names when the value looks like a password', () => {
    expect(redactSecrets('dbPass: "hunter22x"')).toBe('dbPass: "[REDACTED:password]"');
    expect(redactSecrets('userPass=Sup3rS3cret1')).toBe('userPass=[REDACTED:password]');
    expect(redactSecretsDeep({ adminPass: 'hunter22x' })).toEqual({ adminPass: '[REDACTED:password]' });
  });

  it('leaves render-pass style names and plain values under camelCase Pass intact', () => {
    for (const text of ['renderPass: shadowMap2', 'shadowPass = "depth24"', 'dbPass: "primary"', 'userPass=abc1']) {
      expect(redactSecrets(text)).toBe(text);
    }
  });

  it('redacts a scheme-less Authorization token that contains underscores', () => {
    const token = 'lin_api_' + 'FAKE0test9'.repeat(4);
    expect(redactSecrets(`Authorization: ${token}`)).toBe('Authorization: [REDACTED:authorization]');
  });

  it('leaves a word-like scheme-less Authorization value intact', () => {
    for (const text of ['authorization: enabled_for_users_2024', 'Authorization: required_for_admin_users_v2']) {
      expect(redactSecrets(text)).toBe(text);
    }
  });
});

// Observed 2026-11-08 while cleaning the logs: "Stack CI first pass: 12/27
// green" lost "12/27", because a bare `pass` in prose was read as a field name.
describe('redactSecrets: the word "pass" in test results', () => {
  it('leaves counts, fractions, and percentages after "pass:" intact', () => {
    for (const text of [
      'Stack CI first pass: 12/27 green. Failures: L02, L14',
      'tests pass: 40/40',
      'PASS: 1234/1250',
      '- Pass: 40/40 green',
      'Results (pass: 12/27, fail: 15)',
      'CI, pass: 98.5%',
      'unit pass: 3120 fail: 0',
    ]) {
      expect(redactSecrets(text)).toBe(text);
    }
  });

  it('still redacts a pass field that holds a password', () => {
    const cases: Array<[string, string]> = [
      ["auth: { user: 'bob', pass: 'hunter22x' }", "auth: { user: 'bob', pass: '[REDACTED:password]' }"],
      ['smtp:\n  user: bob\n  pass: hunter22x\n', 'smtp:\n  user: bob\n  pass: [REDACTED:password]\n'],
      ['accounts:\n  - pass: hunter22x\n', 'accounts:\n  - pass: [REDACTED:password]\n'],
      ['pass=Sup3rS3cret1', 'pass=[REDACTED:password]'],
      ['user=bob pass=hunter22x', 'user=bob pass=[REDACTED:password]'],
      ['mysql --user=bob --pass=hunter22x db', 'mysql --user=bob --pass=[REDACTED:password] db'],
      ['GET /login?user=a&pass=hunter22x', 'GET /login?user=a&pass=[REDACTED:password]'],
      ['Server=db;User=sa;Pass=hunter22x;', 'Server=db;User=sa;Pass=[REDACTED:password];'],
      ['{"user":"bob","pass":"hunter22x"}', '{"user":"bob","pass":"[REDACTED:password]"}'],
      ['{\\"user\\":\\"a\\",\\"pass\\":\\"hunter22x\\"}', '{\\"user\\":\\"a\\",\\"pass\\":\\"[REDACTED:password]\\"}'],
      ['user: bob pass: hunter22x', 'user: bob pass: [REDACTED:password]'],
      ['# pass: hunter22x', '# pass: [REDACTED:password]'],
      ['pass: "1234/5678"', 'pass: "[REDACTED:password]"'],
      ['SMTP_PASS=hunter22x', 'SMTP_PASS=[REDACTED:password]'],
    ];
    for (const [input, expected] of cases) expect(redactSecrets(input)).toBe(expected);
  });
});
