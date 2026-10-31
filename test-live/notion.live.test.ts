import { describe, it } from 'vitest';
import { checkRun, liveSync, runnable, secretValues } from './support.js';

describe.skipIf(!runnable('notion', 'NOTION_TOKEN'))('live: notion integration', () => {
  it('syncs pages shared with the integration', async () => {
    const run = await liveSync({ id: 'live-notion', type: 'notion' }, secretValues('NOTION_TOKEN'));
    checkRun(run, { kind: 'doc', host: ['notion.so', 'notion.site'], tagPrefix: 'notion' });
  }, 300_000);
});
