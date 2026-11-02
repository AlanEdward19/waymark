import { fileAuditSink } from '../audit.js';
import { findUserByIdentity, openAuthDb } from '../auth/store.js';
import { BOT_PLATFORMS, type BotPlatform, BotsSchema, loadConfig } from '../config.js';
import { openDb } from '../index/db.js';
import { queryEmbedderFrom } from '../index/hybrid.js';
import type { WaymarkPaths } from '../paths.js';
import { createSearchAnswerEngine } from './answer.js';
import { createBotRuntime } from './runtime.js';
import type { BotAdapter } from './types.js';

/** Neutral Markdown → platform format; each platform issue registers its converter here. */
export type Formatter = (markdown: string) => string;
export const FORMATTERS: Partial<Record<BotPlatform, Formatter>> = {};

export const isBotPlatform = (p: string): p is BotPlatform =>
  (BOT_PLATFORMS as readonly string[]).includes(p);

/** Adapter that prints replies instead of posting them, for `waymark bot test`. */
export function consoleAdapter(
  platform: BotPlatform,
  write: (text: string) => void,
  log: (msg: string) => void,
): BotAdapter {
  const format = FORMATTERS[platform] ?? ((m: string) => m);
  return {
    platform,
    start: async () => {},
    stop: async () => {},
    acknowledge: async () => log(`bot test: acknowledged (${platform})`),
    reply: async (_event, reply) => write(`${format(reply.markdown)}\n`),
  };
}

/** Runs one question through the full bot pipeline with the console adapter. */
export async function runBotTest(
  paths: WaymarkPaths,
  input: { platform: string; user?: string; question: string },
  write: (text: string) => void = (t) => process.stdout.write(t),
  log: (msg: string) => void = (m) => process.stderr.write(`${m}\n`),
): Promise<void> {
  const { platform, user, question } = input;
  if (!isBotPlatform(platform)) {
    throw new Error(`unknown bot platform "${platform}" (valid: ${BOT_PLATFORMS.join(', ')})`);
  }
  if (!user) throw new Error('bot test needs --user <externalUserId>');
  if (question.trim() === '') throw new Error('bot test needs a question');

  const config = await loadConfig(paths);
  const authDb = openAuthDb(paths.authDb);
  const db = openDb(paths.db);
  try {
    const runtime = createBotRuntime({
      bots: config.bots ?? BotsSchema.parse({}),
      auditQueries: config.audit?.queries,
      resolveUser: (p, id) => findUserByIdentity(authDb, p, id),
      answer: createSearchAnswerEngine({ db, config, embedQuery: queryEmbedderFrom(config) }),
      audit: fileAuditSink(paths.audit),
      log,
    });
    await runtime.handle(consoleAdapter(platform, write, log), {
      platform,
      externalUserId: user,
      displayName: user,
      text: question,
      isBotAuthor: false,
      context: { console: 'bot-test' },
    });
  } finally {
    db.close();
    authDb.close();
  }
}
