import fs from 'node:fs/promises';
import path from 'node:path';
import { loadConfig } from '../config.js';
import { type Db, openDb, upsertDoc } from '../index/db.js';
import type { WaymarkPaths } from '../paths.js';
import { makeId, type WaymarkDoc } from '../store/doc.js';
import { readDoc, writeDoc } from '../store/markdown.js';

export interface HookInput {
  session_id: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name: string;
  source?: string;
  reason?: string;
  trigger?: string;
}

type Turn = { role: 'user' | 'assistant'; text: string; timestamp?: string };

const MAX_TRANSCRIPT_CHARS = 200_000;
const OMITTED = '_[earlier turns omitted]_';

export function parseTranscript(jsonl: string): Turn[] {
  const turns: Turn[] = [];
  for (const line of jsonl.split('\n')) {
    if (line.trim() === '') continue;
    let entry: {
      type?: string;
      isSidechain?: boolean;
      timestamp?: unknown;
      message?: { content?: unknown };
    };
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry === null || typeof entry !== 'object' || entry.isSidechain === true) continue;
    const content = entry.message?.content as unknown;
    let role: Turn['role'];
    let text: string;
    if (entry.type === 'user' && typeof content === 'string') {
      role = 'user';
      text = content.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
    } else if (entry.type === 'assistant' && Array.isArray(content)) {
      role = 'assistant';
      text = content
        .filter(
          (b: { type?: string; text?: unknown }) =>
            b?.type === 'text' && typeof b.text === 'string',
        )
        .map((b) => b.text as string)
        .join('\n\n')
        .trim();
    } else {
      continue;
    }
    if (text === '') continue;
    const turn: Turn = { role, text };
    if (typeof entry.timestamp === 'string') turn.timestamp = entry.timestamp;
    turns.push(turn);
  }
  return turns;
}

function iso(ts: string | undefined, fallback: Date): string {
  const d = ts === undefined ? fallback : new Date(ts);
  return (Number.isNaN(d.getTime()) ? fallback : d).toISOString();
}

export function sessionDoc(input: HookInput, turns: Turn[], now: Date): WaymarkDoc | null {
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

  const tags = ['harness:claude-code'];
  if (input.cwd) tags.push(`project:${path.basename(input.cwd)}`);
  return {
    id: makeId('agent', 'session', input.session_id),
    kind: 'session',
    sourceId: 'agent',
    title,
    authors: [],
    createdAt: iso(turns[0]?.timestamp, now),
    updatedAt: iso(turns[turns.length - 1]?.timestamp, now),
    tags,
    body: `Claude Code session \`${input.session_id}\` in \`${input.cwd ?? ''}\`\n\n## Transcript\n\n${transcript}`,
  };
}

export function sessionStartContext(db: Db): string {
  let out = `Waymark knowledge base is available through the MCP tools \`search\`, \`get_document\` and \`save_note\`.
Search it before changing unfamiliar code or when asked why something is built a certain way. Save durable decisions and conventions with save_note.
`;
  const rows = db
    .prepare("SELECT id, title FROM docs WHERE kind = 'note' ORDER BY updated_at DESC LIMIT 5")
    .all() as Array<{ id: string; title: string }>;
  if (rows.length > 0) {
    out += `\nRecent notes:\n${rows.map((r) => `- ${r.title} (${r.id})`).join('\n')}\n`;
  }
  return out;
}

export async function handleHook(stdin: string, paths: WaymarkPaths): Promise<string> {
  let input: HookInput;
  try {
    input = JSON.parse(stdin);
    if (typeof input?.hook_event_name !== 'string') throw new Error('bad input');
  } catch {
    process.stderr.write('warn: waymark hook: invalid input\n');
    return '';
  }
  const event = input.hook_event_name;
  if (event !== 'SessionStart' && event !== 'PreCompact' && event !== 'SessionEnd') return '';
  try {
    await loadConfig(paths);
  } catch {
    return ''; // not initialised: never break the user's session
  }

  if (event === 'SessionStart') {
    const db = openDb(paths.db);
    try {
      return JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext: sessionStartContext(db),
        },
      });
    } finally {
      db.close();
    }
  }

  if (!input.transcript_path || typeof input.session_id !== 'string') return '';
  let jsonl: string;
  try {
    jsonl = await fs.readFile(input.transcript_path, 'utf8');
  } catch {
    return '';
  }
  const doc = sessionDoc(input, parseTranscript(jsonl), new Date());
  if (!doc) return '';
  await writeDoc(paths.wiki, doc);
  // index the redacted copy from disk, not the raw doc
  const stored = (await readDoc(paths.wiki, doc.id)) ?? doc;
  const db = openDb(paths.db);
  try {
    upsertDoc(db, stored, `${doc.id}.md`);
  } finally {
    db.close();
  }
  return '';
}
