#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { VERSION } from './version.js';

const USAGE = `Usage: waymark [options] <command>

Options:
  -v, --version  Print the version
  -h, --help     Print this help

Commands:
  (none yet)
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
