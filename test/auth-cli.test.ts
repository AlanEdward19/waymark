import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openAuthDb } from '../src/auth/store.js';
import { main } from '../src/cli.js';
import { writeDoc } from '../src/store/markdown.js';

let tmp: string;
let stdout: ReturnType<typeof vi.spyOn>;
let stderr: ReturnType<typeof vi.spyOn>;

const text = (spy: typeof stdout) => spy.mock.calls.map((c) => String(c[0])).join('');
const out = () => text(stdout);
const err = () => text(stderr);
const reset = () => {
  stdout.mockClear();
  stderr.mockClear();
};

async function run(...args: string[]): Promise<number> {
  reset();
  return main(args);
}

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'waymark-'));
  vi.stubEnv('WAYMARK_HOME', tmp);
  stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('waymark user', () => {
  it('adds a user and rejects a duplicate and a bad name', async () => {
    expect(
      await run('user', 'add', 'alice', '--display', 'Alice', '--group', 'a', '--group', 'b'),
    ).toBe(0);
    expect(out()).toBe('Created user alice\n');
    expect(await run('user', 'add', 'alice')).toBe(1);
    expect(err()).toBe('error: user "alice" already exists\n');
    expect(await run('user', 'add', 'Bad')).toBe(1);
    expect(err()).toContain('error: invalid user name "Bad"');
  });

  it('lists as a table and as json', async () => {
    await run('user', 'add', 'alice', '--admin', '--group', 'dev');
    await run('user', 'link', 'alice', 'github', 'octo');
    await run('token', 'create', 'alice');
    await run('user', 'list');
    const [head, row] = out().trimEnd().split('\n');
    expect(head?.split(/\s+/)).toEqual([
      'NAME',
      'DISPLAY',
      'ROLE',
      'GROUPS',
      'DISABLED',
      'LINKED',
      'TOKENS',
    ]);
    expect(row?.split(/\s+/)).toEqual(['alice', 'alice', 'admin', 'dev', 'no', 'github', '1']);
    await run('user', 'list', '--json');
    expect(JSON.parse(out())[0]).toMatchObject({
      name: 'alice',
      providers: ['github'],
      activeTokens: 1,
    });
  });

  it('updates role, groups and disabled', async () => {
    await run('user', 'add', 'alice', '--group', 'a');
    expect(await run('user', 'update', 'alice', '--admin', '--group', 'x', '--disable')).toBe(0);
    await run('user', 'list', '--json');
    expect(JSON.parse(out())[0]).toMatchObject({ role: 'admin', groups: ['x'], disabled: true });
    await run('user', 'update', 'alice', '--member', '--enable');
    await run('user', 'list', '--json');
    expect(JSON.parse(out())[0]).toMatchObject({ role: 'member', disabled: false });
    expect(await run('user', 'update', 'alice', '--admin', '--member')).toBe(1);
    expect(err()).toBe('error: --admin and --member cannot be used together\n');
    expect(await run('user', 'update', 'alice', '--disable', '--enable')).toBe(1);
    expect(err()).toBe('error: --disable and --enable cannot be used together\n');
    expect(await run('user', 'update', 'ghost')).toBe(1);
    expect(err()).toBe('error: user not found: ghost\n');
  });

  it('links and unlinks with validation errors', async () => {
    await run('user', 'add', 'alice');
    await run('user', 'add', 'bob');
    expect(await run('user', 'link', 'alice', 'github', 'octo')).toBe(0);
    expect(await run('user', 'link', 'bob', 'github', 'octo')).toBe(1);
    expect(err()).toBe('error: github id "octo" is already linked to user "alice"\n');
    expect(await run('user', 'link', 'bob', 'fax', 'x')).toBe(1);
    expect(err()).toBe(
      'error: invalid provider "fax" (valid: github, slack, teams, discord, linear, oidc)\n',
    );
    expect(await run('user', 'unlink', 'alice', 'github')).toBe(0);
  });
});

describe('waymark token', () => {
  it('prints the token alone on stdout and the notice on stderr', async () => {
    await run('user', 'add', 'alice');
    expect(await run('token', 'create', 'alice', '--label', 'ci', '--expires', '30')).toBe(0);
    expect(out()).toMatch(/^wmk_[A-Za-z0-9_-]{43}\n$/);
    expect(err()).toMatch(
      /^Token tok_[0-9a-f]{8} for alice\. Store it now: it is not shown again\.\n$/,
    );
    const token = out().trim();

    await run('token', 'list');
    expect(out()).not.toContain(token);
    expect(out()).toContain('active');
    await run('token', 'list', '--user', 'alice', '--json');
    const [t] = JSON.parse(out());
    expect(t).toMatchObject({ user: 'alice', label: 'ci', status: 'active' });
    expect(JSON.stringify(t)).not.toContain(token);

    expect(await run('token', 'revoke', t.id)).toBe(0);
    expect(out()).toBe(`Revoked ${t.id}\n`);
    await run('token', 'list', '--json');
    expect(JSON.parse(out())[0].status).toBe('revoked');
  });

  it('reports unknown tokens and bad expiry', async () => {
    await run('user', 'add', 'alice');
    expect(await run('token', 'revoke', 'tok_00000000')).toBe(1);
    expect(err()).toBe('error: token not found: tok_00000000\n');
    expect(await run('token', 'create', 'alice', '--expires', 'soon')).toBe(1);
    expect(err()).toBe('error: invalid expiry "soon" (a whole number of days, at least 1)\n');
    expect(await run('token', 'create', 'alice', '--expires', '1000000000')).toBe(1);
    expect(err()).toBe('error: invalid expiry "1000000000" (a whole number of days, at least 1)\n');
    expect(await run('token', 'create', 'ghost')).toBe(1);
    expect(err()).toBe('error: user not found: ghost\n');
  });
});

describe('auth.db is state, not cache', () => {
  it('survives reindex and deleting db/', async () => {
    await run('user', 'add', 'alice');
    await run('token', 'create', 'alice');
    const file = path.join(tmp, 'auth', 'auth.db');
    const before = await fs.readFile(file);
    await writeDoc(path.join(tmp, 'wiki'), {
      id: 'notes/note/a',
      kind: 'note',
      sourceId: 'notes',
      title: 'A',
      authors: [],
      tags: [],
      createdAt: '2026-11-01T00:00:00.000Z',
      updatedAt: '2026-11-01T00:00:00.000Z',
      body: 'hello',
    });
    expect(await run('reindex')).toBe(0);
    await fs.rm(path.join(tmp, 'db'), { recursive: true, force: true });
    expect(await run('reindex')).toBe(0);
    expect(await fs.readFile(file)).toEqual(before);
    const db = openAuthDb(file);
    expect(db.prepare('SELECT COUNT(*) AS n FROM users').get()).toEqual({ n: 1 });
    db.close();
  });
});
