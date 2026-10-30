import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { gitConnector, githubCommitUrl, parseGitLog } from '../src/connectors/git.js';
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

describe('gitConnector (real git)', () => {
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
  const runOnce = async (dir: string, cursor: string | null) => {
    const docs: WaymarkDoc[] = [];
    const logs: string[] = [];
    const res = await gitConnector(
      { id: 'r', type: 'git', path: '.' },
      dir,
    )({
      sourceId: 'r',
      cursor,
      emit: async (d) => {
        docs.push(d);
      },
      log: (m) => logs.push(m),
    });
    return { res, docs, logs };
  };

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
