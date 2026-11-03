import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type AuditEvent, auditLine, fileAuditSink } from '../src/audit.js';
import { runAuditCommand } from '../src/audit-reader.js';
import { main } from '../src/cli.js';
import { AuditSchema } from '../src/config.js';

let tmp: string;
const base: AuditEvent = {
  at: '2026-11-01T12:00:00.000Z',
  event: 'search',
  outcome: 'ok',
  user: 'alice',
  via: 'mcp-http',
  ip: '10.0.0.5',
  tokenId: 'tok_fake',
  object: null,
  detail: { query: 'why sqlite', results: 7 },
};

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'waymark-'));
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('audit writer', () => {
  it('appends synchronously across UTC months and preserves older events', async () => {
    const sink = fileAuditSink(tmp);
    vi.useFakeTimers();
    try {
      vi.setSystemTime('2026-11-30T23:59:59.999Z');
      sink({ ...base, at: new Date().toISOString() });
      const before = await fs.readFile(path.join(tmp, '2026-11.jsonl'), 'utf8');
      vi.setSystemTime('2026-12-01T00:00:00.000Z');
      sink({ ...base, at: new Date().toISOString() });
      expect(await fs.readFile(path.join(tmp, '2026-11.jsonl'), 'utf8')).toBe(before);
      expect(JSON.parse(await fs.readFile(path.join(tmp, '2026-12.jsonl'), 'utf8')).at).toBe(
        '2026-12-01T00:00:00.000Z',
      );
      sink(base);
      expect(
        (await fs.readFile(path.join(tmp, '2026-11.jsonl'), 'utf8')).trim().split('\n'),
      ).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps queries private by default and redacts all strings, including nested keys', async () => {
    expect(AuditSchema.parse({})).toEqual({ queries: false });
    expect(JSON.parse(auditLine(base)).detail).toEqual({ queryChars: 10, results: 7 });
    const token = `wmk_${'a'.repeat(43)}`;
    const event = {
      ...base,
      user: token,
      ip: token,
      tokenId: token,
      object: token,
      detail: { query: `why ${token}\n`, extra: [{ [token]: `${token}\u001b\r` }] },
    };
    const line = auditLine(event, { queries: true });
    expect(line).not.toContain(token);
    expect(line.trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(line).detail.query).toBe('why [REDACTED:waymark-token]\\u000a');
    expect(JSON.parse(line).detail.extra[0]['[REDACTED:waymark-token]']).toContain(
      '\\u001b\\u000d',
    );
    expect(JSON.parse(auditLine(event)).detail).not.toHaveProperty('query');
    expect(() => fileAuditSink(tmp)({ ...base, at: '../bad' })).toThrow('Invalid audit timestamp');
    await fs.writeFile(path.join(tmp, '2026-11.jsonl'), '');
    await fs.mkdir(path.join(tmp, '2026-12.jsonl'));
    expect(() => fileAuditSink(tmp)({ ...base, at: '2026-12-01T00:00:00Z' })).toThrow(
      'Cannot append audit log',
    );
  });
});

describe('audit reader', () => {
  it('filters all dimensions, repeated events, time ranges and newest-first limit', () => {
    const sink = fileAuditSink(tmp, { queries: true });
    sink({ ...base, at: '2026-10-31T23:59:59Z' });
    sink({ ...base, event: 'user.created', at: '2026-11-03T12:00:00Z' });
    sink({ ...base, outcome: 'denied', at: '2026-11-04T12:00:00Z' });
    sink({ ...base, user: 'bob', at: '2026-11-05T12:00:00Z' });
    sink({ ...base, at: '2026-11-02T12:00:00Z' });
    sink({ ...base, at: '2026-12-01T00:00:00Z' });
    const flags = {
      since: '2026-11-01',
      until: '2026-11-30',
      user: 'alice',
      event: ['search', 'user.created'],
      outcome: 'ok',
      json: true,
    };
    const result = runAuditCommand(tmp, flags)
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(result.map((e) => e.event)).toEqual(['user.created', 'search']);
    expect(
      runAuditCommand(tmp, { ...flags, limit: '1' })
        .trim()
        .split('\n'),
    ).toHaveLength(1);
    expect(runAuditCommand(tmp, { ...flags, since: '2d' }, new Date('2026-11-04T00:00:00Z'))).toBe(
      runAuditCommand(tmp, { ...flags, since: '2026-11-02' }),
    );
  });

  it('prints compact text and unknown detail, warns once per malformed file and skips other months', async () => {
    fileAuditSink(tmp, { queries: true })(base);
    await fs.appendFile(path.join(tmp, '2026-11.jsonl'), 'invalid\n{}\n');
    await fs.mkdir(path.join(tmp, '2026-10.jsonl'));
    const warnings: string[] = [];
    expect(runAuditCommand(tmp, { since: '2026-11-01' }, new Date(), (w) => warnings.push(w))).toBe(
      '2026-11-01 12:00:00Z  search  ok  alice  mcp-http  10.0.0.5  "why sqlite" (7 results)\n',
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('2026-11.jsonl');
    await fs.appendFile(
      path.join(tmp, '2026-11.jsonl'),
      `${JSON.stringify({
        ...base,
        event: 'future.event',
        at: '2026-11-02T00:00:00Z',
        detail: { extra: 1 },
      })}\n`,
    );
    expect(
      runAuditCommand(tmp, { since: '2026-11-01', event: ['future.event'] }, new Date(), () => {}),
    ).toContain('{"extra":1}');
  });

  it('defaults to 100 and rejects invalid options with actionable errors', () => {
    expect(runAuditCommand(path.join(tmp, 'absent'), {})).toBe('');
    for (let i = 0; i < 101; i++) fileAuditSink(tmp)(base);
    expect(runAuditCommand(tmp, { json: true }).trim().split('\n')).toHaveLength(100);
    for (const flags of [
      { since: 'yesterday' },
      { since: '2026-02-30' },
      { until: 'not-date' },
      { since: '2026-12-01', until: '2026-11-01' },
      { outcome: 'maybe' },
      { limit: '0' },
      { limit: '1.5' },
      { limit: '' },
    ]) {
      expect(() => runAuditCommand(tmp, flags)).toThrow(/Invalid/);
    }
  });
});

describe('audit CLI and account producers', () => {
  it('logs every successful account mutation, never secrets or list/read operations', async () => {
    vi.stubEnv('WAYMARK_HOME', tmp);
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const run = async (...args: string[]) => {
      out.mockClear();
      expect(await main(args)).toBe(0);
      return out.mock.calls.map((c) => String(c[0])).join('');
    };
    await run('user', 'add', 'alice');
    await run('user', 'update', 'alice', '--admin');
    await run('user', 'link', 'alice', 'github', 'alice-gh');
    await run('user', 'unlink', 'alice', 'github');
    const secret = (await run('token', 'create', 'alice')).trim();
    const [token] = JSON.parse(await run('token', 'list', '--json'));
    await run('token', 'revoke', token.id);
    await run('user', 'list');
    expect(await main(['user', 'add', 'alice'])).toBe(1);
    const json = await run(
      'audit',
      '--user',
      'owner',
      '--event',
      'user.created',
      '--event',
      'token.created',
      '--json',
    );
    expect(
      json
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l).event)
        .sort(),
    ).toEqual(['token.created', 'user.created']);
    const all = runAuditCommand(path.join(tmp, 'audit'), { json: true });
    expect(all).not.toContain(secret);
    expect(all).not.toContain('hash');
    const events = all
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(events.map((e) => e.event).sort()).toEqual([
      'token.created',
      'token.revoked',
      'user.created',
      'user.linked',
      'user.unlinked',
      'user.updated',
    ]);
    expect(events.every((e) => e.user === 'owner' && e.via === 'cli' && e.outcome === 'ok')).toBe(
      true,
    );
    expect(events.find((e) => e.event === 'token.created').object).toBe(token.id);
    expect(await run('audit', '--event', 'token.revoked')).toContain(token.id);
  });
});
