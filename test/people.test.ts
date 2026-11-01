import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/cli.js';
import { createPeopleResolver } from '../src/memory/people.js';
import { parseId } from '../src/store/doc.js';
import { writeDoc } from '../src/store/markdown.js';

function capture() {
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const text = (spy: typeof stdout) => spy.mock.calls.map((c) => String(c[0])).join('');
  return { out: () => text(stdout), err: () => text(stderr) };
}

describe('createPeopleResolver', () => {
  const resolve = createPeopleResolver([
    { name: 'Alan Oliveira', aliases: ['AlanEdward19', 'Alan O.'] },
  ]);
  it('maps aliases, @login and padded/lower-case forms to the canonical name', () => {
    for (const raw of [
      '@AlanEdward19',
      'alanedward19 ',
      'AlanEdward19',
      'alan o.',
      'Alan Oliveira',
    ]) {
      expect(resolve(raw)).toBe('Alan Oliveira');
    }
  });
  it('leaves unknown names as stored, minus a leading @', () => {
    expect(resolve('bob')).toBe('bob');
    expect(resolve('@bob')).toBe('bob');
  });
  it('rejects an alias listed under two names', () => {
    expect(() =>
      createPeopleResolver([
        { name: 'A', aliases: ['x'] },
        { name: 'B', aliases: ['X'] },
      ]),
    ).toThrow('people: alias "X" is listed under both "A" and "B"');
  });
});

describe('waymark people', () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'waymark-'));
    vi.stubEnv('WAYMARK_HOME', tmp);
    capture();
    await main(['init']);
    vi.restoreAllMocks();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await fs.rm(tmp, { recursive: true, force: true });
  });

  const add = (id: string, sourceId: string, authors: string[]) =>
    writeDoc(path.join(tmp, 'wiki'), {
      id,
      kind: parseId(id).kind,
      sourceId,
      title: id,
      authors,
      createdAt: '2026-10-01T12:00:00.000Z',
      updatedAt: '2026-10-02T08:30:00.000Z',
      tags: [],
      body: 'b',
    });

  it('prints the empty-index message', async () => {
    const io = capture();
    expect(await main(['people'])).toBe(0);
    expect(io.out()).toBe('No people found. Run "waymark sync" first.\n');
  });

  it('groups by canonical name with per-source counts, bots last', async () => {
    await fs.writeFile(
      path.join(tmp, 'config.json'),
      JSON.stringify({
        version: 1,
        sources: [],
        people: [{ name: 'Alan Oliveira', aliases: ['AlanEdward19', 'Alan O.'] }],
      }),
    );
    for (let i = 0; i < 2; i++)
      await add(`waymark-git/commit/${i}`, 'waymark-git', ['AlanEdward19']);
    await add('waymark-gh/pull_request/1', 'waymark-gh', ['@AlanEdward19', 'bob']);
    await add('waymark-gh/pull_request/2', 'waymark-gh', ['bob ', 'dependabot[bot]']);
    for (const n of [3, 4, 5]) await add(`waymark-gh/pull_request/${n}`, 'waymark-gh', ['bob']);
    for (const n of [6, 7, 8, 9, 10, 11]) {
      await add(`waymark-gh/pull_request/${n}`, 'waymark-gh', ['dependabot[bot]']);
    }
    await add('waymark-chat/chat/1', 'waymark-chat', ['Alan O.', 'bob']);
    // two aliases of one person in one doc: counts once toward the total
    await add('waymark-gh/issue/1', 'waymark-gh', ['AlanEdward19', 'Alan Oliveira']);
    await main(['reindex']);

    const io = capture();
    expect(await main(['people'])).toBe(0);
    expect(io.out()).toBe(`bob  (6 docs)
  aliases seen: bob (waymark-gh 5, waymark-chat 1)
Alan Oliveira  (5 docs)
  aliases seen: AlanEdward19 (waymark-gh 2, waymark-git 2), Alan O. (waymark-chat 1), Alan Oliveira (waymark-gh 1)
bots
dependabot[bot]  (7 docs)
  aliases seen: dependabot[bot] (waymark-gh 7)
`);

    vi.restoreAllMocks();
    const j = capture();
    expect(await main(['people', '--json'])).toBe(0);
    expect(JSON.parse(j.out())).toEqual([
      {
        name: 'bob',
        total: 6,
        aliases: [{ alias: 'bob', bySource: { 'waymark-gh': 5, 'waymark-chat': 1 } }],
      },
      {
        name: 'Alan Oliveira',
        total: 5,
        aliases: [
          { alias: 'AlanEdward19', bySource: { 'waymark-gh': 2, 'waymark-git': 2 } },
          { alias: 'Alan O.', bySource: { 'waymark-chat': 1 } },
          { alias: 'Alan Oliveira', bySource: { 'waymark-gh': 1 } },
        ],
      },
      {
        name: 'dependabot[bot]',
        total: 7,
        aliases: [{ alias: 'dependabot[bot]', bySource: { 'waymark-gh': 7 } }],
      },
    ]);
  });
  it('never prints e-mail authors, lists any-case [bot] under bots, sorts ties by name', async () => {
    await add('s/commit/1', 's', ['alan@example.com', 'zed']);
    await add('s/commit/2', 's', ['@bob@corp.io', 'amy']);
    await add('s/commit/3', 's', ['Renovate[BOT]']);
    await main(['reindex']);
    const io = capture();
    expect(await main(['people'])).toBe(0);
    expect(io.out()).toBe(`amy  (1 docs)
  aliases seen: amy (s 1)
zed  (1 docs)
  aliases seen: zed (s 1)
bots
Renovate[BOT]  (1 docs)
  aliases seen: Renovate[BOT] (s 1)
`);
    vi.restoreAllMocks();
    const j = capture();
    expect(await main(['people', '--json'])).toBe(0);
    expect(j.out()).not.toMatch(/@(example|corp)/);
  });
});
