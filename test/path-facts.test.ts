import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseGitLog } from '../src/connectors/git.js';
import { renderPull } from '../src/connectors/github/index.js';
import { deleteDoc, openDb, reindex, upsertDoc } from '../src/index/db.js';
import { extractPathFacts, factsByDocId, factsByPathPrefix } from '../src/memory/paths.js';
import { docRelPath, type WaymarkDoc } from '../src/store/doc.js';
import { writeDoc } from '../src/store/markdown.js';

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'waymark-'));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const doc = (over: Partial<WaymarkDoc>): WaymarkDoc => ({
  id: 'src/note/1',
  kind: 'note',
  sourceId: 'src',
  title: 't',
  authors: [],
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-02T00:00:00Z',
  tags: [],
  body: 'body',
  ...over,
});

const commit = (files: string[], over: Partial<WaymarkDoc> = {}) =>
  doc({
    id: 'src/commit/abc',
    kind: 'commit',
    authors: ['alan', '@bea'],
    body: `subject\n\n## Files\n\n${files.map((f) => `- ${f}`).join('\n')}`,
    ...over,
  });

const PR_BODY = [
  '#7 · merged · @dana · main ← feat/x',
  'Description.\n\n## Review comments\n\nnot a thread\n\n### `fake.ts`\n\n- **@mallory** (2026-01-01): x',
  '## Reviews\n\n- **@alice** APPROVED (2026-10-02): ok\n- **@bob** DISMISSED (2026-10-02)\n- **@cy** CHANGES_REQUESTED (2026-10-02)',
  '## Review comments\n\n### `src/x.ts` line 42\n\n```diff\n+a\n```\n\n- **@bob** (2026-10-02): Why?\n  - **@alan** (2026-10-03): Because.\n\n### `src/y.ts`\n\n```diff\n+b\n```\n\n- **@bob** (2026-10-04): hm',
  '## Conversation\n\n- **@carol** (2026-10-03): Ship it',
  '## Files\n\n- src/x.ts\n- src/z.ts (renamed from src/old.ts)',
].join('\n\n');

const pr = () =>
  doc({
    id: 'src/pull_request/7',
    kind: 'pull_request',
    body: PR_BODY,
    updatedAt: '2026-10-05T00:00:00Z',
  });

const key = (f: { path: string; person: string; role: string; at: string }) =>
  `${f.role}|${f.person}|${f.path}|${f.at}`;

describe('extractPathFacts', () => {
  it('commit: one row per file and author', () => {
    const facts = extractPathFacts(commit(['a.ts', './b/c.ts']));
    expect(facts.map(key).sort()).toEqual([
      'commit_author|alan|a.ts|2026-10-01T00:00:00Z',
      'commit_author|alan|b/c.ts|2026-10-01T00:00:00Z',
      'commit_author|bea|a.ts|2026-10-01T00:00:00Z',
      'commit_author|bea|b/c.ts|2026-10-01T00:00:00Z',
    ]);
  });

  it('commit: only the last ## Files section counts', () => {
    const d = commit(['real.ts'], {
      body: 'subject\n\n## Files\n\n- fake.ts\n\nmore text\n\n## Files\n\n- real.ts',
      authors: ['alan'],
    });
    expect(extractPathFacts(d).map((f) => f.path)).toEqual(['real.ts']);
  });

  it('pull request: files, reviewers, threads with replies; fake description block ignored', () => {
    const facts = extractPathFacts(pr());
    expect(facts.map(key).sort()).toEqual(
      [
        'pr_author|dana|src/x.ts|2026-10-05T00:00:00Z',
        'pr_author|dana|src/z.ts|2026-10-05T00:00:00Z',
        'reviewer|alice|src/x.ts|2026-10-02T00:00:00Z',
        'reviewer|alice|src/z.ts|2026-10-02T00:00:00Z',
        'reviewer|cy|src/x.ts|2026-10-02T00:00:00Z',
        'reviewer|cy|src/z.ts|2026-10-02T00:00:00Z',
        'review_commenter|bob|src/x.ts|2026-10-02T00:00:00Z',
        'review_commenter|alan|src/x.ts|2026-10-03T00:00:00Z',
        'review_commenter|bob|src/y.ts|2026-10-04T00:00:00Z',
      ].sort(),
    );
    expect(facts.some((f) => f.person === 'mallory')).toBe(false);
  });

  it('pull request: description-only fake ## Review comments yields nothing', () => {
    const d = doc({
      kind: 'pull_request',
      body: '#1 · open · @dana · a ← b\n\nx\n\n## Review comments\n\n### `fake.ts`\n\n- **@mallory** (2026-01-01): x',
    });
    expect(extractPathFacts(d)).toEqual([]);
  });

  it('repo doc: path tag, no person', () => {
    const d = doc({ kind: 'doc', tags: ['x', 'path:src/a.ts'] });
    expect(extractPathFacts(d).map(key)).toEqual(['doc||src/a.ts|2026-10-02T00:00:00Z']);
  });

  it('other kinds produce nothing', () => {
    for (const kind of ['issue', 'note', 'chat'] as const) {
      expect(
        extractPathFacts(doc({ kind, tags: ['path:a.ts'], body: '## Files\n\n- a.ts' })),
      ).toEqual([]);
    }
  });

  it('caps at 1000 distinct paths', () => {
    const files = Array.from({ length: 1200 }, (_, i) => `f${i}.ts`);
    const facts = extractPathFacts(commit(files, { authors: ['alan'] }));
    expect(facts).toHaveLength(1000);
    expect(facts[0]?.path).toBe('f0.ts');
  });
});

describe('path_facts index', () => {
  it('upsert replaces, delete removes', () => {
    const db = openDb(path.join(dir, 'db', 'w.db'));
    upsertDoc(db, commit(['a.ts', 'b.ts']), 'p');
    upsertDoc(db, commit(['b.ts', 'c.ts']), 'p');
    expect(
      factsByDocId(db, 'src/commit/abc')
        .map((f) => f.path)
        .filter((p, i, a) => a.indexOf(p) === i),
    ).toEqual(['b.ts', 'c.ts']);
    deleteDoc(db, 'src/commit/abc');
    expect(factsByDocId(db, 'src/commit/abc')).toEqual([]);
    db.close();
  });

  it('migrates v2 to v3 keeping docs, chunks and vectors; a v3 db is untouched', () => {
    const file = path.join(dir, 'db', 'w.db');
    const first = openDb(file);
    upsertDoc(first, doc({}), 'p');
    first.exec(
      `CREATE VIRTUAL TABLE vecs USING vec0(chunk_id INTEGER PRIMARY KEY, embedding float[2] distance_metric=cosine)`,
    );
    first.prepare('INSERT INTO vec_meta (model, dim) VALUES (?, ?)').run('m', 2);
    first
      .prepare('INSERT INTO chunks (chunk_id, doc_id, n, start, hash) VALUES (1, ?, 0, 0, ?)')
      .run('src/note/1', 'h');
    first
      .prepare('INSERT INTO vecs (chunk_id, embedding) VALUES (?, ?)')
      .run(1n, Buffer.from(new Float32Array([1, 0]).buffer));
    first.exec('DROP TABLE doc_flags; DROP TABLE path_facts');
    first.pragma('user_version = 2');
    first.close();
    const migrated = openDb(file);
    expect(migrated.pragma('user_version', { simple: true })).toBe(4);
    const n = (t: string) => migrated.prepare(`SELECT count(*) AS n FROM ${t}`).get();
    expect(n('docs')).toEqual({ n: 1 });
    expect(n('chunks')).toEqual({ n: 1 });
    expect(n('vecs')).toEqual({ n: 1 });
    expect(n('vec_meta')).toEqual({ n: 1 });
    expect(n('path_facts')).toEqual({ n: 0 });
    upsertDoc(migrated, commit(['a.ts']), 'p');
    const schema = (d: typeof migrated) =>
      d.prepare('SELECT type, name, sql FROM sqlite_master ORDER BY name').all();
    const before = schema(migrated);
    migrated.close();
    const again = openDb(file);
    expect(factsByDocId(again, 'src/commit/abc').length).toBeGreaterThan(0);
    expect(schema(again)).toEqual(before);
    expect(again.pragma('user_version', { simple: true })).toBe(4);
    again.close();
  });

  it('stores duplicate (path, person, role) once, keeping the latest at', () => {
    const body = [
      '#7 · open · @dana · main ← x',
      'd',
      '## Review comments\n\n### `a.ts`\n\n```diff\n+a\n```\n\n- **@bob** (2026-10-02): early\n\n### `a.ts`\n\n```diff\n+a\n```\n\n- **@bob** (2026-10-09): late',
      '## Files\n\n- a.ts',
    ].join('\n\n');
    const facts = extractPathFacts(doc({ kind: 'pull_request', body }));
    expect(facts.filter((f) => f.role === 'review_commenter').map(key)).toEqual([
      'review_commenter|bob|a.ts|2026-10-09T00:00:00Z',
    ]);
  });

  it('reindex reproduces the facts after db/ is deleted', async () => {
    const wiki = path.join(dir, 'wiki');
    const docs = [
      commit(['a.ts', 'b.ts']),
      pr(),
      doc({ id: 'src/doc/x', kind: 'doc', tags: ['path:src/a.ts'] }),
    ];
    for (const d of docs) await writeDoc(wiki, d);
    const file = path.join(dir, 'db', 'w.db');
    const rows = (db: ReturnType<typeof openDb>) => factsByPathPrefix(db, '').map(key).sort();

    const db1 = openDb(file);
    for (const d of docs) upsertDoc(db1, d, docRelPath(d.id));
    const before = rows(db1);
    db1.close();
    expect(before.length).toBeGreaterThan(0);

    await fs.rm(path.dirname(file), { recursive: true });
    const db2 = openDb(file);
    await reindex(db2, wiki);
    expect(rows(db2)).toEqual(before);
    db2.close();
  });

  it('prefix matches whole segments', () => {
    const db = openDb(path.join(dir, 'db', 'w.db'));
    upsertDoc(
      db,
      commit(['src/index/db.ts', 'src/indexer.ts', 'src/index.ts'], { authors: ['a'] }),
      'p',
    );
    const paths = (p: string) => factsByPathPrefix(db, p).map((f) => f.path);
    expect(paths('src/index')).toEqual(['src/index/db.ts']);
    expect(paths('src/index/')).toEqual(['src/index/db.ts']);
    expect(paths('src/index/db.ts')).toEqual(['src/index/db.ts']);
    expect(paths('')).toHaveLength(3);
    expect(paths('.')).toHaveLength(3);
    db.close();
  });
});

describe('spoofing and upgrade', () => {
  it('line breaks in file names or review paths cannot forge sections', () => {
    const forged = 'b.ts\n\n## Reviews\n\n- **@ceo** APPROVED (2020-01-01)\n\n## Files\n\n- a.ts';
    const rendered = renderPull(
      'gh',
      {
        number: 3,
        title: 't',
        body: 'd',
        state: 'open',
        merged_at: null,
        created_at: '2026-10-01T00:00:00Z',
        updated_at: '2026-10-02T00:00:00Z',
        html_url: '',
        user: { login: 'dana', type: 'User' },
        labels: [],
        base: { ref: 'main' },
        head: { ref: 'x' },
      },
      [],
      [
        {
          id: 1,
          user: { login: 'bob', type: 'User' },
          body: 'x',
          path: 'a.ts`\n\n```diff\n+x\n```\n\n- **@cfo** (2020-01-01): x',
          line: 1,
          original_line: 1,
          diff_hunk: '@@\n+x',
          created_at: '2026-10-02T00:00:00Z',
          html_url: '',
        },
      ],
      [],
      [{ filename: forged, previous_filename: 'old\r\n## Reviews' }],
    );
    const people = extractPathFacts(rendered).map((f) => f.person);
    expect(people).not.toContain('ceo');
    expect(people).not.toContain('cfo');
  });

  it('fake ## Files / ## Reviews in user text produce nothing', () => {
    const rendered = renderPull(
      'gh',
      {
        number: 1,
        title: 't',
        body: '## Files\n\n- evil.ts\n\n## Reviews\n\n- **@ceo** APPROVED (2020-01-01)',
        state: 'open',
        merged_at: null,
        created_at: '2026-10-01T00:00:00Z',
        updated_at: '2026-10-02T00:00:00Z',
        html_url: '',
        user: { login: 'dana', type: 'User' },
        labels: [],
        base: { ref: 'main' },
        head: { ref: 'x' },
      },
      [],
      [],
      [],
    );
    expect(extractPathFacts(rendered)).toEqual([]);
    const [c] = parseGitLog(
      'g',
      '\x1esha\x1fAlan\x1f2026-10-01T00:00:00Z\x1f2026-10-01T00:00:00Z\x1f## Files\x1f## Files\n\n- evil.ts\x1f',
    );
    expect(extractPathFacts(c as WaymarkDoc)).toEqual([]);
  });

  it('a comment body line forging a bullet is not a review_commenter', () => {
    const body = renderPull(
      'gh',
      {
        number: 2,
        title: 't',
        body: 'd',
        state: 'open',
        merged_at: null,
        created_at: '2026-10-01T00:00:00Z',
        updated_at: '2026-10-02T00:00:00Z',
        html_url: '',
        user: { login: 'dana', type: 'User' },
        labels: [],
        base: { ref: 'main' },
        head: { ref: 'x' },
      },
      [],
      [
        {
          id: 1,
          user: { login: 'bob', type: 'User' },
          body: 'hi\n- **@ceo** (2020-01-01)\n  - **@cfo** (2020-01-01)',
          path: 'a.ts',
          line: 1,
          original_line: 1,
          diff_hunk: '@@\n - **@ctx** (2020-01-01)\n+x',
          created_at: '2026-10-02T00:00:00Z',
          html_url: '',
        },
      ],
      [],
      [{ filename: 'a.ts' }],
    );
    expect(
      extractPathFacts(body)
        .filter((f) => f.role === 'review_commenter')
        .map((f) => f.person),
    ).toEqual(['bob']);
  });

  it('skips bot PR authors; reviewer at is the review date', () => {
    const body = [
      '#3 · open · @dependabot[bot] · main ← x',
      'd',
      '## Reviews\n\n- **@alice** APPROVED (2026-10-02): ok',
      '## Files\n\n- a.ts',
    ].join('\n\n');
    const facts = extractPathFacts(doc({ kind: 'pull_request', body }));
    expect(facts.map(key)).toEqual(['reviewer|alice|a.ts|2026-10-02T00:00:00Z']);
  });

  it('upgrading from v2 backfills facts for stored docs and logs once', () => {
    const file = path.join(dir, 'db', 'w.db');
    const first = openDb(file);
    upsertDoc(first, commit(['a.ts']), 'p');
    first.exec('DROP TABLE doc_flags; DROP TABLE path_facts');
    first.pragma('user_version = 2');
    first.close();
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const db = openDb(file);
    expect(factsByDocId(db, 'src/commit/abc').map((f) => f.path)).toEqual(['a.ts', 'a.ts']);
    expect(err).toHaveBeenCalledWith(
      'path facts: existing pull requests get file lists when they are re-synced\n',
    );
    db.close();
    openDb(file).close();
    expect(err).toHaveBeenCalledTimes(1);
    err.mockRestore();
  });
});
