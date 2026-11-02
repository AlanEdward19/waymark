import type { AzureDevOpsSource } from '../../config.js';
import { ADO_SCOPE, entraTokenProvider } from '../auth/entra.js';
import type { TokenProvider } from '../auth/index.js';
import type { Connector } from '../types.js';
import type { AzureDevOpsApi } from './api.js';
import { appAuthorization, createAzureDevOpsApi, personalAuthorization } from './client.js';
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
  tokens?: TokenProvider; // tests: fake Entra provider
  fetch?: typeof fetch;
}

export function azureDevOpsConnector(
  source: AzureDevOpsSource,
  deps: AzureDevOpsDeps = {},
): Connector {
  return async (ctx) => {
    let api = deps.api;
    if (api === undefined) {
      let authorization: () => Promise<string>;
      if (source.auth === 'personal') {
        ctx.log(
          `warn: ${source.id} uses a personal token; production must use the Waymark app identity (docs/adr/0002-own-identity.md)`,
        );
        authorization = personalAuthorization(source.id);
      } else {
        authorization = appAuthorization(deps.tokens ?? entraTokenProvider({ scope: ADO_SCOPE }));
      }
      api = createAzureDevOpsApi(source.organization, source.project, authorization, deps.fetch);
    }
    const cursor = parseCursor(ctx.cursor);
    let count = 0;

    if (source.include.includes('workitems')) {
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
    if (source.include.includes('pulls')) ctx.log('pulls: not implemented yet');

    return { cursor: JSON.stringify(cursor), count };
  };
}
