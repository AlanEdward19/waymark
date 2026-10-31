import { describe, expect, it } from 'vitest';
import { githubAppTokenProvider } from '../src/connectors/auth/github-app.js';
import { checkRun, enabled, has, liveSync, secretValues } from './support.js';

const APP_KEY = has('WAYMARK_GITHUB_APP_PRIVATE_KEY') || has('WAYMARK_GITHUB_APP_PRIVATE_KEY_PATH');
const appReady = enabled('github') && has('LIVE_GITHUB_REPO', 'WAYMARK_GITHUB_APP_ID') && APP_KEY;
const personalReady =
  enabled('github') && has('LIVE_GITHUB_REPO') && (has('GITHUB_TOKEN') || has('GH_TOKEN'));

const api = (path: string, token: string) =>
  fetch(`https://api.github.com${path}`, {
    headers: { authorization: `Bearer ${token}`, 'user-agent': 'waymark-live' },
  });

describe.skipIf(!appReady)('live: github via GitHub App', () => {
  const repo = process.env.LIVE_GITHUB_REPO as string;
  const secrets = secretValues('WAYMARK_GITHUB_APP_PRIVATE_KEY', 'WAYMARK_GITHUB_INSTALLATION_ID');

  it('uses an installation token, not a user token', async () => {
    const token = await githubAppTokenProvider('live-github', repo).getToken();
    expect((await api('/installation/repositories', token)).ok).toBe(true); // installation tokens only
    expect((await api('/user', token)).ok).toBe(false); // there is no user behind the token
  }, 60_000);

  it('syncs pulls and issues without leaking secrets', async () => {
    const run = await liveSync({ id: 'live-github', type: 'github', repo }, secrets);
    checkRun(run, { kind: ['pull_request', 'issue'], host: ['github.com'], tagPrefix: 'state:' });
  }, 300_000);
});

describe.skipIf(!personalReady)('live: github via personal token (dev only)', () => {
  const secrets = secretValues('GITHUB_TOKEN', 'GH_TOKEN');

  it('syncs and logs the personal-token warning', async () => {
    const run = await liveSync(
      {
        id: 'live-github-personal',
        type: 'github',
        auth: 'personal',
        repo: process.env.LIVE_GITHUB_REPO,
      },
      secrets,
    );
    expect(run.warned).toBe(true);
    checkRun(run, { kind: ['pull_request', 'issue'], host: ['github.com'], tagPrefix: 'state:' });
  }, 300_000);
});
