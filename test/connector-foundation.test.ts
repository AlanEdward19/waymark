import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { htmlToMarkdown } from '../src/connectors/html.js';
import { envToken, fetchJson } from '../src/connectors/http.js';
import { openDb } from '../src/index/db.js';
import { search } from '../src/index/search.js';
import { resolvePaths } from '../src/paths.js';
import { makeId } from '../src/store/doc.js';
import { readDoc, removeDoc } from '../src/store/markdown.js';
import { syncAll } from '../src/sync.js';

const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true });
});

const mkDoc = (n: string) => ({
  id: makeId('src', 'doc', n),
  kind: 'doc' as const,
  sourceId: 'src',
  title: `page ${n}`,
  authors: [],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  tags: [],
  body: `zebrafish ${n}`,
});

describe('remove support', () => {
  it('syncAll removes a doc: file, index row, search hit, commit message', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'waymark-'));
    dirs.push(dir);
    await fs.writeFile(
      path.join(dir, 'config.json'),
      JSON.stringify({ version: 1, sources: [{ id: 'src', type: 'git', path: '.' }] }),
    );
    const paths = resolvePaths({ WAYMARK_HOME: dir });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const a = mkDoc('a');
    const b = mkDoc('b');
    await syncAll(paths, {
      connectors: {
        src: async (ctx) => {
          await ctx.emit(a);
          await ctx.emit(b);
          return { cursor: null, count: 2 };
        },
      },
    });
    let seen: string[] = [];
    const res = await syncAll(paths, {
      connectors: {
        src: async (ctx) => {
          seen = ctx.listIds('doc');
          await ctx.remove(a.id);
          return { cursor: null, count: 0, removed: 1 };
        },
      },
    });
    expect(seen.sort()).toEqual([a.id, b.id].sort());
    expect(res).toEqual([{ sourceId: 'src', count: 0, removed: 1 }]);
    expect(await readDoc(paths.wiki, a.id)).toBeNull();
    expect(await readDoc(paths.wiki, b.id)).not.toBeNull();
    const db = openDb(paths.db);
    expect(db.prepare('SELECT id FROM docs').all()).toEqual([{ id: b.id }]);
    expect(search(db, { query: 'zebrafish' }).map((h) => h.id)).toEqual([b.id]);
    db.close();
    const { execFileSync } = await import('node:child_process');
    const msg = execFileSync('git', ['log', '-1', '--format=%s'], { cwd: paths.wiki }).toString();
    expect(msg.trim()).toBe('sync: src +0 -1');
  });

  it('removeDoc reports whether the file existed', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'waymark-'));
    dirs.push(dir);
    expect(await removeDoc(dir, mkDoc('x').id)).toBe(false);
  });
});

const res = (status: number, headers: Record<string, string> = {}, body = '{"ok":1}') =>
  new Response(status === 204 ? null : body, { status, statusText: 'ST', headers });

describe('fetchJson', () => {
  it('retries a 429 then succeeds', async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(res(429, { 'retry-after': '0' }))
      .mockResolvedValueOnce(res(200));
    expect(await fetchJson('https://api.x.test/a', { fetchImpl: f })).toEqual({ ok: 1 });
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('gives up after retries', async () => {
    const f = vi.fn().mockImplementation(async () => res(503, { 'retry-after': '0' }));
    await expect(fetchJson('https://api.x.test/a', { fetchImpl: f, retries: 2 })).rejects.toThrow(
      'api.x.test responded 503 ST',
    );
    expect(f).toHaveBeenCalledTimes(3);
  });

  it('refuses a 120 s wait', async () => {
    const f = vi.fn().mockResolvedValue(res(429, { 'retry-after': '120' }));
    await expect(fetchJson('https://api.x.test/a', { fetchImpl: f })).rejects.toThrow(
      'Rate limited by api.x.test; retry after 120s',
    );
  });

  it('401 error leaks no header or body', async () => {
    const f = vi.fn().mockResolvedValue(res(401, {}, 'secret-body'));
    const err = await fetchJson('https://api.x.test/a', {
      fetchImpl: f,
      headers: { Authorization: 'Bearer tok-123' },
      body: 'req-body',
    }).catch((e: Error) => e);
    expect((err as Error).message).toBe('api.x.test responded 401 ST');
  });

  it('204 gives undefined', async () => {
    const f = vi.fn().mockResolvedValue(res(204));
    expect(await fetchJson('https://api.x.test/a', { fetchImpl: f })).toBeUndefined();
  });
});

describe('envToken', () => {
  it('returns first non-empty, else throws exact message', () => {
    vi.stubEnv('A_TOK', '');
    vi.stubEnv('B_TOK', 'bee');
    expect(envToken('s', ['A_TOK', 'B_TOK'], 'tip')).toBe('bee');
    vi.stubEnv('B_TOK', '');
    expect(() => envToken('s', ['A_TOK', 'B_TOK'], 'Tip: x')).toThrow(
      'Source "s": set A_TOK or B_TOK to sync. Tip: x',
    );
  });
});

describe('htmlToMarkdown', () => {
  const cases: Array<[string, string, string]> = [
    ['br', 'a<br>b<br/>c', 'a\nb\nc'],
    ['p', '<p>a</p><p>b</p>', 'a\nb'],
    ['div', '<div>a</div><div>b</div>', 'a\nb'],
    ['heading', '<h1>T</h1><h3>U</h3>', '# T\n### U'],
    ['li', '<ul><li>a</li><li>b</li></ul>', '- a\n- b'],
    ['tr', '<tr><td>a</td></tr><tr><td>b</td></tr>', 'a\nb'],
    ['link', '<a href="https://x.test/?a=1">t</a>', '[t](https://x.test/?a=1)'],
    ['code', 'x <code>y</code> z', 'x `y` z'],
    ['pre', '<pre>a\n  <b>b</b></pre>', '```\na\n  b\n```'],
    ['strong/b', '<strong>a</strong> <b>b</b>', '**a** **b**'],
    ['em/i', '<em>a</em> <i>b</i>', '_a_ _b_'],
    ['other tags', '<span class="x">a</span><img src="i.png">', 'a'],
    ['entities', '&amp; &lt;b&gt; &quot;q&quot; &#39;s&#39; a&nbsp;b', '& <b> "q" \'s\' a b'],
    ['numeric entities', '&#65;&#x42;', 'AB'],
    ['collapse', '<p>a</p><br><br><br><p>b</p>', 'a\n\nb'],
    ['trim', '  <p>a</p>  ', 'a'],
    ['nested lists', '<ul><li>a<ul><li>b</li></ul></li></ul>', '- a\n- b'],
  ];
  it.each(cases)('%s', (_n, input, expected) => {
    expect(htmlToMarkdown(input)).toBe(expected);
  });
});
