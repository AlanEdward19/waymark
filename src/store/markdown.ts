import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import { redact } from '../redact.js';
import { docRelPath, isDocKind, parseId, type WaymarkDoc } from './doc.js';

export function serializeDoc(doc: WaymarkDoc): string {
  const front: Record<string, unknown> = {
    id: doc.id,
    kind: doc.kind,
    sourceId: doc.sourceId,
    title: doc.title,
  };
  if (doc.url !== undefined) front.url = doc.url;
  front.authors = doc.authors;
  front.createdAt = doc.createdAt;
  front.updatedAt = doc.updatedAt;
  front.tags = doc.tags;
  const yaml = YAML.stringify(front, { lineWidth: 0 });
  const body = doc.body.replace(/\r\n?/g, '\n').replace(/\n+$/, '');
  return `---\n${yaml}---\n\n${body}\n`;
}

function fail(reason: string): never {
  throw new Error(`Invalid document: ${reason}`);
}

function str(v: Record<string, unknown>, key: string): string {
  const val = v[key];
  if (typeof val !== 'string') fail(`field "${key}" must be a string`);
  return val;
}

function strList(v: Record<string, unknown>, key: string): string[] {
  const val = v[key];
  if (!Array.isArray(val) || val.some((x) => typeof x !== 'string')) {
    fail(`field "${key}" must be a list of strings`);
  }
  return val as string[];
}

export function parseDoc(text: string): WaymarkDoc {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (lines[0] !== '---') fail('missing frontmatter');
  const end = lines.indexOf('---', 1);
  if (end === -1) fail('unterminated frontmatter');
  let front: unknown;
  try {
    front = YAML.parse(lines.slice(1, end).join('\n'));
  } catch (err) {
    fail(`bad frontmatter YAML: ${(err as Error).message}`);
  }
  if (typeof front !== 'object' || front === null || Array.isArray(front)) {
    fail('frontmatter must be a mapping');
  }
  const f = front as Record<string, unknown>;
  const kind = f.kind;
  if (!isDocKind(kind)) fail(`unknown kind "${String(kind)}"`);
  const rest = lines.slice(end + 1);
  if (rest[0] === '') rest.shift();
  const body = rest.join('\n').replace(/\n$/, '');
  const doc: WaymarkDoc = {
    id: str(f, 'id'),
    kind,
    sourceId: str(f, 'sourceId'),
    title: str(f, 'title'),
    authors: strList(f, 'authors'),
    createdAt: str(f, 'createdAt'),
    updatedAt: str(f, 'updatedAt'),
    tags: strList(f, 'tags'),
    body,
  };
  if (f.url !== undefined) doc.url = str(f, 'url');
  try {
    parseId(doc.id);
  } catch {
    fail(`invalid id "${doc.id}"`);
  }
  return doc;
}

/**
 * Redacts and writes a doc. Returns the doc exactly as stored on disk: callers must index
 * `doc` from the result, never their raw input.
 */
export async function writeDoc(
  wikiDir: string,
  doc: WaymarkDoc,
): Promise<{ path: string; changed: boolean; doc: WaymarkDoc }> {
  const target = path.join(wikiDir, ...docRelPath(doc.id).split('/'));
  const text = serializeDoc({
    ...doc,
    title: redact(doc.title),
    body: redact(doc.body),
    tags: doc.tags.map(redact),
  });
  const stored = parseDoc(text);
  // unreadable target (missing, or a directory) falls through to the write path
  const existing = await fs.readFile(target, 'utf8').catch(() => null);
  if (existing === text) return { path: target, changed: false, doc: stored };
  await fs.mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    await fs.writeFile(tmp, text, 'utf8');
    await fs.rename(tmp, target);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
  return { path: target, changed: true, doc: stored };
}

export async function readDoc(wikiDir: string, id: string): Promise<WaymarkDoc | null> {
  const file = path.join(wikiDir, ...docRelPath(id).split('/'));
  try {
    return parseDoc(await fs.readFile(file, 'utf8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export async function* listDocs(
  wikiDir: string,
): AsyncGenerator<{ path: string; doc: WaymarkDoc }> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(wikiDir, { recursive: true, withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  const files = entries
    .filter((e) => e.isFile() && e.name.endsWith('.md'))
    .map((e) => path.join(e.parentPath, e.name))
    .filter(
      (p) =>
        !path
          .relative(wikiDir, p)
          .split(path.sep)
          .slice(0, -1)
          .some((s) => s.startsWith('.')),
    )
    .sort((a, b) => {
      const ra = path.relative(wikiDir, a).split(path.sep).join('/');
      const rb = path.relative(wikiDir, b).split(path.sep).join('/');
      return ra < rb ? -1 : ra > rb ? 1 : 0;
    });
  for (const file of files) {
    try {
      const doc = parseDoc(await fs.readFile(file, 'utf8'));
      // a copied or moved file would otherwise shadow the real one in the index
      const rel = path.relative(wikiDir, file).split(path.sep).join('/');
      if (rel !== docRelPath(doc.id)) throw new Error(`file path does not match id "${doc.id}"`);
      yield { path: file, doc };
    } catch (err) {
      console.error(`warn: skipping ${file}: ${(err as Error).message}`);
    }
  }
}
