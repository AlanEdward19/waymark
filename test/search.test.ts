import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Db, openDb, upsertDoc } from '../src/index/db.js';
import { formatHits } from '../src/index/format.js';
import { type SearchHit, search, toFtsQuery } from '../src/index/search.js';
import { docRelPath, type WaymarkDoc } from '../src/store/doc.js';

let dir: string;
let db: Db;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'waymark-'));
  db = openDb(path.join(dir, 'db', 'waymark.db'));
});
afterEach(async () => {
  db.close();
  await fs.rm(dir, { recursive: true, force: true });
});

const doc = (over: Partial<WaymarkDoc> & { id: string }): WaymarkDoc => ({
  kind: 'note',
  sourceId: 'src',
  title: 'Untitled',
  authors: ['alan'],
  createdAt: '2026-10-01T12:00:00.000Z',
  updatedAt: '2026-10-02T08:30:00.000Z',
  tags: [],
  body: '',
  ...over,
});
const add = (d: WaymarkDoc) => upsertDoc(db, d, docRelPath(d.id));

describe('toFtsQuery', () => {
  it.each([
    ['', ''],
    ['  !!! ', ''],
    ['auth-token', '"auth"* OR "token"*'],
    ['"quoted', '"quoted"*'],
  ])('%j -> %j', (input, expected) => {
    expect(toFtsQuery(input)).toBe(expected);
  });
});

describe('search', () => {
  beforeEach(() => {
    add(doc({ id: 'src/note/1', title: 'Cache design', body: 'we use sqlite for storage' }));
    add(doc({ id: 'src/note/2', title: 'Other', body: 'sqlite sqlite is mentioned in body' }));
    add(
      doc({
        id: 'gh/issue/3',
        kind: 'issue',
        sourceId: 'gh',
        title: 'Decisão sobre auth',
        body: 'token rotation',
      }),
    );
  });

  it('ranks title match above body-only match', () => {
    add(doc({ id: 'src/note/4', title: 'sqlite notes', body: 'nothing' }));
    const hits = search(db, { query: 'sqlite' });
    expect(hits[0]?.id).toBe('src/note/4');
    expect(hits.map((h) => h.id)).toContain('src/note/2');
  });

  it('is accent-insensitive', () => {
    expect(search(db, { query: 'decisao' }).map((h) => h.id)).toEqual(['gh/issue/3']);
  });

  it('filters by kind and source', () => {
    expect(search(db, { query: 'sqlite token', kinds: ['issue'] }).map((h) => h.id)).toEqual([
      'gh/issue/3',
    ]);
    const hits = search(db, { query: 'sqlite token', sourceIds: ['src'] });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.sourceId === 'src')).toBe(true);
  });

  it('clamps limit to 50', () => {
    for (let i = 0; i < 60; i++) add(doc({ id: `src/note/x${i}`, body: 'clampme' }));
    expect(search(db, { query: 'clampme', limit: 1000 })).toHaveLength(50);
    expect(search(db, { query: 'clampme', limit: 0 })).toHaveLength(1);
  });

  it('returns structured hits with snippet', () => {
    const [hit] = search(db, { query: 'rotation' });
    expect(hit).toMatchObject({ id: 'gh/issue/3', kind: 'issue', sourceId: 'gh', url: null });
    expect(hit?.snippet).toContain('**rotation**');
  });

  it.each(['NEAR(', 'AND', '*', 'a:b', '"', 'x OR', '()'])('never throws on %j', (q) => {
    expect(() => search(db, { query: q })).not.toThrow();
  });

  it('returns [] for empty query', () => {
    expect(search(db, { query: '!!!' })).toEqual([]);
  });
});

describe('formatHits', () => {
  const hit = (over: Partial<SearchHit>): SearchHit => ({
    id: 'waymark-gh/pull_request/42',
    kind: 'pull_request',
    sourceId: 'waymark-gh',
    title: 'Add FTS search',
    url: 'https://github.com/AlanEdward19/waymark/pull/42',
    updatedAt: '2026-10-02T08:30:00.000Z',
    snippet: '…we chose **SQLite**…',
    score: -1,
    ...over,
  });

  it('formats hits with and without url', () => {
    const out = formatHits([hit({}), hit({ id: 'a/note/1', url: null, title: 'Two' })]).split('\n');
    expect(out.slice(0, 4)).toEqual([
      '1. Add FTS search  [pull_request · waymark-gh · 2026-10-02]',
      '   id: waymark-gh/pull_request/42',
      '   https://github.com/AlanEdward19/waymark/pull/42',
      '   …we chose **SQLite**…',
    ]);
    expect(out[4]).toBe('');
    expect(out.slice(5)).toEqual([
      '2. Two  [pull_request · waymark-gh · 2026-10-02]',
      '   id: a/note/1',
      '   …we chose **SQLite**…',
    ]);
  });

  it('says No results.', () => {
    expect(formatHits([])).toBe('No results.');
  });
});
