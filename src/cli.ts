#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { HOOK_HANDLERS } from './agents/index.js';
import { initHome, loadConfig } from './config.js';
import { createEmbedder, embedConfigFrom } from './embed/client.js';
import { embedPending } from './embed/index.js';
import { openDb, reindex } from './index/db.js';
import { formatHits } from './index/format.js';
import { hybridSearch, queryEmbedderFor } from './index/hybrid.js';
import { runStdio } from './mcp/server.js';
import { resolvePaths } from './paths.js';
import { DOC_KINDS, isDocKind } from './store/doc.js';
import { readDoc, serializeDoc } from './store/markdown.js';
import { syncAll } from './sync.js';
import { VERSION } from './version.js';

const USAGE = `Usage: waymark [options] <command>

Options:
  -v, --version  Print the version
  -h, --help     Print this help

Commands:
  mcp            Run the MCP server over stdio
  hook <harness> Handle an agent hook event from stdin (claude-code, cursor, hermes)
  init           Create the Waymark data directory and config
  reindex        Rebuild the search index from the wiki
  sync           Sync configured sources (--source <id> for one)
  embed          Embed new or changed documents (needs "embeddings" in config)
  search <query...> [--kind <k>]... [--source <id>]... [--limit <n>] [--json]
                 Ranked search over indexed documents
  show <id>      Print a document as markdown
`;

export async function main(argv: string[]): Promise<number> {
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      options: {
        version: { type: 'boolean', short: 'v' },
        help: { type: 'boolean', short: 'h' },
        kind: { type: 'string', multiple: true },
        source: { type: 'string', multiple: true },
        limit: { type: 'string' },
        json: { type: 'boolean' },
      },
      allowPositionals: true,
    });

    if (values.version) {
      process.stdout.write(`${VERSION}\n`);
      return 0;
    }

    const command = positionals[0];
    if (values.help || command === undefined) {
      process.stdout.write(USAGE);
      return 0;
    }

    switch (command) {
      case 'hook': {
        // hooks must never break the user's session: always exit 0
        try {
          const name = positionals[1] ?? '';
          const handler = Object.hasOwn(HOOK_HANDLERS, name) ? HOOK_HANDLERS[name] : undefined;
          if (!handler) {
            process.stderr.write(`warn: waymark hook: unknown harness "${positionals[1] ?? ''}"\n`);
            return 0;
          }
          const chunks: Buffer[] = [];
          for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
          const out = await handler(Buffer.concat(chunks).toString('utf8'), resolvePaths());
          if (out !== '') process.stdout.write(`${out}\n`);
        } catch (err) {
          process.stderr.write(
            `warn: waymark hook: ${err instanceof Error ? err.message : String(err)}\n`,
          );
        }
        return 0;
      }
      case 'mcp':
        // stdout carries only JSON-RPC from here on; the process stays alive on stdin
        await runStdio(resolvePaths());
        return 0;
      case 'init': {
        const paths = resolvePaths();
        const { created } = await initHome(paths);
        process.stdout.write(
          created
            ? `Initialised Waymark at ${paths.home}\n`
            : `Waymark already initialised at ${paths.home}\n`,
        );
        return 0;
      }
      case 'reindex': {
        const paths = resolvePaths();
        const db = openDb(paths.db);
        try {
          const { count } = await reindex(db, paths.wiki);
          process.stdout.write(`Indexed ${count} documents\n`);
        } finally {
          db.close();
        }
        return 0;
      }
      case 'embed': {
        const paths = resolvePaths();
        const cfg = embedConfigFrom(await loadConfig(paths));
        if (!cfg)
          throw new Error('embeddings are not configured (add "embeddings" to config.json)');
        const db = openDb(paths.db);
        try {
          const r = await embedPending(db, createEmbedder(cfg), cfg.model);
          process.stdout.write(`Embedded ${r.embedded} chunks (${r.removed} removed)\n`);
        } finally {
          db.close();
        }
        return 0;
      }
      case 'sync': {
        if ((values.source?.length ?? 0) > 1) throw new Error('sync takes at most one --source');
        const results = await syncAll(resolvePaths(), { only: values.source?.[0] });
        for (const r of results) {
          process.stdout.write(
            r.error
              ? `${r.sourceId}: error: ${r.error}\n`
              : `${r.sourceId}: ${r.count} documents\n`,
          );
        }
        return results.some((r) => r.error) ? 1 : 0;
      }
      case 'search': {
        const query = positionals.slice(1).join(' ');
        if (query.trim() === '') throw new Error('search needs a query');
        const kinds = values.kind ?? [];
        for (const k of kinds) {
          if (!isDocKind(k)) {
            throw new Error(`invalid kind "${k}" (valid: ${DOC_KINDS.join(', ')})`);
          }
        }
        const limit = values.limit === undefined ? undefined : Number(values.limit);
        if (limit !== undefined && !(Number.isInteger(limit) && limit >= 1)) {
          throw new Error(`invalid limit "${values.limit}"`);
        }
        const paths = resolvePaths();
        const db = openDb(paths.db);
        try {
          const hits = await hybridSearch(
            db,
            { query, kinds: kinds.filter(isDocKind), sourceIds: values.source, limit },
            await queryEmbedderFor(paths),
          );
          process.stdout.write(
            values.json ? `${JSON.stringify(hits, null, 2)}\n` : `${formatHits(hits)}\n`,
          );
        } finally {
          db.close();
        }
        return 0;
      }
      case 'show': {
        const id = positionals[1];
        if (!id) throw new Error('show needs a document id');
        const doc = await readDoc(resolvePaths().wiki, id);
        if (!doc) throw new Error(`document not found: ${id}`);
        process.stdout.write(serializeDoc(doc));
        return 0;
      }
      default:
        throw new Error(`unknown command "${command}"`);
    }
  } catch (err) {
    process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
