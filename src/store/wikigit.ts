import fs from 'node:fs/promises';
import path from 'node:path';
import { defaultRun, type RunGit } from '../git.js';
import { redact } from '../redact.js';

let warned = false;

function isMissingGit(err: unknown): boolean {
  return (err as NodeJS.ErrnoException)?.code === 'ENOENT';
}

function warnMissingGit(): void {
  if (warned) return;
  warned = true;
  process.stderr.write('warn: git not found; wiki changes are not versioned\n');
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function ensureWikiRepo(wikiDir: string, run: RunGit = defaultRun): Promise<void> {
  await fs.mkdir(wikiDir, { recursive: true });
  if (await exists(path.join(wikiDir, '.git'))) return;
  try {
    await run(['init', '-q', '-b', 'main'], wikiDir);
    await fs.writeFile(path.join(wikiDir, '.gitattributes'), '* text=auto eol=lf\n');
  } catch (err) {
    if (isMissingGit(err)) return warnMissingGit();
    process.stderr.write(`warn: could not init wiki repo: ${(err as Error).message}\n`);
  }
}

/** Commits pending wiki changes. Returns true if a commit was made. Never throws. */
export async function commitWiki(
  wikiDir: string,
  message: string,
  run: RunGit = defaultRun,
): Promise<boolean> {
  try {
    await ensureWikiRepo(wikiDir, run);
    if ((await run(['status', '--porcelain'], wikiDir)).trim() === '') return false;
    await run(['add', '-A'], wikiDir);
    await run(
      [
        '-c',
        'user.name=Waymark',
        '-c',
        'user.email=waymark@localhost',
        '-c',
        'commit.gpgsign=false',
        'commit',
        '-q',
        '-m',
        redact(message),
      ],
      wikiDir,
    );
    return true;
  } catch (err) {
    if (isMissingGit(err)) warnMissingGit();
    else process.stderr.write(`warn: could not commit wiki: ${(err as Error).message}\n`);
    return false;
  }
}
