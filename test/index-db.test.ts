import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deleteDoc, getState, openDb, reindex, setState, upsertDoc } from '../src/index/db.js';
import { docRelPath, type WaymarkDoc } from '../src/store/doc.js';
import { writeDoc } from '../src/store/markdown.js';

let dir: string;
let dbPath: string;
let wiki: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'waymark-'));
  dbPath = path.join(dir, 'db', 'waymark.db');
  wiki = path.join(dir, 'wiki');
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const doc = (n: number, over: Partial<WaymarkDoc> = {}): WaymarkDoc => ({
  id: `src/note/${n}`,
  kind: 'note',
  sourceId: 'src',
  title: `Title ${n}`,
  authors: ['alan'],
  createdAt: '2026-10-01T12:00:00.000Z',
  updatedAt: '2026-10-02T08:30:00.000Z',
  tags: [],
  body: `body ${n}`,
  ...over,
});

const count = (db: ReturnType<typeof openDb>, table: string, id?: string) =>
  (
    db
      .prepare(`SELECT count(*) AS n FROM ${table}${id ? ' WHERE id = ?' : ''}`)
      .get(...(id ? [id] : [])) as { n: number }
  ).n;

describe('openDb', () => {
  it('creates the current-schema db in WAL mode and reopens', () => {
    const db = openDb(dbPath);
    expect(db.pragma('user_version', { simple: true })).toBe(2);
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    db.close();
    openDb(dbPath).close();
  });

  it('rejects a newer schema', () => {
    const raw = new Database(path.join(dir, 'new.db'));
    raw.pragma('user_version = 99');
    raw.close();
    expect(() => openDb(path.join(dir, 'new.db'))).toThrow(
      'Database schema is newer than this Waymark version',
    );
  });
});

describe('upsertDoc', () => {
  it('keeps one row per id and updates the title', () => {
    const db = openDb(dbPath);
    upsertDoc(db, doc(1), docRelPath('src/note/1'));
    upsertDoc(db, doc(1, { title: 'New title' }), docRelPath('src/note/1'));
    expect(count(db, 'docs', 'src/note/1')).toBe(1);
    expect(count(db, 'docs_fts', 'src/note/1')).toBe(1);
    expect(db.prepare('SELECT title FROM docs_fts WHERE id = ?').get('src/note/1')).toEqual({
      title: 'New title',
    });
    deleteDoc(db, 'src/note/1');
    expect(count(db, 'docs')).toBe(0);
    expect(count(db, 'docs_fts')).toBe(0);
    db.close();
  });

  it('matches accent-insensitively', () => {
    const db = openDb(dbPath);
    upsertDoc(db, doc(1, { body: 'decisão' }), 'src/note/1.md');
    const rows = db.prepare("SELECT id FROM docs_fts WHERE docs_fts MATCH 'decisao'").all();
    expect(rows).toEqual([{ id: 'src/note/1' }]);
    db.close();
  });
});

describe('state', () => {
  it('round trips', () => {
    const db = openDb(dbPath);
    expect(getState(db, 's')).toBeNull();
    setState(db, 's', 'c1');
    setState(db, 's', 'c2');
    expect(getState(db, 's')).toBe('c2');
    db.close();
  });
});

describe('reindex', () => {
  it('rebuilds from the wiki and keeps state', async () => {
    for (const n of [1, 2, 3]) await writeDoc(wiki, doc(n));
    const db = openDb(dbPath);
    setState(db, 'src', 'cur');
    expect(await reindex(db, wiki)).toEqual({ count: 3 });
    await fs.rm(path.join(wiki, ...docRelPath('src/note/2').split('/')));
    expect(await reindex(db, wiki)).toEqual({ count: 2 });
    expect(count(db, 'docs', 'src/note/2')).toBe(0);
    expect(count(db, 'docs_fts', 'src/note/2')).toBe(0);
    expect(getState(db, 'src')).toBe('cur');
    db.close();
  });
});
