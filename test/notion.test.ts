import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { notionConnector } from '../src/connectors/notion.js';
import type { WaymarkDoc } from '../src/store/doc.js';

const rt = (s: string) => [{ plain_text: s }];
const blk = (id: string, type: string, data: object, has_children = false) => ({
  id,
  type,
  has_children,
  [type]: data,
});
const page = (id: string, edited: string, extra: object = {}) => ({
  id,
  url: `https://notion.so/${id}`,
  created_time: '2026-01-01T00:00:00.000Z',
  last_edited_time: edited,
  properties: { Name: { type: 'title', title: rt(`Page ${id}`) } },
  ...extra,
});

function fakeFetch(opts: { searchPages: object[][]; blocks: Record<string, object[]> }) {
  const seen: Array<{ url: string; init: RequestInit }> = [];
  let searchCall = 0;
  const impl = (async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
    if (url.endsWith('/search')) {
      const i = searchCall++;
      return json({
        results: opts.searchPages[i],
        has_more: i < opts.searchPages.length - 1,
        next_cursor: `c${i + 1}`,
      });
    }
    const id = /blocks\/([^/]+)\/children/.exec(url)?.[1] as string;
    return json({ results: opts.blocks[id] ?? [], has_more: false, next_cursor: null });
  }) as unknown as typeof fetch;
  return { impl, seen };
}

async function run(f: ReturnType<typeof fakeFetch>, cursor: string | null = null) {
  const docs: WaymarkDoc[] = [];
  const removed: string[] = [];
  const logs: string[] = [];
  const res = await notionConnector(
    { id: 'n' },
    f.impl,
  )({
    sourceId: 'n',
    cursor,
    log: (m) => logs.push(m),
    emit: async (d) => {
      docs.push(d);
    },
    remove: async (id) => {
      removed.push(id);
    },
    listIds: () => [],
  });
  return { ...res, docs, removed, logs };
}

describe('notion connector', () => {
  const saved = process.env.NOTION_TOKEN;
  beforeEach(() => {
    process.env.NOTION_TOKEN = 'secret-token';
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.NOTION_TOKEN;
    else process.env.NOTION_TOKEN = saved;
  });

  it('pages through search, stops at first older page, removes trashed', async () => {
    const f = fakeFetch({
      searchPages: [
        [
          page('p1', '2026-03-03T00:00:00.000Z'),
          page('p2', '2026-03-02T00:00:00.000Z', { in_trash: true }),
        ],
        [page('p3', '2026-03-01T00:00:00.000Z'), page('p4', '2026-02-01T00:00:00.000Z')],
        [page('p5', '2026-01-01T00:00:00.000Z')],
      ],
      blocks: { p1: [blk('b', 'paragraph', { rich_text: rt('hi') })] },
    });
    const r = await run(f, '2026-03-01T00:00:00.000Z');
    expect(r.docs.map((d) => d.id)).toEqual(['n/doc/p1', 'n/doc/p3']); // equal timestamp re-processed
    expect(r.removed).toEqual(['n/doc/p2']);
    expect(r.cursor).toBe('2026-03-03T00:00:00.000Z');
    expect(f.seen.filter((s) => s.url.endsWith('/search'))).toHaveLength(2); // never fetched page 3
    expect(r.docs[0]).toMatchObject({
      kind: 'doc',
      title: 'Page p1',
      url: 'https://notion.so/p1',
      authors: [],
      tags: ['notion'],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-03-03T00:00:00.000Z',
      body: 'hi',
    });
    const headers = f.seen[0]?.init.headers as Record<string, string>;
    expect(headers['Notion-Version']).toBe('2026-03-11');
    expect(headers.Authorization).toBe('Bearer secret-token');
    expect(JSON.parse(f.seen[0]?.init.body as string)).toMatchObject({
      filter: { property: 'object', value: 'page' },
      sort: { timestamp: 'last_edited_time', direction: 'descending' },
      page_size: 100,
    });
  });

  it('first run takes everything; archived removed; title fallback', async () => {
    const f = fakeFetch({
      searchPages: [
        [
          page('a', '2026-03-02T00:00:00.000Z', { properties: {} }),
          page('b', '2026-01-01T00:00:00.000Z', { archived: true }),
        ],
      ],
      blocks: {},
    });
    const r = await run(f);
    expect(r.docs[0]?.title).toBe('Untitled');
    expect(r.removed).toEqual(['n/doc/b']);
    expect(r.count).toBe(1);
  });

  it('converts blocks to markdown, nested, with depth cut-off', async () => {
    const f = fakeFetch({
      searchPages: [[page('p', '2026-03-01T00:00:00.000Z')]],
      blocks: {
        p: [
          blk('1', 'heading_1', { rich_text: rt('One') }),
          blk('2', 'heading_2', { rich_text: rt('Two') }),
          blk('3', 'heading_3', { rich_text: rt('Three') }),
          blk('4', 'heading_4', { rich_text: rt('Four') }),
          blk('5', 'paragraph', { rich_text: rt('para') }),
          blk('6', 'bulleted_list_item', { rich_text: rt('bul') }, true),
          blk('7', 'numbered_list_item', { rich_text: rt('num') }),
          blk('8', 'to_do', { rich_text: rt('done'), checked: true }),
          blk('9', 'to_do', { rich_text: rt('open'), checked: false }),
          blk('10', 'quote', { rich_text: rt('q') }),
          blk('11', 'callout', { rich_text: rt('c') }),
          blk('12', 'code', { rich_text: rt('x = 1'), language: 'python' }),
          blk('13', 'divider', {}),
          blk('14', 'child_page', { title: 'Kid' }, true),
          blk('15', 'image', {}),
        ],
        '6': [blk('6a', 'bulleted_list_item', { rich_text: rt('l2') }, true)],
        '6a': [blk('6b', 'bulleted_list_item', { rich_text: rt('l3') }, true)],
        '6b': [blk('6c', 'bulleted_list_item', { rich_text: rt('l4') })],
      },
    });
    const r = await run(f);
    expect(r.docs[0]?.body).toBe(
      [
        '# One',
        '## Two',
        '### Three',
        '#### Four',
        'para',
        '- bul',
        '  - l2',
        '    - l3',
        '1. num',
        '- [x] done',
        '- [ ] open',
        '> q',
        '> c',
        '```python\nx = 1\n```',
        '---',
        '- [Kid]',
      ].join('\n'),
    );
    expect(r.logs.some((l) => l.includes('deeper than 3'))).toBe(true);
    expect(f.seen.some((s) => s.url.includes('blocks/14/'))).toBe(false); // child page is its own doc
    expect(f.seen.some((s) => s.url.includes('blocks/6b/'))).toBe(false);
  });

  it('missing token: exact message', async () => {
    delete process.env.NOTION_TOKEN;
    const f = fakeFetch({ searchPages: [[]], blocks: {} });
    await expect(run(f)).rejects.toThrow(
      'Source "n": set NOTION_TOKEN to sync. Create an internal integration at notion.so/profile/integrations and add it to the pages to index.',
    );
  });

  it('errors never contain the token', async () => {
    const impl = (async () =>
      new Response('{}', { status: 401, statusText: 'Unauthorized' })) as unknown as typeof fetch;
    const err = await run({ impl, seen: [] }).catch((e: Error) => e);
    expect((err as Error).message).toContain('401');
    expect((err as Error).message).not.toContain('secret-token');
  });
});

describe('notion config', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'waymark-'));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });
  const load = async (source: object) => {
    const config = path.join(dir, 'config.json');
    await fs.writeFile(config, JSON.stringify({ version: 1, sources: [source] }));
    return loadConfig({ config } as never);
  };

  it('accepts notion, defaults auth to app', async () => {
    const c = await load({ id: 'n', type: 'notion' });
    expect(c.sources[0]).toMatchObject({ type: 'notion', auth: 'app' });
  });
  it("rejects auth: 'personal'", async () => {
    await expect(load({ id: 'n', type: 'notion', auth: 'personal' })).rejects.toThrow(
      "notion sources only support auth: 'app'",
    );
  });
});
