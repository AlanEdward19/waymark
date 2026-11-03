import { describe, expect, it } from 'vitest';
import { azureDevOpsConnector } from '../src/connectors/azure-devops/index.js';
import {
  type AdoPullRequest,
  type AdoPullsApi,
  type AdoPullThread,
  createPullsApi,
} from '../src/connectors/azure-devops/pulls.js';
import type { WaymarkDoc } from '../src/store/doc.js';

const source = {
  id: 'ado',
  type: 'azure-devops' as const,
  auth: 'app' as const,
  organization: 'contoso',
  project: 'My Shop',
  include: ['pulls' as const],
};
const pr = (
  id: number,
  creationDate = '2026-10-10T00:00:00Z',
  status = 'active',
): AdoPullRequest => ({
  pullRequestId: id,
  title: `PR ${id}`,
  status,
  creationDate,
  sourceRefName: 'refs/heads/feature',
  targetRefName: 'refs/heads/main',
  createdBy: { displayName: 'Dana', uniqueName: 'dana@example.com' },
});
function fake(pages: AdoPullRequest[][], threads: AdoPullThread[] = []) {
  const calls: string[] = [];
  const api: AdoPullsApi = {
    repositories: async () => [
      { id: 'r1', name: 'app' },
      { id: 'r2', name: 'other' },
    ],
    pullRequests: async (repo, skip) => {
      calls.push(`${repo}:${skip}`);
      return pages[skip / 100] ?? [];
    },
    pullRequest: async (_repo, id) => ({
      ...(pages.flat().find((p) => p.pullRequestId === id) as AdoPullRequest),
      description: 'Full\r\ndescription',
    }),
    threads: async (_repo, id) => {
      calls.push(`threads:${id}`);
      return threads;
    },
  };
  return { api, calls };
}
async function run(api: AdoPullsApi, options: { cursor?: string | null; repos?: string[] } = {}) {
  const docs: WaymarkDoc[] = [];
  const result = await azureDevOpsConnector(
    { ...source, repos: options.repos ?? ['app'] },
    { pullsApi: api },
  )({
    sourceId: 'ado',
    cursor: options.cursor ?? null,
    emit: async (d) => {
      docs.push(d);
    },
    log: () => {},
    remove: async () => {},
    readDoc: async () => null,
    listIds: () => [],
  });
  return { docs, result };
}

describe('Azure Repos pulls', () => {
  it('renders votes, file replies and conversation; excludes system and deleted comments and identity e-mails', async () => {
    const pull = {
      ...pr(7),
      reviewers: [
        { displayName: 'Eve', vote: -10, uniqueName: 'eve@example.com' },
        { displayName: 'Zero', vote: 0 },
        { displayName: 'Approved', vote: 10 },
        { displayName: 'Suggestions', vote: 5 },
        { displayName: 'Waiting', vote: -5 },
      ],
    };
    const comment = {
      author: { displayName: 'Eve', uniqueName: 'eve@example.com' },
      publishedDate: '2026-10-11T00:00:00Z',
      commentType: 'text',
      content: 'First\r\nsecond',
    };
    const f = fake(
      [[pull]],
      [
        {
          status: 'fixed',
          threadContext: { filePath: '/src/a.ts', rightFileStart: { line: 9 } },
          comments: [
            comment,
            { ...comment, content: 'Reply', parentCommentId: 1 },
            { ...comment, content: 'Deleted secret', isDeleted: true },
            { ...comment, content: 'System secret', commentType: 'system' },
          ],
        },
        { comments: [{ ...comment, content: 'General' }] },
        { comments: [{ ...comment, content: 'System only', commentType: 'system' }] },
        { comments: [{ ...comment, content: 'Code change', commentType: 'codeChange' }] },
      ],
    );
    const { docs, result } = await run(f.api);
    const doc = docs[0] as WaymarkDoc;
    expect(doc.id).toBe('ado/pull_request/app-7');
    expect(doc.url).toBe('https://dev.azure.com/contoso/My%20Shop/_git/app/pullrequest/7');
    expect(doc.body).toContain('!7 · active · @Dana · main ← feature\n\nFull\ndescription');
    expect(doc.body).toContain('### `/src/a.ts` line 9 (fixed)');
    expect(doc.body).toContain(
      '- **Eve** (2026-10-11): First\n  second\n  - **Eve** (2026-10-11): Reply',
    );
    expect(doc.body).toContain('## Conversation\n\n- **Eve** (2026-10-11): General');
    expect(doc.tags).toEqual([
      'state:active',
      'repo:app',
      'vote:Eve:rejected',
      'vote:Approved:approved',
      'vote:Suggestions:approved-with-suggestions',
      'vote:Waiting:waiting',
    ]);
    expect(doc.body).toContain('- **Eve** rejected');
    expect(JSON.stringify(doc)).not.toMatch(/secret|System only|Code change|example.com|\r/);
    expect(doc.updatedAt).toBe('2026-10-11T00:00:00.000Z');
    expect(JSON.parse(result.cursor as string)).toEqual({ pulls: '2026-10-10T00:00:00.000Z' });
  });

  it('processes old active and boundary PRs, skips old completed PRs, stops paging with no qualifying PR', async () => {
    const old = '2026-08-01T00:00:00Z';
    const page = Array.from({ length: 100 }, (_, i) => pr(i + 1, old, 'completed'));
    page[0] = pr(1, old, 'active');
    page[1] = pr(2, '2026-09-01T00:00:00Z', 'completed');
    const f = fake([
      page,
      Array.from({ length: 100 }, (_, i) => pr(i + 101, old, 'completed')),
      [pr(201)],
    ]);
    const { docs, result } = await run(f.api, {
      cursor: JSON.stringify({ pulls: '2026-10-01T00:00:00Z', workitems: '2026-09-01T00:00:00Z' }),
    });
    expect(docs.map((d) => d.title)).toEqual(['PR 1', 'PR 2']);
    expect(f.calls).toEqual(['r1:0', 'threads:1', 'threads:2', 'r1:100']);
    expect(JSON.parse(result.cursor as string)).toEqual({
      pulls: '2026-10-01T00:00:00Z',
      workitems: '2026-09-01T00:00:00Z',
    });
  });

  it('first run follows full pages, retains newest creation date, and invalid cursors restart', async () => {
    const page = Array.from({ length: 100 }, (_, i) =>
      pr(i + 1, '2026-01-01T00:00:00Z', 'completed'),
    );
    const f = fake([page, [pr(101, '2026-10-01T00:00:00.5Z')]]);
    const { docs, result } = await run(f.api, { cursor: '{"pulls":"invalid"}' });
    expect(docs).toHaveLength(101);
    expect(f.calls).toContain('r1:100');
    expect(JSON.parse(result.cursor as string)).toEqual({ pulls: '2026-10-01T00:00:00.500Z' });
  });

  it('honours repository names and errors before writing for an unknown repository', async () => {
    const f = fake([[pr(1)]]);
    await run(f.api, { repos: ['other'] });
    expect(f.calls).toEqual(['r2:0', 'threads:1']);
    await expect(run(f.api, { repos: ['app', 'missing'] })).rejects.toThrow('repository "missing"');
  });

  it('omits empty sections and provides a description fallback', async () => {
    const f = fake([[pr(1)]]);
    f.api.pullRequest = async () => pr(1);
    const { docs } = await run(f.api);
    expect(docs[0]?.body).toContain('_No description._');
    expect(docs[0]?.body).not.toContain('##');
  });

  it('requests the exact endpoints with app auth and full PR descriptions', async () => {
    const calls: Array<{ url: string; auth: string }> = [];
    const impl = (async (url: string, init: RequestInit) => {
      calls.push({ url, auth: (init.headers as Record<string, string>).authorization as string });
      if (url.endsWith('/repositories?api-version=7.1'))
        return Response.json({ value: [{ id: 'repo/id', name: 'app' }] });
      if (url.includes('searchCriteria'))
        return Response.json({ value: [{ ...pr(1), description: 'truncated' }] });
      if (url.includes('/threads?')) return Response.json({ value: [] });
      return Response.json({ ...pr(1), description: 'x'.repeat(600) });
    }) as unknown as typeof fetch;
    const docs: WaymarkDoc[] = [];
    await azureDevOpsConnector(source, {
      fetch: impl,
      tokens: { getToken: async () => 'synthetic' },
    })({
      sourceId: 'ado',
      cursor: null,
      emit: async (d) => {
        docs.push(d);
      },
      log: () => {},
      remove: async () => {},
      readDoc: async () => null,
      listIds: () => [],
    });
    expect(calls.map((c) => c.url)).toEqual([
      'https://dev.azure.com/contoso/My%20Shop/_apis/git/repositories?api-version=7.1',
      'https://dev.azure.com/contoso/My%20Shop/_apis/git/repositories/repo%2Fid/pullRequests?searchCriteria.status=all&$top=100&$skip=0&api-version=7.1',
      'https://dev.azure.com/contoso/My%20Shop/_apis/git/repositories/repo%2Fid/pullRequests/1?api-version=7.1',
      'https://dev.azure.com/contoso/My%20Shop/_apis/git/repositories/repo%2Fid/pullRequests/1/threads?api-version=7.1',
    ]);
    expect(calls.every((c) => c.auth === 'Bearer synthetic')).toBe(true);
    expect(docs[0]?.body).toContain('x'.repeat(600));
  });

  it.each([401, 403])('provides repository access guidance on HTTP %i', async (status) => {
    const api = createPullsApi(
      'contoso',
      'P',
      async () => 'Bearer fake',
      (async () => new Response('{}', { status })) as typeof fetch,
    );
    await expect(api.repositories()).rejects.toThrow('Basic access and repository Read permission');
  });
});
