import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/cli.js';
import { initHome } from '../src/config.js';
import { type Db, openDb, upsertDoc } from '../src/index/db.js';
import { findExperts, formatExperts } from '../src/memory/experts.js';
import { createPeopleResolver } from '../src/memory/people.js';
import { resolvePaths } from '../src/paths.js';
import { type DocKind, docRelPath } from '../src/store/doc.js';
import { writeDoc } from '../src/store/markdown.js';

const NOW = Date.parse('2026-11-01T00:00:00.000Z');
const resolve = createPeopleResolver([{ name: 'River Example', aliases: ['river-login'] }]);
let tmp: string;
let db: Db;
beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'waymark-'));
  const paths = resolvePaths({ WAYMARK_HOME: tmp });
  await initHome(paths);
  db = openDb(paths.db);
});
afterEach(async () => {
  db.close();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await fs.rm(tmp, { recursive: true, force: true });
});
async function add(
  nativeId: string,
  authors: string[],
  files: string[],
  days = 0,
  kind: DocKind = 'commit',
  extra = '',
) {
  const id = `fixture/${kind}/${nativeId}`;
  const at = new Date(NOW - days * 86_400_000).toISOString();
  const { doc } = await writeDoc(path.join(tmp, 'wiki'), {
    id,
    kind,
    sourceId: 'fixture',
    title: nativeId,
    authors,
    createdAt: at,
    updatedAt: at,
    tags: [],
    body: `${kind === 'pull_request' ? '#1 · OPEN · @sage · main' : 'Synthetic commit'}\n\n## Files\n\n${files.map((file) => `- ${file}`).join('\n')}\n${extra}`,
  });
  upsertDoc(db, doc, docRelPath(id));
}
const experts = (query: string, options: Parameters<typeof findExperts>[3] = {}) =>
  findExperts(db, query, resolve, { now: NOW, ...options });

describe('path expertise', () => {
  it('ranks synthetic commits, reviews and comments with exact explained text and whole segments', async () => {
    await add('one', ['river-login'], ['src/a/one.ts']);
    await add('two', ['River Example'], ['src/a/two.ts']);
    await add('three', ['taylor'], ['src/b/three.ts']);
    await add(
      'pull',
      ['sage'],
      ['src/a/one.ts'],
      0,
      'pull_request',
      `
## Reviews

- **@river-login** APPROVED (2026-11-01)

## Review comments

### \`src/a/one.ts\` line 1

\`\`\`diff
+ synthetic
\`\`\`

- **@river-login** (2026-11-01)
  Looks fine.
`,
    );
    expect(formatExperts(experts('src/a/'))).toBe(`Experts for src/a/ (from 3 documents)

1. River Example  score 3.4  last active 2026-11-01
   commits 2 · reviews 1 · review comments 1 · PRs authored 0
   evidence: fixture/commit/one, fixture/commit/two, fixture/pull_request/pull
2. sage  score 0.5  last active 2026-11-01
   commits 0 · reviews 0 · review comments 0 · PRs authored 1
   evidence: fixture/pull_request/pull
`);
    expect(experts('src/b').experts.map((e) => e.name)).toEqual(['taylor']);
    expect(experts('src/ab').experts).toEqual([]);
    expect(experts('.').documents).toBe(4);
    expect(experts('').documents).toBe(4);
  });
  it('counts fifty files and multiple aliases once per canonical person, document and role', async () => {
    await add(
      'large',
      ['river-login', 'River Example'],
      Array.from({ length: 50 }, (_, i) => `src/a/${i}.ts`),
    );
    await add('bot', ['automation[BOT]'], ['src/a/bot.ts']);
    const result = experts('src/a');
    expect(result.documents).toBe(1);
    expect(result.experts).toHaveLength(1);
    expect(result.experts[0]).toMatchObject({
      name: 'River Example',
      score: 1,
      counts: { commit_author: 1 },
    });
  });
  it('halves at 180 days, filters since and sources, limits evidence to recent distinct docs', async () => {
    await add('old', ['river-login'], ['src/a.ts'], 180);
    expect(experts('src/a.ts').experts[0]?.score).toBe(0.5);
    expect(experts('src/a.ts', { sinceDays: 30 }).experts).toEqual([]);
    expect(experts('src/a.ts', { sourceIds: ['other'] }).experts).toEqual([]);
    for (let i = 0; i < 4; i++) await add(`recent-${i}`, ['river-login'], ['src/a.ts'], i);
    expect(experts('src/a.ts').experts[0]?.evidence).toEqual([
      'fixture/commit/recent-0',
      'fixture/commit/recent-1',
      'fixture/commit/recent-2',
    ]);
  });
  it('deduplicates aliases using latest activity and breaks score ties by latest activity', async () => {
    await add('same', ['river-login'], ['src/a.ts']);
    db.prepare('INSERT INTO path_facts VALUES (?, ?, ?, ?, ?, ?)').run(
      'fixture/commit/same',
      'fixture',
      'src/b.ts',
      'River Example',
      'commit_author',
      new Date(NOW - 180 * 86_400_000).toISOString(),
    );
    expect(experts('src').experts[0]?.score).toBe(1);
    await add('older-person', ['sage'], ['src/a.ts'], 180);
    await add('newer-person', ['taylor'], ['src/a.ts']);
    expect(experts('src', { limit: 1 }).experts[0]?.name).toBe('River Example');
    expect(experts('src').experts.map((e) => e.name)).toEqual(['River Example', 'taylor', 'sage']);
  });
  it('uses recent activity for equal unrounded scores and defaults to five people', async () => {
    await add('older-one', ['older'], ['src/tie.ts'], 180);
    await add('older-two', ['older'], ['src/tie.ts'], 180);
    await add('newer', ['newer'], ['src/tie.ts']);
    expect(experts('src/tie.ts').experts.map((e) => e.name)).toEqual(['newer', 'older']);
    for (let i = 0; i < 8; i++) await add(`person-${i}`, [`person-${i}`], ['src/limit.ts']);
    expect(experts('src/limit.ts').experts).toHaveLength(5);
    expect(experts('src/limit.ts', { limit: 20 }).experts).toHaveLength(8);
  });

  it('CLI prints text and JSON and rejects invalid limit/since before opening an index', async () => {
    vi.stubEnv('WAYMARK_HOME', tmp);
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    await add('cli', ['sage'], ['src/a.ts']);
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    expect(await main(['experts', 'src'])).toBe(0);
    expect(out.mock.calls[0]?.[0]).toBe(formatExperts(experts('src')));
    out.mockClear();
    expect(await main(['experts', 'src', '--json'])).toBe(0);
    expect(JSON.parse(String(out.mock.calls[0]?.[0]))).toEqual(experts('src'));
    for (const [flag, value] of [
      ['limit', '21'],
      ['limit', 'no'],
      ['since', '0'],
      ['since', '1.5'],
    ]) {
      err.mockClear();
      expect(await main(['experts', 'src', `--${flag}`, value as string])).toBe(1);
      expect(err.mock.calls[0]?.[0]).toBe(`error: invalid ${flag} "${value}"\n`);
    }
    out.mockClear();
    expect(await main(['experts', 'absent'])).toBe(0);
    expect(out.mock.calls[0]?.[0]).toBe('No one found for "absent".\n');
  });
});
