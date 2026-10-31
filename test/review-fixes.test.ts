// Regression tests for the findings of the post-MVP review (secret leaks, handoff scoping,
// reindex robustness, CRLF, GitHub rendering edge cases).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleCursorHook } from '../src/agents/cursor.js';
import { claimHandoff, createHandoff } from '../src/agents/handoff.js';
import { handleHermesHook } from '../src/agents/hermes.js';
import { main } from '../src/cli.js';
import { initHome } from '../src/config.js';
import type { GhReviewComment } from '../src/connectors/github/api.js';
import { mapGithubError } from '../src/connectors/github/client.js';
import { githubConnector, renderPull } from '../src/connectors/github/index.js';
import { openDb, reindex } from '../src/index/db.js';
import { search } from '../src/index/search.js';
import { resolvePaths } from '../src/paths.js';
import { redact } from '../src/redact.js';
import { makeId, noteStampId, parseId, type WaymarkDoc } from '../src/store/doc.js';
import { listDocs, readDoc, serializeDoc, writeDoc } from '../src/store/markdown.js';
import { commitWiki } from '../src/store/wikigit.js';
import { syncAll } from '../src/sync.js';

// built by concatenation so push protection never sees a real-looking token
const TOKEN = `ghp_${'a1B2'.repeat(9)}`;

const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true });
});

async function tmp(): Promise<string> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'waymark-'));
  dirs.push(d);
  return d;
}

async function initialisedHome() {
  const paths = resolvePaths({ WAYMARK_HOME: await tmp() });
  await initHome(paths);
  return paths;
}

const doc = (over: Partial<WaymarkDoc> = {}): WaymarkDoc => ({
  id: 'src/note/1',
  kind: 'note',
  sourceId: 'src',
  title: 'title',
  authors: [],
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  tags: [],
  body: 'body',
  ...over,
});

const gitLog = (cwd: string) =>
  execFileSync('git', ['log', '--format=%s'], { cwd, encoding: 'utf8' });

describe('secrets never reach the index, ids or git history', () => {
  it('sync indexes the redacted doc, not the raw one', async () => {
    const paths = await initialisedHome();
    await fs.writeFile(
      paths.config,
      JSON.stringify({ version: 1, sources: [{ id: 'fake', type: 'git', path: '.' }] }),
    );
    const leaky = doc({ id: 'fake/note/1', sourceId: 'fake', title: `leak ${TOKEN}`, body: TOKEN });
    await syncAll(paths, {
      connectors: {
        fake: async (ctx) => {
          await ctx.emit(leaky);
          return { cursor: null, count: 1 };
        },
      },
    });
    const db = openDb(paths.db);
    try {
      const row = db.prepare('SELECT title FROM docs WHERE id = ?').get('fake/note/1') as {
        title: string;
      };
      expect(row.title).not.toContain(TOKEN);
      expect(JSON.stringify(search(db, { query: 'leak' }))).not.toContain(TOKEN);
    } finally {
      db.close();
    }
  });

  it('writeDoc redacts tags and returns the stored doc', async () => {
    const wiki = await tmp();
    const { doc: stored } = await writeDoc(wiki, doc({ tags: [`t:${TOKEN}`], body: 'a\r\nb' }));
    expect(stored.tags[0]).toBe('t:[REDACTED:github-token]');
    expect(stored.body).toBe('a\nb');
    expect(stored).toEqual(await readDoc(wiki, stored.id));
  });

  it('note/handoff ids are built from the redacted title', () => {
    const id = noteStampId('note', `leak ${TOKEN}`, new Date('2026-10-30T00:00:00Z'));
    expect(id.toLowerCase()).not.toContain(TOKEN.toLowerCase());
  });

  it('commit messages are redacted', async () => {
    const wiki = await tmp();
    await writeDoc(wiki, doc());
    expect(await commitWiki(wiki, `note: ${TOKEN}`)).toBe(true);
    expect(gitLog(wiki)).not.toContain(TOKEN);
  });

  it('a bearer token after Password= is redacted', () => {
    const out = redact(`Password=Bearer ${'x'.repeat(30)}`);
    expect(out).not.toContain('x'.repeat(30));
  });
});

describe('store and index robustness', () => {
  it('rejects ids that point into hidden dirs', () => {
    expect(() => parseId('.git/note/x')).toThrow('Invalid document id');
  });

  it('serializes CRLF bodies with LF only', () => {
    expect(serializeDoc(doc({ body: 'a\r\nb\rc' }))).not.toContain('\r');
  });

  it('reindex skips files with a bad id or a path that does not match the id', async () => {
    const dir = await tmp();
    const wiki = path.join(dir, 'wiki');
    await writeDoc(wiki, doc());
    await fs.mkdir(path.join(wiki, 'z'), { recursive: true });
    const good = await fs.readFile(path.join(wiki, 'src/note/1.md'), 'utf8');
    await fs.writeFile(path.join(wiki, 'z/bad.md'), good.replace('id: src/note/1', 'id: foo'));
    await fs.writeFile(path.join(wiki, 'z/copy.md'), good);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const db = openDb(path.join(dir, 'db.sqlite'));
    try {
      expect(await reindex(db, wiki)).toEqual({ count: 1 });
      const row = db.prepare('SELECT path FROM docs').get() as { path: string };
      expect(row.path).toBe('src/note/1.md');
    } finally {
      db.close();
    }
    const seen: string[] = [];
    for await (const d of listDocs(wiki)) seen.push(d.doc.id);
    expect(seen).toEqual(['src/note/1']);
  });
});

describe('handoff claim', () => {
  it('the conditional UPDATE loses when another connection claims in between', async () => {
    const dir = await tmp();
    const wiki = path.join(dir, 'wiki');
    const dbPath = path.join(dir, 'db.sqlite');
    const a = openDb(dbPath);
    const b = openDb(dbPath);
    try {
      const id = await createHandoff(a, wiki, {
        title: 'Race',
        summary: 's',
        nextSteps: 'n',
        project: 'p',
      });
      // let `a` read the open row, then let `b` win before `a` runs its UPDATE
      let bClaim: ReturnType<typeof claimHandoff> | undefined;
      const prepare = a.prepare.bind(a);
      vi.spyOn(a, 'prepare').mockImplementation(((sql: string) => {
        if (sql.startsWith('UPDATE docs SET tags') && !bClaim) bClaim = claimHandoff(b, wiki, id);
        return prepare(sql);
      }) as typeof a.prepare);
      const aRes = await claimHandoff(a, wiki, id);
      expect(aRes).toEqual({ ok: false, reason: 'already_claimed' });
      expect((await bClaim)?.ok).toBe(true);
      expect((await readDoc(wiki, id))?.tags).toContain('status:claimed');
      expect(gitLog(wiki)).toContain('handoff claimed: Race');
    } finally {
      a.close();
      b.close();
    }
  });

  it('handoffs are searchable by kind', async () => {
    const dir = await tmp();
    const db = openDb(path.join(dir, 'db.sqlite'));
    try {
      await createHandoff(db, path.join(dir, 'wiki'), {
        title: 'Finish parser',
        summary: 's',
        nextSteps: 'n',
        project: 'p',
      });
      const hits = search(db, { query: 'parser', kinds: ['handoff'] });
      expect(hits.map((h) => h.kind)).toEqual(['handoff']);
    } finally {
      db.close();
    }
  });
});

describe('Cursor and Hermes start-up context is scoped to the project', () => {
  async function homeWithHandoffs() {
    const paths = await initialisedHome();
    const db = openDb(paths.db);
    try {
      for (const project of ['mine', 'other']) {
        await createHandoff(db, paths.wiki, {
          title: `Work for ${project}`,
          summary: 's',
          nextSteps: 'n',
          project,
        });
      }
    } finally {
      db.close();
    }
    return paths;
  }

  it('cursor sessionStart lists only this project', async () => {
    const paths = await homeWithHandoffs();
    const out = await handleCursorHook(
      JSON.stringify({ hook_event_name: 'sessionStart', workspace_roots: ['/w/mine'] }),
      paths,
    );
    const ctx = JSON.parse(out).additional_context as string;
    expect(ctx).toContain('Work for mine');
    expect(ctx).not.toContain('Work for other');
  });

  it('cursor ignores a non-array workspace_roots', async () => {
    const paths = await homeWithHandoffs();
    const out = await handleCursorHook(
      JSON.stringify({ hook_event_name: 'sessionStart', workspace_roots: 'C:/w/mine' }),
      paths,
    );
    expect(JSON.parse(out).additional_context).not.toContain('project:C');
  });

  it('hermes first turn lists only this project', async () => {
    const paths = await homeWithHandoffs();
    const out = await handleHermesHook(
      JSON.stringify({
        hook_event_name: 'pre_llm_call',
        session_id: 'h',
        cwd: '/w/mine',
        extra: { is_first_turn: true },
      }),
      paths,
    );
    const ctx = JSON.parse(out).context as string;
    expect(ctx).toContain('Work for mine');
    expect(ctx).not.toContain('Work for other');
  });
});

describe('GitHub rendering and errors', () => {
  const user = { login: 'rev', type: 'User' };
  const comment = (id: number, body: string, reply?: number): GhReviewComment => ({
    id,
    user,
    body,
    path: 'src/a.ts',
    line: null,
    original_line: null,
    diff_hunk: '@@ -1 +1 @@\n+x',
    created_at: `2026-10-0${id}T00:00:00Z`,
    html_url: `https://github.com/o/r/pull/1#c${id}`,
    ...(reply === undefined ? {} : { in_reply_to_id: reply }),
  });
  const pr = {
    number: 1,
    title: 'PR',
    body: 'desc',
    state: 'open' as const,
    merged_at: null,
    created_at: '2026-10-01T00:00:00Z',
    updated_at: '2026-10-02T00:00:00Z',
    html_url: 'https://github.com/o/r/pull/1',
    user,
    labels: [],
    base: { ref: 'main' },
    head: { ref: 'x' },
  };

  it('keeps replies to replies in the thread and normalises CRLF', () => {
    const body = renderPull(
      'gh',
      pr,
      [
        {
          id: 9,
          user,
          state: 'APPROVED',
          body: 'one\r\ntwo',
          submitted_at: '2026-10-02T00:00:00Z',
          html_url: '',
        },
      ],
      [comment(1, 'root'), comment(2, 'reply\r\nline2', 1), comment(3, 'reply to reply', 2)],
      [{ id: 7, user, body: '', created_at: '2026-10-05T00:00:00Z', html_url: '' }],
    ).body;
    expect(body).not.toContain('\r');
    expect(body).toContain('APPROVED (2026-10-02): one two');
    expect(body).toContain('reply to reply');
    expect(body).toContain('  - **@rev** (2026-10-02): reply\n    line2');
    expect(body).toContain('### `src/a.ts`\n');
    expect(body).toMatch(/- \*\*@rev\*\* \(2026-10-05\)$/m);
    expect(body).not.toContain('(2026-10-05): ');
  });

  it('a missing rate-limit reset header does not crash the error mapping', () => {
    const err = mapGithubError(
      { status: 403, response: { headers: { 'x-ratelimit-remaining': '0' } } },
      'o',
      'r',
    );
    expect((err as Error).message).toBe('GitHub rate limit exceeded; resets');
  });

  it('an empty GITHUB_TOKEN falls back to GH_TOKEN', async () => {
    vi.stubEnv('GITHUB_TOKEN', '');
    vi.stubEnv('GH_TOKEN', 'x');
    const paths = await initialisedHome();
    await fs.writeFile(
      paths.config,
      JSON.stringify({
        version: 1,
        sources: [{ id: 'gh', type: 'github', repo: 'o/r', auth: 'personal' }],
      }),
    );
    // no api passed: the connector reads the token itself; include: [] makes no network calls
    const [res] = await syncAll(paths, {
      connectors: {
        gh: githubConnector({
          id: 'gh',
          type: 'github',
          repo: 'o/r',
          include: [],
          auth: 'personal',
        }),
      },
    });
    expect(res?.error).toBeUndefined();
  });
});

describe('CLI', () => {
  it('rejects a non-positive or fractional --limit', async () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    for (const limit of ['0', '-1', '2.5']) {
      expect(await main(['search', 'x', '--limit', limit])).toBe(1);
    }
  });

  it('sync a git source, then search finds a commit subject (end to end)', async () => {
    const repo = await tmp();
    const git = (...args: string[]) =>
      execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], {
        cwd: repo,
        env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' },
      });
    git('init', '-q');
    git('config', 'user.name', 'T');
    git('config', 'user.email', 't@example.com');
    await fs.writeFile(path.join(repo, 'ação.ts'), 'x');
    git('add', '-A');
    git('commit', '-q', '-m', 'introduce flamingo parser');

    const home = await tmp();
    vi.stubEnv('WAYMARK_HOME', home);
    const out: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((s) => {
      out.push(String(s));
      return true;
    });
    expect(await main(['init'])).toBe(0);
    await fs.writeFile(
      path.join(home, 'config.json'),
      JSON.stringify({ version: 1, sources: [{ id: 'repo', type: 'git', path: repo }] }),
    );
    expect(await main(['sync'])).toBe(0);
    expect(out.join('')).toContain('repo: 1 documents');
    out.length = 0;
    expect(await main(['search', 'flamingo'])).toBe(0);
    expect(out.join('')).toContain('introduce flamingo parser');
    // non-ASCII file names are not octal-escaped
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    const stored = await readDoc(path.join(home, 'wiki'), makeId('repo', 'commit', sha));
    expect(stored?.body).toContain('- ação.ts');
  });
});
