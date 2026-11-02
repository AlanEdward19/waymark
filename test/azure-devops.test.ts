import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  AdoComment,
  AdoWorkItem,
  AzureDevOpsApi,
} from '../src/connectors/azure-devops/api.js';
import { createAzureDevOpsApi } from '../src/connectors/azure-devops/client.js';
import { azureDevOpsConnector } from '../src/connectors/azure-devops/index.js';
import type { WaymarkDoc } from '../src/store/doc.js';

const source = {
  id: 'ado',
  type: 'azure-devops' as const,
  auth: 'app' as const,
  organization: 'contoso',
  project: 'My Shop',
  include: ['workitems' as const],
};

function item(id: number, changed: string, extra: Record<string, unknown> = {}): AdoWorkItem {
  return {
    id,
    fields: {
      'System.Title': `Item ${id}`,
      'System.Description': '<p>It <b>broke</b>.</p>',
      'System.State': 'Active',
      'System.WorkItemType': 'Bug',
      'System.CreatedBy': { displayName: 'Dana', uniqueName: 'dana@example.com' },
      'System.CreatedDate': '2026-10-01T00:00:00Z',
      'System.ChangedDate': changed,
      'System.Tags': 'api; urgent ;',
      ...extra,
    },
  };
}

function fakeApi(items: AdoWorkItem[], comments: Record<number, AdoComment[]> = {}) {
  const queries: string[] = [];
  const batches: number[][] = [];
  const api: AzureDevOpsApi = {
    queryIds: async (q) => {
      queries.push(q);
      return items.map((i) => i.id);
    },
    getWorkItems: async (ids) => {
      batches.push(ids);
      return items.filter((i) => ids.includes(i.id));
    },
    comments: async (id) => comments[id] ?? [],
  };
  return { api, queries, batches };
}

async function run(api: AzureDevOpsApi, cursor: string | null = null) {
  const docs: WaymarkDoc[] = [];
  const logs: string[] = [];
  const res = await azureDevOpsConnector(source, { api })({
    sourceId: 'ado',
    cursor,
    log: (m) => logs.push(m),
    emit: async (d) => {
      docs.push(d);
    },
    remove: async () => {},
    readDoc: async () => null,
    listIds: () => [],
  });
  return { docs, logs, res };
}

describe('azure-devops work items', () => {
  it('first run has no date clause, second run uses the cursor', async () => {
    const f = fakeApi([item(1, '2026-10-02T00:00:00.123Z')]);
    const first = await run(f.api);
    expect(f.queries[0]).not.toContain('ChangedDate] >');
    expect(f.queries[0]).toContain('ORDER BY [System.ChangedDate] ASC');
    const cursor = first.res.cursor;
    expect(JSON.parse(cursor as string)).toEqual({ workitems: '2026-10-02T00:00:00.123Z' });
    await run(f.api, cursor);
    expect(f.queries[1]).toContain("[System.ChangedDate] > '2026-10-02T00:00:00.123Z'");
  });

  it('splits 450 ids into 200/200/50 batches', async () => {
    const items = Array.from({ length: 450 }, (_, i) => item(i + 1, '2026-10-02T00:00:00Z'));
    const f = fakeApi(items);
    const { res } = await run(f.api);
    expect(f.batches.map((b) => b.length)).toEqual([200, 200, 50]);
    expect(res.count).toBe(450);
  });

  it('maps HTML to markdown, splits tags and never stores e-mails', async () => {
    const f = fakeApi(
      [
        item(7, '2026-10-02T00:00:00Z', {
          'Microsoft.VSTS.Common.AcceptanceCriteria': '<p>Works</p>',
        }),
      ],
      {
        7: [
          {
            text: '<p>Line one</p><p>Line two</p>',
            createdBy: { displayName: 'Eve', uniqueName: 'eve@example.com' },
            createdDate: '2026-10-03T08:00:00Z',
          },
        ],
      },
    );
    const { docs } = await run(f.api);
    const d = docs[0] as WaymarkDoc;
    expect(d.id).toBe('ado/issue/7');
    expect(d.url).toBe('https://dev.azure.com/contoso/My Shop/_workitems/edit/7');
    expect(d.tags).toEqual(['state:Active', 'type:Bug', 'label:api', 'label:urgent']);
    expect(d.authors).toEqual(['Dana', 'Eve']);
    expect(d.body).toContain('#7 · Bug · Active · @Dana');
    expect(d.body).toContain('It **broke**.');
    expect(d.body).toContain('## Acceptance criteria\n\nWorks');
    expect(d.body).not.toContain('## Repro steps');
    expect(d.body).toContain('- **Eve** (2026-10-03): Line one');
    expect(JSON.stringify(d)).not.toContain('example.com');
  });

  it('logs when the WIQL limit is reached and stubs pulls', async () => {
    const ids = Array.from({ length: 20000 }, (_, i) => i + 1);
    const api: AzureDevOpsApi = {
      queryIds: async () => ids,
      getWorkItems: async () => [],
      comments: async () => [],
    };
    const { logs } = await run(api);
    expect(logs).toContain(
      'azure-devops: more than 20000 changed work items; run sync again to continue',
    );
    const stub = await azureDevOpsConnector(
      { ...source, include: ['workitems', 'pulls'] },
      { api },
    )({
      sourceId: 'ado',
      cursor: null,
      log: (m) => logs.push(m),
      emit: async () => {},
      remove: async () => {},
      readDoc: async () => null,
      listIds: () => [],
    });
    expect(logs).toContain('pulls: not implemented yet');
    expect(stub.count).toBe(0);
  });
});

describe('azure-devops client', () => {
  afterEach(() => vi.unstubAllEnvs());

  function recorder(bodies: unknown[]) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const impl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify(bodies.shift()), { status: 200 });
    }) as unknown as typeof fetch;
    return { impl, calls };
  }

  it('follows continuation tokens for comments', async () => {
    const r = recorder([
      { comments: [{ text: 'a', createdDate: 'x' }], continuationToken: 'tok/1' },
      { comments: [{ text: 'b', createdDate: 'y' }] },
    ]);
    const api = createAzureDevOpsApi('contoso', 'My Shop', async () => 'Bearer t', r.impl);
    const all = await api.comments(5);
    expect(all.map((c) => c.text)).toEqual(['a', 'b']);
    expect(r.calls[0]?.url).toBe(
      'https://dev.azure.com/contoso/My%20Shop/_apis/wit/workItems/5/comments?api-version=7.1-preview.4',
    );
    expect(r.calls[1]?.url).toContain('&continuationToken=tok%2F1');
  });

  async function authHeader(auth: 'app' | 'personal', tokens?: { getToken(): Promise<string> }) {
    const r = recorder([{ workItems: [] }]);
    await azureDevOpsConnector(
      { ...source, auth },
      { fetch: r.impl, ...(tokens ? { tokens } : {}) },
    )({
      sourceId: 'ado',
      cursor: null,
      log: () => {},
      emit: async () => {},
      remove: async () => {},
      readDoc: async () => null,
      listIds: () => [],
    });
    expect(r.calls[0]?.url).toContain('/wit/wiql?timePrecision=true&api-version=7.1');
    return ((r.calls[0]?.init.headers ?? {}) as Record<string, string>).authorization;
  }

  it('app auth sends the Entra token as Bearer', async () => {
    expect(await authHeader('app', { getToken: async () => 'entra-tok' })).toBe('Bearer entra-tok');
  });

  it('personal PAT is Basic with an empty user', async () => {
    vi.stubEnv('AZURE_DEVOPS_EXT_PAT', 'pat123');
    expect(await authHeader('personal')).toBe(`Basic ${Buffer.from(':pat123').toString('base64')}`);
  });

  it('personal token is Bearer', async () => {
    vi.stubEnv('AZURE_DEVOPS_EXT_PAT', '');
    vi.stubEnv('AZURE_DEVOPS_PAT', '');
    vi.stubEnv('AZURE_DEVOPS_TOKEN', 'tok');
    expect(await authHeader('personal')).toBe('Bearer tok');
  });

  it('personal without credentials fails without suggesting an az token', async () => {
    vi.stubEnv('AZURE_DEVOPS_EXT_PAT', '');
    vi.stubEnv('AZURE_DEVOPS_PAT', '');
    vi.stubEnv('AZURE_DEVOPS_TOKEN', '');
    const err = await authHeader('personal').catch((e: Error) => e);
    expect((err as Error).message).toMatch(/^Source "ado": set AZURE_DEVOPS_TOKEN to sync\./);
    expect((err as Error).message).not.toContain('az account');
  });
});
