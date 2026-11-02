import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type AuditEvent, auditLine, fileAuditSink } from '../src/audit.js';
import type { User } from '../src/auth/store.js';
import { createSearchAnswerEngine, NO_HITS, visibleScope } from '../src/bots/answer.js';
import {
  createBotRuntime,
  ERROR_REPLY,
  RATE_LIMITED_REPLY,
  UNLINKED_REPLY,
} from '../src/bots/runtime.js';
import type { Answer, AnswerEngine, BotAdapter, QuestionEvent, Reply } from '../src/bots/types.js';
import { BotsSchema, ConfigSchema, initHome, loadConfig } from '../src/config.js';
import { type Db, openDb, upsertDoc } from '../src/index/db.js';
import { resolvePaths } from '../src/paths.js';
import { docRelPath, type WaymarkDoc } from '../src/store/doc.js';

let tmp: string;
beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'waymark-'));
});
afterEach(async () => {
  vi.useRealTimers();
  await fs.rm(tmp, { recursive: true, force: true });
});

const user = (name: string, over: Partial<User> = {}): User => ({
  name,
  displayName: name,
  role: 'member',
  groups: [],
  disabled: false,
  createdAt: '2026-11-01T00:00:00.000Z',
  ...over,
});

const event = (over: Partial<QuestionEvent> = {}): QuestionEvent => ({
  platform: 'slack',
  externalUserId: 'U01ALICE',
  displayName: 'Alice',
  text: 'why sqlite?',
  isBotAuthor: false,
  context: { channel: 'C1' },
  ...over,
});

const ANSWER: Answer = {
  text: 'Because [1].',
  sources: [{ n: 1, id: 'src/doc/adr', title: 'ADR' }],
  usedLlm: false,
};

function fakeAdapter(selfId?: string) {
  const calls: string[] = [];
  const replies: Reply[] = [];
  const adapter: BotAdapter = {
    platform: 'slack',
    selfId,
    start: async () => {},
    stop: async () => {},
    acknowledge: async () => {
      calls.push('ack');
    },
    reply: async (_e, r) => {
      calls.push('reply');
      replies.push(r);
    },
  };
  return { adapter, calls, replies };
}

function setup(
  opts: {
    bots?: Partial<ReturnType<typeof BotsSchema.parse>>;
    users?: Record<string, User>;
    answer?: AnswerEngine;
    auditQueries?: boolean;
    now?: () => Date;
    maxInFlight?: number;
    queueTimeoutMs?: number;
  } = {},
) {
  const fake = fakeAdapter('UBOT');
  const audits: AuditEvent[] = [];
  const logs: string[] = [];
  const asked: Array<User | null> = [];
  const answer: AnswerEngine =
    opts.answer ??
    (async (_q, u) => {
      fake.calls.push('answer');
      asked.push(u);
      return ANSWER;
    });
  const runtime = createBotRuntime({
    bots: { ...BotsSchema.parse({}), ...opts.bots },
    auditQueries: opts.auditQueries,
    resolveUser: (_p, id) => (opts.users ?? { U01ALICE: user('alice') })[id],
    answer,
    audit: (e) => audits.push(e),
    now: opts.now,
    log: (m) => logs.push(m),
    maxInFlight: opts.maxInFlight,
    queueTimeoutMs: opts.queueTimeoutMs,
  });
  const ask = (over: Partial<QuestionEvent> = {}) => runtime.handle(fake.adapter, event(over));
  return { ...fake, runtime, audits, logs, asked, ask };
}

describe('bot pipeline', () => {
  it('answers a linked user and audits ok without the question text', async () => {
    const s = setup({ now: () => new Date('2026-11-02T10:00:00.000Z') });
    await s.ask();
    expect(s.replies).toEqual([{ markdown: ANSWER.text, sources: ANSWER.sources }]);
    expect(s.asked).toEqual([user('alice')]);
    expect(s.audits).toEqual([
      {
        at: '2026-11-02T10:00:00.000Z',
        event: 'bot.ask',
        outcome: 'ok',
        user: 'alice',
        via: 'bot:slack',
        object: null,
        detail: { questionChars: 11, sources: 1, usedLlm: false },
      },
    ]);
  });

  it('logs the question text only when audit.queries is on', async () => {
    const s = setup({ auditQueries: true });
    await s.ask();
    expect(s.audits[0]?.detail.question).toBe('why sqlite?');
  });

  it('acknowledges before calling the answer engine', async () => {
    const s = setup();
    await s.ask();
    expect(s.calls).toEqual(['ack', 'answer', 'reply']);
  });

  it('denies an unlinked user with the exact message under deny', async () => {
    const s = setup({ users: {} });
    await s.ask({ externalUserId: 'U09NOBODY' });
    expect(s.replies.map((r) => r.markdown)).toEqual([
      'I can only answer people linked to a Waymark account. Ask an admin to run: waymark user link <name> slack U09NOBODY',
    ]);
    expect(UNLINKED_REPLY(event({ externalUserId: 'U09NOBODY' }))).toBe(s.replies[0]?.markdown);
    expect(s.calls).toEqual(['ack', 'reply']);
    expect(s.audits[0]).toMatchObject({
      outcome: 'denied',
      user: null,
      via: 'bot:slack',
      detail: { reason: 'unlinked', externalUserId: 'U09NOBODY', questionChars: 11 },
    });
  });

  it('treats a disabled user as unlinked', async () => {
    const s = setup({ users: { U01ALICE: user('alice', { disabled: true }) } });
    await s.ask();
    expect(s.calls).not.toContain('answer');
    expect(s.audits[0]?.detail.reason).toBe('unlinked');
  });

  it('answers an unlinked user under public with no user scope', async () => {
    const s = setup({ users: {}, bots: { unlinkedUsers: 'public' } });
    await s.ask({ externalUserId: 'U09NOBODY' });
    expect(s.asked).toEqual([null]);
    expect(s.audits[0]).toMatchObject({ outcome: 'ok', user: null });
  });

  it('ignores bot authors, its own messages and empty questions', async () => {
    const s = setup();
    await s.ask({ isBotAuthor: true });
    await s.ask({ externalUserId: 'UBOT' });
    await s.ask({ text: '   ' });
    expect(s.calls).toEqual([]);
    expect(s.audits).toEqual([]);
  });

  it('rate limits the 7th question in a minute and recovers after it', async () => {
    let t = Date.parse('2026-11-02T10:00:00.000Z');
    const s = setup({ now: () => new Date(t) });
    for (let i = 0; i < 6; i++) {
      await s.ask();
      t += 1000;
    }
    await s.ask();
    expect(s.replies.at(-1)?.markdown).toBe(RATE_LIMITED_REPLY);
    expect(s.audits.at(-1)).toMatchObject({
      outcome: 'denied',
      user: 'alice',
      detail: { reason: 'rate_limited' },
    });
    expect(s.calls.filter((c) => c === 'answer')).toHaveLength(6);
    t += 55_000; // the first question is now more than a minute old
    await s.ask();
    expect(s.replies.at(-1)?.markdown).toBe(ANSWER.text);
  });

  it('rate limits per external id under public', async () => {
    const s = setup({ users: {}, bots: { unlinkedUsers: 'public', perUserPerMinute: 1 } });
    await s.ask({ externalUserId: 'U1' });
    await s.ask({ externalUserId: 'U2' });
    await s.ask({ externalUserId: 'U1' });
    expect(s.replies.map((r) => r.markdown)).toEqual([
      ANSWER.text,
      ANSWER.text,
      RATE_LIMITED_REPLY,
    ]);
  });

  it('keeps at most 4 questions in flight and serves the rest FIFO', async () => {
    let inFlight = 0;
    let peak = 0;
    const order: string[] = [];
    const gates: Array<() => void> = [];
    const s = setup({
      bots: { perUserPerMinute: 60 },
      answer: async (q) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        order.push(q);
        await new Promise<void>((r) => gates.push(r));
        inFlight--;
        return ANSWER;
      },
    });
    const all = Promise.all([1, 2, 3, 4, 5, 6].map((n) => s.ask({ text: `q${n}` })));
    await vi.waitFor(() => expect(gates).toHaveLength(4));
    expect(s.runtime.inFlight).toBe(4);
    while (gates.length > 0) {
      gates.shift()?.();
      await new Promise((r) => setTimeout(r, 0));
    }
    await all;
    expect(peak).toBe(4);
    expect(order).toEqual(['q1', 'q2', 'q3', 'q4', 'q5', 'q6']);
    expect(s.replies).toHaveLength(6);
  });

  it('answers with the error text when a question waits more than 60 s', async () => {
    vi.useFakeTimers();
    let release: () => void = () => {};
    const s = setup({
      maxInFlight: 1,
      answer: (q) =>
        q === 'slow'
          ? new Promise<Answer>((r) => {
              release = () => r(ANSWER);
            })
          : Promise.resolve(ANSWER),
    });
    const first = s.ask({ text: 'slow' });
    const second = s.ask({ text: 'queued' });
    await vi.advanceTimersByTimeAsync(60_000);
    await second;
    expect(s.replies.map((r) => r.markdown)).toEqual([ERROR_REPLY]);
    expect(s.audits[0]).toMatchObject({ outcome: 'error', detail: { reason: 'timeout' } });
    release();
    await first;
    expect(s.replies.map((r) => r.markdown)).toEqual([ERROR_REPLY, ANSWER.text]);
  });

  it('replies with the generic text on an engine error and logs the stack only', async () => {
    const s = setup({
      answer: async () => {
        throw new Error('boom: secret detail');
      },
    });
    await s.ask();
    expect(s.replies).toEqual([{ markdown: ERROR_REPLY, sources: [] }]);
    expect(s.logs.join('')).toContain('boom: secret detail');
    expect(s.logs.join('')).toContain('bots.test.ts'); // the stack
    expect(JSON.stringify(s.replies)).not.toContain('boom');
    expect(s.audits[0]).toMatchObject({ outcome: 'error', detail: { reason: 'exception' } });
  });

  it('keeps answering when the acknowledgement fails', async () => {
    const s = setup();
    s.adapter.acknowledge = async () => {
      throw new Error('ack down');
    };
    await s.ask();
    expect(s.replies).toHaveLength(1);
    expect(s.logs[0]).toContain('acknowledge failed: ack down');
  });

  it('starts adapters with routes confined to /bots/<platform>/ and stops them', async () => {
    const s = setup();
    const routes: string[] = [];
    let stopped = false;
    let onQuestion: ((e: QuestionEvent) => Promise<void>) | undefined;
    const adapter: BotAdapter = {
      ...s.adapter,
      start: async (ctx) => {
        ctx.registerRoute('POST', '/bots/slack/events', () => {});
        onQuestion = ctx.onQuestion;
      },
      stop: async () => {
        stopped = true;
      },
    };
    await s.runtime.start([adapter], (method, p) => routes.push(`${method} ${p}`));
    expect(routes).toEqual(['POST /bots/slack/events']);
    await onQuestion?.(event());
    expect(s.replies).toHaveLength(1);
    await s.runtime.stop();
    expect(stopped).toBe(true);

    const bad: BotAdapter = {
      ...s.adapter,
      start: async (ctx) => ctx.registerRoute('POST', '/mcp', () => {}),
    };
    await expect(s.runtime.start([bad], () => {})).rejects.toThrow(
      'routes must live under /bots/slack/',
    );
  });
});

describe('scoped answers', () => {
  let db: Db;
  const doc = (id: string, sourceId: string, kind: WaymarkDoc['kind'] = 'doc'): WaymarkDoc => ({
    id,
    kind,
    sourceId,
    title: `Deploy notes ${sourceId}`,
    authors: ['alan'],
    createdAt: '2026-10-01T12:00:00.000Z',
    updatedAt: '2026-10-02T08:30:00.000Z',
    tags: [],
    body: 'How we deploy the service.',
  });
  const config = ConfigSchema.parse({
    version: 1,
    sources: [
      { id: 'open', type: 'git', path: '.' },
      { id: 'secret', type: 'git', path: '.', access: { groups: ['security'] } },
    ],
  });

  beforeEach(() => {
    db = openDb(path.join(tmp, 'db', 'waymark.db'));
    for (const d of [
      doc('open/doc/a', 'open'),
      doc('secret/doc/b', 'secret'),
      doc('agent/session/c', 'agent', 'session'),
      doc('agent/note/d', 'agent', 'note'),
    ]) {
      upsertDoc(db, d, docRelPath(d.id));
    }
  });
  afterEach(() => db.close());

  const ids = async (u: User | null, cfg = config) =>
    (await createSearchAnswerEngine({ db, config: cfg })('deploy', u)).sources
      .map((s) => s.id)
      .sort();

  it('public sees only sources without access and never agent docs', async () => {
    expect(await ids(null)).toEqual(['open/doc/a']);
  });

  it('members see their groups and agent notes but not sessions; admins see all', async () => {
    expect(await ids(user('bob'))).toEqual(['agent/note/d', 'open/doc/a']);
    expect(await ids(user('eve', { groups: ['security'] }))).toEqual([
      'agent/note/d',
      'open/doc/a',
      'secret/doc/b',
    ]);
    expect(await ids(user('root', { role: 'admin' }))).toHaveLength(4);
  });

  it('public with no unrestricted source finds nothing instead of everything', async () => {
    const closed = ConfigSchema.parse({
      version: 1,
      sources: [{ id: 'secret', type: 'git', path: '.', access: { groups: ['security'] } }],
    });
    expect(visibleScope(closed, null)).toBeUndefined();
    const a = await createSearchAnswerEngine({ db, config: closed })('deploy', null);
    expect(a).toEqual({ text: NO_HITS, sources: [], usedLlm: false });
  });

  it('formats the no-LLM answer as numbered sources', async () => {
    const a = await createSearchAnswerEngine({ db, config })('deploy', null);
    expect(a.text).toBe(
      'I found these sources:\n\n1. Deploy notes open — `open/doc/a`\n   How we **deploy** the service.',
    );
    expect(a.usedLlm).toBe(false);
  });
});

describe('audit sink', () => {
  it('appends one cleaned line per event to the UTC month file', async () => {
    const dir = path.join(tmp, 'audit');
    const sink = fileAuditSink(dir);
    const token = `wmk_${'a'.repeat(43)}`;
    const base: AuditEvent = {
      at: '2026-11-30T23:59:59.000Z',
      event: 'bot.ask',
      outcome: 'ok',
      user: 'alice',
      via: 'bot:slack',
      object: null,
      detail: { question: `use ${token} now${String.fromCharCode(27)}[2J` },
    };
    sink(base);
    sink({ ...base, at: '2026-12-01T00:00:00.000Z' });
    const nov = await fs.readFile(path.join(dir, '2026-11.jsonl'), 'utf8');
    expect(nov.split('\n')).toHaveLength(2);
    expect(nov).not.toContain(token);
    expect(nov).not.toContain(String.fromCharCode(27));
    expect(JSON.parse(nov).detail.question).toBe('use [REDACTED:waymark-token] now\\u001b[2J');
    expect(await fs.readFile(path.join(dir, '2026-12.jsonl'), 'utf8')).toBe(
      auditLine({ ...base, at: '2026-12-01T00:00:00.000Z' }),
    );
  });
});

describe('bots config', () => {
  const paths = () => resolvePaths({ WAYMARK_HOME: tmp });
  const write = (data: unknown) => fs.writeFile(paths().config, JSON.stringify(data));

  it('defaults to deny and 6 per minute, keeps platform sections', async () => {
    await initHome(paths());
    await write({ version: 1, bots: { slack: { appId: 'A1' } } });
    const cfg = await loadConfig(paths());
    expect(cfg.bots).toEqual({
      unlinkedUsers: 'deny',
      perUserPerMinute: 6,
      slack: { appId: 'A1' },
    });
  });

  it('rejects out-of-range limits, unknown policies and tokens in bot sections', async () => {
    await initHome(paths());
    await write({ version: 1, bots: { perUserPerMinute: 61 } });
    await expect(loadConfig(paths())).rejects.toThrow('perUserPerMinute');
    await write({ version: 1, bots: { unlinkedUsers: 'everyone' } });
    await expect(loadConfig(paths())).rejects.toThrow('unlinkedUsers');
    await write({ version: 1, bots: { slack: { token: 'xoxb-1' } } });
    await expect(loadConfig(paths())).rejects.toThrow('tokens must come from environment');
  });

  it('validates source access groups', async () => {
    await initHome(paths());
    await write({
      version: 1,
      sources: [{ id: 'a', type: 'git', path: '.', access: { groups: ['Bad Group'] } }],
    });
    await expect(loadConfig(paths())).rejects.toThrow('access');
  });
});
