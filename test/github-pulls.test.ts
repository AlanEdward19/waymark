import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  GhIssueComment,
  GhPull,
  GhReview,
  GhReviewComment,
  GithubApi,
} from '../src/connectors/github/api.js';
import { mapGithubError } from '../src/connectors/github/client.js';
import { githubConnector } from '../src/connectors/github/index.js';
import { resolvePaths } from '../src/paths.js';
import type { WaymarkDoc } from '../src/store/doc.js';
import { syncAll } from '../src/sync.js';

const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true });
});

const source = { id: 'gh', type: 'github' as const, repo: 'o/r', include: ['pulls' as const] };
const user = (login: string, type = 'User') => ({ login, type });

function pull(n: number, updated: string, extra: Partial<GhPull> = {}): GhPull {
  return {
    number: n,
    title: `PR ${n}`,
    body: 'Adds a thing.',
    state: 'closed',
    merged_at: null,
    created_at: '2026-10-01T00:00:00Z',
    updated_at: updated,
    html_url: `https://github.com/o/r/pull/${n}`,
    user: user('dana'),
    labels: [],
    base: { ref: 'main' },
    head: { ref: 'feat/x' },
    ...extra,
  };
}

interface Data {
  reviews?: GhReview[];
  comments?: GhReviewComment[];
  conv?: GhIssueComment[];
}

function fakeApi(pages: GhPull[][], data: Data = {}) {
  const asked: number[] = [];
  const api: GithubApi = {
    async *pullPages() {
      for (let i = 0; i < pages.length; i++) {
        asked.push(i);
        yield pages[i] as GhPull[];
      }
    },
    async *issuePages() {},
    reviews: async () => data.reviews ?? [],
    reviewComments: async () => data.comments ?? [],
    issueComments: async () => data.conv ?? [],
  };
  return { api, asked };
}

async function run(api: GithubApi, cursor: string | null = null) {
  const docs: WaymarkDoc[] = [];
  const res = await githubConnector(
    source,
    api,
  )({
    sourceId: 'gh',
    cursor,
    log: () => {},
    emit: async (d) => {
      docs.push(d);
    },
  });
  return { docs, ...res };
}

describe('github pulls', () => {
  it('maps a PR with reviews, threads, bots and conversation', async () => {
    const { api } = fakeApi(
      [
        [
          pull(7, '2026-10-03T10:00:00Z', {
            merged_at: '2026-10-03T09:00:00Z',
            labels: [{ name: 'bug' }],
          }),
        ],
      ],
      {
        reviews: [
          {
            id: 1,
            user: user('alice'),
            state: 'APPROVED',
            body: 'Looks\ngood',
            submitted_at: '2026-10-02T08:00:00Z',
            html_url: '',
          },
          {
            id: 2,
            user: user('bob'),
            state: 'COMMENTED',
            body: '',
            submitted_at: '2026-10-02T07:00:00Z',
            html_url: '',
          },
        ],
        comments: [
          {
            id: 10,
            user: user('bob'),
            body: 'Why?\nReally.',
            path: 'src/x.ts',
            line: 42,
            original_line: 40,
            diff_hunk: 'a\nb\nc\nd\ne\nf\ng',
            created_at: '2026-10-02T09:00:00Z',
            html_url: '',
          },
          {
            id: 11,
            in_reply_to_id: 10,
            user: user('alan'),
            body: 'Because.',
            path: 'src/x.ts',
            line: 42,
            original_line: 40,
            diff_hunk: 'a',
            created_at: '2026-10-02T10:00:00Z',
            html_url: '',
          },
          {
            id: 12,
            user: user('ci[bot]', 'Bot'),
            body: 'lint',
            path: 'src/x.ts',
            line: 1,
            original_line: 1,
            diff_hunk: 'a',
            created_at: '2026-10-02T11:00:00Z',
            html_url: '',
          },
        ],
        conv: [
          {
            id: 20,
            user: user('carol'),
            body: 'Ship it',
            created_at: '2026-10-03T00:00:00Z',
            html_url: '',
          },
          {
            id: 21,
            user: user('deploy', 'Bot'),
            body: 'deployed',
            created_at: '2026-10-03T01:00:00Z',
            html_url: '',
          },
        ],
      },
    );
    const { docs } = await run(api);
    const doc = docs[0] as WaymarkDoc;
    expect(doc.id).toBe('gh/pull_request/7');
    expect(doc.tags).toEqual(['state:merged', 'label:bug']);
    expect(doc.authors).toEqual(['dana', 'bob', 'alice', 'alan', 'carol']);
    expect(doc.body).toBe(
      [
        '#7 · merged · @dana · main ← feat/x',
        'Adds a thing.',
        '## Reviews\n\n- **@alice** APPROVED (2026-10-02): Looks good',
        '## Review comments\n\n### `src/x.ts` line 42\n\n```diff\nb\nc\nd\ne\nf\ng\n```\n\n- **@bob** (2026-10-02): Why?\n  Really.\n  - **@alan** (2026-10-02): Because.',
        '## Conversation\n\n- **@carol** (2026-10-03): Ship it',
      ].join('\n\n'),
    );
  });

  it('omits empty sections and uses the placeholder description', async () => {
    const { api } = fakeApi([[pull(1, '2026-10-03T00:00:00Z', { body: null })]]);
    const { docs } = await run(api);
    expect(docs[0]?.body).toBe('#1 · closed · @dana · main ← feat/x\n\n_No description._');
  });

  it('is incremental and stops at the first older PR', async () => {
    const three = [
      pull(3, '2026-10-03T00:00:00Z'),
      pull(2, '2026-10-02T00:00:00Z'),
      pull(1, '2026-10-01T00:00:00Z'),
    ];
    const first = await run(fakeApi([three]).api);
    expect(first.docs).toHaveLength(3);
    expect(first.cursor).toBe(JSON.stringify({ pulls: '2026-10-03T00:00:00Z' }));

    const { api, asked } = fakeApi([
      [
        pull(4, '2026-10-04T00:00:00Z'),
        pull(3, '2026-10-03T00:00:00Z'),
        pull(2, '2026-10-02T00:00:00Z'),
      ],
      [pull(1, '2026-10-01T00:00:00Z')],
    ]);
    const second = await run(api, first.cursor);
    expect(second.docs.map((d) => d.id)).toEqual(['gh/pull_request/4', 'gh/pull_request/3']);
    expect(asked).toEqual([0]);
    expect(JSON.parse(second.cursor ?? '').pulls).toBe('2026-10-04T00:00:00Z');
  });

  it('keeps an existing issues cursor and tolerates invalid cursors', async () => {
    const { api } = fakeApi([[pull(1, '2026-10-03T00:00:00Z')]]);
    const r = await run(api, JSON.stringify({ issues: '2026-09-01T00:00:00Z' }));
    expect(JSON.parse(r.cursor ?? '')).toEqual({
      issues: '2026-09-01T00:00:00Z',
      pulls: '2026-10-03T00:00:00Z',
    });
    expect((await run(fakeApi([[pull(1, '2026-10-03T00:00:00Z')]]).api, 'garbage')).count).toBe(1);
    const empty = await run(fakeApi([[]]).api, JSON.stringify({ pulls: 'x' }));
    expect(JSON.parse(empty.cursor ?? '').pulls).toBe('x');
  });

  it('maps rate limit and 404 errors', () => {
    const rl = mapGithubError(
      {
        status: 403,
        response: { headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1767225600' } },
      },
      'o',
      'r',
    );
    expect((rl as Error).message).toBe(
      'GitHub rate limit exceeded; resets at 2026-01-01T00:00:00.000Z',
    );
    expect((mapGithubError({ status: 404 }, 'o', 'r') as Error).message).toBe(
      'GitHub repo o/r not found or token lacks access',
    );
    const other = { status: 500 };
    expect(mapGithubError(other, 'o', 'r')).toBe(other);
  });

  it('syncAll reports a missing token and continues', async () => {
    vi.stubEnv('GITHUB_TOKEN', '');
    vi.stubEnv('GH_TOKEN', '');
    delete process.env.GITHUB_TOKEN;
    delete process.env.GH_TOKEN;
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'waymark-'));
    dirs.push(dir);
    await fs.writeFile(
      path.join(dir, 'config.json'),
      JSON.stringify({
        version: 1,
        sources: [
          { id: 'gh', type: 'github', repo: 'o/r' },
          { id: 'other', type: 'git', path: '.' },
        ],
      }),
    );
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const results = await syncAll(resolvePaths({ WAYMARK_HOME: dir }), {
      connectors: { other: async () => ({ cursor: null, count: 0 }) },
    });
    expect(results).toEqual([
      {
        sourceId: 'gh',
        count: 0,
        error:
          'Source "gh": set GITHUB_TOKEN (or GH_TOKEN) to sync GitHub. Tip: GITHUB_TOKEN=$(gh auth token) waymark sync',
      },
      { sourceId: 'other', count: 0 },
    ]);
  });
});
