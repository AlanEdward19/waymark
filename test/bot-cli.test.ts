import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FORMATTERS } from '../src/bots/console.js';
import { main } from '../src/cli.js';
import { writeDoc } from '../src/store/markdown.js';

let tmp: string;
let stdout: ReturnType<typeof vi.spyOn>;
let stderr: ReturnType<typeof vi.spyOn>;

const text = (spy: typeof stdout) => spy.mock.calls.map((c) => String(c[0])).join('');

async function run(...args: string[]): Promise<number> {
  stdout.mockClear();
  stderr.mockClear();
  return main(args);
}

const auditLines = async () => {
  const dir = path.join(tmp, 'audit');
  const files = await fs.readdir(dir);
  const all = await Promise.all(files.map((f) => fs.readFile(path.join(dir, f), 'utf8')));
  return all
    .join('')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l))
    .filter((event) => event.event === 'bot.ask');
};

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'waymark-'));
  vi.stubEnv('WAYMARK_HOME', tmp);
  stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  await run('init');
  await writeDoc(path.join(tmp, 'wiki'), {
    id: 'agent/note/deploy',
    kind: 'note',
    sourceId: 'agent',
    title: 'How we deploy',
    authors: ['alan'],
    createdAt: '2026-10-01T12:00:00.000Z',
    updatedAt: '2026-10-02T08:30:00.000Z',
    tags: [],
    body: 'Deploys go through the release pipeline.',
  });
  await run('reindex');
  await run('user', 'add', 'alice');
  await run('user', 'link', 'alice', 'slack', 'U01ALICE');
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  delete FORMATTERS.slack;
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('waymark bot test', () => {
  it('prints the reply for a linked user and audits it', async () => {
    expect(
      await run('bot', 'test', 'slack', '--user', 'U01ALICE', 'how', 'do', 'we', 'deploy'),
    ).toBe(0);
    expect(text(stdout)).toBe(
      'I found these sources:\n\n1. How we deploy — `agent/note/deploy`\n   **Deploys** go through the release pipeline.\n',
    );
    expect(text(stderr)).toContain('bot test: acknowledged (slack)');
    expect(await auditLines()).toEqual([
      expect.objectContaining({
        event: 'bot.ask',
        outcome: 'ok',
        user: 'alice',
        via: 'bot:slack',
        detail: { questionChars: 16, sources: 1, usedLlm: false },
      }),
    ]);
  });

  it('formats the reply with the platform formatter when one is registered', async () => {
    FORMATTERS.slack = (m) => m.replaceAll('**', '*');
    await run('bot', 'test', 'slack', '--user', 'U01ALICE', 'deploy');
    expect(text(stdout)).toContain('*Deploys* go');
    expect(text(stdout)).not.toContain('**');
  });

  it('denies an unlinked user with the link hint', async () => {
    expect(await run('bot', 'test', 'slack', '--user', 'U09NOBODY', 'deploy')).toBe(0);
    expect(text(stdout)).toBe(
      'I can only answer people linked to a Waymark account. Ask an admin to run: waymark user link <name> slack U09NOBODY\n',
    );
    expect((await auditLines())[0]).toMatchObject({
      outcome: 'denied',
      detail: { reason: 'unlinked' },
    });
  });

  it('rejects bad usage', async () => {
    expect(await run('bot', 'test', 'irc', '--user', 'x', 'q')).toBe(1);
    expect(text(stderr)).toContain('error: unknown bot platform "irc"');
    expect(await run('bot', 'test', 'slack', 'q')).toBe(1);
    expect(text(stderr)).toBe('error: bot test needs --user <externalUserId>\n');
    expect(await run('bot', 'test', 'slack', '--user', 'U01ALICE')).toBe(1);
    expect(text(stderr)).toBe('error: bot test needs a question\n');
    expect(await run('bot', 'run')).toBe(1);
    expect(text(stderr)).toContain('error: usage: waymark bot test');
  });
});
