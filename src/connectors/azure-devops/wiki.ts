import { z } from 'zod';
import { redact } from '../../redact.js';
import { makeId, type WaymarkDoc } from '../../store/doc.js';
import { serializeDoc } from '../../store/markdown.js';
import { fetchWithRetry } from '../http.js';
import type { SyncContext } from '../types.js';

export interface AdoWiki {
  id: string;
  name: string;
}

export interface AdoWikiPage {
  path: string;
  remoteUrl: string;
  content?: string;
}

export interface WikiApi {
  listWikis(): Promise<AdoWiki[]>;
  wikiPages(
    wikiId: string,
    continuationToken?: string,
  ): Promise<{ pages: Array<{ id: number; path: string }>; continuationToken?: string }>;
  wikiPage(wikiId: string, id: number): Promise<AdoWikiPage>;
}

const WikiSchema = z.object({ id: z.string().min(1), name: z.string().min(1) });
const PageIdSchema = z.object({ id: z.number().int(), path: z.string().min(1) });
const PageSchema = z.object({
  path: z.string().min(1),
  remoteUrl: z.string().min(1),
  content: z.string().optional(),
});

function parseResponse<T>(schema: z.ZodType<T>, data: unknown): T {
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    throw new Error('Invalid Azure DevOps wiki response; retry sync before deleting pages');
  }
  return parsed.data;
}

export function createWikiApi(
  organization: string,
  project: string,
  authorization: () => Promise<string>,
  fetchImpl?: typeof fetch,
): WikiApi {
  const base = `https://dev.azure.com/${organization}/${encodeURIComponent(project)}/_apis/wiki/wikis`;
  const call = async (url: string, body?: unknown) => {
    const res = await fetchWithRetry(
      url,
      {
        method: body === undefined ? 'GET' : 'POST',
        redirect: 'error',
        headers: {
          authorization: await authorization(),
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
      {
        ...(fetchImpl ? { fetchImpl } : {}),
        giveUp: (_r, wait) => new Error(`Rate limited by dev.azure.com; retry after ${wait}s`),
      },
    );
    if (!res.ok) {
      const hint =
        res.status === 401 || res.status === 403
          ? "; check the identity's wiki read access: docs/identities.md#azure-devops"
          : '';
      throw new Error(`dev.azure.com responded ${res.status} ${res.statusText}${hint}`);
    }
    return res;
  };
  return {
    async listWikis() {
      return parseResponse(
        z.object({ value: z.array(WikiSchema) }),
        await (await call(`${base}?api-version=7.1`)).json(),
      ).value;
    },
    async wikiPages(wikiId, continuationToken) {
      const res = await call(`${base}/${encodeURIComponent(wikiId)}/pagesbatch?api-version=7.1`, {
        top: 100,
        ...(continuationToken === undefined ? {} : { continuationToken }),
      });
      const pages = parseResponse(
        z.object({ value: z.array(PageIdSchema) }),
        await res.json(),
      ).value;
      const token = res.headers.get('x-ms-continuationtoken');
      return { pages, ...(token ? { continuationToken: token } : {}) };
    },
    async wikiPage(wikiId, id) {
      return parseResponse(
        PageSchema,
        await (
          await call(
            `${base}/${encodeURIComponent(wikiId)}/pages/${id}?includeContent=true&api-version=7.1`,
          )
        ).json(),
      );
    },
  };
}

export async function syncWiki(
  ctx: SyncContext,
  api: WikiApi,
  wikiNames?: string[],
): Promise<{ count: number; removed: number }> {
  const wikis = (await api.listWikis()).filter(
    (wiki) => wikiNames === undefined || wikiNames.includes(wiki.name),
  );
  const seen = new Set<string>();
  let count = 0;
  // shortcut: full page fetch each sync; use backing-repo commits if thousands of pages get slow.
  for (const wiki of wikis) {
    let token: string | undefined;
    const tokens = new Set<string>();
    do {
      const batch = await api.wikiPages(wiki.id, token);
      for (const item of batch.pages) {
        const page = await api.wikiPage(wiki.id, item.id);
        if (!page.content?.trim()) continue;
        const id = makeId(ctx.sourceId, 'doc', `${wiki.name}${page.path}`);
        const previous = await ctx.readDoc(id);
        const now = new Date().toISOString();
        const doc: WaymarkDoc = {
          id,
          kind: 'doc',
          sourceId: ctx.sourceId,
          title: redact((page.path.split('/').at(-1) ?? '').replace(/-/g, ' ')),
          url: page.remoteUrl,
          body: redact(page.content),
          tags: ['azure-devops-wiki', redact(`wiki:${wiki.name}`)],
          authors: [],
          createdAt: previous?.createdAt ?? now,
          updatedAt: previous?.updatedAt ?? now,
        };
        // The API has no dates: retain stored dates when normalized content is unchanged.
        if (previous && serializeDoc(previous) !== serializeDoc(doc)) doc.updatedAt = now;
        await ctx.emit(doc);
        seen.add(id);
        count++;
      }
      token = batch.continuationToken;
      if (token !== undefined) {
        if (tokens.has(token))
          throw new Error('Azure DevOps wiki pagination repeated a token; retry sync');
        tokens.add(token);
      }
    } while (token !== undefined);
  }
  // Reaching this point means every selected wiki and page was fetched successfully.
  let removed = 0;
  for (const id of ctx.listIds('doc')) {
    if (seen.has(id)) continue;
    await ctx.remove(id);
    removed++;
  }
  return { count, removed };
}
