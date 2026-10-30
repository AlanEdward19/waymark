import fs from 'node:fs/promises';
import { openDb } from '../index/db.js';
import type { WaymarkPaths } from '../paths.js';
import { isInitialised, saveSession, sessionDoc, startContext, type Turn } from './session.js';

export interface CursorHookInput {
  hook_event_name: string;
  conversation_id?: string;
  session_id?: string;
  transcript_path?: string | null;
  workspace_roots?: string[];
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function parseCursorTimestamp(s: string): string | undefined {
  const m =
    /^\w+, (\w{3}) (\d{1,2}), (\d{4}), (\d{1,2}):(\d{2}) (AM|PM) \(UTC(?:([+-]\d{1,2})(?::(\d{2}))?)?\)$/.exec(
      s.trim(),
    );
  if (!m) return undefined;
  const mon = MONTHS.indexOf(m[1] as string);
  if (mon < 0) return undefined;
  let h = Number(m[4]) % 12;
  if (m[6] === 'PM') h += 12;
  const off =
    m[7] === undefined
      ? 0
      : Number(m[7]) * 60 + (m[7].startsWith('-') ? -1 : 1) * Number(m[8] ?? 0);
  return new Date(
    Date.UTC(Number(m[3]), mon, Number(m[2]), h, Number(m[5])) - off * 60000,
  ).toISOString();
}

export function parseCursorTranscript(jsonl: string): Turn[] {
  const turns: Turn[] = [];
  for (const line of jsonl.split('\n')) {
    if (line.trim() === '') continue;
    let entry: { role?: string; message?: { content?: unknown } };
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry === null || typeof entry !== 'object') continue;
    if (entry.role !== 'user' && entry.role !== 'assistant') continue;
    const content = entry.message?.content;
    const texts = Array.isArray(content)
      ? content
          .filter(
            (b: { type?: string; text?: unknown }) =>
              b?.type === 'text' && typeof b.text === 'string',
          )
          .map((b) => b.text as string)
      : [];
    if (entry.role === 'assistant') {
      const text = texts.join('\n\n').trim();
      if (text !== '') turns.push({ role: 'assistant', text });
      continue;
    }
    const joined = texts.join('\n');
    const queries = [...joined.matchAll(/<user_query>([\s\S]*?)<\/user_query>/g)].map((m) =>
      (m[1] as string).trim(),
    );
    if (queries.length === 0) continue;
    const turn: Turn = { role: 'user', text: queries.join('\n\n') };
    const ts = /<timestamp>([\s\S]*?)<\/timestamp>/.exec(joined)?.[1];
    const parsed = ts === undefined ? undefined : parseCursorTimestamp(ts);
    if (parsed) turn.timestamp = parsed;
    turns.push(turn);
  }
  return turns;
}

export async function handleCursorHook(stdin: string, paths: WaymarkPaths): Promise<string> {
  let input: CursorHookInput;
  try {
    input = JSON.parse(stdin);
    if (typeof input?.hook_event_name !== 'string') throw new Error('bad input');
  } catch {
    process.stderr.write('warn: waymark hook: invalid input\n');
    return '';
  }
  const event = input.hook_event_name;
  if (event !== 'sessionStart' && event !== 'preCompact' && event !== 'sessionEnd') return '';
  if (!(await isInitialised(paths))) return ''; // not initialised: never break the user's session

  const cwd = input.workspace_roots?.[0];
  if (event === 'sessionStart') {
    const db = openDb(paths.db);
    try {
      // TODO(#38): pass project
      return JSON.stringify({ additional_context: startContext(db) });
    } finally {
      db.close();
    }
  }

  const sessionId = input.conversation_id ?? input.session_id;
  if (typeof sessionId !== 'string' || !input.transcript_path) return '';
  let jsonl: string;
  try {
    jsonl = await fs.readFile(input.transcript_path, 'utf8');
  } catch {
    return '';
  }
  const doc = sessionDoc(
    { harness: 'cursor', sessionId, cwd: typeof cwd === 'string' ? cwd : undefined },
    parseCursorTranscript(jsonl),
    new Date(),
  );
  if (!doc) return '';
  await saveSession(paths, doc);
  return '';
}
