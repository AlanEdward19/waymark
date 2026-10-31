import { describe, expect, it } from 'vitest';
import { ADO_SCOPE, entraTokenProvider, GRAPH_SCOPE } from '../src/connectors/auth/entra.js';
import { has, runnable, secretValues } from './support.js';

const hasCredential = () =>
  has('AZURE_TENANT_ID', 'AZURE_CLIENT_ID') &&
  (has('AZURE_CLIENT_CERTIFICATE_PATH') || has('AZURE_CLIENT_SECRET'));

/** Claims of an unverified JWT, read only to check which identity the token is for. */
function claims(token: string): Record<string, unknown> {
  const payload = token.split('.')[1] ?? '';
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
}

describe.skipIf(!(runnable('entra') && hasCredential()))(
  'live: entra service principal token',
  () => {
    const secrets = secretValues('AZURE_CLIENT_SECRET');

    it.each([
      ['Azure DevOps', ADO_SCOPE],
      ['Microsoft Graph', GRAPH_SCOPE],
    ])(
      '%s token is for the configured app',
      async (_name, scope) => {
        const token = await entraTokenProvider({ scope }).getToken();
        const c = claims(token);
        expect(c.appid ?? c.azp).toBe(process.env.AZURE_CLIENT_ID);
        expect(typeof c.oid).toBe('string');
        expect(secrets.some((s) => token.includes(s))).toBe(false);
      },
      60_000,
    );

    it.skipIf(!has('LIVE_ADO_ORG'))(
      'Azure DevOps accepts the token (read-only)',
      async () => {
        const token = await entraTokenProvider({ scope: ADO_SCOPE }).getToken();
        const org = process.env.LIVE_ADO_ORG as string;
        const project = process.env.LIVE_ADO_PROJECT;
        const url = `https://dev.azure.com/${org}/_apis/projects${project ? `/${project}` : ''}?api-version=7.1`;
        const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
        expect(res.ok).toBe(true);
        console.log(`[live:entra] ado status=${res.status}`);
      },
      60_000,
    );
  },
);
