import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigSchema } from '../src/config.js';
import { jiraConnector } from '../src/connectors/jira/index.js';
import type { WaymarkDoc } from '../src/store/doc.js';

const PASSWORD = 'jira-token-SYNTHETIC';
const EMAIL = 'dana@example.com';
const adf = (text: string) => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});
const person = (displayName: string) => ({ displayName, emailAddress: `${displayName}@x.test` });
const comment = (who: string, text: string) => ({
  author: person(who),
  body: adf(text),
  created: '2026-10-02T10:00:00.000+0200',
});

function issue(key: string, updated: string, comments: unknown[] = [], total = comments.length) {
  return {
    key,
    fields: {
      summary: `Issue ${key}`,
      description: adf('It broke.'),
      status: { name: 'In Progress', statusCategory: { key: 'indeterminate' } },
      labels: ['bug'],
      issuetype: { name: 'Task' },
      reporter: person('Dana'),
      created: '2026-10-01T08:00:00.000+0000',
      updated,
      comment: { comments, total },
    },
  };
}

function fakeFetch(responses: unknown[]) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(responses.shift()), { status: 200 });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const source = {
  id: 'jira',
  type: 'jira' as const,
  auth: 'personal' as const,
  site: 'acme.atlassian.net',
  project: 'ENG',
};

async function run(responses: unknown[], cursor: string | null = null, src = source) {
  const f = fakeFetch(responses);
  const docs: WaymarkDoc[] = [];
  const logs: string[] = [];
  const result = await jiraConnector(src, {
    fetch: f.impl,
    env: { JIRA_EMAIL: EMAIL, JIRA_API_TOKEN: PASSWORD },
  })({
    sourceId: 'jira',
    cursor,
    log: (m) => logs.push(m),
    emit: async (d) => {
      docs.push(d);
    },
    remove: async () => {},
    readDoc: async () => null,
    listIds: () => [],
  });
  return { ...f, docs, logs, result };
}

const authOf = (c?: { init: RequestInit }) =>
  (c?.init.headers as Record<string, string> | undefined)?.authorization;
const body = (c: { init: RequestInit }) => JSON.parse(c.init.body as string);

describe('jira connector', () => {
  beforeEach(() => {
    vi.stubEnv('JIRA_EMAIL', EMAIL);
    vi.stubEnv('JIRA_API_TOKEN', PASSWORD);
  });
  afterEach(() => vi.unstubAllEnvs());

  it('pages with nextPageToken and renders docs', async () => {
    const r = await run([
      {
        issues: [issue('ENG-1', '2026-10-03T12:00:00.000+0000')],
        nextPageToken: 'tok',
        isLast: false,
      },
      {
        issues: [issue('ENG-2', '2026-10-05T12:00:00.000+0200', [comment('Eve', 'Looks bad')])],
        isLast: true,
      },
    ]);
    expect(r.calls).toHaveLength(2);
    expect(r.calls[0]?.url).toBe('https://acme.atlassian.net/rest/api/3/search/jql');
    expect(body(r.calls[0] as never).nextPageToken).toBeUndefined();
    expect(body(r.calls[1] as never).nextPageToken).toBe('tok');
    expect(body(r.calls[0] as never).jql).toBe('(project = "ENG") ORDER BY updated ASC');
    expect(r.result).toEqual({ cursor: '2026-10-05T10:00:00.000Z', count: 2 });
    const d = r.docs[1] as WaymarkDoc;
    expect(d.url).toBe('https://acme.atlassian.net/browse/ENG-2');
    expect(d.title).toBe('Issue ENG-2');
    expect(d.authors).toEqual(['Dana', 'Eve']);
    expect(d.tags).toEqual(['state:indeterminate', 'type:Task', 'label:bug']);
    expect(d.body).toBe(
      'ENG-2 · Task · In Progress · @Dana\n\nIt broke.\n\n## Conversation\n\n- **Eve** (2026-10-02): Looks bad',
    );
  });

  it('sends maxResults and the exact field list', async () => {
    const r = await run([{ issues: [], isLast: true }]);
    const b = body(r.calls[0] as never);
    expect(b.maxResults).toBe(100);
    expect(b.fields).toEqual([
      'summary',
      'description',
      'status',
      'labels',
      'issuetype',
      'reporter',
      'created',
      'updated',
      'comment',
    ]);
  });

  it('stops when isLast is true even with a nextPageToken', async () => {
    const r = await run([
      {
        issues: [issue('ENG-1', '2026-10-03T12:00:00.000+0000')],
        nextPageToken: 'x',
        isLast: true,
      },
    ]);
    expect(r.calls).toHaveLength(1);
  });

  it('falls back to _No description._ and escapes quotes in the project key', async () => {
    const i = issue('ENG-6', '2026-10-03T12:00:00.000+0000');
    i.fields.description = null as never;
    const r = await run([{ issues: [i], isLast: true }], null, {
      ...source,
      project: 'E"N\\G',
    });
    expect((r.docs[0] as WaymarkDoc).body).toContain('_No description._');
    expect(body(r.calls[0] as never).jql).toBe('(project = "E\\"N\\\\G") ORDER BY updated ASC');
  });

  it('an empty comment page ends the comment loop', async () => {
    const r = await run([
      { issues: [issue('ENG-7', '2026-10-03T12:00:00.000+0000', [], 5)], isLast: true },
      { comments: [], total: 5 },
    ]);
    expect(r.calls).toHaveLength(2);
    expect(r.docs).toHaveLength(1);
  });

  it('second run subtracts 24h from the cursor in the JQL', async () => {
    const r = await run([{ issues: [], isLast: true }], '2026-10-05T10:30:45.000Z');
    expect(body(r.calls[0] as never).jql).toBe(
      '(project = "ENG") AND updated >= "2026-10-04 10:30" ORDER BY updated ASC',
    );
    expect(r.result.cursor).toBe('2026-10-05T10:30:45.000Z');
  });

  it('uses a custom jql', async () => {
    const r = await run([{ issues: [], isLast: true }], null, {
      id: 'jira',
      type: 'jira',
      auth: 'personal',
      site: 'acme.atlassian.net',
      jql: 'labels = x',
    } as never);
    expect(body(r.calls[0] as never).jql).toBe('(labels = x) ORDER BY updated ASC');
  });

  it('fetches overflowing comments from the comment endpoint', async () => {
    const r = await run([
      {
        issues: [issue('ENG-3', '2026-10-03T12:00:00.000+0000', [comment('Eve', 'one')], 3)],
        isLast: true,
      },
      { comments: [comment('Eve', 'one'), comment('Fay', 'two')], total: 3 },
      { comments: [comment('Gus', 'three')], total: 3 },
    ]);
    expect(r.calls[1]?.url).toBe(
      'https://acme.atlassian.net/rest/api/3/issue/ENG-3/comment?startAt=0&maxResults=100',
    );
    expect(r.calls[2]?.url).toContain('startAt=2');
    expect((r.docs[0] as WaymarkDoc).body).toContain('**Gus** (2026-10-02): three');
  });

  it('never stores e-mail addresses and sends Basic auth only in headers', async () => {
    const r = await run([
      {
        issues: [issue('ENG-4', '2026-10-03T12:00:00.000+0000', [comment('Eve', 'hi')])],
        isLast: true,
      },
    ]);
    const stored = JSON.stringify(r.docs);
    expect(stored).not.toContain('@x.test');
    expect(stored).not.toContain(EMAIL);
    expect(stored).not.toContain(PASSWORD);
    expect(authOf(r.calls[0])).toBe(
      `Basic ${Buffer.from(`${EMAIL}:${PASSWORD}`).toString('base64')}`,
    );
    expect(r.logs[0]).toContain('personal token');
  });

  it('errors carry no auth values', async () => {
    const fetchImpl = (async () =>
      new Response('nope', { status: 401 })) as unknown as typeof fetch;
    const err = await jiraConnector(source, {
      fetch: fetchImpl,
      env: { JIRA_EMAIL: EMAIL, JIRA_API_TOKEN: PASSWORD },
    })({
      sourceId: 'jira',
      cursor: null,
      log: () => {},
      emit: async () => {},
      remove: async () => {},
      readDoc: async () => null,
      listIds: () => [],
    }).catch((e: Error) => e);
    expect((err as Error).message).toContain('401');
    expect((err as Error).message).not.toContain(PASSWORD);
    expect((err as Error).message).not.toContain(EMAIL);
  });

  it('app auth uses the service account via api.atlassian.com', async () => {
    const f = fakeFetch([
      { cloudId: 'cloud-jira-test' },
      { access_token: 'svc-token', expires_in: 3600 },
      { issues: [issue('ENG-5', '2026-10-03T12:00:00.000+0000')], isLast: true },
    ]);
    const docs: WaymarkDoc[] = [];
    await jiraConnector(
      { ...source, auth: 'app', site: 'app-test.atlassian.net' },
      {
        fetch: f.impl,
        env: { WAYMARK_ATLASSIAN_CLIENT_ID: 'c', WAYMARK_ATLASSIAN_CLIENT_SECRET: 's' },
      },
    )({
      sourceId: 'jira',
      cursor: null,
      log: () => {},
      emit: async (d) => {
        docs.push(d);
      },
      remove: async () => {},
      readDoc: async () => null,
      listIds: () => [],
    });
    const search = f.calls[2];
    expect(search?.url).toBe(
      'https://api.atlassian.com/ex/jira/cloud-jira-test/rest/api/3/search/jql',
    );
    expect(authOf(search)).toBe('Bearer svc-token');
    expect(docs[0]?.url).toBe('https://app-test.atlassian.net/browse/ENG-5');
  });
});

describe('jira config', () => {
  const parse = (s: Record<string, unknown>) =>
    ConfigSchema.safeParse({ version: 1, sources: [{ id: 'j', type: 'jira', ...s }] }).success;
  it('needs exactly one of project/jql', () => {
    expect(parse({ site: 'acme.atlassian.net', project: 'ENG' })).toBe(true);
    expect(parse({ site: 'acme.atlassian.net', jql: 'a = b' })).toBe(true);
    expect(parse({ site: 'acme.atlassian.net' })).toBe(false);
    expect(parse({ site: 'acme.atlassian.net', project: 'ENG', jql: 'a = b' })).toBe(false);
  });
  it('rejects ORDER BY in jql', () => {
    expect(parse({ site: 'acme.atlassian.net', jql: 'a = b order  by created' })).toBe(false);
    expect(parse({ site: 'acme.atlassian.net', jql: 'text ~ "border"' })).toBe(true);
  });
  it('rejects a bad site', () => {
    expect(parse({ site: 'acme.example.com', project: 'ENG' })).toBe(false);
    expect(parse({ site: 'https://acme.atlassian.net', project: 'ENG' })).toBe(false);
  });
});
