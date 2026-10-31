import { makeId } from '../store/doc.js';
import { envToken, fetchJson } from './http.js';
import type { Connector, SyncContext } from './types.js';

const API = 'https://api.notion.com/v1';
const NOTION_VERSION = '2026-03-11';
const MAX_DEPTH = 3; // ponytail: raise if real pages need it

interface RichText {
  plain_text: string;
}
// biome-ignore lint/suspicious/noExplicitAny: Notion block payloads are keyed by block type
type Block = { id: string; type: string; has_children?: boolean } & Record<string, any>;
interface Page {
  id: string;
  url?: string;
  created_time: string;
  last_edited_time: string;
  in_trash?: boolean;
  archived?: boolean;
  properties?: Record<string, { type: string; title?: RichText[] }>;
}
interface List<T> {
  results: T[];
  next_cursor: string | null;
  has_more: boolean;
}

const text = (rt: RichText[] | undefined) => (rt ?? []).map((t) => t.plain_text).join('');
const prefixLines = (s: string, p: string) =>
  s
    .split('\n')
    .map((l) => p + l)
    .join('\n');

/** One block's own markdown, without indentation or children; null = unsupported type. */
function blockLine(b: Block): string | null {
  const data = b[b.type] ?? {};
  const t = text(data.rich_text);
  const heading = /^heading_([1-4])$/.exec(b.type);
  if (heading) return `${'#'.repeat(Number(heading[1]))} ${t}`;
  switch (b.type) {
    case 'paragraph':
      return t;
    case 'bulleted_list_item':
      return `- ${t}`;
    case 'numbered_list_item':
      return `1. ${t}`;
    case 'to_do':
      return `- [${data.checked ? 'x' : ' '}] ${t}`;
    case 'quote':
    case 'callout':
      return prefixLines(t, '> ');
    case 'code':
      return `\`\`\`${data.language ?? ''}\n${t}\n\`\`\``;
    case 'divider':
      return '---';
    case 'child_page':
      return `- [${data.title ?? 'Untitled'}]`;
    default:
      return null;
  }
}

async function listAll<T>(url: string, init: RequestInit, fetchImpl: typeof fetch): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | null = null;
  do {
    const q: string = `page_size=100${cursor ? `&start_cursor=${encodeURIComponent(cursor)}` : ''}`;
    const res: List<T> = await fetchJson<List<T>>(`${url}?${q}`, { ...init, fetchImpl });
    out.push(...res.results);
    cursor = res.has_more ? res.next_cursor : null;
  } while (cursor);
  return out;
}

export function notionConnector(
  source: { id: string },
  fetchImpl: typeof fetch = fetch,
): Connector {
  return async (ctx: SyncContext) => {
    const token = envToken(
      source.id,
      ['NOTION_TOKEN'],
      'Create an internal integration at notion.so/profile/integrations and add it to the pages to index.',
    );
    const init: RequestInit = {
      headers: {
        Authorization: `Bearer ${token}`,
        'Notion-Version': NOTION_VERSION,
        'Content-Type': 'application/json',
      },
    };

    async function render(blockId: string, depth: number): Promise<string[]> {
      const blocks = await listAll<Block>(`${API}/blocks/${blockId}/children`, init, fetchImpl);
      const lines: string[] = [];
      const indent = '  '.repeat(depth - 1);
      for (const b of blocks) {
        const line = blockLine(b);
        if (line === null) continue;
        lines.push(prefixLines(line, indent));
        if (!b.has_children || b.type === 'child_page') continue;
        if (depth >= MAX_DEPTH) {
          ctx.log(`skipping blocks nested deeper than ${MAX_DEPTH} under ${b.id}`);
          continue;
        }
        lines.push(...(await render(b.id, depth + 1)));
      }
      return lines;
    }

    let newest = ctx.cursor;
    let count = 0;
    let removed = 0;
    let cursor: string | null = null;
    scan: do {
      const res: List<Page> = await fetchJson<List<Page>>(`${API}/search`, {
        ...init,
        method: 'POST',
        body: JSON.stringify({
          filter: { property: 'object', value: 'page' },
          sort: { timestamp: 'last_edited_time', direction: 'descending' },
          page_size: 100,
          ...(cursor ? { start_cursor: cursor } : {}),
        }),
        fetchImpl,
      });
      for (const page of res.results) {
        if (ctx.cursor !== null && page.last_edited_time < ctx.cursor) break scan;
        const id = makeId(ctx.sourceId, 'doc', page.id);
        if (newest === null || page.last_edited_time > newest) newest = page.last_edited_time;
        if (page.in_trash || page.archived) {
          await ctx.remove(id);
          removed++;
          continue;
        }
        const titleProp = Object.values(page.properties ?? {}).find((p) => p.type === 'title');
        await ctx.emit({
          id,
          kind: 'doc',
          sourceId: ctx.sourceId,
          title: text(titleProp?.title) || 'Untitled',
          ...(page.url ? { url: page.url } : {}),
          authors: [],
          createdAt: page.created_time,
          updatedAt: page.last_edited_time,
          tags: ['notion'],
          body: (await render(page.id, 1)).join('\n'),
        });
        count++;
      }
      cursor = res.has_more ? res.next_cursor : null;
    } while (cursor);
    return { cursor: newest, count, ...(removed ? { removed } : {}) };
  };
}
