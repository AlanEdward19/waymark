import { openDb } from '../index/db.js';
import type { WaymarkPaths } from '../paths.js';
import { isInitialised, saveSession, sessionDoc, startContext, type Turn } from './session.js';

export interface HermesHookInput {
  hook_event_name: string;
  session_id?: string;
  cwd?: string;
  extra?: { is_first_turn?: boolean; conversation_history?: unknown[] };
}

export const CONTEXT_OPEN = '<waymark-context>';
export const CONTEXT_CLOSE = '</waymark-context>';

const CONTEXT_BLOCK = /<waymark-context>[\s\S]*?<\/waymark-context>/g;

export function parseHermesHistory(messages: unknown[]): Turn[] {
  const turns: Turn[] = [];
  for (const m of messages) {
    const msg = m as { role?: unknown; content?: unknown } | null;
    if (msg?.role !== 'user' && msg?.role !== 'assistant') continue;
    let text: string;
    if (typeof msg.content === 'string') {
      text = msg.content;
    } else if (Array.isArray(msg.content)) {
      text = msg.content
        .filter(
          (p: { type?: string; text?: unknown }) =>
            p?.type === 'text' && typeof p.text === 'string',
        )
        .map((p) => p.text as string)
        .join('\n\n');
    } else {
      continue;
    }
    text = text.replace(CONTEXT_BLOCK, '').trim();
    if (text !== '') turns.push({ role: msg.role, text });
  }
  return turns;
}

export async function handleHermesHook(stdin: string, paths: WaymarkPaths): Promise<string> {
  let input: HermesHookInput;
  try {
    input = JSON.parse(stdin);
    if (typeof input?.hook_event_name !== 'string') throw new Error('bad input');
  } catch {
    process.stderr.write('warn: waymark hook: invalid input\n');
    return '';
  }
  const event = input.hook_event_name;
  if (event !== 'pre_llm_call' && event !== 'post_llm_call') return '';
  if (!(await isInitialised(paths))) return '';
  const cwd = input.cwd || undefined;

  if (event === 'pre_llm_call') {
    if (input.extra?.is_first_turn !== true) return '';
    const db = openDb(paths.db);
    try {
      // TODO(#38): pass project
      return JSON.stringify({
        context: `${CONTEXT_OPEN}\n${startContext(db)}${CONTEXT_CLOSE}`,
      });
    } finally {
      db.close();
    }
  }

  const history = input.extra?.conversation_history;
  if (typeof input.session_id !== 'string' || input.session_id === '' || !Array.isArray(history)) {
    return '';
  }
  // ponytail: one wiki commit per turn; batch commits if that gets noisy
  const doc = sessionDoc(
    { harness: 'hermes', sessionId: input.session_id, cwd },
    parseHermesHistory(history),
    new Date(),
  );
  if (!doc) return '';
  await saveSession(paths, doc);
  return '';
}
