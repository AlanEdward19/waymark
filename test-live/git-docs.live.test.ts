import { describe, it } from 'vitest';
import { checkRun, enabled, liveSync } from './support.js';

// No credentials: syncs this repository's own markdown docs.
describe.skipIf(!enabled('git'))('live: git repo docs', () => {
  it('syncs docs from this repo twice, incrementally', async () => {
    const run = await liveSync(
      { id: 'live-git', type: 'git', path: process.cwd(), include: ['docs'] },
      [],
    );
    checkRun(run, { kind: 'doc', host: ['github.com'], tagPrefix: 'path:' });
  }, 120_000);
});
