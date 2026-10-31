import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GitSourceSchema } from '../src/config.js';
import { blobUrl, gitConnector, githubCommitUrl, parseGitLog } from '../src/connectors/git.js';
import type { WaymarkDoc } from '../src/store/doc.js';

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true });
});

describe('parseGitLog', () => {
  it('builds docs from synthetic output', () => {
    const out =
      '\x1eaaa\x1fAda\x1f2026-10-30T10:02:07-03:00\x1f2026-10-30T11:00:00-03:00\x1ffix: a\x1fline1\nline2\n\x1f\n\nsrc/a.ts\nsrc/b.ts\n' +
      '\x1ebbb\x1fBob\x1f2026-10-29T10:00:00+00:00\x1f2026-10-29T10:00:00+00:00\x1fchore: b\x1f\x1f\n';
    const docs = parseGitLog('repo', out, 'git@github.com:o/r.git');
    expect(docs).toHaveLength(2);
    expect(docs[0]).toEqual({
      id: 'repo/commit/aaa',
      kind: 'commit',
      sourceId: 'repo',
      title: 'fix: a',
      url: 'https://github.com/o/r/commit/aaa',
      authors: ['Ada'],
      createdAt: '2026-10-30T13:02:07.000Z',
      updatedAt: '2026-10-30T14:00:00.000Z',
      tags: [],
      body: 'fix: a\n\nline1\nline2\n\n## Files\n\n- src/a.ts\n- src/b.ts',
    });
    expect(docs[1]?.body).toBe('chore: b');
  });
});

describe('githubCommitUrl', () => {
  it.each([
    ['git@github.com:o/r.git', 'https://github.com/o/r/commit/x'],
    ['https://github.com/o/r.git', 'https://github.com/o/r/commit/x'],
    ['https://github.com/o/r', 'https://github.com/o/r/commit/x'],
    ['https://gitlab.com/o/r.git', undefined],
    [undefined, undefined],
  ])('%s', (remote, expected) => {
    expect(githubCommitUrl(remote, 'x')).toBe(expected);
  });
});

describe('gitConnector (real git)', { timeout: 30_000 }, () => {
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1' };
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd, env, encoding: 'utf8' });

  async function setup() {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'waymark-'));
    dirs.push(dir);
    git(dir, 'init', '-q');
    git(dir, 'config', 'user.name', 'T');
    git(dir, 'config', 'user.email', 't@example.com');
    return dir;
  }
  const commit = async (dir: string, name: string, msg: string) => {
    await fs.writeFile(path.join(dir, name), name);
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', msg);
  };
  // fake index shared across runs so removes and listIds behave like the real one
  const index = new Map<string, WaymarkDoc>();
  const runOnce = async (
    dir: string,
    cursor: string | null,
    extra: Record<string, unknown> = { include: ['commits'] },
  ) => {
    const docs: WaymarkDoc[] = [];
    const removes: string[] = [];
    const logs: string[] = [];
    const res = await gitConnector(
      GitSourceSchema.parse({ id: 'r', type: 'git', path: '.', ...extra }),
      dir,
    )({
      sourceId: 'r',
      cursor,
      emit: async (d) => {
        docs.push(d);
        index.set(d.id, d);
      },
      remove: async (id) => {
        removes.push(id);
        index.delete(id);
      },
      listIds: (kind) =>
        [...index.values()].filter((d) => !kind || d.kind === kind).map((d) => d.id),
      log: (m) => logs.push(m),
    });
    return { res, docs, removes, logs };
  };
  const write = async (dir: string, file: string, text: string) => {
    await fs.mkdir(path.dirname(path.join(dir, file)), { recursive: true });
    await fs.writeFile(path.join(dir, file), text);
  };
  const commitAll = (dir: string, msg: string) => {
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', msg);
  };
  const withDocs = { include: ['docs'] };

  it('ingests markdown docs, ignores other files', async () => {
    index.clear();
    const dir = await setup();
    await write(dir, 'README.md', 'no heading here');
    await write(dir, 'docs/adr/0001-x.md', 'intro\n# Use X\nbody');
    await write(dir, 'src/a.ts', 'x');
    commitAll(dir, 'init');
    const { docs } = await runOnce(dir, null, withDocs);
    expect(docs).toHaveLength(2);
    const adr = docs.find((d) => d.title === 'Use X');
    expect(adr?.tags).toEqual(['path:docs/adr/0001-x.md', 'adr']);
    expect(docs.find((d) => d.title === 'README.md')?.tags).toEqual(['path:README.md']);
  });

  it('syncs doc edit, delete and rename incrementally', async () => {
    index.clear();
    const dir = await setup();
    await write(dir, 'README.md', '# Readme');
    await write(dir, 'docs/adr/0001-x.md', '# Use X\nbody');
    await write(
      dir,
      'docs/guide.md',
      '# Guide\nlots of stable guide text that survives the rename',
    );
    commitAll(dir, 'init');
    const first = await runOnce(dir, null, withDocs);
    expect(first.docs).toHaveLength(3);
    await write(dir, 'docs/adr/0001-x.md', '# Use X\nchanged');
    git(dir, 'rm', '-q', 'README.md');
    git(dir, 'mv', 'docs/guide.md', 'docs/handbook.md');
    commitAll(dir, 'second');
    const second = await runOnce(dir, first.res.cursor, withDocs);
    expect(second.docs.map((d) => d.title).sort()).toEqual(['Guide', 'Use X']);
    expect(second.removes).toHaveLength(2);
    expect(second.res.removed).toBe(2);
    expect([...index.values()].map((d) => d.title).sort()).toEqual(['Guide', 'Use X']);
  });

  it('full run reconciles after amend', async () => {
    index.clear();
    const dir = await setup();
    await write(dir, 'README.md', '# Readme');
    await write(dir, 'docs/a.md', '# A');
    commitAll(dir, 'init');
    const first = await runOnce(dir, null, withDocs);
    git(dir, 'rm', '-q', 'docs/a.md');
    git(dir, 'commit', '-q', '--amend', '-m', 'init2');
    const again = await runOnce(dir, first.res.cursor, withDocs);
    expect(again.logs).toContain('history rewritten, full resync');
    expect(again.removes).toHaveLength(1);
    expect([...index.values()].map((d) => d.title)).toEqual(['Readme']);
  });

  it('honours include and docs globs', async () => {
    index.clear();
    const dir = await setup();
    await write(dir, 'README.md', '# Readme');
    await write(dir, 'notes/n.md', '# Note');
    commitAll(dir, 'init');
    expect((await runOnce(dir, null, { include: ['commits'] })).docs.map((d) => d.kind)).toEqual([
      'commit',
    ]);
    index.clear();
    const only = await runOnce(dir, null, { include: ['docs'], docs: ['notes/*.md'] });
    expect(only.docs.map((d) => d.title)).toEqual(['Note']);
  });

  it('skips docs over 200 KB', async () => {
    index.clear();
    const dir = await setup();
    await write(dir, 'big.md', `# Big\n${'x'.repeat(201 * 1024)}`);
    commitAll(dir, 'init');
    const r = await runOnce(dir, null, withDocs);
    expect(r.docs).toHaveLength(0);
    expect(r.logs[0]).toContain('big.md');
  });

  it('syncs incrementally', async () => {
    const dir = await setup();
    await commit(dir, 'a.txt', 'first');
    await commit(dir, 'b.txt', 'second');
    const first = await runOnce(dir, null);
    expect(first.docs).toHaveLength(2);
    await commit(dir, 'c.txt', 'third');
    const second = await runOnce(dir, first.res.cursor);
    expect(second.docs.map((d) => d.title)).toEqual(['third']);
    expect(second.docs[0]?.body).toContain('- c.txt');
    expect((await runOnce(dir, second.res.cursor)).res.count).toBe(0);
  });

  it('full resync after rewritten history', async () => {
    const dir = await setup();
    await commit(dir, 'a.txt', 'first');
    const first = await runOnce(dir, null);
    git(dir, 'commit', '-q', '--amend', '-m', 'first amended');
    const again = await runOnce(dir, first.res.cursor);
    expect(again.docs).toHaveLength(1);
    expect(again.logs).toContain('history rewritten, full resync');
  });

  it('rejects a non-repo', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'waymark-'));
    dirs.push(dir);
    await expect(runOnce(dir, null)).rejects.toThrow('is not a git repository');
  });
});

describe('blobUrl', () => {
  it.each([
    ['git@github.com:o/r.git', 'https://github.com/o/r/blob/s/docs/a.md'],
    ['https://github.com/o/r', 'https://github.com/o/r/blob/s/docs/a.md'],
    [
      'https://dev.azure.com/org/proj/_git/repo',
      'https://dev.azure.com/org/proj/_git/repo?path=/docs/a.md&version=GCs',
    ],
    [
      'https://org@dev.azure.com/org/proj/_git/repo',
      'https://dev.azure.com/org/proj/_git/repo?path=/docs/a.md&version=GCs',
    ],
    [
      'org@vs-ssh.visualstudio.com:v3/org/proj/repo',
      'https://dev.azure.com/org/proj/_git/repo?path=/docs/a.md&version=GCs',
    ],
    ['https://gitlab.com/o/r.git', undefined],
  ])('%s', (remote, expected) => {
    expect(blobUrl(remote, 's', 'docs/a.md')).toBe(expected);
  });
});
