#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { handleHook } from './agents/claude-code.js';
import { initHome } from './config.js';
import { openDb, reindex } from './index/db.js';
import { resolvePaths } from './paths.js';
import { VERSION } from './version.js';

const USAGE = `Usage: waymark [options] <command>

Options:
  -v, --version  Print the version
  -h, --help     Print this help

Commands:
  init           Create the Waymark data directory and config
  reindex        Rebuild the search index from the wiki
  hook <harness> Handle an agent hook event from stdin (claude-code)
`;

export async function main(argv: string[]): Promise<number> {
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      options: {
        version: { type: 'boolean', short: 'v' },
        help: { type: 'boolean', short: 'h' },
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
      case 'hook': {
        // hooks must never break the user's session: always exit 0
        try {
          if (positionals[1] !== 'claude-code') {
            process.stderr.write(`warn: waymark hook: unknown harness "${positionals[1] ?? ''}"
`);
            return 0;
          }
          const chunks: Buffer[] = [];
          for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
          const out = await handleHook(Buffer.concat(chunks).toString('utf8'), resolvePaths());
          if (out !== '')
            process.stdout.write(`${out}
`);
        } catch (err) {
          process.stderr.write(
            `warn: waymark hook: ${err instanceof Error ? err.message : String(err)}
`,
          );
        }
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
