import type { Db } from '../index/db.js';
import type { WaymarkDoc } from '../store/doc.js';

export type PathRole = 'commit_author' | 'pr_author' | 'reviewer' | 'review_commenter' | 'doc';

export interface PathFact {
  docId: string;
  sourceId: string;
  path: string;
  person: string;
  role: PathRole;
  at: string;
}

const MAX_PATHS = 1000;

/** Lines of the LAST `## <heading>` section: user text can contain the same heading earlier. */
function lastSection(body: string, heading: string): string[] {
  const lines = body.split('\n');
  const start = lines.findLastIndex((l) => l.trimEnd() === `## ${heading}`);
  if (start < 0) return [];
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith('## '));
  return end < 0 ? rest : rest.slice(0, end);
}

/** Repo-relative, `/` separators, no leading `./` or `/`. */
function normalizePath(raw: string): string {
  return raw
    .trim()
    .replace(/\\/g, '/')
    .replace(/^(\.?\/)+/, '');
}

const stripAt = (s: string) => (s.startsWith('@') ? s.slice(1) : s);

function fileBullets(body: string): string[] {
  return lastSection(body, 'Files').flatMap((l) => {
    const m = /^- (.+?)(?: \(renamed from .+\))?$/.exec(l.trimEnd());
    return m?.[1] ? [m[1]] : [];
  });
}

/** One fact per (path, person, role), latest `at` wins; keeps the first 1000 distinct paths. */
class Facts {
  private rows = new Map<string, PathFact>();
  private paths = new Set<string>();
  constructor(private doc: WaymarkDoc) {}

  add(rawPath: string, rawPerson: string, role: PathRole, at: string): void {
    const path = normalizePath(rawPath);
    if (path === '') return;
    if (!this.paths.has(path)) {
      if (this.paths.size >= MAX_PATHS) return;
      this.paths.add(path);
    }
    const person = stripAt(rawPerson.trim());
    const key = `${path}\0${person}\0${role}`;
    const prev = this.rows.get(key);
    if (prev && prev.at >= at) return;
    this.rows.set(key, {
      docId: this.doc.id,
      sourceId: this.doc.sourceId,
      path,
      person,
      role,
      at,
    });
  }

  list(): PathFact[] {
    return [...this.rows.values()];
  }
}

function pullFacts(doc: WaymarkDoc, out: Facts): void {
  const author = /^#\d+ · [^·]*· @([^\s·]+) ·/.exec(doc.body.split('\n')[0] ?? '')?.[1] ?? '';
  const reviewers = new Set<string>();
  for (const l of lastSection(doc.body, 'Reviews')) {
    const m = /^- \*\*@([^*]+)\*\* (APPROVED|CHANGES_REQUESTED|COMMENTED)\b/.exec(l);
    if (m?.[1]) reviewers.add(m[1]);
  }
  for (const file of fileBullets(doc.body)) {
    out.add(file, author, 'pr_author', doc.updatedAt);
    for (const r of reviewers) out.add(file, r, 'reviewer', doc.updatedAt);
  }

  // a generated thread heading is followed by its diff fence; text that merely mimics the
  // section heading (a PR description) has no such fence
  const lines = lastSection(doc.body, 'Review comments');
  let current: string | null = null;
  lines.forEach((l, i) => {
    const h = /^### `(.+?)`(?: line \d+)?$/.exec(l);
    if (h?.[1]) {
      current = lines[i + 2]?.startsWith('```diff') ? h[1] : null;
      return;
    }
    const m = /^\s*- \*\*@([^*]+)\*\* \((\d{4}-\d{2}-\d{2})\)/.exec(l);
    if (current && m?.[1] && m[2]) out.add(current, m[1], 'review_commenter', `${m[2]}T00:00:00Z`);
  });
}

/** Pure: which repository paths a document is about, and who touched them in which role. */
export function extractPathFacts(doc: WaymarkDoc): PathFact[] {
  const out = new Facts(doc);
  if (doc.kind === 'commit') {
    const people = doc.authors.length > 0 ? doc.authors : [''];
    for (const file of fileBullets(doc.body)) {
      for (const p of people) out.add(file, p, 'commit_author', doc.createdAt);
    }
  } else if (doc.kind === 'pull_request') {
    pullFacts(doc, out);
  } else if (doc.kind === 'doc') {
    for (const t of doc.tags) {
      if (t.startsWith('path:')) out.add(t.slice(5), '', 'doc', doc.updatedAt);
    }
  }
  return out.list();
}

const COLS = 'doc_id AS docId, source_id AS sourceId, path, person, role, at';

export function factsByDocId(db: Db, docId: string): PathFact[] {
  return db
    .prepare(`SELECT ${COLS} FROM path_facts WHERE doc_id = ? ORDER BY path, person, role`)
    .all(docId) as PathFact[];
}

/** Whole-segment prefix: `src/index` matches `src/index/db.ts` but not `src/indexer.ts`. `''` and `.` match all. */
export function factsByPathPrefix(db: Db, prefix: string): PathFact[] {
  const p = normalizePath(prefix).replace(/\/+$/, '');
  if (p === '' || p === '.') {
    return db
      .prepare(`SELECT ${COLS} FROM path_facts ORDER BY path, person, role`)
      .all() as PathFact[];
  }
  // '0' is the character after '/': [p/, p0) is exactly the paths below p
  return db
    .prepare(
      `SELECT ${COLS} FROM path_facts WHERE path = @p OR (path >= @lo AND path < @hi)
       ORDER BY path, person, role`,
    )
    .all({ p, lo: `${p}/`, hi: `${p}0` }) as PathFact[];
}
