import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { docRelPath, makeId, parseId, type WaymarkDoc } from '../src/store/doc.js';
import { listDocs, parseDoc, readDoc, serializeDoc, writeDoc } from '../src/store/markdown.js';

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'waymark-'));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(dir, { recursive: true, force: true });
});

const doc = (over: Partial<WaymarkDoc> = {}): WaymarkDoc => ({
  id: 'waymark-gh/pull_request/42',
  kind: 'pull_request',
  sourceId: 'waymark-gh',
  title: 'Añadir búsqueda 検索: "FTS"',
  authors: ['alan'],
  createdAt: '2026-10-01T12:00:00.000Z',
  updatedAt: '2026-10-02T08:30:00.000Z',
  tags: [],
  body: 'line one\n---\nline: two\n\n---\nend',
  ...over,
});

describe('ids', () => {
  it('sanitises native ids and appends a hash of the original', () => {
    expect(makeId('agent', 'session', 'abc:def/ghi')).toMatch(
      /^agent\/session\/abc-def-ghi-[0-9a-f]{10}$/,
    );
    expect(() => makeId('a', 'note', '')).toThrow();
  });
  it('keeps already-safe ids unchanged', () => {
    const sha = 'a'.repeat(40);
    for (const n of [
      '123e4567-e89b-12d3-a456-426614174000',
      '42',
      sha,
      '20261030-120000-my-note',
    ]) {
      expect(makeId('a', 'note', n)).toBe(`a/note/${n}`);
    }
  });
  it('never collides distinct native ids', () => {
    expect(makeId('a', 'note', '!!!')).not.toBe(makeId('a', 'note', '???'));
    expect(makeId('a', 'note', 'docs/a-b.md')).not.toBe(makeId('a', 'note', 'docs-a/b.md'));
    expect(makeId('a', 'note', '!!!')).toMatch(/^a\/note\/[0-9a-f]{10}$/);
    const long1 = 'x'.repeat(300);
    const long2 = `${'x'.repeat(120)}${'y'.repeat(180)}`;
    const id1 = makeId('a', 'note', long1);
    expect(id1).toBe(makeId('a', 'note', long1));
    expect(id1.slice('a/note/'.length)).toHaveLength(120);
    expect(id1).not.toBe(makeId('a', 'note', long2));
  });
  it('round-trips through parseId', () => {
    for (const n of [
      '!!!',
      'docs/a-b.md',
      'x'.repeat(300),
      'abc:def/ghi',
      '42',
      'T:19@thread.tacv2',
    ]) {
      const id = makeId('a', 'note', n);
      expect(parseId(id)).toMatchObject({ sourceId: 'a', kind: 'note' });
      expect(makeId('a', 'note', parseId(id).nativeId)).toBe(id);
    }
  });
  it('rejects invalid ids', () => {
    for (const id of [
      'a\\b/issue/1',
      'a:b/issue/1',
      'a/b',
      'a/unknown/c',
      'a//c',
      '../issue/1',
      'a/issue/b/c',
    ]) {
      expect(() => parseId(id)).toThrow(`Invalid document id: ${id}`);
    }
    expect(docRelPath('a/issue/1')).toBe('a/issue/1.md');
  });
});

describe('serialize/parse', () => {
  it('round trips', () => {
    const d = doc();
    expect(parseDoc(serializeDoc(d))).toEqual(d);
    const withUrl = doc({ url: 'https://example.com/x', authors: ['a', 'b'], tags: ['t'] });
    expect(parseDoc(serializeDoc(withUrl))).toEqual(withUrl);
  });
  it('matches the documented format', () => {
    const text = serializeDoc(
      doc({ url: 'https://x.test/1', title: 'Add FTS search', body: 'hi' }),
    );
    expect(text).toBe(
      '---\nid: waymark-gh/pull_request/42\nkind: pull_request\nsourceId: waymark-gh\n' +
        'title: Add FTS search\nurl: https://x.test/1\nauthors:\n  - alan\n' +
        'createdAt: 2026-10-01T12:00:00.000Z\nupdatedAt: 2026-10-02T08:30:00.000Z\ntags: []\n---\n\nhi\n',
    );
  });
  it('accepts CRLF and rejects bad input', () => {
    expect(parseDoc(serializeDoc(doc()).replace(/\n/g, '\r\n'))).toEqual(doc());
    expect(() => parseDoc('no frontmatter')).toThrow(/^Invalid document: /);
    expect(() => parseDoc('---\nid: a\n')).toThrow(/^Invalid document: /);
    expect(() => parseDoc(serializeDoc(doc()).replace('kind: pull_request', 'kind: x'))).toThrow(
      /Invalid document: /,
    );
  });
});

describe('store', () => {
  it('redacts, is idempotent, leaves no tmp files, uses LF', async () => {
    const token = `ghp_${'a'.repeat(36)}`;
    const r = await writeDoc(dir, doc({ body: `token ${token}`, title: `t ${token}` }));
    expect(r.changed).toBe(true);
    const raw = await fs.readFile(r.path, 'utf8');
    expect(raw).toContain('[REDACTED:github-token]');
    expect(raw).not.toContain(token);
    expect(raw).not.toContain('\r');
    const before = (await fs.stat(r.path)).mtimeMs;
    const again = await writeDoc(dir, doc({ body: `token ${token}`, title: `t ${token}` }));
    expect(again.changed).toBe(false);
    expect((await fs.stat(r.path)).mtimeMs).toBe(before);
    const names = await fs.readdir(path.dirname(r.path));
    expect(names.filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });

  it('leaves no tmp file when write fails', async () => {
    await fs.mkdir(path.join(dir, 'waymark-gh', 'pull_request', '42.md'), { recursive: true });
    await expect(writeDoc(dir, doc())).rejects.toThrow();
    const names = await fs.readdir(path.join(dir, 'waymark-gh', 'pull_request'));
    expect(names).toEqual(['42.md']);
  });

  it('readDoc returns null when missing', async () => {
    expect(await readDoc(dir, 'a/note/1')).toBeNull();
    await writeDoc(dir, doc());
    expect((await readDoc(dir, doc().id))?.title).toBe(doc().title);
  });

  it('listDocs skips .git and malformed files, sorted', async () => {
    await writeDoc(dir, doc({ id: 'b/note/2', kind: 'note', sourceId: 'b' }));
    await writeDoc(dir, doc({ id: 'a/note/1', kind: 'note', sourceId: 'a' }));
    await fs.mkdir(path.join(dir, '.git'));
    await fs.writeFile(path.join(dir, '.git', 'x.md'), 'junk');
    await fs.mkdir(path.join(dir, 'c'));
    await fs.writeFile(path.join(dir, 'c', 'bad.md'), 'junk');
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const ids: string[] = [];
    for await (const { doc: d } of listDocs(dir)) ids.push(d.id);
    expect(ids).toEqual(['a/note/1', 'b/note/2']);
    expect(err).toHaveBeenCalledOnce();
    expect(String(err.mock.calls[0]?.[0])).toMatch(/^warn: skipping .*bad\.md: /);
  });

  it('listDocs on missing dir yields nothing', async () => {
    const out = [];
    for await (const x of listDocs(path.join(dir, 'nope'))) out.push(x);
    expect(out).toEqual([]);
  });
});
