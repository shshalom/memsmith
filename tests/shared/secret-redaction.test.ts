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
  ];
  for (const [label, input] of inputs) {
    it(`redacts 1 MB of ${label} in under 1 second`, () => {
      const started = performance.now();
      redactSecrets(input);
      expect(performance.now() - started).toBeLessThan(1000);
    });
  }
});
