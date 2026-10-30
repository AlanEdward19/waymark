import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleHook, parseTranscript, sessionDoc } from '../src/agents/claude-code.js';
import { main } from '../src/cli.js';
import { initHome } from '../src/config.js';
import { openDb, upsertDoc } from '../src/index/db.js';
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
const user = (content: unknown, extra = {}) =>
  line({ type: 'user', message: { role: 'user', content }, ...extra });
const assistant = (content: unknown[], extra = {}) =>
  line({ type: 'assistant', message: { role: 'assistant', content }, ...extra });

const fixture = [
  user('<system-reminder>ctx</system-reminder>\nFix the login bug', {
    timestamp: '2026-10-01T10:00:00.000Z',
  }),
  user([{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }]),
  assistant(
    [
      { type: 'thinking', thinking: 'hmm' },
      { type: 'text', text: 'On it.' },
      { type: 'tool_use', id: 't1', name: 'Read', input: {} },
    ],
    { timestamp: '2026-10-01T10:05:00.000Z' },
  ),
  user('sidechain prompt', { isSidechain: true }),
  line({ type: 'attachment', attachment: {} }),
  '{not json',
  '',
].join('\n');

const input = { session_id: 's-1', cwd: '/work/my-proj', hook_event_name: 'SessionEnd' };

describe('parseTranscript', () => {
  it('keeps only real user and assistant turns', () => {
    expect(parseTranscript(fixture)).toEqual([
      { role: 'user', text: 'Fix the login bug', timestamp: '2026-10-01T10:00:00.000Z' },
      { role: 'assistant', text: 'On it.', timestamp: '2026-10-01T10:05:00.000Z' },
    ]);
  });
});

describe('sessionDoc', () => {
  const now = new Date('2026-10-30T00:00:00.000Z');

  it('returns null without user turns', () => {
    expect(sessionDoc(input, [{ role: 'assistant', text: 'hi' }], now)).toBeNull();
  });

  it('maps fields and truncates the title', () => {
    const doc = sessionDoc(input, parseTranscript(fixture), now);
    expect(doc?.id).toBe('agent/session/s-1');
    expect(doc?.tags).toEqual(['harness:claude-code', 'project:my-proj']);
    expect(doc?.createdAt).toBe('2026-10-01T10:00:00.000Z');
    expect(doc?.updatedAt).toBe('2026-10-01T10:05:00.000Z');
    const long = sessionDoc(input, [{ role: 'user', text: `${'a'.repeat(100)}\nrest` }], now);
    expect(long?.title).toBe(`${'a'.repeat(80)}…`);
    expect(sessionDoc(input, [{ role: 'user', text: 'x' }], now)?.createdAt).toBe(
      now.toISOString(),
    );
  });

  it('caps the transcript keeping the newest turns', () => {
    const turns = Array.from({ length: 5 }, (_, i) => ({
      role: 'user' as const,
      text: `${i}`.repeat(60_000),
    }));
    const body = sessionDoc(input, turns, now)?.body ?? '';
    expect(body).toContain('_[earlier turns omitted]_');
    expect(body).toContain('4'.repeat(60_000));
    expect(body).not.toContain('0'.repeat(60_000));
    expect(body.length).toBeLessThan(210_000);
  });
});

describe('handleHook', () => {
  const setup = async () => {
    const paths = resolvePaths({ WAYMARK_HOME: dir });
    await initHome(paths);
    return paths;
  };

  it('SessionStart returns context listing recent notes', async () => {
    const paths = await setup();
    const db = openDb(paths.db);
    upsertDoc(
      db,
      {
        id: 'me/note/n1',
        kind: 'note',
        sourceId: 'me',
        title: 'Use pnpm',
        authors: [],
        createdAt: '2026-10-01T00:00:00.000Z',
        updatedAt: '2026-10-01T00:00:00.000Z',
        tags: [],
        body: 'b',
      },
      'me/note/n1.md',
    );
    db.close();
    const out = JSON.parse(
      await handleHook(JSON.stringify({ session_id: 's', hook_event_name: 'SessionStart' }), paths),
    );
    expect(out.hookSpecificOutput.hookEventName).toBe('SessionStart');
    expect(out.hookSpecificOutput.additionalContext).toContain('- Use pnpm (me/note/n1)');
  });

  it('SessionEnd twice keeps one doc, updated and redacted', async () => {
    const paths = await setup();
    const tp = path.join(dir, 't.jsonl');
    const secret = `ghp_${'a1B2c3D4e5'.repeat(4)}`;
    await fs.writeFile(tp, user('first prompt'));
    const stdin = JSON.stringify({ ...input, transcript_path: tp });
    expect(await handleHook(stdin, paths)).toBe('');
    await fs.writeFile(
      tp,
      `${user('first prompt')}\n${assistant([{ type: 'text', text: `key ${secret}` }])}`,
    );
    expect(await handleHook(stdin, paths)).toBe('');

    const db = openDb(paths.db);
    expect(db.prepare('SELECT COUNT(*) AS n FROM docs').get()).toEqual({ n: 1 });
    const fts = db.prepare('SELECT body FROM docs_fts').get() as { body: string };
    db.close();
    const stored = await readDoc(paths.wiki, 'agent/session/s-1');
    expect(stored?.body).toContain('**Assistant:** key');
    expect(stored?.body).not.toContain(secret);
    expect(fts.body).not.toContain(secret);
  });

  it('ignores invalid input, missing transcripts and uninitialised homes', async () => {
    const err = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const paths = resolvePaths({ WAYMARK_HOME: dir });
    const start = JSON.stringify({ ...input, hook_event_name: 'SessionStart' });
    expect(await handleHook('nope', paths)).toBe('');
    expect(err).toHaveBeenCalledWith('warn: waymark hook: invalid input\n');
    expect(await handleHook(start, paths)).toBe('');
    await initHome(paths);
    const missing = JSON.stringify({ ...input, transcript_path: path.join(dir, 'x') });
    expect(await handleHook(missing, paths)).toBe('');
    expect(await handleHook(JSON.stringify({ ...input, hook_event_name: 'Stop' }), paths)).toBe('');
  });
});

describe('waymark hook CLI', () => {
  it('exits 0 with empty stdout on bad stdin and unknown harness', async () => {
    vi.stubEnv('WAYMARK_HOME', dir);
    const out = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    vi.spyOn(process, 'stdin', 'get').mockReturnValue(Readable.from(['garbage']) as never);
    expect(await main(['hook', 'claude-code'])).toBe(0);
    expect(await main(['hook', 'other'])).toBe(0);
    expect(await main(['hook'])).toBe(0);
    expect(out).not.toHaveBeenCalled();
  });
});
