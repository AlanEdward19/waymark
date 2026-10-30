import fs from 'node:fs/promises';
import { openDb } from '../index/db.js';
import type { WaymarkPaths } from '../paths.js';
import {
  isInitialised,
  projectOf,
  saveSession,
  sessionDoc,
  startContext,
  type Turn,
} from './session.js';

export interface HookInput {
  session_id: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name: string;
  source?: string;
  reason?: string;
  trigger?: string;
}

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
  if (!(await isInitialised(paths))) return ''; // not initialised: never break the user's session

  if (event === 'SessionStart') {
    const db = openDb(paths.db);
    try {
      return JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext: startContext(db, projectOf(input.cwd)),
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
  const doc = sessionDoc(
    { harness: 'claude-code', sessionId: input.session_id, cwd: input.cwd },
    parseTranscript(jsonl),
    new Date(),
  );
  if (!doc) return '';
  await saveSession(paths, doc);
  return '';
}
