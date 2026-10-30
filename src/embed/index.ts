import { createHash } from 'node:crypto';
import type { Db } from '../index/db.js';
import { type Chunk, chunkDoc } from './chunks.js';
import type { Embedder } from './client.js';

const toBlob = (v: Float32Array) => Buffer.from(v.buffer, v.byteOffset, v.byteLength);
const hashOf = (model: string, text: string) =>
  createHash('sha256').update(`${model}\n${text}`).digest('hex');

export function hasVectors(db: Db): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'vecs'").get() !== undefined;
}

/** Drops all vectors when the configured model changed. */
function resetIfModelChanged(db: Db, model: string): void {
  const meta = db.prepare('SELECT model FROM vec_meta').get() as { model: string } | undefined;
  if (!meta || meta.model === model) return;
  db.transaction(() => {
    db.exec('DROP TABLE IF EXISTS vecs; DELETE FROM chunks; DELETE FROM vec_meta;');
  })();
}

function ensureVecTable(db: Db, model: string, dim: number): void {
  if (hasVectors(db)) return;
  db.transaction(() => {
    // dim is a number from the embedder, never user text
    db.exec(
      `CREATE VIRTUAL TABLE vecs USING vec0(chunk_id INTEGER PRIMARY KEY, embedding float[${dim}] distance_metric=cosine)`,
    );
    db.prepare('INSERT INTO vec_meta (model, dim) VALUES (?, ?)').run(model, dim);
  })();
}

function deleteChunks(db: Db, chunkIds: number[]): void {
  const delVec = hasVectors(db) ? db.prepare('DELETE FROM vecs WHERE chunk_id = ?') : null;
  const delChunk = db.prepare('DELETE FROM chunks WHERE chunk_id = ?');
  for (const id of chunkIds) {
    delVec?.run(BigInt(id)); // vec0 rejects non-integer JS numbers as keys
    delChunk.run(id);
  }
}

/**
 * Embeds chunks that are new or changed since the last run; removes chunks of deleted docs.
 * Never called from hooks or MCP writes: it is slow and may cost money.
 */
export async function embedPending(
  db: Db,
  embed: Embedder,
  model: string,
): Promise<{ embedded: number; removed: number }> {
  resetIfModelChanged(db, model);

  const orphans = db
    .prepare('SELECT chunk_id FROM chunks WHERE doc_id NOT IN (SELECT id FROM docs)')
    .all() as Array<{ chunk_id: number }>;
  db.transaction(() =>
    deleteChunks(
      db,
      orphans.map((r) => r.chunk_id),
    ),
  )();
  let removed = orphans.length;

  const existing = new Map<string, { chunk_id: number; hash: string }>();
  for (const r of db.prepare('SELECT chunk_id, doc_id, n, hash FROM chunks').all() as Array<{
    chunk_id: number;
    doc_id: string;
    n: number;
    hash: string;
  }>) {
    existing.set(`${r.doc_id}\n${r.n}`, r);
  }

  const todo: Array<Chunk & { docId: string; hash: string }> = [];
  const stale: number[] = [];
  const docs = db
    .prepare('SELECT d.id, d.title, f.body FROM docs d JOIN docs_fts f ON f.id = d.id')
    .all() as Array<{ id: string; title: string; body: string }>;
  for (const d of docs) {
    const chunks = chunkDoc(d.title, d.body);
    for (const c of chunks) {
      const hash = hashOf(model, c.text);
      const old = existing.get(`${d.id}\n${c.n}`);
      if (old?.hash === hash) continue;
      if (old) stale.push(old.chunk_id);
      todo.push({ ...c, docId: d.id, hash });
    }
    // chunks beyond the new count (doc got shorter)
    for (let n = chunks.length; existing.has(`${d.id}\n${n}`); n++) {
      stale.push((existing.get(`${d.id}\n${n}`) as { chunk_id: number }).chunk_id);
      removed++;
    }
  }
  db.transaction(() => deleteChunks(db, stale))();

  const BATCH = 64;
  for (let i = 0; i < todo.length; i += BATCH) {
    const batch = todo.slice(i, i + BATCH);
    const vectors = await embed(batch.map((c) => c.text));
    ensureVecTable(db, model, (vectors[0] as Float32Array).length);
    const insChunk = db.prepare(
      'INSERT INTO chunks (doc_id, n, start, hash) VALUES (?, ?, ?, ?) RETURNING chunk_id',
    );
    const insVec = db.prepare('INSERT INTO vecs (chunk_id, embedding) VALUES (?, ?)');
    db.transaction(() => {
      batch.forEach((c, j) => {
        const { chunk_id } = insChunk.get(c.docId, c.n, c.start, c.hash) as { chunk_id: number };
        insVec.run(BigInt(chunk_id), toBlob(vectors[j] as Float32Array));
      });
    })();
  }
  return { embedded: todo.length, removed };
}
