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
        people: [{ name: 'Alan Oliveira', aliases: ['AlanEdward19'] }],
      }),
    );
    for (let i = 0; i < 2; i++)
      await add(`waymark-git/commit/${i}`, 'waymark-git', ['AlanEdward19']);
    await add('waymark-gh/pull_request/1', 'waymark-gh', ['@AlanEdward19', 'bob']);
    await add('waymark-gh/pull_request/2', 'waymark-gh', ['bob', 'dependabot[bot]']);
    await add('waymark-gh/pull_request/3', 'waymark-gh', ['bob']);
    await add('waymark-gh/pull_request/4', 'waymark-gh', ['bob']);
    await main(['reindex']);

    const io = capture();
    expect(await main(['people'])).toBe(0);
    expect(io.out()).toBe(`bob  (4 docs)
  aliases seen: bob (waymark-gh 4)
Alan Oliveira  (3 docs)
  aliases seen: AlanEdward19 (waymark-git 2, waymark-gh 1)
bots
dependabot[bot]  (1 docs)
  aliases seen: dependabot[bot] (waymark-gh 1)
`);

    vi.restoreAllMocks();
    const j = capture();
    expect(await main(['people', '--json'])).toBe(0);
    expect(JSON.parse(j.out())[1]).toEqual({
      name: 'Alan Oliveira',
      total: 3,
      aliases: [{ alias: 'AlanEdward19', bySource: { 'waymark-git': 2, 'waymark-gh': 1 } }],
    });
  });
});
