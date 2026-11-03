import { describe, expect, it } from 'vitest';
import { ConfigSchema, type ConfluenceSource } from '../src/config.js';
import { confluenceConnector } from '../src/connectors/atlassian/confluence.js';
import type { WaymarkDoc } from '../src/store/doc.js';

const source: ConfluenceSource = {
  id: 'conf',
  type: 'confluence',
  auth: 'personal',
  site: 'acme.atlassian.net',
  spaces: ['ENG', 'OPS'],
};
const env = { CONFLUENCE_EMAIL: 'synthetic@example.test', CONFLUENCE_API_TOKEN: 'SYNTHETIC' };
const adf = {
  type: 'doc',
  content: [
    {
      type: 'panel',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Warning' }] }],
    },
    {
      type: 'table',
      content: [
        {
          type: 'tableRow',
          content: [
            {
              type: 'tableHeader',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Owner' }] }],
            },
          ],
        },
        {
          type: 'tableRow',
          content: [
            {
              type: 'tableCell',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Team' }] }],
            },
          ],
        },
      ],
    },
  ],
};
const page = (id: string, date = '2026-10-03T00:00:00.000Z') => ({
  id,
  title: `Page ${id}`,
  createdAt: '2026-10-01T00:00:00.000Z',
  version: { createdAt: date },
  body: { atlas_doc_format: { value: JSON.stringify(adf) } },
  _links: { webui: `/spaces/ENG/pages/${id}` },
});
const result = (results: unknown[], link?: string) =>
  new Response(JSON.stringify({ results }), { headers: link ? { link } : {} });
async function run(responses: Response[], cursor: string | null = null, src = source) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const docs: WaymarkDoc[] = [];
  const removed: string[] = [];
  const logs: string[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const response = responses.shift();
    if (!response) throw new Error('Unexpected request');
    return response;
  }) as typeof fetch;
  const value = await confluenceConnector(src, { fetch: fetchImpl, env })({
    sourceId: src.id,
    cursor,
    emit: async (d) => {
      docs.push(d);
    },
    remove: async (id) => {
      removed.push(id);
    },
    readDoc: async () => null,
    listIds: (kind) => {
      expect(kind).toBe('doc');
      return ['conf/doc/1', 'conf/doc/deleted', 'conf/doc/removed-space'];
    },
    log: (m) => logs.push(m),
  });
  return { calls, docs, removed, logs, value };
}
const spaces = () =>
  result([
    { id: '10', key: 'ENG' },
    { id: '20', key: 'OPS' },
  ]);

describe('Confluence', () => {
  it('resolves spaces, follows Link pagination, converts panel/table and removes stale docs', async () => {
    const r = await run([
      spaces(),
      result([page('1')], '</wiki/api/v2/spaces/10/pages?cursor=next>; rel="next"'),
      result([page('2')]),
      result([page('3')]),
      result([{ id: '1' }], '</wiki/api/v2/spaces/10/pages?cursor=inventory>; rel="next"'),
      result([{ id: '2' }]),
      result([{ id: '3' }]),
    ]);
    expect(r.calls[0]?.url).toContain('keys=ENG%2COPS');
    expect(r.calls[1]?.url).toContain(
      'sort=-modified-date&status=current&body-format=atlas_doc_format&limit=100',
    );
    expect(r.calls[2]?.url).toBe(
      'https://acme.atlassian.net/wiki/api/v2/spaces/10/pages?cursor=next',
    );
    expect(r.calls[4]?.url).toContain('status=current&limit=250');
    expect(r.calls[4]?.url).not.toContain('body-format');
    expect(r.value).toEqual({
      cursor: '{"10":"2026-10-03T00:00:00.000Z","20":"2026-10-03T00:00:00.000Z"}',
      count: 3,
      removed: 2,
    });
    expect(r.removed).toEqual(['conf/doc/deleted', 'conf/doc/removed-space']);
    expect(r.docs[0]).toEqual({
      id: 'conf/doc/1',
      kind: 'doc',
      sourceId: 'conf',
      title: 'Page 1',
      url: 'https://acme.atlassian.net/wiki/spaces/ENG/pages/1',
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-03T00:00:00.000Z',
      tags: ['confluence', 'space:ENG'],
      authors: [],
      body: 'Warning\n\n| Owner |\n| --- |\n| Team |',
    });
  });
  it('replays equal timestamps and stops before older pages or later links', async () => {
    const r = await run(
      [
        spaces(),
        result(
          [page('1'), page('old', '2026-10-02T00:00:00.000Z'), page('never')],
          '</wiki/api/v2/spaces/10/pages?cursor=unused>; rel="next"',
        ),
        result([]),
        result([{ id: '1' }]),
        result([]),
      ],
      '{"10":"2026-10-03T00:00:00.000Z","20":"2026-10-04T00:00:00.000Z"}',
    );
    expect(r.docs.map((d) => d.id)).toEqual(['conf/doc/1']);
    expect(r.calls).toHaveLength(5);
    expect(JSON.parse(r.value.cursor as string)).toEqual({
      10: '2026-10-03T00:00:00.000Z',
      20: '2026-10-04T00:00:00.000Z',
    });
  });
  it('never deletes when any configured space inventory fails', async () => {
    const r = await run([
      spaces(),
      result([]),
      result([]),
      result([{ id: '1' }]),
      new Response('secret', { status: 403 }),
    ]);
    expect(r.removed).toEqual([]);
    expect(r.logs.join(' ')).toContain('deletions skipped');
    expect(r.logs.join(' ')).not.toContain('secret');
  });
  it('rejects unresolved space keys before deleting', async () => {
    await expect(run([result([{ id: '10', key: 'ENG' }])])).rejects.toThrow(
      'resolve every configured space',
    );
  });
  it.each([
    'https://evil.test/wiki/api/v2/pages',
    '//evil.test/wiki/api/v2/pages',
    'https://user:pass@acme.atlassian.net/wiki/api/v2/pages',
    '/wiki/rest/api/pages',
  ])('rejects unsafe pagination %s', async (url) => {
    await expect(run([result([], `<${url}>; rel="next"`)])).rejects.toThrow('unsafe pagination');
  });
  it('rejects malformed inventory instead of deleting', async () => {
    const r = await run([spaces(), result([]), result([]), result([{}])]);
    expect(r.removed).toEqual([]);
  });
  it('uses the shared service account through the Confluence cloud gateway', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push(url);
      if (url.includes('tenant_info')) return Response.json({ cloudId: 'cloud-test' });
      if (url.includes('oauth/token'))
        return Response.json({ access_token: 'SYNTHETIC', expires_in: 3600 });
      expect((init?.headers as Record<string, string> | undefined)?.authorization).toBe(
        'Bearer SYNTHETIC',
      );
      expect(init?.redirect).toBe('error');
      return result(
        url.includes('/spaces?') ? [{ id: '10', key: 'ENG' }] : [],
        url.includes('/spaces?') ? '</wiki/api/v2/spaces?cursor=second>; rel="next"' : undefined,
      );
    }) as typeof fetch;
    // Separate resolution pages to exercise gateway rebasing without a repeated cursor.
    let resolved = false;
    const f = (async (url: string, init?: RequestInit) => {
      if (url.includes('cursor=second')) {
        resolved = true;
        return result([]);
      }
      return fetchImpl(url, init);
    }) as typeof fetch;
    await confluenceConnector(
      { ...source, auth: 'app', spaces: ['ENG'], site: 'confluence-test.atlassian.net' },
      {
        fetch: f,
        env: { WAYMARK_ATLASSIAN_CLIENT_ID: 'id', WAYMARK_ATLASSIAN_CLIENT_SECRET: 'SYNTHETIC' },
      },
    )({
      sourceId: 'conf',
      cursor: null,
      emit: async () => {},
      remove: async () => {},
      readDoc: async () => null,
      listIds: () => [],
      log: () => {},
    });
    expect(resolved).toBe(true);
    expect(
      calls.some((url) =>
        url.startsWith('https://api.atlassian.com/ex/confluence/cloud-test/wiki/api/v2/'),
      ),
    ).toBe(true);
  });
  it('validates spaces/site and defaults auth', () => {
    expect(
      ConfigSchema.parse({
        version: 1,
        sources: [{ id: 'c', type: 'confluence', site: source.site, spaces: ['ENG'] }],
      }).sources[0]?.auth,
    ).toBe('app');
    for (const override of [{ spaces: [] }, { spaces: [''] }, { site: 'evil.test/path' }]) {
      expect(
        ConfigSchema.safeParse({ version: 1, sources: [{ ...source, ...override }] }).success,
      ).toBe(false);
    }
  });
});
