import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { initHome } from '../src/config.js';
import { azureDevOpsConnector } from '../src/connectors/azure-devops/index.js';
import { createWikiApi, syncWiki, type WikiApi } from '../src/connectors/azure-devops/wiki.js';
import type { SyncContext } from '../src/connectors/types.js';
import { resolvePaths } from '../src/paths.js';
import { makeId, type WaymarkDoc } from '../src/store/doc.js';
import { readDoc } from '../src/store/markdown.js';
import { syncAll } from '../src/sync.js';

const dirs: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

function api(): WikiApi {
  return {
    listWikis: async () => [{ id: 'project', name: 'Handbook' }],
    wikiPages: async () => ({ pages: [{ id: 1, path: '/Getting-started' }] }),
    wikiPage: async () => ({
      path: '/Getting-started',
      remoteUrl: 'https://dev.azure.com/org/project/_wiki/wikis/project/1',
      content: '# Getting started\n\nRead **this**.\r\n',
    }),
  };
}

function context(stored: WaymarkDoc[] = []) {
  const docs = new Map(stored.map((doc) => [doc.id, doc]));
  const removed: string[] = [];
  const ctx: SyncContext = {
    sourceId: 'ado',
    cursor: null,
    log: () => {},
    emit: async (doc) => {
      docs.set(doc.id, doc);
    },
    readDoc: async (id) => docs.get(id) ?? null,
    listIds: (kind) => [...docs.values()].filter((doc) => doc.kind === kind).map((doc) => doc.id),
    remove: async (id) => {
      removed.push(id);
      docs.delete(id);
    },
  };
  return { ctx, docs, removed };
}

describe('Azure DevOps wiki', () => {
  it('follows page tokens, maps markdown and skips empty folder pages', async () => {
    const fake = api();
    const tokens: Array<string | undefined> = [];
    fake.wikiPages = async (_wiki, token) => {
      tokens.push(token);
      return token === undefined
        ? { pages: [{ id: 1, path: '/Getting-started' }], continuationToken: 'next' }
        : { pages: [{ id: 2, path: '/Folder' }] };
    };
    const get = fake.wikiPage;
    fake.wikiPage = async (wiki, id) =>
      id === 2 ? { path: '/Folder', remoteUrl: 'https://example.test/folder' } : get(wiki, id);
    const { ctx, docs } = context();
    expect(await syncWiki(ctx, fake)).toEqual({ count: 1, removed: 0 });
    expect(tokens).toEqual([undefined, 'next']);
    const doc = [...docs.values()][0];
    expect(doc).toMatchObject({
      id: makeId('ado', 'doc', 'Handbook/Getting-started'),
      title: 'Getting started',
      kind: 'doc',
      url: 'https://dev.azure.com/org/project/_wiki/wikis/project/1',
      body: '# Getting started\n\nRead **this**.\r\n',
      tags: ['azure-devops-wiki', 'wiki:Handbook'],
      authors: [],
    });
    expect(doc?.createdAt).toBe(doc?.updatedAt);
    expect(new Date(doc?.createdAt ?? '').toISOString()).toBe(doc?.createdAt);
  });

  it('honours wiki name filters, removes disappeared docs and preserves other kinds', async () => {
    const fake = api();
    fake.listWikis = async () => [
      { id: 'project', name: 'Handbook' },
      { id: 'code', name: 'Code wiki' },
    ];
    const pages = vi.spyOn(fake, 'wikiPages');
    const c = context();
    await syncWiki(c.ctx, fake);
    const existing = [...c.docs.values()][0] as WaymarkDoc;
    c.docs.set('ado/doc/removed', { ...existing, id: 'ado/doc/removed' });
    c.docs.set('ado/issue/1', { ...existing, id: 'ado/issue/1', kind: 'issue' });
    pages.mockClear();
    expect(await syncWiki(c.ctx, fake, ['Handbook'])).toEqual({ count: 1, removed: 2 });
    expect(pages.mock.calls.map(([wiki]) => wiki)).toEqual(['project']);
    expect(c.removed).toEqual([
      makeId('ado', 'doc', 'Code wiki/Getting-started'),
      'ado/doc/removed',
    ]);
    expect(c.docs.has('ado/issue/1')).toBe(true);
  });

  it.each(['wikis', 'pages', 'content', 'token'])(
    'skips all deletion after %s failure',
    async (failure) => {
      const fake = api();
      const c = context();
      await syncWiki(c.ctx, fake);
      const previous = [...c.docs.values()][0] as WaymarkDoc;
      c.docs.set('ado/doc/missing', { ...previous, id: 'ado/doc/missing' });
      if (failure === 'wikis')
        fake.listWikis = async () => {
          throw new Error('denied');
        };
      if (failure === 'pages') {
        fake.listWikis = async () => [
          { id: 'one', name: 'One' },
          { id: 'two', name: 'Two' },
        ];
        fake.wikiPages = async (wiki) => {
          if (wiki === 'two') throw new Error('denied');
          return { pages: [] };
        };
      }
      if (failure === 'content')
        fake.wikiPage = async () => {
          throw new Error('denied');
        };
      if (failure === 'token')
        fake.wikiPages = async () => ({ pages: [], continuationToken: 'again' });
      await expect(syncWiki(c.ctx, fake)).rejects.toThrow();
      expect(c.removed).toEqual([]);
      expect(c.docs.has('ado/doc/missing')).toBe(true);
    },
  );

  it('removes all old wiki docs when every wiki was deleted', async () => {
    const fake = api();
    const c = context();
    await syncWiki(c.ctx, fake);
    fake.listWikis = async () => [];
    expect(await syncWiki(c.ctx, fake)).toEqual({ count: 0, removed: 1 });
  });

  it('retains creation time and advances update time only for changed content', async () => {
    vi.useFakeTimers();
    vi.setSystemTime('2026-01-01T00:00:00Z');
    const fake = api();
    const c = context();
    await syncWiki(c.ctx, fake);
    vi.setSystemTime('2026-02-01T00:00:00Z');
    await syncWiki(c.ctx, fake);
    expect([...c.docs.values()][0]?.updatedAt).toBe('2026-01-01T00:00:00.000Z');
    const get = fake.wikiPage;
    fake.wikiPage = async (wiki, id) => ({ ...(await get(wiki, id)), content: 'Updated' });
    await syncWiki(c.ctx, fake);
    expect([...c.docs.values()][0]).toMatchObject({
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-02-01T00:00:00.000Z',
      body: 'Updated',
    });
  });

  it('makes no wiki commit on an unchanged second sync, including normalized and redacted content', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'waymark-'));
    dirs.push(dir);
    const source = {
      id: 'ado',
      type: 'azure-devops' as const,
      auth: 'app' as const,
      organization: 'org',
      project: 'project',
      include: ['wiki' as const],
    };
    await fs.writeFile(
      path.join(dir, 'config.json'),
      JSON.stringify({ version: 1, sources: [source] }),
    );
    const paths = resolvePaths({ WAYMARK_HOME: dir });
    await initHome(paths);
    const fake = api();
    const get = fake.wikiPage;
    fake.wikiPage = async (wiki, id) => ({
      ...(await get(wiki, id)),
      content: 'password=synthetic-secret\r\n\r\n',
    });
    const connectors = { ado: azureDevOpsConnector(source, { wikiApi: fake }) };
    expect(await syncAll(paths, { connectors })).toEqual([{ sourceId: 'ado', count: 1 }]);
    const head = () =>
      execFileSync('git', ['rev-parse', 'HEAD'], { cwd: paths.wiki, encoding: 'utf8' }).trim();
    const first = head();
    const doc = await readDoc(paths.wiki, makeId('ado', 'doc', 'Handbook/Getting-started'));
    expect(doc?.body).toBe('password=[REDACTED:connection-string]');
    vi.spyOn(Date.prototype, 'toISOString').mockReturnValue('2099-01-01T00:00:00.000Z');
    expect(await syncAll(paths, { connectors })).toEqual([{ sourceId: 'ado', count: 1 }]);
    expect(head()).toBe(first);
    fake.wikiPages = async () => ({ pages: [] });
    expect(await syncAll(paths, { connectors })).toEqual([
      { sourceId: 'ado', count: 0, removed: 1 },
    ]);
    expect(await readDoc(paths.wiki, makeId('ado', 'doc', 'Handbook/Getting-started'))).toBeNull();
    expect(head()).not.toBe(first);
  }, 15_000);
});

describe('Azure DevOps wiki client', () => {
  it('uses exact endpoints, encoded identifiers, bearer auth and response header pagination', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const replies = [
      Response.json({ value: [{ id: 'wiki/id', name: 'Handbook' }] }),
      Response.json(
        { value: [{ id: 1, path: '/Start' }] },
        { headers: { 'x-ms-continuationtoken': 'next/1' } },
      ),
      Response.json({ value: [] }),
      Response.json({
        path: '/Start',
        remoteUrl: 'https://example.test/start',
        content: '# Markdown',
      }),
    ];
    const fetcher = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return replies.shift() as Response;
    }) as unknown as typeof fetch;
    const fake = createWikiApi('org', 'My project', async () => 'Bearer synthetic', fetcher);
    expect(await fake.listWikis()).toEqual([{ id: 'wiki/id', name: 'Handbook' }]);
    expect(await fake.wikiPages('wiki/id')).toMatchObject({ continuationToken: 'next/1' });
    await fake.wikiPages('wiki/id', 'next/1');
    expect((await fake.wikiPage('wiki/id', 1)).content).toBe('# Markdown');
    const base = 'https://dev.azure.com/org/My%20project/_apis/wiki/wikis';
    expect(calls.map((call) => call.url)).toEqual([
      `${base}?api-version=7.1`,
      `${base}/wiki%2Fid/pagesbatch?api-version=7.1`,
      `${base}/wiki%2Fid/pagesbatch?api-version=7.1`,
      `${base}/wiki%2Fid/pages/1?includeContent=true&api-version=7.1`,
    ]);
    expect(calls.map((call) => call.init.method)).toEqual(['GET', 'POST', 'POST', 'GET']);
    expect(calls.every((call) => call.init.redirect === 'error')).toBe(true);
    expect(JSON.parse(calls[1]?.init.body as string)).toEqual({ top: 100 });
    expect(JSON.parse(calls[2]?.init.body as string)).toEqual({
      top: 100,
      continuationToken: 'next/1',
    });
    expect(
      calls.every(
        (call) =>
          (call.init.headers as Record<string, string>).authorization === 'Bearer synthetic',
      ),
    ).toBe(true);
  });

  it.each([401, 403])('gives an actionable wiki access hint for %i', async (status) => {
    const fetcher = (async () => new Response('{}', { status })) as typeof fetch;
    const fake = createWikiApi('org', 'project', async () => 'Bearer synthetic', fetcher);
    await expect(fake.listWikis()).rejects.toThrow("check the identity's wiki read access");
  });

  it('rejects malformed successful listings so they cannot trigger deletions', async () => {
    const fetcher = (async () => Response.json({})) as typeof fetch;
    const fake = createWikiApi('org', 'project', async () => 'Bearer synthetic', fetcher);
    await expect(fake.listWikis()).rejects.toThrow('Invalid Azure DevOps wiki response');
    await expect(fake.wikiPages('wiki')).rejects.toThrow('Invalid Azure DevOps wiki response');
  });

  it.each(['wiki', 'page id', 'content'])(
    'keeps stored pages after malformed %s responses',
    async (bad) => {
      const c = context();
      await syncWiki(c.ctx, api());
      const fetcher = (async (url: string) => {
        if (url.includes('/pagesbatch?'))
          return Response.json({
            value: bad === 'page id' ? [{ path: '/Start' }] : [{ id: 1, path: '/Start' }],
          });
        if (url.includes('/pages/'))
          return Response.json({
            path: '/Start',
            remoteUrl: 'https://example.test/start',
            content: 42,
          });
        return Response.json({
          value: bad === 'wiki' ? [{ id: 'wiki' }] : [{ id: 'wiki', name: 'Handbook' }],
        });
      }) as typeof fetch;
      const fake = createWikiApi('org', 'project', async () => 'Bearer synthetic', fetcher);
      await expect(syncWiki(c.ctx, fake)).rejects.toThrow('Invalid Azure DevOps wiki response');
      expect(c.removed).toEqual([]);
      expect(c.docs.size).toBe(1);
    },
  );
});
