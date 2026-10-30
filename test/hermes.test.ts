import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleHermesHook, parseHermesHistory } from '../src/agents/hermes.js';
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

const payload = (event: string, extra: unknown, rest = {}) =>
  JSON.stringify({
    hook_event_name: event,
    session_id: 'h-1',
    cwd: '/work/my-proj',
    extra,
    ...rest,
  });

describe('parseHermesHistory', () => {
  it('keeps only non-empty user and assistant text, minus our context', () => {
    expect(
      parseHermesHistory([
        { role: 'system', content: 'sys' },
        { role: 'user', content: '<waymark-context>\nctx\n</waymark-context>\nFix login' },
        { role: 'assistant', content: null, tool_calls: [{ id: 't1' }] },
        { role: 'tool', content: 'result' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Done.' },
            { type: 'image', url: 'x' },
            { type: 'text', text: 'Really.' },
          ],
        },
      ]),
    ).toEqual([
      { role: 'user', text: 'Fix login' },
      { role: 'assistant', text: 'Done.\n\nReally.' },
    ]);
  });
});

describe('handleHermesHook', () => {
  const setup = async () => {
    const paths = resolvePaths({ WAYMARK_HOME: dir });
    await initHome(paths);
    return paths;
  };

  it('pre_llm_call injects context on the first turn only', async () => {
    const paths = await setup();
    const out = JSON.parse(
      await handleHermesHook(payload('pre_llm_call', { is_first_turn: true }), paths),
    );
    expect(out.context.startsWith('<waymark-context>\n')).toBe(true);
    expect(out.context.endsWith('</waymark-context>')).toBe(true);
    expect(out.context).toContain('save_note');
    expect(await handleHermesHook(payload('pre_llm_call', { is_first_turn: false }), paths)).toBe(
      '',
    );
  });

  it('post_llm_call twice keeps one doc with all turns, redacted, no metadata', async () => {
    const paths = await setup();
    const secret = `ghp_${'a1B2c3D4e5'.repeat(4)}`;
    const h1 = [{ role: 'user', content: 'first prompt' }];
    const h2 = [
      ...h1,
      { role: 'assistant', content: `key ${secret}` },
      { role: 'user', content: 'second prompt' },
    ];
    const extra = (h: unknown) => ({
      conversation_history: h,
      model: 'm-secret',
      platform: 'p-secret',
      sender_id: 'u-secret',
    });
    expect(await handleHermesHook(payload('post_llm_call', extra(h1)), paths)).toBe('');
    expect(await handleHermesHook(payload('post_llm_call', extra(h2)), paths)).toBe('');

    const db = openDb(paths.db);
    expect(db.prepare('SELECT COUNT(*) AS n FROM docs').get()).toEqual({ n: 1 });
    db.close();
    const doc = await readDoc(paths.wiki, 'agent/session/h-1');
    expect(doc?.tags).toEqual(['harness:hermes', 'project:my-proj']);
    expect(doc?.body).toContain('**User:** first prompt');
    expect(doc?.body).toContain('**User:** second prompt');
    expect(doc?.body).not.toContain(secret);
    for (const s of ['m-secret', 'p-secret', 'u-secret']) expect(doc?.body).not.toContain(s);
  });

  it('treats a stringified history as missing', async () => {
    const paths = await setup();
    const stdin = payload('post_llm_call', { conversation_history: "[{'role': 'user'}]" });
    expect(await handleHermesHook(stdin, paths)).toBe('');
    expect(await readDoc(paths.wiki, 'agent/session/h-1')).toBeNull();
  });

  it('ignores invalid input, other events and uninitialised homes', async () => {
    const err = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const paths = resolvePaths({ WAYMARK_HOME: dir });
    expect(await handleHermesHook('nope', paths)).toBe('');
    expect(err).toHaveBeenCalledWith('warn: waymark hook: invalid input\n');
    expect(await handleHermesHook(payload('pre_llm_call', { is_first_turn: true }), paths)).toBe(
      '',
    );
    await initHome(paths);
    expect(await handleHermesHook(payload('on_session_end', {}), paths)).toBe('');
  });
});

describe('waymark hook hermes CLI', () => {
  it('exits 0 with empty stdout on bad stdin', async () => {
    vi.stubEnv('WAYMARK_HOME', dir);
    const out = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    vi.spyOn(process, 'stdin', 'get').mockReturnValue(Readable.from(['garbage']) as never);
    expect(await main(['hook', 'hermes'])).toBe(0);
    expect(out).not.toHaveBeenCalled();
  });
});
