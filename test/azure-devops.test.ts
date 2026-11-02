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
    expect(d.url).toBe('https://dev.azure.com/contoso/My%20Shop/_workitems/edit/7');
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

describe('azure-devops hardening', () => {
  afterEach(() => vi.unstubAllEnvs());

  const ctxFor = (docs: WaymarkDoc[], logs: string[], cursor: string | null = null) => ({
    sourceId: 'ado',
    cursor,
    log: (m: string) => logs.push(m),
    emit: async (d: WaymarkDoc) => {
      docs.push(d);
    },
    remove: async () => {},
    readDoc: async () => null,
    listIds: () => [],
  });

  it('cursor is the true max with mixed fractional precision, whatever the order', async () => {
    const f = fakeApi([
      item(1, '2026-10-02T00:00:00.5Z'),
      item(2, '2026-10-02T00:00:00.78Z'),
      item(3, '2026-10-02T00:00:00.7Z'),
    ]);
    const { res } = await run(f.api);
    expect(JSON.parse(res.cursor as string)).toEqual({ workitems: '2026-10-02T00:00:00.78Z' });
  });

  it('renders fallbacks, repro steps, dedup, indentation and unnamed commenters', async () => {
    const f = fakeApi(
      [
        item(9, '2026-10-02T00:00:00Z', {
          'System.Description': undefined,
          'Microsoft.VSTS.TCM.ReproSteps': '<p>Click it</p>',
        }),
      ],
      {
        9: [
          {
            text: '<p>first</p><p>second</p>',
            createdBy: { displayName: 'Dana' },
            createdDate: '2026-10-03T00:00:00Z',
          },
          { text: '<p>anon</p>', createdDate: '2026-10-04T00:00:00Z' },
        ],
      },
    );
    const { docs } = await run(f.api);
    const d = docs[0] as WaymarkDoc;
    expect(d.body).toContain('_No description._');
    expect(d.body).toContain('## Repro steps\n\nClick it');
    expect(d.authors).toEqual(['Dana']);
    expect(d.body).toMatch(
      /- **Dana** (2026-10-03): first
 {2}
 {2}second/,
    );
    expect(d.body).toContain('- **unknown** (2026-10-04): anon');
  });

  function wire(batchValue: unknown[]) {
    const calls: Array<{ url: string; body: unknown; auth: string | undefined }> = [];
    const impl = (async (url: string, init: RequestInit) => {
      calls.push({
        url,
        body: init.body ? JSON.parse(init.body as string) : undefined,
        auth: (init.headers as Record<string, string>).authorization,
      });
      if (url.includes('/wiql')) return Response.json({ workItems: [{ id: 1 }, { id: 2 }] });
      if (url.includes('/workitemsbatch')) return Response.json({ value: batchValue });
      return Response.json({ comments: [] });
    }) as unknown as typeof fetch;
    return { impl, calls };
  }

  it('sends the exact WIQL and batch requests, skips deleted items, requests ADO_SCOPE', async () => {
    const w = wire([item(1, '2026-10-02T00:00:00Z'), null]);
    const scopes: string[] = [];
    const docs: WaymarkDoc[] = [];
    const logs: string[] = [];
    const res = await azureDevOpsConnector(source, {
      fetch: w.impl,
      entra: (o) => {
        scopes.push(o.scope);
        return { getToken: async () => 'tk' };
      },
    })(ctxFor(docs, logs));
    expect(scopes).toEqual(['https://app.vssps.visualstudio.com/.default']);
    expect(res.count).toBe(1);
    const [wiql, batch] = w.calls;
    expect(wiql?.url).toBe(
      'https://dev.azure.com/contoso/My%20Shop/_apis/wit/wiql?timePrecision=true&api-version=7.1',
    );
    expect(Object.keys(wiql?.body as object)).toEqual(['query']);
    expect(((wiql?.body ?? {}) as { query?: string }).query).toContain(
      '[System.TeamProject] = @project',
    );
    expect(batch?.url).toBe(
      'https://dev.azure.com/contoso/My%20Shop/_apis/wit/workitemsbatch?api-version=7.1',
    );
    expect(batch?.body).toEqual({
      ids: [1, 2],
      fields: [
        'System.Title',
        'System.Description',
        'System.State',
        'System.WorkItemType',
        'System.CreatedBy',
        'System.CreatedDate',
        'System.ChangedDate',
        'System.Tags',
        'Microsoft.VSTS.Common.AcceptanceCriteria',
        'Microsoft.VSTS.TCM.ReproSteps',
      ],
      errorPolicy: 'Omit',
    });
    expect(w.calls.every((c) => c.auth === 'Bearer tk')).toBe(true);
  });

  it('logs the personal-token warning once per sync', async () => {
    vi.stubEnv('AZURE_DEVOPS_EXT_PAT', 'p');
    const w = wire([item(1, '2026-10-02T00:00:00Z'), item(2, '2026-10-02T00:00:00Z')]);
    const logs: string[] = [];
    await azureDevOpsConnector(
      { ...source, auth: 'personal' },
      { fetch: w.impl },
    )(ctxFor([], logs));
    expect(logs.filter((l) => l.startsWith('warn: ado uses a personal token'))).toHaveLength(1);
  });
});
