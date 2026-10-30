import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { initHome } from '../src/config.js';
import { resolvePaths } from '../src/paths.js';
import { makeId } from '../src/store/doc.js';
import { writeDoc } from '../src/store/markdown.js';
import { commitWiki, ensureWikiRepo } from '../src/store/wikigit.js';
import { syncAll } from '../src/sync.js';

const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true });
});

async function tmp() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'waymark-'));
  dirs.push(dir);
  return dir;
}

const log = (cwd: string) =>
  execFileSync('git', ['log', '--format=%s'], { cwd, encoding: 'utf8' }).trim();

const doc = (sourceId: string, n: string) => ({
  id: makeId(sourceId, 'note', n),
  kind: 'note' as const,
  sourceId,
  title: `t${n}`,
  authors: [],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  tags: [],
  body: 'b',
});

describe('wikigit', () => {
  it('init creates the repo once and is idempotent', async () => {
    const paths = resolvePaths({ WAYMARK_HOME: await tmp() });
    await initHome(paths);
    const attrs = await fs.readFile(path.join(paths.wiki, '.gitattributes'), 'utf8');
    expect(attrs).toBe('* text=auto eol=lf\n');
    await fs.writeFile(path.join(paths.wiki, '.gitattributes'), 'custom\n');
    await ensureWikiRepo(paths.wiki);
    expect(await fs.readFile(path.join(paths.wiki, '.gitattributes'), 'utf8')).toBe('custom\n');
  });

  it('commits only when there are changes', async () => {
    const wiki = path.join(await tmp(), 'wiki');
    await ensureWikiRepo(wiki);
    expect(await commitWiki(wiki, 'first')).toBe(true); // .gitattributes
    expect(await commitWiki(wiki, 'nothing')).toBe(false);
    await writeDoc(wiki, doc('s', '1'));
    expect(await commitWiki(wiki, 'note: hello')).toBe(true);
    expect(log(wiki).split('\n')).toEqual(['note: hello', 'first']);
  });

  it('returns false and warns once when git is missing', async () => {
    const wiki = path.join(await tmp(), 'wiki');
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const run = async () => {
      throw Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' });
    };
    expect(await commitWiki(wiki, 'm', run)).toBe(false);
    expect(await commitWiki(wiki, 'm', run)).toBe(false);
    const warns = err.mock.calls.filter((c) => String(c[0]).includes('git not found'));
    expect(warns).toHaveLength(1);
  });

  it('sync makes one commit per run with changes', async () => {
    const dir = await tmp();
    await fs.writeFile(
      path.join(dir, 'config.json'),
      JSON.stringify({ version: 1, sources: [{ id: 'a', type: 'git', path: '.' }] }),
    );
    const paths = resolvePaths({ WAYMARK_HOME: dir });
    await initHome(paths);
    await commitWiki(paths.wiki, 'init');
    const connectors = {
      a: async (ctx: { emit: (d: ReturnType<typeof doc>) => Promise<void> }) => {
        await ctx.emit(doc('a', '1'));
        await ctx.emit(doc('a', '2'));
        return { cursor: 'c', count: 2 };
      },
    };
    await syncAll(paths, { connectors: connectors as never });
    await syncAll(paths, { connectors: connectors as never });
    expect(log(paths.wiki).split('\n')).toEqual(['sync: a +2', 'init']);
  });
});
