import type { DocKind } from '../store/doc.js';
import type { Db } from './db.js';

export interface SearchOptions {
  query: string;
  kinds?: DocKind[];
  sourceIds?: string[];
  limit?: number; // default 10, clamp to 1..50
}

export interface SearchHit {
  id: string;
  kind: DocKind;
  sourceId: string;
  title: string;
  url: string | null;
  updatedAt: string;
  snippet: string;
  score: number; // bm25, lower is better (as returned by SQLite)
}

/** Builds a safe FTS5 query: every term quoted, prefix-matched, OR-joined. '' when no terms. */
export function toFtsQuery(input: string): string {
  const terms = input.match(/[\p{L}\p{N}_]+/gu) ?? [];
  return terms.map((t) => `"${t}"*`).join(' OR ');
}

interface Row {
  id: string;
  kind: DocKind;
  source_id: string;
  title: string;
  url: string | null;
  updated_at: string;
  snippet: string;
  score: number;
}

export function search(db: Db, opts: SearchOptions): SearchHit[] {
  const match = toFtsQuery(opts.query);
  if (match === '') return [];

  const limit = Math.min(50, Math.max(1, Math.trunc(opts.limit ?? 10)));
  const params: (string | number)[] = [match];
  let filters = '';
  if (opts.kinds?.length) {
    filters += ` AND d.kind IN (${opts.kinds.map(() => '?').join(', ')})`;
    params.push(...opts.kinds);
  }
  if (opts.sourceIds?.length) {
    filters += ` AND d.source_id IN (${opts.sourceIds.map(() => '?').join(', ')})`;
    params.push(...opts.sourceIds);
  }
  params.push(limit);

  const rows = db
    .prepare(
      `SELECT d.id, d.kind, d.source_id, d.title, d.url, d.updated_at,
              snippet(docs_fts, 2, '**', '**', '…', 16) AS snippet,
              bm25(docs_fts, 0.0, 10.0, 1.0, 2.0) AS score
       FROM docs_fts
       JOIN docs d ON d.id = docs_fts.id
       WHERE docs_fts MATCH ?${filters}
       ORDER BY score
       LIMIT ?`,
    )
    .all(...params) as Row[];

  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    sourceId: r.source_id,
    title: r.title,
    url: r.url,
    updatedAt: r.updated_at,
    snippet: r.snippet,
    score: r.score,
  }));
}
