// Epic #15: ranking (#46), embeddings client (#47), vector index (#48), hybrid search (#49).
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/cli.js';
import { initHome, loadConfig } from '../src/config.js';
import { chunkDoc } from '../src/embed/chunks.js';
import { createEmbedder, type Embedder, embedConfigFrom } from '../src/embed/client.js';
import { embedPending } from '../src/embed/index.js';
import { type Db, openDb, upsertDoc } from '../src/index/db.js';
import { hybridSearch } from '../src/index/hybrid.js';
import { fuse, recencyBoost } from '../src/index/rank.js';
import { search, toFtsQuery } from '../src/index/search.js';
import { resolvePaths } from '../src/paths.js';
import type { WaymarkDoc } from '../src/store/doc.js';

const dirs: string[] = [];
const open: Db[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const db of open.splice(0)) db.close();
  for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true });
});

async function tmp(): Promise<string> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'waymark-'));
  dirs.push(d);
  return d;
}

async function db(): Promise<Db> {
  const d = openDb(path.join(await tmp(), 'db.sqlite'));
  open.push(d);
  return d;
}

const doc = (id: string, title: string, body: string, over: Partial<WaymarkDoc> = {}) => ({
  id: `src/note/${id}`,
  kind: 'note' as const,
  sourceId: 'src',
  title,
  authors: [],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  tags: [],
  body,
  ...over,
});
const put = (d: Db, x: WaymarkDoc) => upsertDoc(d, x, `${x.id}.md`);

// Fake embedder: a tiny "semantic" space where synonyms share a dimension.
const CONCEPTS: Record<string, number> = {
  login: 0,
  signin: 0,
  authentication: 0,
  auth: 0,
  database: 1,
  sqlite: 1,
  storage: 1,
  deploy: 2,
  release: 2,
};
function fakeEmbedder(calls: string[][] = []): Embedder {
  return async (texts) => {
    calls.push(texts);
    return texts.map((t) => {
      const v = new Float32Array(4);
      for (const w of t.toLowerCase().match(/[a-z]+/g) ?? []) {
        const dim = CONCEPTS[w];
        if (dim !== undefined) v[dim] = (v[dim] ?? 0) + 1;
      }
      v[3] = 0.01; // never the zero vector
      return v;
    });
  };
}
const queryOf = (e: Embedder) => async (q: string) => (await e([q]))[0] as Float32Array;

describe('#46 ranking', () => {
  it('drops stopwords unless nothing else is left', () => {
    expect(toFtsQuery('why did we choose TypeScript')).toBe('"choose"* OR "TypeScript"*');
    expect(toFtsQuery('por que escolhemos SQLite')).toBe('"escolhemos"* OR "SQLite"*');
    expect(toFtsQuery('why')).toBe('"why"*');
  });

  it('fuse rewards ids ranked well in several lists and applies weights', () => {
    expect([...fuse([{ ids: ['a', 'b', 'c'] }]).entries()].map(([id]) => id)).toEqual([
      'a',
      'b',
      'c',
    ]);
    const two = fuse([{ ids: ['a', 'b'] }, { ids: ['b', 'c'] }]);
    expect((two.get('b') as number) > (two.get('a') as number)).toBe(true);
    const weighted = fuse([{ ids: ['a'] }, { ids: ['b'], weight: 2 }]);
    expect((weighted.get('b') as number) > (weighted.get('a') as number)).toBe(true);
  });

  it('recencyBoost is 1.2 now, ~1.1 after a year, ~1 when old, never below 1', () => {
    const now = new Date('2026-10-30T00:00:00Z');
    expect(recencyBoost(now.toISOString(), now)).toBeCloseTo(1.2);
    expect(recencyBoost('2025-10-30T00:00:00Z', now)).toBeCloseTo(1.1, 2);
    expect(recencyBoost('1990-01-01T00:00:00Z', now)).toBeCloseTo(1, 4);
    expect(recencyBoost('2030-01-01T00:00:00Z', now)).toBeCloseTo(1.2);
    expect(recencyBoost('not a date', now)).toBe(1);
  });

  it('the newer of two equal docs ranks first', async () => {
    const d = await db();
    put(d, doc('old', 'parser notes', 'tokenizer', { updatedAt: '2020-01-01T00:00:00.000Z' }));
    put(d, doc('new', 'parser notes', 'tokenizer', { updatedAt: '2026-10-01T00:00:00.000Z' }));
    expect(search(d, { query: 'parser' }).map((h) => h.id)).toEqual([
      'src/note/new',
      'src/note/old',
    ]);
  });
});

describe('#47 embeddings client and config', () => {
  function fakeFetch(seen: Array<{ url: string; init: RequestInit }>, mode = 'ok') {
    return (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      if (mode === '500') return new Response('boom', { status: 500, statusText: 'Server Error' });
      const input = JSON.parse(String(init.body)).input as string[];
      const data = input.map((_, i) => ({ index: i, embedding: [i, 1] })).reverse(); // out of order
      if (mode === 'short') data.pop();
      return Response.json({ data });
    }) as unknown as typeof fetch;
  }

  it('batches, restores order and sends the key only when set', async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const embed = createEmbedder(
      { url: 'http://x/v1/', model: 'm', batchSize: 32, apiKey: 'k' },
      fakeFetch(seen),
    );
    const out = await embed(Array.from({ length: 70 }, (_, i) => `t${i}`));
    expect(seen).toHaveLength(3);
    expect(seen[0]?.url).toBe('http://x/v1/embeddings');
    expect(
      ((seen[0] as { init: RequestInit }).init.headers as Record<string, string>).authorization,
    ).toBe('Bearer k');
    expect(out).toHaveLength(70);
    expect([...(out[1] as Float32Array)]).toEqual([1, 1]);

    const noKey: Array<{ url: string; init: RequestInit }> = [];
    await createEmbedder({ url: 'http://x/v1', model: 'm', batchSize: 8 }, fakeFetch(noKey))(['a']);
    expect(
      ((noKey[0] as { init: RequestInit }).init.headers as Record<string, string>).authorization,
    ).toBeUndefined();
  });

  it('maps HTTP errors and malformed responses without leaking the key', async () => {
    const cfg = { url: 'http://x/v1', model: 'm', batchSize: 8, apiKey: 'secret-key' };
    await expect(createEmbedder(cfg, fakeFetch([], '500'))(['a'])).rejects.toThrow(
      'Embeddings request failed: 500 Server Error',
    );
    const err = await createEmbedder(cfg, fakeFetch([], 'short'))(['a', 'b']).catch((e) => e);
    expect(err.message).toBe('Embeddings response malformed');
    expect(err.message).not.toContain('secret-key');
  });

  it('config: off by default, api key only from env', async () => {
    const paths = resolvePaths({ WAYMARK_HOME: await tmp() });
    await initHome(paths);
    expect(embedConfigFrom(await loadConfig(paths))).toBeNull();
    await fs.writeFile(
      paths.config,
      JSON.stringify({ version: 1, embeddings: { url: 'http://localhost:11434/v1', model: 'e' } }),
    );
    const cfg = embedConfigFrom(await loadConfig(paths), { WAYMARK_EMBED_API_KEY: 'k' });
    expect(cfg).toEqual({
      url: 'http://localhost:11434/v1',
      model: 'e',
      batchSize: 32,
      apiKey: 'k',
    });
    await fs.writeFile(
      paths.config,
      JSON.stringify({ version: 1, embeddings: { url: 'http://x/v1', model: 'e', apiKey: 'k' } }),
    );
    await expect(loadConfig(paths)).rejects.toThrow('tokens must come from environment variables');
  });
});

describe('#48 vector index', () => {
  it('migrates a v1 database to v2 keeping rows', async () => {
    const dir = await tmp();
    const file = path.join(dir, 'db.sqlite');
    const first = openDb(file);
    put(first, doc('1', 'kept', 'body'));
    first.exec('DROP TABLE chunks; DROP TABLE vec_meta;');
    first.pragma('user_version = 1');
    first.close();
    const raw = new Database(file);
    expect(raw.pragma('user_version', { simple: true })).toBe(1);
    raw.close();
    const d = openDb(file);
    open.push(d);
    expect(d.pragma('user_version', { simple: true })).toBe(2);
    expect(d.prepare('SELECT title FROM docs').get()).toEqual({ title: 'kept' });
    expect(d.prepare('SELECT count(*) AS n FROM chunks').get()).toEqual({ n: 0 });
  });

  it('chunks: one for short docs, overlapping windows, capped at 8', () => {
    expect(chunkDoc('t', 'short')).toEqual([{ n: 0, start: 0, text: 't\n\nshort' }]);
    const two = chunkDoc('t', 'x'.repeat(1500));
    expect(two.map((c) => c.start)).toEqual([0, 1000]);
    expect(chunkDoc('t', 'x'.repeat(100_000))).toHaveLength(8);
  });

  it('embeds incrementally, re-embeds edits, drops deleted docs, rebuilds on model change', async () => {
    const d = await db();
    put(d, doc('a', 'login flow', 'authentication'));
    put(d, doc('b', 'sqlite notes', 'storage'));
    const calls: string[][] = [];
    const e = fakeEmbedder(calls);
    expect(await embedPending(d, e, 'm1')).toEqual({ embedded: 2, removed: 0 });
    expect(await embedPending(d, e, 'm1')).toEqual({ embedded: 0, removed: 0 });

    put(d, doc('a', 'login flow', 'authentication changed'));
    expect(await embedPending(d, e, 'm1')).toEqual({ embedded: 1, removed: 0 });

    d.prepare("DELETE FROM docs WHERE id = 'src/note/b'").run();
    expect(await embedPending(d, e, 'm1')).toEqual({ embedded: 0, removed: 1 });
    expect(d.prepare('SELECT count(*) AS n FROM vecs').get()).toEqual({ n: 1 });

    expect((await embedPending(d, e, 'm2')).embedded).toBe(1);
    expect(d.prepare('SELECT model FROM vec_meta').get()).toEqual({ model: 'm2' });
  });

  it('`waymark embed` without config exits 1 with a clear error', async () => {
    const home = await tmp();
    vi.stubEnv('WAYMARK_HOME', home);
    await initHome(resolvePaths());
    const err: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((s) => {
      err.push(String(s));
      return true;
    });
    expect(await main(['embed'])).toBe(1);
    expect(err.join('')).toContain('embeddings are not configured');
  });
});

describe('#49 hybrid search', () => {
  async function seeded() {
    const d = await db();
    put(d, doc('auth', 'Sign-in redesign', 'We moved login to OAuth.'));
    put(d, doc('db', 'Storage choice', 'Picked sqlite for the index.'));
    put(d, doc('rel', 'Release checklist', 'How we deploy on Fridays.'));
    put(d, doc('issue', 'Login bug', 'authentication fails', { kind: 'issue' }));
    const e = fakeEmbedder();
    await embedPending(d, e, 'm');
    return { d, e };
  }

  it('finds a doc that shares no keyword with the query (semantic recall)', async () => {
    const { d, e } = await seeded();
    expect(search(d, { query: 'database' })).toEqual([]);
    const hits = await hybridSearch(d, { query: 'database' }, queryOf(e));
    expect(hits[0]?.id).toBe('src/note/db');
    expect(hits[0]?.snippet).toBe('Picked sqlite for the index.');
  });

  it('a doc strong in both lists outranks docs strong in only one', async () => {
    const { d, e } = await seeded();
    const hits = await hybridSearch(d, { query: 'login' }, queryOf(e));
    expect(['src/note/auth', 'src/note/issue']).toContain(hits[0]?.id);
    expect(hits.findIndex((h) => h.id === 'src/note/rel')).not.toBe(0);
  });

  it('kind filters apply to vector hits', async () => {
    const { d, e } = await seeded();
    const hits = await hybridSearch(d, { query: 'signin', kinds: ['issue'] }, queryOf(e));
    expect(hits.map((h) => h.id)).toEqual(['src/note/issue']);
  });

  it('falls back to keyword search with a warning when the provider fails', async () => {
    const { d } = await seeded();
    const logs: string[] = [];
    const hits = await hybridSearch(
      d,
      { query: 'login' },
      async () => {
        throw new Error('connect ECONNREFUSED');
      },
      (m) => logs.push(m),
    );
    expect(hits.map((h) => h.id)).toEqual(search(d, { query: 'login' }).map((h) => h.id));
    expect(logs[0]).toContain('warn: embeddings unavailable, using keyword search');
  });

  it('without embeddings it equals keyword search', async () => {
    const { d } = await seeded();
    const ids = (hits: { id: string }[]) => hits.map((h) => h.id);
    expect(ids(await hybridSearch(d, { query: 'login' }))).toEqual(
      ids(search(d, { query: 'login' })),
    );
  });
});
