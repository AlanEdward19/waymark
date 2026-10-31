import { describe, expect, it } from 'vitest';
import {
  atlassianBase,
  atlassianCloudId,
  atlassianTokenProvider,
} from '../src/connectors/auth/atlassian.js';

const env = { WAYMARK_ATLASSIAN_CLIENT_ID: 'cid', WAYMARK_ATLASSIAN_CLIENT_SECRET: 'shh-secret' };

describe('atlassianTokenProvider', () => {
  it('posts JSON credentials and caches the token for its lifetime', async () => {
    let t = 0;
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const f = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return Response.json({ access_token: `tok${calls.length}`, expires_in: 3600 });
    }) as unknown as typeof fetch;
    const p = atlassianTokenProvider(env, f, () => t);
    expect(await p.getToken()).toBe('tok1');
    t = 30 * 60 * 1000;
    expect(await p.getToken()).toBe('tok1');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://auth.atlassian.com/oauth/token');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(calls[0]?.init?.headers).toEqual({ 'content-type': 'application/json' });
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      grant_type: 'client_credentials',
      client_id: 'cid',
      client_secret: 'shh-secret',
    });
    t = 56 * 60 * 1000;
    expect(await p.getToken()).toBe('tok2');
  });

  it('errors without credentials', () => {
    expect(() => atlassianTokenProvider({}, fetch)).toThrow(/WAYMARK_ATLASSIAN_CLIENT_ID/);
  });

  it('never leaks the secret in errors', async () => {
    const f = (async () =>
      Response.json({ error: 'shh-secret' }, { status: 401 })) as unknown as typeof fetch;
    const err = await atlassianTokenProvider(env, f)
      .getToken()
      .catch((e: Error) => e);
    expect((err as Error).message).toMatch(/401/);
    expect((err as Error).message).not.toContain('shh-secret');
    const bad = (async () => Response.json({ access_token: 5 })) as unknown as typeof fetch;
    const err2 = await atlassianTokenProvider(env, bad)
      .getToken()
      .catch((e: Error) => e);
    expect((err2 as Error).message).not.toContain('shh-secret');
  });
});

describe('atlassianCloudId', () => {
  it('resolves once per site', async () => {
    const urls: string[] = [];
    const f = (async (url: string) => {
      urls.push(url);
      return Response.json({ cloudId: 'abc-123' });
    }) as unknown as typeof fetch;
    expect(await atlassianCloudId('one.atlassian.net', f)).toBe('abc-123');
    expect(await atlassianCloudId('one.atlassian.net', f)).toBe('abc-123');
    expect(await atlassianCloudId('two.atlassian.net', f)).toBe('abc-123');
    expect(urls).toEqual([
      'https://one.atlassian.net/_edge/tenant_info',
      'https://two.atlassian.net/_edge/tenant_info',
    ]);
  });

  it('errors and does not cache failures', async () => {
    const bad = (async () => new Response('nope', { status: 404 })) as unknown as typeof fetch;
    await expect(atlassianCloudId('bad.atlassian.net', bad)).rejects.toThrow(
      'Could not resolve Atlassian cloud id for bad.atlassian.net',
    );
    const ok = (async () => Response.json({ cloudId: 'x' })) as unknown as typeof fetch;
    expect(await atlassianCloudId('bad.atlassian.net', ok)).toBe('x');
  });
});

describe('atlassianBase', () => {
  it('builds exact base urls', () => {
    expect(atlassianBase('jira', 'id1')).toBe('https://api.atlassian.com/ex/jira/id1');
    expect(atlassianBase('confluence', 'id1')).toBe('https://api.atlassian.com/ex/confluence/id1');
  });
});
