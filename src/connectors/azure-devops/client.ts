import type { TokenProvider } from '../auth/index.js';
import { envToken, fetchJson } from '../http.js';
import type { AdoComment, AdoWorkItem, AzureDevOpsApi } from './api.js';

export const WORK_ITEM_FIELDS = [
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
];

/** ADR-0002: personal PATs and tokens are for local testing only. */
export function personalAuthorization(sourceId: string): () => Promise<string> {
  const pat = process.env.AZURE_DEVOPS_EXT_PAT || process.env.AZURE_DEVOPS_PAT;
  if (pat) {
    const basic = `Basic ${Buffer.from(`:${pat}`).toString('base64')}`;
    return async () => basic;
  }
  const token = envToken(
    sourceId,
    ['AZURE_DEVOPS_TOKEN'],
    'Or set AZURE_DEVOPS_EXT_PAT (or AZURE_DEVOPS_PAT) to a personal access token. Personal credentials are for local testing only: see docs/identities.md#azure-devops.',
  );
  return async () => `Bearer ${token}`;
}

export function appAuthorization(tokens: TokenProvider): () => Promise<string> {
  return async () => `Bearer ${await tokens.getToken()}`;
}

export function createAzureDevOpsApi(
  organization: string,
  project: string,
  authorization: () => Promise<string>,
  fetchImpl?: typeof fetch,
): AzureDevOpsApi {
  const base = `https://dev.azure.com/${organization}/${encodeURIComponent(project)}/_apis`;
  const call = async <T>(url: string, body?: unknown): Promise<T> =>
    fetchJson<T>(url, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        authorization: await authorization(),
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(fetchImpl ? { fetchImpl } : {}),
    });
  return {
    async queryIds(query) {
      const r = await call<{ workItems?: Array<{ id: number }> }>(
        `${base}/wit/wiql?timePrecision=true&api-version=7.1`,
        { query },
      );
      return (r.workItems ?? []).map((w) => w.id);
    },
    async getWorkItems(ids) {
      const r = await call<{ value?: AdoWorkItem[] }>(
        `${base}/wit/workitemsbatch?api-version=7.1`,
        { ids, fields: WORK_ITEM_FIELDS },
      );
      return (r.value ?? []).map((w) => ({ id: w.id, fields: w.fields }));
    },
    async comments(id) {
      const all: AdoComment[] = [];
      let token: string | undefined;
      do {
        const q = token === undefined ? '' : `&continuationToken=${encodeURIComponent(token)}`;
        const r = await call<{ comments?: AdoComment[]; continuationToken?: string }>(
          `${base}/wit/workItems/${id}/comments?api-version=7.1-preview.4${q}`,
        );
        all.push(...(r.comments ?? []));
        token = r.continuationToken || undefined;
      } while (token !== undefined);
      return all;
    },
  };
}
