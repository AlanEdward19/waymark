import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deleteDoc, openDb, reindex, upsertDoc } from '../src/index/db.js';
import { formatDocumentFlags, getDocumentFlags } from '../src/memory/supersession.js';
import { docRelPath, makeId, type WaymarkDoc } from '../src/store/doc.js';
import { writeDoc } from '../src/store/markdown.js';

let dir: string;
let db: ReturnType<typeof openDb>;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'waymark-'));
  db = openDb(path.join(dir, 'db', 'w.db'));
});
afterEach(async () => {
  if (db.open) db.close();
  await fs.rm(dir, { recursive: true, force: true });
});
const doc = (over: Partial<WaymarkDoc> = {}): WaymarkDoc => ({
  id: 'src/note/1',
  kind: 'note',
  sourceId: 'src',
  title: 'Synthetic',
  authors: [],
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  tags: [],
  body: '',
  ...over,
});
const adr = (file: string, body = 'Status: Accepted', sourceId = 'src') =>
  doc({
    id: makeId(sourceId, 'doc', file),
    sourceId,
    kind: 'doc',
    tags: ['adr', `path:${file}`],
    body,
  });
const put = (d: WaymarkDoc) => upsertDoc(db, d, docRelPath(d.id));

describe('supersession index', () => {
  it('resolves relative ADR links and numbers, regardless of arrival order and source', () => {
    const old = adr('docs/adr/0001-old.md', '- Status: Superseded by [ADR-0004](0004-x.md)');
    const winner = adr('docs/adr/0004-x.md');
    put(old);
    expect(getDocumentFlags(db, old.id)).toEqual([{ flag: 'superseded' }]);
    put(adr('docs/adr/0004-x.md', 'Status: Accepted', 'other'));
    expect(getDocumentFlags(db, old.id)).toEqual([{ flag: 'superseded' }]);
    put(winner);
    expect(getDocumentFlags(db, old.id)).toEqual([{ flag: 'superseded', by: winner.id }]);
    put({ ...old, body: '**sTaTuS:** Superseded by ADR-4' });
    expect(getDocumentFlags(db, old.id)).toEqual([{ flag: 'superseded', by: winner.id }]);
    deleteDoc(db, winner.id);
    expect(getDocumentFlags(db, old.id)).toEqual([{ flag: 'superseded' }]);
    put(winner);
    expect(getDocumentFlags(db, old.id)).toEqual([{ flag: 'superseded', by: winner.id }]);
  });

  it('matches a relative link without an ADR number and prefers its exact path', () => {
    const winner = adr('decisions/new.md');
    const old = adr('decisions/archive/old.md', 'Status: **Superseded** by [new](../new.md)');
    put(winner);
    put(old);
    expect(getDocumentFlags(db, old.id)).toEqual([{ flag: 'superseded', by: winner.id }]);
  });

  it('handles deprecated/rejected, multiple statuses, accepted, self references and non-ADRs', () => {
    const d = adr('docs/adr/0001-old.md', 'Status: **Deprecated**\n- **Status:** Rejected');
    put(d);
    expect(getDocumentFlags(db, d.id)).toEqual([{ flag: 'deprecated' }]);
    put({ ...d, body: 'Status: Superseded by ADR-0001' });
    expect(getDocumentFlags(db, d.id)).toEqual([]);
    put({ ...d, body: 'Status: Accepted' });
    expect(getDocumentFlags(db, d.id)).toEqual([]);
    put({ ...d, tags: [], body: 'Status: Deprecated' });
    expect(getDocumentFlags(db, d.id)).toEqual([]);
  });

  it('stores absent reverted targets and removes outgoing signals on update/delete', () => {
    const target = doc({ id: makeId('src', 'commit', 'a'.repeat(40)), kind: 'commit' });
    const revert = doc({
      id: makeId('src', 'commit', 'b'.repeat(40)),
      kind: 'commit',
      body: `Revert\n\nThis reverts commit ${'a'.repeat(40)}.`,
    });
    put(revert);
    const flags = [{ flag: 'reverted', by: revert.id }];
    expect(getDocumentFlags(db, target.id)).toEqual(flags);
    put(target);
    expect(getDocumentFlags(db, target.id)).toEqual(flags);
    put({ ...revert, body: 'No longer a revert' });
    expect(getDocumentFlags(db, target.id)).toEqual([]);
    put(revert);
    deleteDoc(db, revert.id);
    expect(getDocumentFlags(db, target.id)).toEqual([]);
  });

  it('retains several incoming flags on target updates and removes note edges independently', () => {
    const target = doc();
    const n = doc({ id: 'src/note/2', tags: [`supersedes:${target.id}`, 'supersedes:src/note/2'] });
    const other = doc({ id: 'src/note/3', tags: [`supersedes:${target.id}`] });
    put(target);
    put(n);
    put(other);
    put(target);
    expect(getDocumentFlags(db, target.id)).toHaveLength(2);
    expect(getDocumentFlags(db, n.id)).toEqual([]);
    put({ ...n, tags: [] });
    expect(getDocumentFlags(db, target.id)).toEqual([{ flag: 'superseded', by: other.id }]);
    deleteDoc(db, other.id);
    expect(getDocumentFlags(db, target.id)).toEqual([]);
    for (const tag of ['state:not_planned', 'state:duplicate']) {
      put(doc({ kind: 'issue', tags: [tag] }));
      expect(getDocumentFlags(db, target.id)).toEqual([{ flag: 'not_planned' }]);
    }
  });

  it('keeps different flags on one document and ignores malformed or self reverts', () => {
    const issue = doc({ id: 'src/issue/1', kind: 'issue', tags: ['state:not_planned'] });
    const replacement = doc({ id: 'src/note/2', tags: [`supersedes:${issue.id}`] });
    put(issue);
    put(replacement);
    put(issue);
    expect(getDocumentFlags(db, issue.id)).toEqual([
      { flag: 'not_planned' },
      { flag: 'superseded', by: replacement.id },
    ]);
    const self = doc({
      id: makeId('src', 'commit', 'a'.repeat(40)),
      kind: 'commit',
      body: `This reverts commit ${'a'.repeat(40)}.\nThis reverts commit abc.`,
    });
    put(self);
    expect(getDocumentFlags(db, self.id)).toEqual([]);
    expect(getDocumentFlags(db, 'src/commit/abc')).toEqual([]);
  });

  it('rebuilds identical flags after deleting db/, without changing wiki files', async () => {
    const old = adr('docs/adr/0001-old.md', '- Status: Superseded by [ADR-0004](0004-x.md)');
    const docs = [
      old,
      adr('docs/adr/0004-x.md'),
      doc(),
      doc({ id: 'src/note/2', tags: ['supersedes:src/note/1'] }),
    ];
    const wiki = path.join(dir, 'wiki');
    for (const d of docs) {
      await writeDoc(wiki, d);
      put(d);
    }
    const flags = () => docs.map((d) => getDocumentFlags(db, d.id));
    const before = flags();
    const file = path.join(wiki, ...docRelPath(old.id).split('/'));
    const contents = await fs.readFile(file, 'utf8');
    db.close();
    await fs.rm(path.join(dir, 'db'), { recursive: true });
    db = openDb(path.join(dir, 'db', 'w.db'));
    await reindex(db, wiki);
    expect(flags()).toEqual(before);
    expect(await fs.readFile(file, 'utf8')).toBe(contents);
  });

  it('migrates v3 documents from indexed bodies and preserves path facts and cursor', () => {
    const d = adr('docs/adr/0001-old.md', 'Status: Deprecated');
    put(d);
    db.exec(
      "INSERT INTO source_state VALUES ('src', 'cursor', '2026-10-01T00:00:00.000Z'); DROP TABLE doc_flags;",
    );
    db.pragma('user_version = 3');
    db.close();
    db = openDb(path.join(dir, 'db', 'w.db'));
    expect(db.pragma('user_version', { simple: true })).toBe(4);
    expect(getDocumentFlags(db, d.id)).toEqual([{ flag: 'deprecated' }]);
    expect(db.prepare('SELECT cursor FROM source_state').get()).toEqual({ cursor: 'cursor' });
    expect(db.prepare('SELECT count(*) AS n FROM path_facts').get()).toEqual({ n: 1 });
  });

  it('formats all visible warnings', () => {
    expect(
      formatDocumentFlags([
        { flag: 'superseded', by: 'src/note/2' },
        { flag: 'reverted', by: 'src/commit/2' },
        { flag: 'deprecated' },
        { flag: 'not_planned' },
      ]),
    ).toBe(
      '> Note: superseded by src/note/2\n> Note: reverted by src/commit/2\n> Note: marked deprecated\n> Note: closed as not planned',
    );
  });
});
