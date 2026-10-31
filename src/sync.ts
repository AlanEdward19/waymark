import path from 'node:path';
import { loadConfig, type SourceConfig } from './config.js';
import { gitConnector } from './connectors/git.js';
import { githubConnector } from './connectors/github/index.js';
import { notionConnector } from './connectors/notion.js';
import type { Connector } from './connectors/types.js';
import { createEmbedder, type Embedder, embedConfigFrom } from './embed/client.js';
import { embedPending } from './embed/index.js';
import { deleteDoc, getState, openDb, setState, upsertDoc } from './index/db.js';
import type { WaymarkPaths } from './paths.js';
import { docRelPath } from './store/doc.js';
import { removeDoc, writeDoc } from './store/markdown.js';
import { commitWiki } from './store/wikigit.js';

function buildConnector(source: SourceConfig, configDir: string): Connector {
  switch (source.type) {
    case 'git':
      return gitConnector(source, configDir);
    case 'github':
      return githubConnector(source);
    case 'notion':
      return notionConnector(source);
  }
}

export async function syncAll(
  paths: WaymarkPaths,
  opts: { only?: string; connectors?: Record<string, Connector>; embedder?: Embedder } = {},
): Promise<Array<{ sourceId: string; count: number; removed?: number; error?: string }>> {
  const config = await loadConfig(paths);
  let sources = config.sources;
  if (opts.only !== undefined) {
    sources = sources.filter((s) => s.id === opts.only);
    if (sources.length === 0) throw new Error(`Unknown source "${opts.only}"`);
  }
  const db = openDb(paths.db);
  const results: Array<{ sourceId: string; count: number; removed?: number; error?: string }> = [];
  try {
    for (const source of sources) {
      const log = (msg: string) => process.stderr.write(`[${source.id}] ${msg}\n`);
      try {
        const connector =
          opts.connectors?.[source.id] ?? buildConnector(source, path.dirname(paths.config));
        const { cursor, count, removed } = await connector({
          sourceId: source.id,
          cursor: getState(db, source.id),
          log,
          remove: async (id) => {
            await removeDoc(paths.wiki, id);
            deleteDoc(db, id);
          },
          listIds: (kind) =>
            (kind === undefined
              ? db.prepare('SELECT id FROM docs WHERE source_id = ?').all(source.id)
              : db
                  .prepare('SELECT id FROM docs WHERE source_id = ? AND kind = ?')
                  .all(source.id, kind)
            ).map((r) => (r as { id: string }).id),
          emit: async (doc) => {
            const { doc: stored } = await writeDoc(paths.wiki, doc);
            upsertDoc(db, stored, docRelPath(doc.id));
          },
        });
        if (cursor !== null) setState(db, source.id, cursor);
        results.push({ sourceId: source.id, count, ...(removed ? { removed } : {}) });
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        log(`error: ${error}`);
        results.push({ sourceId: source.id, count: 0, error });
      }
    }
    const embedCfg = embedConfigFrom(config);
    if (embedCfg) {
      // optional upgrade: a provider outage must not fail the sync
      try {
        const r = await embedPending(db, opts.embedder ?? createEmbedder(embedCfg), embedCfg.model);
        process.stderr.write(`embeddings: ${r.embedded} chunks embedded\n`);
      } catch (err) {
        process.stderr.write(`warn: embeddings: ${(err as Error).message}\n`);
      }
    }
  } finally {
    db.close();
  }
  await commitWiki(
    paths.wiki,
    `sync: ${results
      .map((r) => `${r.sourceId} +${r.count}${r.removed ? ` -${r.removed}` : ''}`)
      .join(', ')}`,
  );
  return results;
}
