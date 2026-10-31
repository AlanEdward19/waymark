import { describe, expect, it } from 'vitest';
import { linearAppTokenProvider } from '../src/connectors/auth/linear-app.js';
import { checkRun, enabled, has, liveSync, secretValues } from './support.js';

const team = process.env.LIVE_LINEAR_TEAM;
const source = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  type: 'linear',
  ...(team ? { team } : {}),
  ...extra,
});

const viewerId = async (authorization: string): Promise<string> => {
  const res = await fetch('https://api.linear.app/graphql', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization },
    body: JSON.stringify({ query: '{ viewer { id } }' }),
  });
  const body = (await res.json()) as { data?: { viewer?: { id?: string } } };
  return body.data?.viewer?.id ?? '';
};

describe.skipIf(
  !(enabled('linear') && has('WAYMARK_LINEAR_CLIENT_ID', 'WAYMARK_LINEAR_CLIENT_SECRET')),
)('live: linear via OAuth app', () => {
  const secrets = secretValues('WAYMARK_LINEAR_CLIENT_ID', 'WAYMARK_LINEAR_CLIENT_SECRET');

  it('token belongs to the app actor', async () => {
    const token = await linearAppTokenProvider('live-linear').getToken();
    const appViewer = await viewerId(`Bearer ${token}`);
    expect(appViewer).toBeTruthy();
    // when a personal key is also set, the app actor must be a different identity
    if (process.env.LINEAR_API_KEY) {
      expect(appViewer).not.toBe(await viewerId(process.env.LINEAR_API_KEY));
    }
  }, 60_000);

  it('syncs issues without leaking secrets', async () => {
    const run = await liveSync(source('live-linear'), secrets);
    checkRun(run, { kind: 'issue', host: ['linear.app'], tagPrefix: 'state:' });
  }, 300_000);
});

describe.skipIf(!(enabled('linear') && has('LINEAR_API_KEY')))(
  'live: linear via personal key (dev only)',
  () => {
    it('syncs and logs the personal-token warning', async () => {
      const run = await liveSync(
        source('live-linear-personal', { auth: 'personal' }),
        secretValues('LINEAR_API_KEY'),
      );
      expect(run.warned).toBe(true);
      checkRun(run, { kind: 'issue', host: ['linear.app'], tagPrefix: 'state:' });
    }, 300_000);
  },
);
