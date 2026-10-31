import { createHash, createSign, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { cachedToken, type TokenProvider } from './index.js';

export const ADO_SCOPE = 'https://app.vssps.visualstudio.com/.default';
export const GRAPH_SCOPE = 'https://graph.microsoft.com/.default';

const DOC = 'docs/identities.md#azure-devops';
const IMDS = 'http://169.254.169.254/metadata/identity/oauth2/token';
const ASSERTION_TYPE = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';

export interface EntraOptions {
  scope: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  now?: () => number; // epoch ms
}

const b64url = (v: string | Buffer) => Buffer.from(v).toString('base64url');

function pemBlock(pem: string, label: string, path: string): string {
  const m = pem.match(new RegExp(`-----BEGIN ${label}-----[\\s\\S]+?-----END ${label}-----`));
  if (!m)
    throw new Error(
      `Entra certificate ${path} has no ${label} block (needs private key and certificate in one PEM)`,
    );
  return m[0];
}

/** Client assertion JWT (RS256) signed with the certificate's private key. */
export function signClientAssertion(
  pem: string,
  clientId: string,
  audience: string,
  nowMs: number,
  path = 'AZURE_CLIENT_CERTIFICATE_PATH',
): string {
  const key = pemBlock(pem, '(?:RSA |ENCRYPTED )?PRIVATE KEY', path);
  const der = Buffer.from(
    pemBlock(pem, 'CERTIFICATE', path).replace(/-----[A-Z ]+-----|\s/g, ''),
    'base64',
  );
  const now = Math.floor(nowMs / 1000);
  const head = b64url(
    JSON.stringify({
      alg: 'RS256',
      typ: 'JWT',
      'x5t#S256': createHash('sha256').update(der).digest('base64url'),
    }),
  );
  const claims = b64url(
    JSON.stringify({
      aud: audience,
      iss: clientId,
      sub: clientId,
      jti: randomUUID(),
      nbf: now,
      iat: now,
      exp: now + 10 * 60,
    }),
  );
  const sig = createSign('RSA-SHA256').update(`${head}.${claims}`).sign(key);
  return `${head}.${claims}.${b64url(sig)}`;
}

export function entraTokenProvider(opts: EntraOptions): TokenProvider {
  const env = opts.env ?? process.env;
  const doFetch = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now;
  const { scope } = opts;
  const tenant = env.AZURE_TENANT_ID;
  const clientId = env.AZURE_CLIENT_ID;
  const certPath = env.AZURE_CLIENT_CERTIFICATE_PATH;
  const secret = env.AZURE_CLIENT_SECRET;

  const request = async (url: string, init: RequestInit) => {
    const res = await doFetch(url, init);
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      throw new Error(
        `Entra token request failed: ${String(body.error ?? res.status)} ${String(body.error_description ?? '')}`.trimEnd(),
      );
    }
    const token = body.access_token;
    if (typeof token !== 'string')
      throw new Error('Entra token request failed: no access_token in response');
    const expiresOn = Number(body.expires_on);
    const expiresAt =
      expiresOn > 0 ? expiresOn * 1000 : now() + Number(body.expires_in ?? 3600) * 1000;
    return { token, expiresAt };
  };

  const clientCredentials = (tenantId: string, id: string, credential: Record<string, string>) => {
    const endpoint = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;
    return request(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: id,
        scope,
        ...credential,
      }).toString(),
    });
  };

  if (tenant && clientId && certPath) {
    return cachedToken(async () => {
      const pem = await fs.readFile(certPath, 'utf8');
      const endpoint = `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`;
      return clientCredentials(tenant, clientId, {
        client_assertion_type: ASSERTION_TYPE,
        client_assertion: signClientAssertion(pem, clientId, endpoint, now(), certPath),
      });
    }, now);
  }
  if (tenant && clientId && secret) {
    return cachedToken(() => clientCredentials(tenant, clientId, { client_secret: secret }), now);
  }
  if (env.WAYMARK_USE_MANAGED_IDENTITY === '1') {
    const query = new URLSearchParams({
      'api-version': '2018-02-01',
      resource: scope.replace(/\/\.default$/, ''),
    });
    if (clientId) query.set('client_id', clientId);
    return cachedToken(
      () => request(`${IMDS}?${query}`, { method: 'GET', headers: { Metadata: 'true' } }),
      now,
    );
  }
  throw new Error(
    `Entra credentials missing. Set one of: (1) AZURE_TENANT_ID, AZURE_CLIENT_ID and AZURE_CLIENT_CERTIFICATE_PATH (PEM with private key and certificate); (2) AZURE_TENANT_ID, AZURE_CLIENT_ID and AZURE_CLIENT_SECRET; (3) WAYMARK_USE_MANAGED_IDENTITY=1 (optional AZURE_CLIENT_ID for a user-assigned identity). See ${DOC}.`,
  );
}
