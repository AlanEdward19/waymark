import type { AzureDevOpsSource } from '../../config.js';
import { ADO_SCOPE, entraTokenProvider } from '../auth/entra.js';
import type { TokenProvider } from '../auth/index.js';
import type { Connector } from '../types.js';
import type { AzureDevOpsApi } from './api.js';
import { appAuthorization, createAzureDevOpsApi, personalAuthorization } from './client.js';
import { type AdoPullsApi, createPullsApi, syncPulls } from './pulls.js';
import { createWikiApi, syncWiki, type WikiApi } from './wiki.js';
import { syncWorkItems } from './workitems.js';

interface Cursor {
  workitems?: string;
  pulls?: string;
}

function parseCursor(raw: string | null): Cursor {
  if (raw === null) return {};
  try {
    const v: unknown = JSON.parse(raw);
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Cursor) : {};
  } catch {
    return {};
  }
}

export interface AzureDevOpsDeps {
  api?: AzureDevOpsApi; // tests: brings its own credentials
  pullsApi?: AdoPullsApi;
  wikiApi?: WikiApi;
  tokens?: TokenProvider; // tests: fake Entra provider
  entra?: typeof entraTokenProvider; // tests: spy on the requested scope
  fetch?: typeof fetch;
}

export function azureDevOpsConnector(
  source: AzureDevOpsSource,
  deps: AzureDevOpsDeps = {},
): Connector {
  return async (ctx) => {
    let authorization: (() => Promise<string>) | undefined;
    const authorize = async () => {
      if (authorization === undefined) {
        if (source.auth === 'personal') {
          ctx.log(
            `warn: ${source.id} uses a personal token; production must use the Waymark app identity (docs/adr/0002-own-identity.md)`,
          );
          authorization = personalAuthorization(source.id);
        } else {
          authorization = appAuthorization(
            deps.tokens ?? (deps.entra ?? entraTokenProvider)({ scope: ADO_SCOPE }),
          );
        }
      }
      return authorization();
    };
    const cursor = parseCursor(ctx.cursor);
    for (const key of ['workitems', 'pulls'] as const) {
      if (typeof cursor[key] !== 'string' || Number.isNaN(Date.parse(cursor[key])))
        delete cursor[key];
    }
    let count = 0;
    let removed = 0;
    if (source.include.includes('workitems')) {
      const api =
        deps.api ??
        createAzureDevOpsApi(source.organization, source.project, authorize, deps.fetch);
      const r = await syncWorkItems(
        ctx,
        api,
        source.organization,
        source.project,
        cursor.workitems,
      );
      count += r.count;
      if (r.cursor !== undefined) cursor.workitems = r.cursor;
    }
    if (source.include.includes('pulls')) {
      const api =
        deps.pullsApi ?? createPullsApi(source.organization, source.project, authorize, deps.fetch);
      const r = await syncPulls(
        ctx,
        api,
        source.organization,
        source.project,
        cursor.pulls,
        source.repos,
      );
      count += r.count;
      if (r.cursor !== undefined) cursor.pulls = r.cursor;
    }
    if (source.include.includes('wiki')) {
      const api =
        deps.wikiApi ?? createWikiApi(source.organization, source.project, authorize, deps.fetch);
      const r = await syncWiki(ctx, api, source.wikis);
      count += r.count;
      removed += r.removed;
    }
    return {
      cursor: JSON.stringify(cursor),
      count,
      ...(source.include.includes('wiki') ? { removed } : {}),
    };
  };
}
