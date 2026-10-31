import { fetchJson } from '../http.js';
import { cachedToken, type TokenProvider } from './index.js';

const TOKEN_URL = 'https://api.linear.app/oauth/token';
const ADR = 'docs/adr/0002-own-identity.md';

export interface LinearAppDeps {
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  now?: () => number; // epoch ms
}

/** OAuth app with the client_credentials grant. Always asks for `read`: other scopes revoke app tokens. */
export function linearAppTokenProvider(sourceId: string, deps: LinearAppDeps = {}): TokenProvider {
  const env = deps.env ?? process.env;
  const now = deps.now ?? Date.now;
  const id = env.WAYMARK_LINEAR_CLIENT_ID;
  const secret = env.WAYMARK_LINEAR_CLIENT_SECRET;
  if (!id || !secret) {
    throw new Error(
      `Source "${sourceId}": Linear app credentials missing. Set WAYMARK_LINEAR_CLIENT_ID and WAYMARK_LINEAR_CLIENT_SECRET (see docs/identities.md#linear and ${ADR}). For local testing only, set "auth": "personal" on this source in config.json to use LINEAR_API_KEY instead.`,
    );
  }
  return cachedToken(async () => {
    const out = await fetchJson<{ access_token: string; expires_in: number }>(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        scope: 'read',
        client_id: id,
        client_secret: secret,
      }).toString(),
      ...(deps.fetch ? { fetchImpl: deps.fetch } : {}),
    });
    return { token: out.access_token, expiresAt: now() + out.expires_in * 1000 };
  }, now);
}
