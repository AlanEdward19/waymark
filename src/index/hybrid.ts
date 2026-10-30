import { type Config, loadConfig } from '../config.js';
import { createEmbedder, embedConfigFrom } from '../embed/client.js';
import { hasVectors } from '../embed/index.js';
import type { WaymarkPaths } from '../paths.js';
import type { DocKind } from '../store/doc.js';
import type { Db } from './db.js';
import {
  clampLimit,
  docFilters,
  ftsCandidates,
  rankHits,
  type SearchHit,
  type SearchOptions,
  toHit,
} from './search.js';

export type QueryEmbedder = (query: string) => Promise<Float32Array>;

const CANDIDATES = 50;

/** Query embedder from config, or undefined when embeddings are off. */
export function queryEmbedderFrom(config: Config): QueryEmbedder | undefined {
  const cfg = embedConfigFrom(config);
  if (!cfg) return undefined;
  const embed = createEmbedder(cfg);
  return async (q) => (await embed([q]))[0] as Float32Array;
}

export async function queryEmbedderFor(paths: WaymarkPaths): Promise<QueryEmbedder | undefined> {
  return queryEmbedderFrom(await loadConfig(paths));
}

/** Nearest docs by their best chunk, best first. */
function vectorCandidates(db: Db, opts: SearchOptions, q: Float32Array): SearchHit[] {
  const f = docFilters(opts);
  // ponytail: KNN runs before the kind/source filters, so filtered queries can return < limit
  const rows = db
    .prepare(
      `SELECT d.id, d.kind, d.source_id, d.title, d.url, d.updated_at,
              substr(fts.body, c.start + 1, 200) AS snippet, v.distance
       FROM vecs v
       JOIN chunks c ON c.chunk_id = v.chunk_id
       JOIN docs d ON d.id = c.doc_id
       JOIN docs_fts fts ON fts.id = d.id
       WHERE v.embedding MATCH ? AND k = ?${f.sql}
       ORDER BY v.distance`,
    )
    .all(Buffer.from(q.buffer, q.byteOffset, q.byteLength), CANDIDATES, ...f.params) as Array<{
    id: string;
    kind: DocKind;
    source_id: string;
    title: string;
    url: string | null;
    updated_at: string;
    snippet: string;
  }>;
  const seen = new Set<string>();
  return rows.filter((r) => !seen.has(r.id) && seen.add(r.id)).map((r) => toHit(r));
}

/**
 * Keyword + (when configured) vector search, fused with RRF and a recency boost.
 * Falls back to keyword search when embeddings are off or the provider fails.
 */
export async function hybridSearch(
  db: Db,
  opts: SearchOptions,
  embedQuery?: QueryEmbedder,
  log: (msg: string) => void = (m) => process.stderr.write(`${m}\n`),
): Promise<SearchHit[]> {
  const limit = clampLimit(opts.limit);
  const fts = ftsCandidates(db, opts, Math.max(limit * 5, CANDIDATES));
  if (!embedQuery || !hasVectors(db) || opts.query.trim() === '') return rankHits([fts], limit);
  let vec: SearchHit[];
  try {
    vec = vectorCandidates(db, opts, await embedQuery(opts.query));
  } catch (err) {
    log(`warn: embeddings unavailable, using keyword search: ${(err as Error).message}`);
    return rankHits([fts], limit);
  }
  return rankHits([fts, vec], limit);
}
