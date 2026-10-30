import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { docRelPath, type WaymarkDoc } from '../store/doc.js';
import { listDocs } from '../store/markdown.js';

export type Db = Database.Database;

const SCHEMA_VERSION = 1;

const SCHEMA_V1 = `
CREATE TABLE docs (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,
  source_id   TEXT NOT NULL,
  title       TEXT NOT NULL,
  url         TEXT,
  authors     TEXT NOT NULL,  -- JSON array
  tags        TEXT NOT NULL,  -- JSON array
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  path        TEXT NOT NULL   -- relative to wiki dir, "/" separators
);
CREATE INDEX docs_source_kind ON docs(source_id, kind);
CREATE INDEX docs_updated ON docs(updated_at);

CREATE VIRTUAL TABLE docs_fts USING fts5(
  id UNINDEXED,
  title,
  body,
  authors,
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TABLE source_state (
  source_id  TEXT PRIMARY KEY,
  cursor     TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

export function openDb(dbPath: string): Db {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  try {
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    const version = db.pragma('user_version', { simple: true }) as number;
    if (version > SCHEMA_VERSION) {
      throw new Error('Database schema is newer than this Waymark version');
    }
    if (version === 0) {
      db.transaction(() => {
        db.exec(SCHEMA_V1);
        db.pragma(`user_version = ${SCHEMA_VERSION}`);
      })();
    }
  } catch (err) {
    db.close();
    throw err;
  }
  return db;
}

export function upsertDoc(db: Db, doc: WaymarkDoc, relPath: string): void {
  db.transaction(() => {
    db.prepare(
      `INSERT INTO docs (id, kind, source_id, title, url, authors, tags, created_at, updated_at, path)
       VALUES (@id, @kind, @sourceId, @title, @url, @authors, @tags, @createdAt, @updatedAt, @path)
       ON CONFLICT(id) DO UPDATE SET
         kind = excluded.kind, source_id = excluded.source_id, title = excluded.title,
         url = excluded.url, authors = excluded.authors, tags = excluded.tags,
         created_at = excluded.created_at, updated_at = excluded.updated_at, path = excluded.path`,
    ).run({
      id: doc.id,
      kind: doc.kind,
      sourceId: doc.sourceId,
      title: doc.title,
      url: doc.url ?? null,
      authors: JSON.stringify(doc.authors),
      tags: JSON.stringify(doc.tags),
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
      path: relPath,
    });
    db.prepare('DELETE FROM docs_fts WHERE id = ?').run(doc.id);
    db.prepare('INSERT INTO docs_fts (id, title, body, authors) VALUES (?, ?, ?, ?)').run(
      doc.id,
      doc.title,
      doc.body,
      doc.authors.join(' '),
    );
  })();
}

export function deleteDoc(db: Db, id: string): void {
  db.transaction(() => {
    db.prepare('DELETE FROM docs WHERE id = ?').run(id);
    db.prepare('DELETE FROM docs_fts WHERE id = ?').run(id);
  })();
}

export function getState(db: Db, sourceId: string): string | null {
  const row = db.prepare('SELECT cursor FROM source_state WHERE source_id = ?').get(sourceId) as
    | { cursor: string }
    | undefined;
  return row?.cursor ?? null;
}

export function setState(db: Db, sourceId: string, cursor: string): void {
  db.prepare(
    `INSERT INTO source_state (source_id, cursor, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(source_id) DO UPDATE SET cursor = excluded.cursor, updated_at = excluded.updated_at`,
  ).run(sourceId, cursor, new Date().toISOString());
}

export async function reindex(db: Db, wikiDir: string): Promise<{ count: number }> {
  // listDocs is async, transactions are sync: collect first
  // ponytail: fine up to ~100k docs; batch in chunks if memory becomes a problem
  const docs: WaymarkDoc[] = [];
  for await (const { doc } of listDocs(wikiDir)) docs.push(doc);
  db.transaction(() => {
    db.exec('DELETE FROM docs; DELETE FROM docs_fts;');
    for (const doc of docs) upsertDoc(db, doc, docRelPath(doc.id));
  })();
  return { count: docs.length };
}
