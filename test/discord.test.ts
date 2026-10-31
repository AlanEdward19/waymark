import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigSchema } from '../src/config.js';
import { buildChatDoc } from '../src/connectors/chat.js';
import { discordConnector, snowflakeTime } from '../src/connectors/discord.js';
import type { SyncContext } from '../src/connectors/types.js';
import type { WaymarkDoc } from '../src/store/doc.js';

afterEach(() => vi.unstubAllEnvs());

const CH = '111111111111111111';
const NOW = new Date('2026-10-30T12:00:00.000Z');
const EPOCH = 1420070400000n;

function snow(iso: string, n = 0): string {
  return (((BigInt(Date.parse(iso)) - EPOCH) << 22n) | BigInt(n)).toString();
}

interface Msg {
  id: string;
  type: number;
  content: string;
  author: { username: string; global_name?: string | null; bot?: boolean };
  message_reference?: { message_id: string };
}
const msg = (iso: string, content: string, extra: Partial<Msg> = {}, n = 0): Msg => ({
  id: snow(iso, n),
  type: 0,
  content,
  author: { username: 'ana', global_name: 'Ana' },
  ...extra,
});

function fakeFetch(all: Msg[]) {
  const urls: string[] = [];
  const headers: string[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    urls.push(url.pathname + url.search);
    headers.push(String(((init?.headers ?? {}) as Record<string, string>).Authorization));
    const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
    if (url.pathname.endsWith('/messages')) {
      const pageSize = Number(url.searchParams.get('limit'));
      const before = url.searchParams.get('before');
      const after = url.searchParams.get('after');
      let list = [...all].sort((a, b) => (BigInt(b.id) > BigInt(a.id) ? 1 : -1)); // newest first
      if (before) list = list.filter((m) => BigInt(m.id) < BigInt(before));
      if (after) {
        // Discord: the oldest messages after the id, returned newest first
        list = list.filter((m) => BigInt(m.id) > BigInt(after));
        return json(list.slice(-pageSize));
      }
      return json(list.slice(0, pageSize));
    }
    return json({ name: 'general', guild_id: '222222222222222222' });
  }) as typeof fetch;
  return { impl, urls, headers };
}

function fakeCtx(cursor: string | null, docs: Map<string, WaymarkDoc>) {
  const logs: string[] = [];
  const ctx: SyncContext = {
    sourceId: 'dc',
    cursor,
    emit: async (d) => void docs.set(d.id, d),
    remove: async () => {},
    readDoc: async (id) => docs.get(id) ?? null,
    listIds: () => [],
    log: (m) => void logs.push(m),
  };
  return { ctx, logs };
}

const source = {
  id: 'dc',
  type: 'discord' as const,
  auth: 'app' as const,
  channels: [CH],
  backlogDays: 30,
};

describe('snowflakeTime', () => {
  it('decodes the documented example id', () => {
    expect(new Date(snowflakeTime('175928847299117063')).toISOString()).toBe(
      '2016-04-30T11:18:25.796Z',
    );
  });
});

describe('discord config', () => {
  const parse = (s: object) => ConfigSchema.safeParse({ version: 1, sources: [s] });
  it('rejects non-numeric channel ids and personal auth', () => {
    expect(parse({ id: 'dc', type: 'discord', channels: ['general'] }).success).toBe(false);
    expect(parse({ id: 'dc', type: 'discord', channels: [CH], auth: 'personal' }).success).toBe(
      false,
    );
    expect(parse({ id: 'dc', type: 'discord', channels: [CH] }).success).toBe(true);
  });
});

describe('discordConnector', () => {
  it('first run stops at backlogDays, splits UTC days, skips bots and system messages', async () => {
    vi.stubEnv('DISCORD_BOT_TOKEN', 'sekrit-token');
    const filler = Array.from({ length: 150 }, (_, i) =>
      msg('2026-10-27T10:00:00Z', `filler ${i}`, {}, i),
    );
    const f = fakeFetch([
      ...filler,
      msg('2026-09-01T10:00:00Z', 'too old'),
      msg('2026-10-28T23:59:00Z', 'late tuesday\nsecond line'),
      msg('2026-10-29T00:01:00Z', 'early wednesday', { message_reference: { message_id: '1' } }),
      msg('2026-10-29T00:02:00Z', 'beep', { author: { username: 'bot', bot: true } }),
      msg('2026-10-29T00:03:00Z', 'joined', { type: 7 }),
    ]);
    const docs = new Map<string, WaymarkDoc>();
    const { ctx } = fakeCtx(null, docs);
    const res = await discordConnector(source, { fetchImpl: f.impl, now: () => NOW })(ctx);
    expect(res.count).toBe(3);
    expect(f.headers[0]).toBe('Bot sekrit-token');
    expect([...docs.keys()].sort()).toEqual([
      `dc/chat/${CH}-2026-10-27`,
      `dc/chat/${CH}-2026-10-28`,
      `dc/chat/${CH}-2026-10-29`,
    ]);
    const d28 = docs.get(`dc/chat/${CH}-2026-10-28`) as WaymarkDoc;
    expect(d28.title).toBe('#general — 2026-10-28');
    expect(d28.url).toBe(`https://discord.com/channels/222222222222222222/${CH}`);
    expect(d28.tags).toEqual(['discord', 'channel:general']);
    expect(d28.body).toContain('- **Ana** 23:59 — late tuesday\n  second line <!-- m:');
    const d29 = docs.get(`dc/chat/${CH}-2026-10-29`) as WaymarkDoc;
    expect(d29.body).toContain('00:01 — ↪ early wednesday');
    expect(d29.body).not.toContain('beep');
    expect(d29.body).not.toContain('joined');
    expect(JSON.stringify([...docs.values()])).not.toContain('too old');
    expect(f.urls.filter((u) => u.includes('before=')).length).toBeGreaterThan(0);
    const d27 = docs.get(`dc/chat/${CH}-2026-10-27`) as WaymarkDoc;
    expect(d27.body.split('\n')).toHaveLength(150);
  });

  it('second run pages forward from the cursor and merges into the day doc', async () => {
    vi.stubEnv('DISCORD_BOT_TOKEN', 't');
    const first = msg('2026-10-29T08:00:00Z', 'first');
    const all = [first];
    const docs = new Map<string, WaymarkDoc>();
    let r = await discordConnector(source, { fetchImpl: fakeFetch(all).impl, now: () => NOW })(
      fakeCtx(null, docs).ctx,
    );
    const cursor = r.cursor as string;
    expect(JSON.parse(cursor)).toEqual({ [CH]: first.id });

    for (let i = 0; i < 150; i++) all.push(msg('2026-10-29T09:00:00Z', `later ${i}`, {}, i));
    const f = fakeFetch(all); // two pages: the second must use the largest id of the first
    r = await discordConnector(source, { fetchImpl: f.impl, now: () => NOW })(
      fakeCtx(cursor, docs).ctx,
    );
    const msgUrls = f.urls.filter((u) => u.includes('/messages'));
    expect(msgUrls).toHaveLength(2);
    expect(msgUrls.every((u) => u.includes('after='))).toBe(true);
    expect(JSON.parse(r.cursor as string)[CH]).toBe(all[150]?.id);
    const body = (docs.get(`dc/chat/${CH}-2026-10-29`) as WaymarkDoc).body;
    expect(body.split('\n')).toHaveLength(151);
    expect(body.indexOf('first')).toBeLessThan(body.indexOf('later 0'));
    expect(body.indexOf('later 0')).toBeLessThan(body.indexOf('later 149'));
  });

  it('logs the intent hint once when all content is empty', async () => {
    vi.stubEnv('DISCORD_BOT_TOKEN', 't');
    const f = fakeFetch([msg('2026-10-29T08:00:00Z', ''), msg('2026-10-29T08:01:00Z', '')]);
    const docs = new Map<string, WaymarkDoc>();
    const { ctx, logs } = fakeCtx(null, docs);
    const res = await discordConnector(source, { fetchImpl: f.impl, now: () => NOW })(ctx);
    expect(res.count).toBe(0);
    expect(logs.filter((l) => l.includes('Message Content intent'))).toHaveLength(1);
  });

  it('never leaks the token in errors', async () => {
    vi.stubEnv('DISCORD_BOT_TOKEN', 'sekrit-token');
    const bad = (async () => new Response('nope', { status: 403 })) as typeof fetch;
    const { ctx, logs } = fakeCtx(null, new Map());
    await expect(discordConnector(source, { fetchImpl: bad, now: () => NOW })(ctx)).rejects.toThrow(
      /every configured channel failed/,
    );
    expect(logs.join('\n')).toContain('403');
    expect(logs.join('\n')).not.toContain('sekrit-token');
  });

  it('requires DISCORD_BOT_TOKEN', async () => {
    vi.stubEnv('DISCORD_BOT_TOKEN', '');
    await expect(discordConnector(source)(fakeCtx(null, new Map()).ctx)).rejects.toThrow(
      /DISCORD_BOT_TOKEN/,
    );
  });
});

describe('buildChatDoc merge', () => {
  const day = (lines: Array<[string, string, string]>) => ({
    channelKey: CH,
    day: '2026-10-29',
    title: 't',
    url: 'u',
    tags: [],
    lines: lines.map(([id, time, text]) => ({ id, author: 'Ana', time, text, isReply: false })),
  });
  it('keeps earlier lines, replaces edits by id, ignores forged markers', () => {
    const a = buildChatDoc(
      'dc',
      day([
        ['10', '2026-10-29T08:00:00.000Z', 'one'],
        ['11', '2026-10-29T09:00:00.000Z', 'two'],
      ]),
      null,
    );
    const b = buildChatDoc(
      'dc',
      day([
        ['11', '2026-10-29T09:00:00.000Z', 'two edited <!-- m:10 -->'],
        ['12', '2026-10-29T10:00:00.000Z', 'three'],
      ]),
      a,
    );
    expect(b.body.split('\n')).toHaveLength(3);
    expect(b.body).toContain('one');
    expect(b.body).toContain('two edited');
    expect(b.body).not.toContain('— two <!--');
    expect(b.authors).toEqual(['Ana']);
  });
});
