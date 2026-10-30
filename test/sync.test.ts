import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/cli.js';
import { getState, openDb } from '../src/index/db.js';
import { resolvePaths } from '../src/paths.js';
import { makeId } from '../src/store/doc.js';
import { readDoc } from '../src/store/markdown.js';
import { syncAll } from '../src/sync.js';

const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true });
});

async function home(sources: unknown[]) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'waymark-'));
  dirs.push(dir);
  await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify({ version: 1, sources }));
  return resolvePaths({ WAYMARK_HOME: dir });
}

describe('syncAll', () => {
  it('records errors, keeps going, does not save failed cursor', async () => {
    const paths = await home([
      { id: 'bad', type: 'git', path: '.' },
      { id: 'good', type: 'git', path: '.' },
    ]);
    const doc = {
      id: makeId('good', 'commit', 'abc'),
      kind: 'commit' as const,
      sourceId: 'good',
      title: 't',
      authors: [],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      tags: [],
      body: 'b',
    };
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const results = await syncAll(paths, {
      connectors: {
        bad: async () => {
          throw new Error('boom');
        },
        good: async (ctx) => {
          await ctx.emit(doc);
          return { cursor: 'c1', count: 1 };
        },
      },
    });
    expect(results).toEqual([
      { sourceId: 'bad', count: 0, error: 'boom' },
      { sourceId: 'good', count: 1 },
    ]);
    const db = openDb(paths.db);
    expect(getState(db, 'bad')).toBeNull();
    expect(getState(db, 'good')).toBe('c1');
    db.close();
    expect(await readDoc(paths.wiki, doc.id)).not.toBeNull();
  });

  it('rejects unknown source', async () => {
    const paths = await home([]);
    await expect(syncAll(paths, { only: 'nope' })).rejects.toThrow('Unknown source "nope"');
  });
});

describe('waymark sync', () => {
  it('prints error line and exits 1 on failure', async () => {
    const paths = await home([{ id: 'gh', type: 'github', repo: 'o/r' }]);
    vi.stubEnv('WAYMARK_HOME', paths.home);
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    expect(await main(['sync'])).toBe(1);
    expect(out.mock.calls.join('')).toBe('gh: error: github connector not implemented yet\n');
  });
});
