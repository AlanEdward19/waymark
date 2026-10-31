import { cachedToken, type TokenProvider } from './index.js';

const TOKEN_URL = 'https://auth.atlassian.com/oauth/token';
const DOC = 'docs/identities.md#jira-and-confluence';

/** OAuth 2.0 client-credentials token for an Atlassian Cloud service account. */
export function atlassianTokenProvider(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
  now: () => number = Date.now,
): TokenProvider {
  const clientId = env.WAYMARK_ATLASSIAN_CLIENT_ID;
  const clientSecret = env.WAYMARK_ATLASSIAN_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error(
      `Atlassian service account credentials missing. Set WAYMARK_ATLASSIAN_CLIENT_ID and WAYMARK_ATLASSIAN_CLIENT_SECRET. See ${DOC}.`,
    );
  }
  return cachedToken(async () => {
    const res = await fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: clientSecret,
      }),
    });
    if (!res.ok) {
      throw new Error(
        `Atlassian token request failed with ${res.status}. Check WAYMARK_ATLASSIAN_CLIENT_ID and WAYMARK_ATLASSIAN_CLIENT_SECRET (${DOC}).`,
      );
    }
    const body = (await res.json().catch(() => ({}))) as {
      access_token?: unknown;
      expires_in?: unknown;
    };
    if (typeof body.access_token !== 'string' || typeof body.expires_in !== 'number') {
      throw new Error(`Atlassian token response had no access_token/expires_in (${DOC}).`);
    }
    return { token: body.access_token, expiresAt: now() + body.expires_in * 1000 };
  }, now);
}

const cloudIds = new Map<string, Promise<string>>();

/** Resolves the cloud id of a site such as `acme.atlassian.net`; cached per site for the process. */
export function atlassianCloudId(site: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  let id = cloudIds.get(site);
  if (id === undefined) {
    id = (async () => {
      const res = await fetchImpl(`https://${site}/_edge/tenant_info`);
      const body = res.ok ? ((await res.json().catch(() => ({}))) as { cloudId?: unknown }) : {};
      if (typeof body.cloudId !== 'string' || body.cloudId === '') {
        throw new Error(`Could not resolve Atlassian cloud id for ${site}`);
      }
      return body.cloudId;
    })();
    cloudIds.set(site, id);
    id.catch(() => cloudIds.delete(site)); // do not cache failures
  }
  return id;
}

export function atlassianBase(product: 'jira' | 'confluence', cloudId: string): string {
  return `https://api.atlassian.com/ex/${product}/${cloudId}`;
}
