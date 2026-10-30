import type { DocKind } from '../store/doc.js';
import type { Db } from './db.js';
import { fuse, recencyBoost, STOPWORDS } from './rank.js';

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
  score: number; // negated fused score: lower is better
}

/**
 * Builds a safe FTS5 query: every term quoted, prefix-matched, OR-joined. '' when no terms.
 * Stopwords are dropped unless the query has nothing else.
 */
export function toFtsQuery(input: string): string {
  const terms = input.match(/[\p{L}\p{N}_]+/gu) ?? [];
  const content = terms.filter((t) => !STOPWORDS.has(t.toLowerCase()));
  return (content.length > 0 ? content : terms).map((t) => `"${t}"*`).join(' OR ');
}

export const clampLimit = (limit: number | undefined) =>
  Math.min(50, Math.max(1, Math.trunc(limit ?? 10)));

/** `AND d.kind IN (...) AND d.source_id IN (...)` with its params; `d` is the docs table. */
export function docFilters(opts: SearchOptions): { sql: string; params: string[] } {
  let sql = '';
  const params: string[] = [];
  if (opts.kinds?.length) {
    sql += ` AND d.kind IN (${opts.kinds.map(() => '?').join(', ')})`;
    params.push(...opts.kinds);
  }
  if (opts.sourceIds?.length) {
    sql += ` AND d.source_id IN (${opts.sourceIds.map(() => '?').join(', ')})`;
    params.push(...opts.sourceIds);
  }
  return { sql, params };
}

interface Row {
  id: string;
  kind: DocKind;
  source_id: string;
  title: string;
  url: string | null;
  updated_at: string;
  snippet: string;
}

export const toHit = (r: Row, score = 0): SearchHit => ({
  id: r.id,
  kind: r.kind,
  sourceId: r.source_id,
  title: r.title,
  url: r.url,
  updatedAt: r.updated_at,
  snippet: r.snippet,
  score,
});

/** Keyword candidates in BM25 order (best first). */
export function ftsCandidates(db: Db, opts: SearchOptions, n: number): SearchHit[] {
  const match = toFtsQuery(opts.query);
  if (match === '') return [];
  const f = docFilters(opts);
  const rows = db
    .prepare(
      `SELECT d.id, d.kind, d.source_id, d.title, d.url, d.updated_at,
              snippet(docs_fts, 2, '**', '**', '…', 16) AS snippet
       FROM docs_fts
       JOIN docs d ON d.id = docs_fts.id
       WHERE docs_fts MATCH ?${f.sql}
       ORDER BY bm25(docs_fts, 0.0, 10.0, 1.0, 2.0)
       LIMIT ?`,
    )
    .all(match, ...f.params, n) as Row[];
  return rows.map((r) => toHit(r));
}

/** Fuses ranked candidate lists with RRF, applies the recency boost, returns the top `limit`. */
export function rankHits(lists: SearchHit[][], limit: number, now: Date = new Date()): SearchHit[] {
  const byId = new Map<string, SearchHit>();
  for (const list of lists) for (const h of list) if (!byId.has(h.id)) byId.set(h.id, h);
  const fused = fuse(lists.map((l) => ({ ids: l.map((h) => h.id) })));
  return [...byId.values()]
    .map((h) => ({ ...h, score: -((fused.get(h.id) ?? 0) * recencyBoost(h.updatedAt, now)) }))
    .sort((a, b) => a.score - b.score)
    .slice(0, limit);
}

export function search(db: Db, opts: SearchOptions): SearchHit[] {
  const limit = clampLimit(opts.limit);
  return rankHits([ftsCandidates(db, opts, Math.max(limit * 5, 50))], limit);
}
