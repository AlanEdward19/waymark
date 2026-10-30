import { describe, expect, it } from 'vitest';
import { redact } from '../src/redact.js';

const a = (n: number) => 'a'.repeat(n);
const pem = (kind: string) =>
  [
    `-----BEGIN ${kind} PRIVATE KEY-----`,
    'line1',
    'line2',
    `-----END ${kind} PRIVATE KEY-----`,
  ].join('\n');

const positives: Record<string, [string, string]> = {
  'private-key': [`before\n${pem('RSA')}\nafter`, 'before\n[REDACTED:private-key]\nafter'],
  'github-token (ghp)': [`ghp_${a(36)}`, '[REDACTED:github-token]'],
  'github-token (fine-grained)': [`github_pat_${a(30)}`, '[REDACTED:github-token]'],
  'anthropic-key': [`sk-ant-${a(30)}`, '[REDACTED:anthropic-key]'],
  'openai-key': [`sk-proj-${a(30)}`, '[REDACTED:openai-key]'],
  'aws-access-key': [`AKIA${'A'.repeat(16)}`, '[REDACTED:aws-access-key]'],
  'slack-token': [`xoxb-${'1'.repeat(12)}`, '[REDACTED:slack-token]'],
  'google-api-key': [`AIza${a(35)}`, '[REDACTED:google-api-key]'],
  'stripe-key': [`sk_live_${a(24)}`, '[REDACTED:stripe-key]'],
  jwt: [`eyJ${a(12)}.eyJ${a(12)}.${a(12)}`, '[REDACTED:jwt]'],
  'connection-string': [
    `Server=x;Password=${a(10)};Db=y`,
    'Server=x;Password=[REDACTED:connection-string];Db=y',
  ],
  bearer: [`Authorization: Bearer ${a(30)}`, 'Authorization: Bearer [REDACTED:bearer]'],
  assignment: [`api_key = ${a(12)}`, 'api_key = [REDACTED:assignment]'],
};

describe('redact', () => {
  for (const [name, [input, expected]] of Object.entries(positives)) {
    it(`redacts ${name}`, () => {
      expect(redact(input)).toBe(expected);
    });
  }

  it('leaves non-secrets unchanged', () => {
    for (const s of [
      'sk-short',
      'remember to rotate the password regularly',
      'a'.repeat(40).replace(/a/g, 'f'),
      '123e4567-e89b-12d3-a456-426614174000',
      'Bearer token',
    ]) {
      expect(redact(s)).toBe(s);
    }
  });

  it('keeps the key name for quoted assignments', () => {
    expect(redact('password: "hunter2hunter2"')).toBe('password: "[REDACTED:assignment]"');
  });

  it('prefers the specific token rule over the assignment rule', () => {
    expect(redact(`GITHUB_TOKEN=ghp_${a(36)}`)).toBe('GITHUB_TOKEN=[REDACTED:github-token]');
  });

  it('replaces a multi-line PEM block with one placeholder', () => {
    expect(redact(pem('EC'))).toBe('[REDACTED:private-key]');
  });

  it('is idempotent', () => {
    const all = Object.values(positives)
      .map(([input]) => input)
      .join('\n');
    const once = redact(all);
    expect(once).not.toBe(all);
    expect(redact(once)).toBe(once);
  });
});
