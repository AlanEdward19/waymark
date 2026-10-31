import path from 'node:path';
import type { RunGit } from '../git.js';
import { makeId, type WaymarkDoc } from '../store/doc.js';
import type { SyncContext } from './types.js';

export const DOC_GLOBS = ['*.md', 'docs/**/*.md', '**/adr/**/*.md', '**/decisions/**/*.md'];
const MAX_DOC_BYTES = 200 * 1024;

type Change = { op: 'emit' | 'remove'; path: string };

// `git diff --name-status -z`: "A\0path\0", "D\0path\0", "R100\0old\0new\0"
export function parseNameStatus(output: string): Change[] {
  const tokens = output.split('\0');
  const changes: Change[] = [];
  for (let i = 0; i + 1 < tokens.length; ) {
    const status = tokens[i] ?? '';
    if (status === '') break;
    if (status.startsWith('R') || status.startsWith('C')) {
      if (status.startsWith('R')) changes.push({ op: 'remove', path: tokens[i + 1] ?? '' });
      changes.push({ op: 'emit', path: tokens[i + 2] ?? '' });
      i += 3;
    } else {
      changes.push({ op: status.startsWith('D') ? 'remove' : 'emit', path: tokens[i + 1] ?? '' });
      i += 2;
    }
  }
  return changes;
}

export interface DocsOptions {
  sourceId: string;
  repo: string;
  head: string;
  incremental: boolean; // cursor is an ancestor of HEAD
  globs?: string[] | undefined;
  urlFor: (sha: string, path: string) => string | undefined;
}

export async function syncDocs(
  ctx: SyncContext,
  run: RunGit,
  o: DocsOptions,
): Promise<{ emitted: number; removed: number }> {
  const specs = (o.globs ?? DOC_GLOBS).map((g) => `:(glob)${g}`);
  const idOf = (p: string) => makeId(o.sourceId, 'doc', p);
  // quotePath=false keeps non-ASCII file names readable instead of octal-escaped
  const git = (args: string[]) => run(['-c', 'core.quotePath=false', ...args], o.repo);
  let emitted = 0;
  let removed = 0;

  const emitDoc = async (file: string): Promise<string | undefined> => {
    let body: string;
    try {
      body = await git(['show', `HEAD:${file}`]);
    } catch {
      return undefined; // in the index but not committed at HEAD
    }
    if (Buffer.byteLength(body) > MAX_DOC_BYTES) {
      ctx.log(`skipping ${file}: larger than ${MAX_DOC_BYTES / 1024} KB`);
      return undefined;
    }
    const lit = `:(literal)${file}`;
    const updated = (await git(['log', '-1', '--format=%cI', '--', lit])).trim();
    const added = (await git(['log', '--diff-filter=A', '--format=%aI', '--', lit]))
      .trim()
      .split('\n')
      .pop();
    const updatedAt = new Date(updated || Date.now()).toISOString();
    const createdAt = added ? new Date(added).toISOString() : updatedAt;
    const tags = [`path:${file}`];
    if (
      file
        .split('/')
        .slice(0, -1)
        .some((s) => s === 'adr' || s === 'decisions')
    )
      tags.push('adr');
    const url = o.urlFor(o.head, file);
    const doc: WaymarkDoc = {
      id: idOf(file),
      kind: 'doc',
      sourceId: o.sourceId,
      title: body.match(/^#\s+(.+)/m)?.[1]?.trim() || path.posix.basename(file),
      authors: [],
      createdAt,
      updatedAt,
      tags,
      body,
      ...(url === undefined ? {} : { url }),
    };
    await ctx.emit(doc);
    emitted++;
    return doc.id;
  };

  if (o.incremental && ctx.cursor !== null) {
    const out = await git(['diff', '--name-status', '-z', ctx.cursor, 'HEAD', '--', ...specs]);
    for (const c of parseNameStatus(out)) {
      if (c.op === 'emit') await emitDoc(c.path);
      else {
        await ctx.remove(idOf(c.path));
        removed++;
      }
    }
  } else {
    const files = (await git(['ls-files', '-z', '--', ...specs])).split('\0').filter(Boolean);
    const seen = new Set<string>();
    for (const f of files) {
      const id = await emitDoc(f);
      if (id) seen.add(id);
    }
    for (const id of ctx.listIds('doc')) {
      if (seen.has(id)) continue;
      await ctx.remove(id);
      removed++;
    }
  }
  return { emitted, removed };
}
