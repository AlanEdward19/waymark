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

type Block = { type?: string; text?: unknown };
const textOf = (blocks: Block[]) =>
  blocks
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('\n\n');

const HARNESS_ENVELOPE =
  /^(?:<side-sessions-event>|<task-notification>|<agent-message\b|Another Claude session sent a message|\[SYSTEM NOTIFICATION)/;

export function parseTranscript(jsonl: string): Turn[] {
  const turns: Turn[] = [];
  for (const line of jsonl.split('\n')) {
    if (line.trim() === '') continue;
    let entry: {
      type?: string;
      isSidechain?: boolean;
      origin?: { kind?: unknown };
      isMeta?: boolean;
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
    if (entry.type === 'user') {
      // isMeta: injected by the harness (e.g. a loaded skill's full text), not typed
      if (entry.isMeta === true) continue;
      // task notifications carry a non-human origin kind; older transcripts have no origin
      if (entry.origin?.kind !== undefined && entry.origin.kind !== 'human') continue;
      if (typeof content === 'string') text = content;
      // a prompt with attachments is an array of text blocks; tool results are not prompts
      else if (Array.isArray(content) && !content.some((b: Block) => b?.type === 'tool_result')) {
        text = textOf(content);
      } else continue;
      role = 'user';
      text = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
      // harness events (sub-agent reports, side-session notes) are not the user's words. They
      // share turnOrigin "sdk" with prompts of sessions started by another session, so match
      // their envelopes instead of the origin.
      if (HARNESS_ENVELOPE.test(text)) continue;
    } else if (entry.type === 'assistant' && Array.isArray(content)) {
      role = 'assistant';
      text = textOf(content).trim();
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
  // Stop runs after every turn: capture does not depend on the session ending cleanly
  // (an app that kills the process may never send SessionEnd)
  const capture = event === 'Stop' || event === 'PreCompact' || event === 'SessionEnd';
  if (event !== 'SessionStart' && !capture) return '';
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
