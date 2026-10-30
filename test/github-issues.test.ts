import { describe, expect, it } from 'vitest';
import type { GhIssue, GhIssueComment, GhPull, GithubApi } from '../src/connectors/github/api.js';
import { githubConnector } from '../src/connectors/github/index.js';
import type { WaymarkDoc } from '../src/store/doc.js';

const user = (login: string, type = 'User') => ({ login, type });

function issue(n: number, updated: string, extra: Partial<GhIssue> = {}): GhIssue {
  return {
    number: n,
    title: `Issue ${n}`,
    body: 'Something broke.',
    state: 'open',
    created_at: '2026-10-01T00:00:00Z',
    updated_at: updated,
    html_url: `https://github.com/o/r/issues/${n}`,
    user: user('dana'),
    labels: [],
    ...extra,
  };
}

function fakeApi(pages: GhIssue[][], conv: GhIssueComment[] = [], pulls: GhPull[] = []) {
  const sinceArgs: Array<string | undefined> = [];
  const calls = { pulls: 0, issues: 0 };
  const api: GithubApi = {
    async *pullPages() {
      calls.pulls++;
      yield pulls;
    },
    async *issuePages(_o, _r, since) {
      calls.issues++;
      sinceArgs.push(since);
      yield* pages;
    },
    reviews: async () => [],
    reviewComments: async () => [],
    issueComments: async () => conv,
  };
  return { api, sinceArgs, calls };
}

async function run(
  api: GithubApi,
  include: Array<'pulls' | 'issues'> = ['issues'],
  cursor: string | null = null,
) {
  const docs: WaymarkDoc[] = [];
  const res = await githubConnector(
    { id: 'gh', type: 'github', repo: 'o/r', include },
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

describe('github issues', () => {
  it('maps issues, ignores PRs, normalises labels and state reasons', async () => {
    const { api } = fakeApi(
      [
        [
          issue(1, '2026-10-02T00:00:00Z', {
            state: 'closed',
            state_reason: 'not_planned',
            labels: ['bug', { name: 'help wanted' }],
          }),
          issue(2, '2026-10-03T00:00:00Z', { body: null, user: null }),
          issue(3, '2026-10-04T00:00:00Z', { pull_request: {} }),
        ],
      ],
      [
        {
          id: 1,
          user: user('carol'),
          body: 'Me too\nreally',
          created_at: '2026-10-03T00:00:00Z',
          html_url: '',
        },
        {
          id: 2,
          user: user('ci[bot]', 'Bot'),
          body: 'stale',
          created_at: '2026-10-03T01:00:00Z',
          html_url: '',
        },
      ],
    );
    const { docs, count } = await run(api);
    expect(count).toBe(2);
    expect(docs.map((d) => d.id)).toEqual(['gh/issue/1', 'gh/issue/2']);
    const [a, b] = docs as [WaymarkDoc, WaymarkDoc];
    expect(a.kind).toBe('issue');
    expect(a.url).toBe('https://github.com/o/r/issues/1');
    expect(a.tags).toEqual(['state:not_planned', 'label:bug', 'label:help wanted']);
    expect(a.authors).toEqual(['dana', 'carol']);
    expect(a.body).toBe(
      '#1 · not_planned · @dana\n\nSomething broke.\n\n## Conversation\n\n- **@carol** (2026-10-03): Me too\n  really',
    );
    expect(b.authors).toEqual(['carol']);
    expect(b.tags).toEqual(['state:open']);
    expect(b.body.startsWith('#2 · open · @ghost\n\n_No description._')).toBe(true);
  });

  it('passes the previous cursor as since and keeps it when nothing returns', async () => {
    const first = fakeApi([[issue(1, '2026-10-02T00:00:00Z'), issue(2, '2026-10-03T00:00:00Z')]]);
    const r1 = await run(first.api);
    expect(first.sinceArgs).toEqual([undefined]);
    expect(r1.cursor).toBe(JSON.stringify({ issues: '2026-10-03T00:00:00Z' }));

    const second = fakeApi([[]]);
    const r2 = await run(second.api, ['issues'], r1.cursor);
    expect(second.sinceArgs).toEqual(['2026-10-03T00:00:00Z']);
    expect(r2.cursor).toBe(r1.cursor);
  });

  it('only calls the endpoints listed in include', async () => {
    const a = fakeApi([[]]);
    await run(a.api, ['issues']);
    expect(a.calls).toEqual({ pulls: 0, issues: 1 });
    const b = fakeApi([[]]);
    await run(b.api, ['pulls']);
    expect(b.calls).toEqual({ pulls: 1, issues: 0 });
  });

  it('stores both cursors when both are enabled', async () => {
    const pr = {
      number: 9,
      title: 'PR',
      body: null,
      state: 'open',
      merged_at: null,
      created_at: '2026-10-01T00:00:00Z',
      updated_at: '2026-10-05T00:00:00Z',
      html_url: '',
      user: user('dana'),
      labels: [],
      base: { ref: 'main' },
      head: { ref: 'x' },
    } satisfies GhPull;
    const { api } = fakeApi([[issue(1, '2026-10-02T00:00:00Z')]], [], [pr]);
    const r = await run(api, ['pulls', 'issues']);
    expect(JSON.parse(r.cursor ?? '')).toEqual({
      pulls: '2026-10-05T00:00:00Z',
      issues: '2026-10-02T00:00:00Z',
    });
  });
});
