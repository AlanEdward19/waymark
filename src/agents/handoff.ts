import { type Db, upsertDoc } from '../index/db.js';
import { docRelPath, noteStampId, type WaymarkDoc } from '../store/doc.js';
import { readDoc, writeDoc } from '../store/markdown.js';
import { commitWiki } from '../store/wikigit.js';

export interface HandoffInput {
  title: string;
  summary: string;
  nextSteps: string;
  project: string;
  from?: string;
}

async function store(db: Db, wikiDir: string, doc: WaymarkDoc): Promise<WaymarkDoc> {
  const { doc: stored } = await writeDoc(wikiDir, doc);
  upsertDoc(db, stored, docRelPath(doc.id));
  return stored;
}

export async function createHandoff(
  db: Db,
  wikiDir: string,
  input: HandoffInput,
  now: Date = new Date(),
): Promise<string> {
  const id = noteStampId('handoff', input.title, now);
  const iso = now.toISOString();
  const tags = ['status:open', `project:${input.project}`];
  if (input.from) tags.push(`from:${input.from}`);
  await store(db, wikiDir, {
    id,
    kind: 'handoff',
    sourceId: 'agent',
    title: input.title,
    authors: [],
    createdAt: iso,
    updatedAt: iso,
    tags,
    body: `## Summary\n\n${input.summary}\n\n## Next steps\n\n${input.nextSteps}`,
  });
  await commitWiki(wikiDir, `handoff: ${input.title}`);
  return id;
}

export function listOpenHandoffs(
  db: Db,
  project?: string,
): Array<{ id: string; title: string; updatedAt: string; project: string }> {
  const rows = db
    .prepare(
      "SELECT id, title, updated_at, tags FROM docs WHERE kind = 'handoff' ORDER BY updated_at DESC",
    )
    .all() as Array<{ id: string; title: string; updated_at: string; tags: string }>;
  const out: Array<{ id: string; title: string; updatedAt: string; project: string }> = [];
  for (const r of rows) {
    const tags = JSON.parse(r.tags) as string[];
    if (!tags.includes('status:open')) continue;
    const p = tags.find((t) => t.startsWith('project:'))?.slice('project:'.length) ?? '';
    if (project !== undefined && p !== project) continue;
    out.push({ id: r.id, title: r.title, updatedAt: r.updated_at, project: p });
    if (out.length === 10) break;
  }
  return out;
}

export async function claimHandoff(
  db: Db,
  wikiDir: string,
  id: string,
  now: Date = new Date(),
): Promise<{ ok: true; doc: WaymarkDoc } | { ok: false; reason: 'not_found' | 'already_claimed' }> {
  const row = db.prepare("SELECT tags FROM docs WHERE id = ? AND kind = 'handoff'").get(id) as
    | { tags: string }
    | undefined;
  if (!row) return { ok: false, reason: 'not_found' };
  const oldTags = JSON.parse(row.tags) as string[];
  if (!oldTags.includes('status:open')) return { ok: false, reason: 'already_claimed' };
  const tags = [...oldTags.filter((t) => !t.startsWith('status:')), 'status:claimed'];
  const iso = now.toISOString();
  // conditional update on the old tags: only one connection can win
  const res = db
    .prepare('UPDATE docs SET tags = ?, updated_at = ? WHERE id = ? AND tags = ?')
    .run(JSON.stringify(tags), iso, id, row.tags);
  if (res.changes !== 1) return { ok: false, reason: 'already_claimed' };

  // ponytail: a crash here leaves the file open, so reindex reopens it (at-least-once after a crash)
  const doc = await readDoc(wikiDir, id);
  if (!doc) throw new Error(`Handoff file missing: ${id}`);
  const claimed = await store(db, wikiDir, {
    ...doc,
    tags,
    updatedAt: iso,
    body: `${doc.body}\n\n## Claimed\n\nClaimed at ${iso}.`,
  });
  await commitWiki(wikiDir, `handoff claimed: ${doc.title}`);
  return { ok: true, doc: claimed };
}
