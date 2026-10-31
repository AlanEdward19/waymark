import type { DiscordSource } from '../config.js';
import { buildChatDoc, type ChatDay, type ChatLine, chatDocId } from './chat.js';
import { envToken, fetchJson } from './http.js';
import type { Connector } from './types.js';

const BASE = 'https://discord.com/api/v10';
const EPOCH = 1420070400000n;
const MAX_PAGE = 100;
const DAY_MS = 86_400_000;
const TOKEN_TIP =
  'Create a bot at discord.com/developers, enable the Message Content intent, invite it with View Channel + Read Message History.';

interface DiscordUser {
  username: string;
  global_name?: string | null;
  bot?: boolean;
}
interface DiscordMessage {
  id: string;
  type: number;
  content: string;
  author: DiscordUser;
  message_reference?: { message_id?: string; type?: number };
}
interface DiscordChannel {
  name?: string;
  guild_id?: string;
}

export interface DiscordDeps {
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

/** Creation time (ms since Unix epoch) encoded in a snowflake id. */
export function snowflakeTime(id: string): number {
  return Number((BigInt(id) >> 22n) + EPOCH);
}

const cmp = (a: string, b: string) => {
  const d = BigInt(a) - BigInt(b);
  return d < 0n ? -1 : d > 0n ? 1 : 0;
};
const maxId = (ids: string[]) => ids.reduce((a, b) => (cmp(a, b) >= 0 ? a : b));
const minId = (ids: string[]) => ids.reduce((a, b) => (cmp(a, b) <= 0 ? a : b));

function parseCursor(raw: string | null): Record<string, string> {
  if (raw === null) return {};
  try {
    const v: unknown = JSON.parse(raw);
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return {};
    return Object.fromEntries(
      Object.entries(v).filter(([, s]) => typeof s === 'string' && /^\d+$/.test(s)),
    );
  } catch {
    return {};
  }
}

export function discordConnector(source: DiscordSource, deps: DiscordDeps = {}): Connector {
  const now = deps.now ?? (() => new Date());
  return async (ctx) => {
    const token = envToken(source.id, ['DISCORD_BOT_TOKEN'], TOKEN_TIP);
    const get = <T>(path: string) =>
      fetchJson<T>(`${BASE}${path}`, {
        headers: { Authorization: `Bot ${token}` },
        ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
      });

    const cursors = parseCursor(ctx.cursor);
    const cutoff = now().getTime() - source.backlogDays * DAY_MS;
    let count = 0;
    let failed = 0;

    for (const channelId of source.channels) {
      try {
        const since = cursors[channelId];
        const msgs: DiscordMessage[] = [];
        const page = (q: string) =>
          get<DiscordMessage[]>(`/channels/${channelId}/messages?limit=${MAX_PAGE}${q}`);

        if (since !== undefined) {
          let after = since;
          for (;;) {
            const batch = await page(`&after=${after}`);
            if (batch.length === 0) break;
            msgs.push(...batch);
            after = maxId(batch.map((m) => m.id));
            if (batch.length < MAX_PAGE) break;
          }
        } else {
          let before = '';
          for (;;) {
            const batch = await page(before);
            const fresh = batch.filter((m) => snowflakeTime(m.id) >= cutoff);
            msgs.push(...fresh);
            // pages run newest to oldest: a short page or an old message ends the backlog
            if (batch.length < MAX_PAGE || fresh.length < batch.length) break;
            before = `&before=${minId(batch.map((m) => m.id))}`;
          }
        }
        if (msgs.length === 0) continue;
        const newest = maxId(msgs.map((m) => m.id));

        const kept = msgs.filter((m) => !m.author.bot && (m.type === 0 || m.type === 19));
        if (kept.length > 0 && kept.every((m) => m.content.trim() === '')) {
          ctx.log('discord: empty message content — is the Message Content intent enabled?');
        }

        const channel = await get<DiscordChannel>(`/channels/${channelId}`);
        const name = channel.name ?? channelId;
        const days = new Map<string, ChatLine[]>();
        for (const m of kept.sort((a, b) => cmp(a.id, b.id))) {
          if (m.content.trim() === '') continue;
          const time = new Date(snowflakeTime(m.id)).toISOString();
          const ref = m.message_reference;
          const line: ChatLine = {
            id: m.id,
            author: m.author.global_name ?? m.author.username,
            time,
            text: m.content,
            isReply: ref?.message_id !== undefined && (ref.type ?? 0) === 0,
          };
          const key = time.slice(0, 10);
          days.set(key, [...(days.get(key) ?? []), line]);
        }
        for (const [day, lines] of days) {
          const chatDay: ChatDay = {
            channelKey: channelId,
            day,
            title: `#${name} — ${day}`,
            url: `https://discord.com/channels/${channel.guild_id ?? '@me'}/${channelId}`,
            tags: ['discord', `channel:${name}`],
            lines,
          };
          const existing = await ctx.readDoc(chatDocId(ctx.sourceId, channelId, day));
          await ctx.emit(buildChatDoc(ctx.sourceId, chatDay, existing));
          count++;
        }
        cursors[channelId] = newest; // only after the channel's docs are written
      } catch (err) {
        failed++;
        ctx.log(`warn: channel ${channelId}: ${(err as Error).message}`);
      }
    }
    if (failed === source.channels.length) {
      throw new Error('discord: every configured channel failed (see warnings above)');
    }
    return { cursor: JSON.stringify(cursors), count };
  };
}
