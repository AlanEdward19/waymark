import { createSign } from 'node:crypto';
import fs from 'node:fs/promises';
import { cachedToken, type TokenProvider } from './index.js';

const API = 'https://api.github.com';
const ADR = 'docs/adr/0002-own-identity.md#github';

export interface GithubAppDeps {
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  now?: () => number; // epoch ms
}

const b64url = (v: string | Buffer) => Buffer.from(v).toString('base64url');

/** JWT (RS256) that authenticates as the app itself. */
export function signAppJwt(appId: string, privateKeyPem: string, nowMs: number): string {
  const now = Math.floor(nowMs / 1000);
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({ iat: now - 60, exp: now + 9 * 60, iss: appId }));
  const sig = createSign('RSA-SHA256').update(`${head}.${claims}`).sign(privateKeyPem);
  return `${head}.${claims}.${b64url(sig)}`;
}

export function githubAppTokenProvider(
  sourceId: string,
  repo: string,
  deps: GithubAppDeps = {},
): TokenProvider {
  const env = deps.env ?? process.env;
  const doFetch = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;

  const appId = env.WAYMARK_GITHUB_APP_ID;
  const keyPem = env.WAYMARK_GITHUB_APP_PRIVATE_KEY;
  const keyPath = env.WAYMARK_GITHUB_APP_PRIVATE_KEY_PATH;
  if (!appId || !(keyPem || keyPath)) {
    throw new Error(
      `Source "${sourceId}": GitHub App credentials missing. Set WAYMARK_GITHUB_APP_ID and WAYMARK_GITHUB_APP_PRIVATE_KEY (or WAYMARK_GITHUB_APP_PRIVATE_KEY_PATH); optional WAYMARK_GITHUB_INSTALLATION_ID. See ${ADR}. For local testing only, set "auth": "personal" on this source in config.json to use GITHUB_TOKEN (or GH_TOKEN) instead.`,
    );
  }

  const call = async (method: string, url: string, jwt: string): Promise<unknown> => {
    const res = await doFetch(`${API}${url}`, {
      method,
      headers: {
        authorization: `Bearer ${jwt}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'waymark',
      },
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { message?: unknown };
      const msg = typeof body.message === 'string' ? `: ${body.message}` : '';
      throw new Error(
        `Source "${sourceId}": GitHub App request ${method} ${url} failed with ${res.status}${msg}. Check the app is installed on ${repo} and its id and private key are right (${ADR}).`,
      );
    }
    return res.json();
  };

  let installationId = env.WAYMARK_GITHUB_INSTALLATION_ID || undefined;
  return cachedToken(async () => {
    const pem = keyPem ? keyPem.replace(/\n/g, '\n') : await fs.readFile(keyPath as string, 'utf8');
    const jwt = signAppJwt(appId, pem, now());
    if (installationId === undefined) {
      const inst = (await call('GET', `/repos/${repo}/installation`, jwt)) as { id: number };
      installationId = String(inst.id);
    }
    const out = (await call('POST', `/app/installations/${installationId}/access_tokens`, jwt)) as {
      token: string;
      expires_at: string;
    };
    return { token: out.token, expiresAt: Date.parse(out.expires_at) };
  }, now);
}
