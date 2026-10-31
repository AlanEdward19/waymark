import { afterEach, describe, expect, it, vi } from 'vitest';
import { linearConnector } from '../src/connectors/linear.js';
import type { WaymarkDoc } from '../src/store/doc.js';

const SECRET_KEY = 'lin_api_SYNTHETIC';

function node(identifier: string, updatedAt: string, extra: Record<string, unknown> = {}) {
  return {
    identifier,
    title: `Issue ${identifier}`,
    description: 'It broke.',
    url: `https://linear.app/t/issue/${identifier}`,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt,
    archivedAt: null,
    state: { name: 'In Progress', type: 'started' },
    labels: { nodes: [{ name: 'bug' }] },
    creator: { name: 'Dana' },
    comments: { nodes: [] },
    ...extra,
  };
}

const gql = (nodes: unknown[], hasNextPage = false, endCursor: string | null = null) => ({
  data: { issues: { pageInfo: { hasNextPage, endCursor }, nodes } },
});

function fakeFetch(responses: unknown[]) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const body = responses.shift();
    return new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

async function run(
  responses: unknown[],
  opts: { team?: string; auth?: 'app' | 'personal'; cursor?: string | null } = {},
) {
  const f = fakeFetch(responses);
  const docs: WaymarkDoc[] = [];
  const logs: string[] = [];
  const res = await linearConnector(
    { id: 'lin', type: 'linear', auth: opts.auth ?? 'personal', team: opts.team },
    {
      fetch: f.impl,
      env: { WAYMARK_LINEAR_CLIENT_ID: 'cid', WAYMARK_LINEAR_CLIENT_SECRET: 'sec' },
    },
  )({
    sourceId: 'lin',
    cursor: opts.cursor ?? null,
    log: (m) => logs.push(m),
    emit: async (d) => {
      docs.push(d);
    },
    remove: async () => {},
    listIds: () => [],
  });
  return { docs, logs, calls: f.calls, ...res };
}

const vars = (call: { init: RequestInit }) =>
  JSON.parse(call.init.body as string).variables as { after: string | null; filter: unknown };

const auth = (call: { init: RequestInit }) =>
  (call.init.headers as Record<string, string>).authorization;

afterEach(() => vi.unstubAllEnvs());

describe('linear connector', () => {
  it('pages, maps docs, and filters by cursor and team only when set', async () => {
    vi.stubEnv('LINEAR_API_KEY', SECRET_KEY);
    const comments = {
      nodes: [
        {
          body: 'Looks\nbad',
          createdAt: '2026-10-02T00:00:00Z',
          user: { name: 'Eli' },
          botActor: null,
        },
        { body: 'bot', createdAt: '2026-10-02T00:00:00Z', user: null, botActor: { name: 'Bot' } },
        {
          body: 'bot2',
          createdAt: '2026-10-02T00:00:00Z',
          user: { name: 'X' },
          botActor: { name: 'Bot' },
        },
      ],
    };
    const r = await run(
      [
        gql([node('ENG-1', '2026-10-03T00:00:00.000Z', { comments })], true, 'c1'),
        gql([node('ENG-2', '2026-10-05T00:00:00.000Z', { archivedAt: '2026-10-06T00:00:00Z' })]),
      ],
      { team: 'ENG' },
    );
    expect(r.count).toBe(2);
    expect(r.cursor).toBe('2026-10-05T00:00:00.000Z');
    expect(vars(r.calls[0] as never)).toEqual({
      after: null,
      filter: { team: { key: { eq: 'ENG' } } },
    });
    expect(vars(r.calls[1] as never).after).toBe('c1');
    expect(auth(r.calls[0] as never)).toBe(SECRET_KEY);
    const [a, b] = r.docs;
    expect(a?.id).toBe('lin/issue/ENG-1');
    expect(a?.tags).toEqual(['state:started', 'label:bug']);
    expect(a?.authors).toEqual(['Dana', 'Eli']);
    expect(a?.body).toBe(
      'ENG-1 · In Progress · @Dana\n\nIt broke.\n\n## Conversation\n\n- **Eli** (2026-10-02): Looks\n  bad',
    );
    expect(b?.tags).toContain('archived');

    const second = await run([gql([])], { cursor: r.cursor });
    expect(vars(second.calls[0] as never).filter).toEqual({
      updatedAt: { gt: '2026-10-05T00:00:00.000Z' },
    });
    expect(second.cursor).toBe('2026-10-05T00:00:00.000Z');
  });

  it('logs when a comment page is full', async () => {
    vi.stubEnv('LINEAR_API_KEY', SECRET_KEY);
    const full = Array.from({ length: 50 }, () => ({
      body: 'x',
      createdAt: '2026-10-02T00:00:00Z',
      user: { name: 'Eli' },
      botActor: null,
    }));
    const r = await run([
      gql([node('ENG-1', '2026-10-03T00:00:00Z', { comments: { nodes: full } })]),
    ]);
    expect(r.logs.some((l) => l.includes('comment page full'))).toBe(true);
  });

  it('surfaces a GraphQL error message', async () => {
    vi.stubEnv('LINEAR_API_KEY', SECRET_KEY);
    await expect(run([{ errors: [{ message: 'bad filter' }] }])).rejects.toThrow(
      'Linear: bad filter',
    );
  });

  it('personal auth without a key throws the envToken message and warns', async () => {
    vi.stubEnv('LINEAR_API_KEY', '');
    await expect(run([])).rejects.toThrow(
      'Source "lin": set LINEAR_API_KEY to sync. Create one at linear.app → Settings → Security & access → Personal API keys.',
    );
  });

  it('app auth exchanges client credentials once and sends Bearer', async () => {
    const r = await run(
      [{ access_token: 'tok', expires_in: 2592000 }, gql([node('ENG-1', '2026-10-03T00:00:00Z')])],
      { auth: 'app' },
    );
    const [token, query] = r.calls;
    expect(token?.url).toBe('https://api.linear.app/oauth/token');
    expect(Object.fromEntries(new URLSearchParams(token?.init.body as string))).toEqual({
      grant_type: 'client_credentials',
      scope: 'read',
      client_id: 'cid',
      client_secret: 'sec',
    });
    expect(auth(query as never)).toBe('Bearer tok');
  });

  it('app auth without credentials points to the docs and never leaks secrets', async () => {
    const connector = linearConnector(
      { id: 'lin', type: 'linear', auth: 'app' },
      { env: { WAYMARK_LINEAR_CLIENT_ID: 'cid' } },
    );
    const ctx = {
      sourceId: 'lin',
      cursor: null,
      log: () => {},
      emit: async () => {},
      remove: async () => {},
      listIds: () => [],
    };
    await expect(connector(ctx)).rejects.toThrow(
      /WAYMARK_LINEAR_CLIENT_SECRET.*identities\.md#linear/,
    );
  });
});
