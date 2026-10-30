import path from 'node:path';
import { loadConfig } from '../config.js';
import { type Db, openDb, upsertDoc } from '../index/db.js';
import type { WaymarkPaths } from '../paths.js';
import { makeId, parseId, type WaymarkDoc } from '../store/doc.js';
import { readDoc, writeDoc } from '../store/markdown.js';
import { commitWiki } from '../store/wikigit.js';
import { listOpenHandoffs } from './handoff.js';

export type Turn = { role: 'user' | 'assistant'; text: string; timestamp?: string };

export interface SessionMeta {
  harness: 'claude-code' | 'cursor' | 'hermes';
  sessionId: string;
  cwd?: string;
}

const MAX_TRANSCRIPT_CHARS = 200_000;
const OMITTED = '_[earlier turns omitted]_';

const LABELS: Record<SessionMeta['harness'], string> = {
  'claude-code': 'Claude Code',
  cursor: 'Cursor',
  hermes: 'Hermes',
};

function iso(ts: string | undefined, fallback: Date): string {
  const d = ts === undefined ? fallback : new Date(ts);
  return (Number.isNaN(d.getTime()) ? fallback : d).toISOString();
}

export function sessionDoc(meta: SessionMeta, turns: Turn[], now: Date): WaymarkDoc | null {
  const first = turns.find((t) => t.role === 'user');
  if (!first) return null;
  const firstLine = first.text.split('\n')[0] ?? '';
  const title = firstLine.length > 80 ? `${firstLine.slice(0, 80)}…` : firstLine;

  const blocks = turns.map((t) => `**${t.role === 'user' ? 'User' : 'Assistant'}:** ${t.text}`);
  // ponytail: dumb cap; summarisation is the later consolidation epic
  let total = blocks.reduce((n, b) => n + b.length + 2, 0);
  let start = 0;
  while (total > MAX_TRANSCRIPT_CHARS && start < blocks.length - 1) {
    total -= (blocks[start] as string).length + 2;
    start++;
  }
  const transcript = [...(start > 0 ? [OMITTED] : []), ...blocks.slice(start)].join('\n\n');

  const tags = [`harness:${meta.harness}`];
  if (meta.cwd) tags.push(`project:${path.basename(meta.cwd)}`);
  return {
    id: makeId('agent', 'session', meta.sessionId),
    kind: 'session',
    sourceId: 'agent',
    title,
    authors: [],
    createdAt: iso(turns[0]?.timestamp, now),
    updatedAt: iso(turns[turns.length - 1]?.timestamp, now),
    tags,
    body: `${LABELS[meta.harness]} session \`${meta.sessionId}\` in \`${meta.cwd ?? ''}\`\n\n## Transcript\n\n${transcript}`,
  };
}

export function startContext(db: Db, project?: string): string {
  let out = `Waymark knowledge base is available through the MCP tools \`search\`, \`get_document\` and \`save_note\`.
Search it before changing unfamiliar code or when asked why something is built a certain way. Save durable decisions and conventions with save_note. Before stopping unfinished work, leave a handoff with create_handoff.
`;
  const rows = db
    .prepare("SELECT id, title FROM docs WHERE kind = 'note' ORDER BY updated_at DESC LIMIT 5")
    .all() as Array<{ id: string; title: string }>;
  if (rows.length > 0) {
    out += `\nRecent notes:\n${rows.map((r) => `- ${r.title} (${r.id})`).join('\n')}\n`;
  }
  const handoffs = listOpenHandoffs(db, project);
  if (handoffs.length > 0) {
    out += `\nOpen handoffs for this project (claim one with claim_handoff before continuing it):\n${handoffs.map((h) => `- ${h.title} (${h.id})`).join('\n')}\n`;
  }
  return out;
}

export async function saveSession(paths: WaymarkPaths, doc: WaymarkDoc): Promise<void> {
  await writeDoc(paths.wiki, doc);
  // index the redacted copy from disk, not the raw doc
  const stored = (await readDoc(paths.wiki, doc.id)) ?? doc;
  const db = openDb(paths.db);
  try {
    upsertDoc(db, stored, `${doc.id}.md`);
  } finally {
    db.close();
  }
  await commitWiki(paths.wiki, `session: ${parseId(doc.id).nativeId}`);
}

export async function isInitialised(paths: WaymarkPaths): Promise<boolean> {
  try {
    await loadConfig(paths);
    return true;
  } catch {
    return false;
  }
}
