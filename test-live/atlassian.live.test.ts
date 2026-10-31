import { describe, expect, it } from 'vitest';
import {
  atlassianBase,
  atlassianCloudId,
  atlassianTokenProvider,
} from '../src/connectors/auth/atlassian.js';
import { runnable, secretValues } from './support.js';

describe.skipIf(
  !runnable(
    'atlassian',
    'WAYMARK_ATLASSIAN_CLIENT_ID',
    'WAYMARK_ATLASSIAN_CLIENT_SECRET',
    'LIVE_ATLASSIAN_SITE',
  ),
)('live: atlassian service account', () => {
  const site = process.env.LIVE_ATLASSIAN_SITE as string;

  it('resolves the cloud id and authenticates as a non-human account', async () => {
    const cloudId = await atlassianCloudId(site);
    expect(cloudId).toMatch(/^[0-9a-f-]{36}$/);
    const token = await atlassianTokenProvider().getToken();
    expect(secretValues('WAYMARK_ATLASSIAN_CLIENT_SECRET').some((s) => token.includes(s))).toBe(
      false,
    );
    const res = await fetch(`${atlassianBase('jira', cloudId)}/rest/api/3/myself`, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
    });
    expect(res.ok).toBe(true);
    const me = (await res.json()) as { accountType?: string };
    // a person is 'atlassian'; the service account is an app/service identity
    expect(me.accountType).not.toBe('atlassian');
    console.log(`[live:atlassian] myself status=${res.status}`);
  }, 60_000);
});
