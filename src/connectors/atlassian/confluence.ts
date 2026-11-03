import type { ConfluenceSource } from '../../config.js';
import { makeId } from '../../store/doc.js';
import { atlassianBase, atlassianCloudId, atlassianTokenProvider } from '../auth/atlassian.js';
import { fetchWithRetry } from '../http.js';
import type { Connector } from '../types.js';
import { adfToMarkdown } from './adf.js';

export interface ConfluenceDeps {
  fetch?: typeof fetch;
  env?: NodeJS.ProcessEnv;
}
interface Space {
  id: string;
  key: string;
}
interface Page {
  id: string;
  title: string;
  createdAt: string;
  version: { createdAt: string };
  body: { atlas_doc_format: { value: string } };
  _links: { webui: string };
}

/** Keep pagination on the authenticated API path, including site-relative v2 links. */
function nextUrl(link: string | null, current: string, base: string): string | null {
  if (!link) return null;
  const next = [...link.matchAll(/<([^>]+)>\s*;\s*rel="?([^";,]+)"?/g)].find((m) =>
    m[2]?.split(/\s+/).includes('next'),
  )?.[1];
  if (!next) return null;
  const url = new URL(next.startsWith('/wiki/api/v2/') ? `${base}${next}` : next, current);
  if (
    url.origin !== new URL(base).origin ||
    !url.pathname.startsWith(`${new URL(base).pathname.replace(/\/$/, '')}/wiki/api/v2/`) ||
    url.username ||
    url.password ||
    url.hash
  ) {
    throw new Error('Confluence returned an unsafe pagination URL; sync stopped.');
  }
  return url.href;
}

export function confluenceConnector(
  source: ConfluenceSource,
  deps: ConfluenceDeps = {},
): Connector {
  const fetchImpl = deps.fetch ?? fetch;
  const env = deps.env ?? process.env;
  return async (ctx) => {
    let base: string;
    let authorization: () => Promise<string>;
    if (source.auth === 'personal') {
      ctx.log(
        `warn: ${source.id} uses a personal token; production must use the Waymark service account (docs/identities.md)`,
      );
      if (!env.CONFLUENCE_EMAIL || !env.CONFLUENCE_API_TOKEN) {
        throw new Error(
          `Source "${source.id}": set CONFLUENCE_EMAIL and CONFLUENCE_API_TOKEN to sync.`,
        );
      }
      base = `https://${source.site}`;
      authorization = async () =>
        `Basic ${Buffer.from(`${env.CONFLUENCE_EMAIL}:${env.CONFLUENCE_API_TOKEN}`).toString('base64')}`;
    } else {
      const provider = atlassianTokenProvider(env, fetchImpl);
      base = atlassianBase('confluence', await atlassianCloudId(source.site, fetchImpl));
      authorization = async () => `Bearer ${await provider.getToken()}`;
    }
    const list = async <T>(url: string): Promise<{ results: T[]; next: string | null }> => {
      const res = await fetchWithRetry(
        url,
        {
          headers: { accept: 'application/json', authorization: await authorization() },
          redirect: 'error',
        },
        { fetchImpl },
      );
      if (!res.ok)
        throw new Error(
          `Confluence responded ${res.status}; check service account access and configured spaces.`,
        );
      const body = (await res.json()) as { results?: T[] };
      if (!Array.isArray(body.results))
        throw new Error('Confluence returned no results array; sync stopped.');
      return { results: body.results, next: nextUrl(res.headers.get('link'), url, base) };
    };
    const pages = async function* <T>(first: string) {
      let url: string | null = first;
      const seen = new Set<string>();
      while (url) {
        if (seen.has(url)) throw new Error('Confluence repeated a pagination URL; sync stopped.');
        seen.add(url);
        const response: { results: T[]; next: string | null } = await list<T>(url);
        yield response.results;
        url = response.next;
      }
    };
    const spaces = new Map<string, Space>();
    const params = new URLSearchParams({
      keys: [...new Set(source.spaces)].join(','),
      limit: '250',
    });
    for await (const batch of pages<Space>(`${base}/wiki/api/v2/spaces?${params}`)) {
      for (const space of batch) {
        if (source.spaces.includes(space.key)) spaces.set(space.key, space);
      }
    }
    if (source.spaces.some((key) => !spaces.has(key))) {
      throw new Error(
        'Confluence could not resolve every configured space; check keys and service account access.',
      );
    }
    let previous: Record<string, string> = {};
    if (ctx.cursor !== null) {
      const parsed: unknown = JSON.parse(ctx.cursor);
      if (
        !parsed ||
        typeof parsed !== 'object' ||
        Array.isArray(parsed) ||
        Object.values(parsed).some((v) => typeof v !== 'string' || !Number.isFinite(Date.parse(v)))
      ) {
        throw new Error('Invalid Confluence cursor; reset source sync state.');
      }
      previous = parsed as Record<string, string>;
    }
    const cursor: Record<string, string> = {};
    let count = 0;
    for (const space of spaces.values()) {
      const since =
        previous[space.id] === undefined
          ? undefined
          : new Date(previous[space.id] as string).toISOString();
      if (since) cursor[space.id] = since;
      changes: for await (const batch of pages<Page>(
        `${base}/wiki/api/v2/spaces/${encodeURIComponent(space.id)}/pages?sort=-modified-date&status=current&body-format=atlas_doc_format&limit=100`,
      )) {
        for (const page of batch) {
          const updated = new Date(page.version.createdAt).toISOString();
          if (since && updated < since) break changes;
          await ctx.emit({
            id: makeId(source.id, 'doc', page.id),
            kind: 'doc',
            sourceId: source.id,
            title: page.title,
            url: `https://${source.site}/wiki${page._links.webui}`,
            createdAt: new Date(page.createdAt).toISOString(),
            updatedAt: updated,
            body: adfToMarkdown(JSON.parse(page.body.atlas_doc_format.value)),
            tags: ['confluence', `space:${space.key}`],
            authors: [],
          });
          count++;
          if (!cursor[space.id] || updated > (cursor[space.id] as string))
            cursor[space.id] = updated;
        }
      }
    }
    const current = new Set<string>();
    try {
      for (const space of spaces.values()) {
        for await (const batch of pages<{ id: string }>(
          `${base}/wiki/api/v2/spaces/${encodeURIComponent(space.id)}/pages?status=current&limit=250`,
        )) {
          for (const page of batch) {
            if (typeof page.id !== 'string' || !page.id)
              throw new Error('Confluence returned an invalid page id.');
            current.add(makeId(source.id, 'doc', page.id));
          }
        }
      }
    } catch {
      ctx.log('warn: Confluence page inventory failed; deletions skipped for this sync.');
      return { cursor: JSON.stringify(cursor), count, removed: 0 };
    }
    let removed = 0;
    for (const id of ctx.listIds('doc')) {
      if (!current.has(id)) {
        await ctx.remove(id);
        removed++;
      }
    }
    return { cursor: JSON.stringify(cursor), count, removed };
  };
}
