import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  handleCursorHook,
  parseCursorTimestamp,
  parseCursorTranscript,
} from '../src/agents/cursor.js';
import { main } from '../src/cli.js';
import { initHome } from '../src/config.js';
import { openDb } from '../src/index/db.js';
import { resolvePaths } from '../src/paths.js';
import { readDoc } from '../src/store/markdown.js';

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'waymark-'));
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await fs.rm(dir, { recursive: true, force: true });
});

const line = (o: unknown) => JSON.stringify(o);
const user = (text: string) =>
  line({ role: 'user', message: { content: [{ type: 'text', text }] } });
const assistant = (content: unknown[]) => line({ role: 'assistant', message: { content } });

const fixture = [
  user(
    '<timestamp>Thursday, Sep 17, 2026, 8:09 AM (UTC-3)</timestamp>\n<user_query>\nFix the login bug\n</user_query>',
  ),
  user('<available_subagent_types>explore</available_subagent_types>'),
  assistant([
    { type: 'text', text: 'On it.' },
    { type: 'tool_use', name: 'Read', input: {} },
  ]),
  assistant([{ type: 'tool_use', name: 'Read', input: {} }]),
  line({ type: 'turn_ended', status: 'success' }),
  '{not json',
].join('\n');

describe('parseCursorTimestamp', () => {
  it('parses offsets and rejects garbage', () => {
    expect(parseCursorTimestamp('Thursday, Sep 17, 2026, 8:09 AM (UTC-3)')).toBe(
      '2026-09-17T11:09:00.000Z',
    );
    expect(parseCursorTimestamp('Monday, Jan 5, 2026, 12:30 PM (UTC+5:30)')).toBe(
      '2026-01-05T07:00:00.000Z',
    );
    expect(parseCursorTimestamp('Monday, Jan 5, 2026, 12:30 PM (UTC)')).toBe(
      '2026-01-05T12:30:00.000Z',
    );
    expect(parseCursorTimestamp('garbage')).toBeUndefined();
  });
});

describe('parseCursorTranscript', () => {
  it('keeps real user queries and assistant text only', () => {
    expect(parseCursorTranscript(fixture)).toEqual([
      { role: 'user', text: 'Fix the login bug', timestamp: '2026-09-17T11:09:00.000Z' },
      { role: 'assistant', text: 'On it.' },
    ]);
  });
});

describe('handleCursorHook', () => {
  const setup = async () => {
    const paths = resolvePaths({ WAYMARK_HOME: dir });
    await initHome(paths);
    return paths;
  };
  const base = {
    conversation_id: 'c-1',
    workspace_roots: ['/work/my-proj'],
    user_email: 'someone@example.com',
  };

  it('sessionStart returns additional_context', async () => {
    const paths = await setup();
    const out = JSON.parse(
      await handleCursorHook(JSON.stringify({ ...base, hook_event_name: 'sessionStart' }), paths),
    );
    expect(out.additional_context).toContain('save_note');
  });

  it('sessionEnd twice keeps one redacted doc without stdin metadata', async () => {
    const paths = await setup();
    const tp = path.join(dir, 't.jsonl');
    const secret = `ghp_${'a1B2c3D4e5'.repeat(4)}`;
    await fs.writeFile(tp, user('<user_query>first</user_query>'));
    const stdin = JSON.stringify({ ...base, hook_event_name: 'sessionEnd', transcript_path: tp });
    expect(await handleCursorHook(stdin, paths)).toBe('');
    await fs.writeFile(
      tp,
      `${user('<user_query>first</user_query>')}\n${assistant([{ type: 'text', text: `key ${secret}` }])}`,
    );
    expect(await handleCursorHook(stdin, paths)).toBe('');

    const db = openDb(paths.db);
    expect(db.prepare('SELECT COUNT(*) AS n FROM docs').get()).toEqual({ n: 1 });
    db.close();
    const stored = await readDoc(paths.wiki, 'agent/session/c-1');
    expect(stored?.tags).toEqual(['harness:cursor', 'project:my-proj']);
    expect(stored?.body).not.toContain(secret);
    const raw = await fs.readFile(path.join(paths.wiki, 'agent/session/c-1.md'), 'utf8');
    expect(raw).not.toContain('someone@example.com');
  });

  it('ignores null transcript, invalid input and uninitialised homes', async () => {
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const paths = resolvePaths({ WAYMARK_HOME: dir });
    const start = JSON.stringify({ ...base, hook_event_name: 'sessionStart' });
    expect(await handleCursorHook(start, paths)).toBe('');
    await initHome(paths);
    const end = { ...base, hook_event_name: 'sessionEnd' };
    expect(await handleCursorHook(JSON.stringify({ ...end, transcript_path: null }), paths)).toBe(
      '',
    );
    expect(await handleCursorHook('nope', paths)).toBe('');
    expect(
      await handleCursorHook(JSON.stringify({ ...base, hook_event_name: 'stop' }), paths),
    ).toBe('');
  });

  it('CLI exits 0 on bad stdin', async () => {
    vi.stubEnv('WAYMARK_HOME', dir);
    const out = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    vi.spyOn(process, 'stdin', 'get').mockReturnValue(Readable.from(['garbage']) as never);
    expect(await main(['hook', 'cursor'])).toBe(0);
    expect(out).not.toHaveBeenCalled();
  });
});
