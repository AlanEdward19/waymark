import { createPublicKey, createVerify, generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigSchema } from '../src/config.js';
import { githubAppTokenProvider, signAppJwt } from '../src/connectors/auth/github-app.js';
import { cachedToken } from '../src/connectors/auth/index.js';
import type { GithubApi } from '../src/connectors/github/api.js';
import { githubConnector } from '../src/connectors/github/index.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
const T0 = Date.UTC(2026, 0, 1);

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function fakeGithub() {
  const calls: Array<{ method: string; url: string; auth: string }> = [];
  const impl = async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url).replace('https://api.github.com', '');
    const headers = init?.headers as Record<string, string>;
    calls.push({ method: init?.method ?? 'GET', url: u, auth: headers.authorization ?? '' });
    if (u.endsWith('/installation')) return Response.json({ id: 99 });
    return Response.json({
      token: `ghs_token${calls.length}`,
      expires_at: new Date(T0 + 60 * 60 * 1000).toISOString(),
    });
  };
  return { calls, fetch: impl as typeof fetch };
}

const appEnv = {
  WAYMARK_GITHUB_APP_ID: '12345',
  WAYMARK_GITHUB_APP_PRIVATE_KEY: privateKey,
};

describe('signAppJwt', () => {
  it('signs RS256 with the specified claims', () => {
    const jwt = signAppJwt('12345', privateKey, T0);
    const [h, c, s] = jwt.split('.') as [string, string, string];
    expect(JSON.parse(Buffer.from(h, 'base64url').toString())).toEqual({
      alg: 'RS256',
      typ: 'JWT',
    });
    expect(JSON.parse(Buffer.from(c, 'base64url').toString())).toEqual({
      iat: T0 / 1000 - 60,
      exp: T0 / 1000 + 540,
      iss: '12345',
    });
    const ok = createVerify('RSA-SHA256')
      .update(`${h}.${c}`)
      .verify(createPublicKey(publicKey), Buffer.from(s, 'base64url'));
    expect(ok).toBe(true);
  });
});

describe('cachedToken', () => {
  it('fetches once and refreshes 5 minutes before expiry', async () => {
    let now = T0;
    const fetchToken = vi.fn(async () => ({ token: `t${now}`, expiresAt: T0 + 3600_000 }));
    const p = cachedToken(fetchToken, () => now);
    expect(await p.getToken()).toBe(`t${T0}`);
    now = T0 + 54 * 60_000;
    expect(await p.getToken()).toBe(`t${T0}`);
    expect(fetchToken).toHaveBeenCalledTimes(1);
    now = T0 + 55 * 60_000;
    expect(await p.getToken()).toBe(`t${now}`);
    expect(fetchToken).toHaveBeenCalledTimes(2);
  });

  it('shares one fetch between concurrent callers', async () => {
    const fetchToken = vi.fn(async () => ({ token: 'a', expiresAt: T0 + 3600_000 }));
    const p = cachedToken(fetchToken, () => T0);
    await Promise.all([p.getToken(), p.getToken()]);
    expect(fetchToken).toHaveBeenCalledTimes(1);
  });
});

describe('githubAppTokenProvider', () => {
  it('resolves the installation, mints a token once and reuses it until near expiry', async () => {
    let now = T0;
    const gh = fakeGithub();
    const p = githubAppTokenProvider('gh', 'o/r', { env: appEnv, fetch: gh.fetch, now: () => now });
    const first = await p.getToken();
    expect(first).toMatch(/^ghs_token/);
    now = T0 + 54 * 60_000;
    expect(await p.getToken()).toBe(first);
    expect(gh.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'GET /repos/o/r/installation',
      'POST /app/installations/99/access_tokens',
    ]);
    expect(gh.calls.every((c) => c.auth.startsWith('Bearer ey'))).toBe(true);
    now = T0 + 56 * 60_000;
    expect(await p.getToken()).not.toBe(first);
    // installation id is remembered
    expect(gh.calls.filter((c) => c.url.endsWith('/installation'))).toHaveLength(1);
  });

  it('uses WAYMARK_GITHUB_INSTALLATION_ID and a key file path', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'waymark-'));
    try {
      const keyPath = path.join(dir, 'app.pem');
      await fs.writeFile(keyPath, privateKey);
      const gh = fakeGithub();
      const p = githubAppTokenProvider('gh', 'o/r', {
        env: {
          WAYMARK_GITHUB_APP_ID: '1',
          WAYMARK_GITHUB_APP_PRIVATE_KEY_PATH: keyPath,
          WAYMARK_GITHUB_INSTALLATION_ID: '7',
        },
        fetch: gh.fetch,
        now: () => T0,
      });
      await p.getToken();
      expect(gh.calls.map((c) => c.url)).toEqual(['/app/installations/7/access_tokens']);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('missing env names the variables, the ADR and the personal fallback', () => {
    expect(() => githubAppTokenProvider('gh', 'o/r', { env: {} })).toThrow(
      /WAYMARK_GITHUB_APP_ID.*WAYMARK_GITHUB_APP_PRIVATE_KEY.*docs\/adr\/0002-own-identity\.md#github.*"auth": "personal"/s,
    );
  });
});

describe('GitHub connector auth', () => {
  const emptyApi = {} as GithubApi;
  const ctx = (log: (m: string) => void) => ({
    sourceId: 'gh',
    cursor: null,
    log,
    emit: async () => {},
  });

  it('config defaults auth to app', () => {
    const c = ConfigSchema.parse({
      version: 1,
      sources: [{ id: 'gh', type: 'github', repo: 'o/r' }],
    });
    expect(c.sources[0]?.auth).toBe('app');
  });

  it('auth app works with a fake api and does not warn', async () => {
    const logs: string[] = [];
    const run = githubConnector({ id: 'gh', type: 'github', repo: 'o/r', include: [] }, emptyApi);
    await run(ctx((m) => logs.push(m)));
    expect(logs).toEqual([]);
  });

  it('auth app without credentials fails naming env vars and ADR', async () => {
    vi.stubEnv('WAYMARK_GITHUB_APP_ID', '');
    vi.stubEnv('WAYMARK_GITHUB_APP_PRIVATE_KEY', '');
    vi.stubEnv('WAYMARK_GITHUB_APP_PRIVATE_KEY_PATH', '');
    const run = githubConnector({
      id: 'gh',
      type: 'github',
      repo: 'o/r',
      include: [],
      auth: 'app',
    });
    await expect(run(ctx(() => {}))).rejects.toThrow(/WAYMARK_GITHUB_APP_ID.*0002-own-identity/s);
  });

  it('auth personal warns once per sync', async () => {
    const logs: string[] = [];
    const run = githubConnector(
      { id: 'gh', type: 'github', repo: 'o/r', include: [], auth: 'personal' },
      emptyApi,
    );
    await run(ctx((m) => logs.push(m)));
    expect(logs).toEqual([
      'warn: gh uses a personal token; production must use the Waymark app identity (docs/adr/0002-own-identity.md)',
    ]);
  });
});

describe('secrets never leak', () => {
  it('keeps key, JWT and tokens out of stderr and errors', async () => {
    const written: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((c) => {
      written.push(String(c));
      return true;
    });
    const gh = fakeGithub();
    const good = githubAppTokenProvider('gh', 'o/r', {
      env: appEnv,
      fetch: gh.fetch,
      now: () => T0,
    });
    const token = await good.getToken();
    const bad = githubAppTokenProvider('gh', 'o/r', {
      env: appEnv,
      fetch: (async () =>
        Response.json({ message: 'Bad credentials' }, { status: 401 })) as typeof fetch,
      now: () => T0,
    });
    const err = (await bad.getToken().catch((e: Error) => e)) as Error;
    const jwtHeader = signAppJwt('12345', privateKey, T0).split('.')[0] as string;
    const everything = [...written, err.message, err.stack ?? ''].join('\n');
    expect(everything).not.toContain('PRIVATE KEY');
    expect(everything).not.toContain(token);
    expect(everything).not.toContain(jwtHeader);
    expect(err.message).toContain('401');
    expect(gh.calls.length).toBeGreaterThan(0);
  });
});
