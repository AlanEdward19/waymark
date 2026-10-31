import { describe, it } from 'vitest';
import { checkRun, liveSync, runnable, secretValues } from './support.js';

describe.skipIf(!runnable('discord', 'DISCORD_BOT_TOKEN', 'LIVE_DISCORD_CHANNEL'))(
  'live: discord bot',
  () => {
    it('syncs one channel', async () => {
      const run = await liveSync(
        {
          id: 'live-discord',
          type: 'discord',
          channels: [process.env.LIVE_DISCORD_CHANNEL],
          backlogDays: 30,
        },
        secretValues('DISCORD_BOT_TOKEN'),
      );
      checkRun(run, { kind: 'chat', host: ['discord.com'] });
    }, 300_000);
  },
);
