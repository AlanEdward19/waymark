import path from 'node:path';
import { loadConfig, type SourceConfig } from './config.js';
import { gitConnector } from './connectors/git.js';
import { githubConnector } from './connectors/github/index.js';
import type { Connector } from './connectors/types.js';
import { getState, openDb, setState, upsertDoc } from './index/db.js';
import type { WaymarkPaths } from './paths.js';
import { docRelPath } from './store/doc.js';
import { writeDoc } from './store/markdown.js';
import { commitWiki } from './store/wikigit.js';

function buildConnector(source: SourceConfig, configDir: string): Connector {
  switch (source.type) {
    case 'git':
      return gitConnector(source, configDir);
    case 'github':
      return githubConnector(source);
  }
}

export async function syncAll(
  paths: WaymarkPaths,
  opts: { only?: string; connectors?: Record<string, Connector> } = {},
): Promise<Array<{ sourceId: string; count: number; error?: string }>> {
  const config = await loadConfig(paths);
  let sources = config.sources;
  if (opts.only !== undefined) {
    sources = sources.filter((s) => s.id === opts.only);
    if (sources.length === 0) throw new Error(`Unknown source "${opts.only}"`);
  }
  const db = openDb(paths.db);
  const results: Array<{ sourceId: string; count: number; error?: string }> = [];
  try {
    for (const source of sources) {
      const log = (msg: string) => process.stderr.write(`[${source.id}] ${msg}\n`);
      try {
        const connector =
          opts.connectors?.[source.id] ?? buildConnector(source, path.dirname(paths.config));
        const { cursor, count } = await connector({
          sourceId: source.id,
          cursor: getState(db, source.id),
          log,
          emit: async (doc) => {
            await writeDoc(paths.wiki, doc);
            upsertDoc(db, doc, docRelPath(doc.id));
          },
        });
        if (cursor !== null) setState(db, source.id, cursor);
        results.push({ sourceId: source.id, count });
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        log(`error: ${error}`);
        results.push({ sourceId: source.id, count: 0, error });
      }
    }
  } finally {
    db.close();
  }
  await commitWiki(
    paths.wiki,
    `sync: ${results.map((r) => `${r.sourceId} +${r.count}`).join(', ')}`,
  );
  return results;
}
