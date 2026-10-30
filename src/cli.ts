#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { initHome } from './config.js';
import { openDb, reindex } from './index/db.js';
import { resolvePaths } from './paths.js';
import { syncAll } from './sync.js';
import { VERSION } from './version.js';

const USAGE = `Usage: waymark [options] <command>

Options:
  -v, --version  Print the version
  -h, --help     Print this help

Commands:
  init           Create the Waymark data directory and config
  reindex        Rebuild the search index from the wiki
  sync           Sync configured sources (--source <id> for one)
`;

export async function main(argv: string[]): Promise<number> {
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      options: {
        version: { type: 'boolean', short: 'v' },
        help: { type: 'boolean', short: 'h' },
        source: { type: 'string' },
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
      case 'sync': {
        const results = await syncAll(resolvePaths(), { only: values.source });
        for (const r of results) {
          process.stdout.write(
            r.error
              ? `${r.sourceId}: error: ${r.error}\n`
              : `${r.sourceId}: ${r.count} documents\n`,
          );
        }
        return results.some((r) => r.error) ? 1 : 0;
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
