import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect } from 'vitest';
import { initHome } from '../src/config.js';
import type { WaymarkPaths } from '../src/paths.js';
import type { WaymarkDoc } from '../src/store/doc.js';
import { listDocs } from '../src/store/markdown.js';
import { syncAll } from '../src/sync.js';

/** True when every named env var is set and non-empty. */
export const has = (...names: string[]): boolean => names.every((n) => !!process.env[n]);

/** `LIVE_CONNECTORS` is a comma list or `all`; unset means all. Used by the manual workflow. */
export function enabled(connector: string): boolean {
  const raw = (process.env.LIVE_CONNECTORS ?? 'all').trim();
  if (raw === '' || raw === 'all') return true;
  return raw.split(',').some((c) => c.trim() === connector);
}

/** Skip condition for a `describe.skipIf`: the connector is selected and its env vars are set. */
export const runnable = (connector: string, ...names: string[]): boolean =>
  enabled(connector) && has(...names);

/** Values of the named env vars that are set (secrets to look for in stored output). */
export const secretValues = (...names: string[]): string[] =>
  names.map((n) => process.env[n]).filter((v): v is string => !!v);

async function* walk(dir: string): AsyncGenerator<string> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.isFile()) yield p;
  }
}

/** Number of files under `dirs` that contain any secret. Counts only: never returns content. */
export async function countFilesWithSecrets(dirs: string[], secrets: string[]): Promise<number> {
  const needles = secrets.filter((s) => s !== '').map((s) => Buffer.from(s));
  if (needles.length === 0) return 0;
  let n = 0;
  for (const dir of dirs) {
    for await (const file of walk(dir)) {
      const data = await fs.readFile(file);
      if (needles.some((needle) => data.includes(needle))) n++;
    }
  }
  return n;
}

export const containsSecret = (text: string, secrets: string[]): boolean =>
  secrets.some((s) => s !== '' && text.includes(s));

export interface LiveRun {
  sourceId: string;
  first: { count: number; error?: string };
  second: { count: number; error?: string };
  docs: WaymarkDoc[];
  leakedFiles: number;
  leakedInStderr: boolean;
  warned: boolean; // stderr carried a `warn:` line
}

/**
 * Syncs one source twice into a temp WAYMARK_HOME and scans the output for `secrets`.
 * Read-only against the source. Always removes the temp dir.
 */
export async function liveSync(
  source: Record<string, unknown>,
  secrets: string[],
): Promise<LiveRun> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'waymark-'));
  const paths: WaymarkPaths = {
    home,
    config: path.join(home, 'config.json'),
    wiki: path.join(home, 'wiki'),
    db: path.join(home, 'db', 'waymark.db'),
  };
  const sourceId = String(source.id);
  const realWrite = process.stderr.write.bind(process.stderr);
  let stderr = '';
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += chunk.toString();
    return true;
  }) as typeof process.stderr.write;
  try {
    await initHome(paths);
    await fs.writeFile(paths.config, JSON.stringify({ version: 1, sources: [source] }));
    const run = async () => {
      const [r] = await syncAll(paths, { only: sourceId });
      if (!r) throw new Error('no sync result');
      return r;
    };
    const first = await run();
    const second = await run();
    const docs: WaymarkDoc[] = [];
    for await (const { doc } of listDocs(paths.wiki)) docs.push(doc);
    return {
      sourceId,
      first,
      second,
      docs,
      leakedFiles: await countFilesWithSecrets([home], secrets),
      leakedInStderr: containsSecret(stderr, secrets),
      warned: stderr.includes('] warn:'),
    };
  } finally {
    process.stderr.write = realWrite;
    await fs.rm(home, { recursive: true, force: true });
  }
}

/** Shared assertions for a live run. `host` matches the doc url hostname or a parent domain. */
export function checkRun(
  run: LiveRun,
  opts: { kind: WaymarkDoc['kind'] | WaymarkDoc['kind'][]; host: string[]; tagPrefix?: string },
): void {
  expect(run.first.error).toBe(undefined);
  expect(run.second.error).toBe(undefined);
  expect(run.first.count).toBeGreaterThan(0);
  expect(run.second.count).toBeLessThanOrEqual(run.first.count);
  expect(run.docs.length).toBeGreaterThan(0);
  for (const d of run.docs) {
    expect([opts.kind].flat().includes(d.kind)).toBe(true);
    expect(d.title.trim() !== '').toBe(true);
    const host = d.url ? new URL(d.url).hostname : '';
    expect(opts.host.some((h) => host === h || host.endsWith(`.${h}`))).toBe(true);
    if (opts.tagPrefix)
      expect(d.tags.some((t) => t.startsWith(opts.tagPrefix as string))).toBe(true);
  }
  expect(run.leakedFiles).toBe(0);
  expect(run.leakedInStderr).toBe(false);
  // counts only, never content
  console.log(
    `[live:${run.sourceId}] first=${run.first.count} second=${run.second.count} docs=${run.docs.length}`,
  );
}
