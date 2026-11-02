import type { AuditSink } from '../audit.js';
import type { User } from '../auth/store.js';
import type { BotsConfig } from '../config.js';
import type {
  AnswerEngine,
  AnswerSource,
  BotAdapter,
  QuestionEvent,
  RegisterRoute,
} from './types.js';

export const UNLINKED_REPLY = (e: QuestionEvent) =>
  `I can only answer people linked to a Waymark account. Ask an admin to run: waymark user link <name> ${e.platform} ${e.externalUserId}`;
export const RATE_LIMITED_REPLY = "You're asking too fast; try again in a minute.";
export const ERROR_REPLY = 'Sorry, something went wrong answering this.';

const WINDOW_MS = 60_000;
export const MAX_IN_FLIGHT = 4;
export const QUEUE_TIMEOUT_MS = 60_000;

/** Sliding one-minute window per key; `true` when the call is allowed (and counted). */
export function createRateLimiter(perMinute: number, now: () => Date) {
  const hits = new Map<string, number[]>();
  return (key: string): boolean => {
    const t = now().getTime();
    if (hits.size > 1000) {
      for (const [k, v] of hits) if (v.every((x) => t - x >= WINDOW_MS)) hits.delete(k);
    }
    const recent = (hits.get(key) ?? []).filter((x) => t - x < WINDOW_MS);
    const allowed = recent.length < perMinute;
    if (allowed) recent.push(t);
    hits.set(key, recent);
    return allowed;
  };
}

export class QueueTimeoutError extends Error {
  constructor(ms: number) {
    super(`question waited more than ${ms / 1000} s for a free slot`);
  }
}

/** At most `max` tasks in flight; the rest wait FIFO and fail after `timeoutMs` in the queue. */
export function createSlots(max: number, timeoutMs: number) {
  let active = 0;
  const queue: Array<{ resolve: () => void; timer: NodeJS.Timeout }> = [];
  const release = () => {
    const next = queue.shift();
    if (next) {
      clearTimeout(next.timer); // the slot passes straight to the next waiter
      next.resolve();
    } else active--;
  };
  return {
    get active() {
      return active;
    },
    async run<T>(fn: () => Promise<T>): Promise<T> {
      if (active < max) active++;
      else {
        await new Promise<void>((resolve, reject) => {
          const waiter = {
            resolve,
            timer: setTimeout(() => {
              queue.splice(queue.indexOf(waiter), 1);
              reject(new QueueTimeoutError(timeoutMs));
            }, timeoutMs),
          };
          queue.push(waiter);
        });
      }
      try {
        return await fn();
      } finally {
        release();
      }
    },
  };
}

export interface BotRuntimeDeps {
  bots: BotsConfig;
  /** config `audit.queries`: log the question text, not only its length */
  auditQueries?: boolean;
  /** linked identity lookup (#93); a disabled user counts as unlinked */
  resolveUser: (platform: string, externalUserId: string) => User | undefined;
  answer: AnswerEngine;
  audit: AuditSink;
  now?: () => Date;
  log?: (msg: string) => void;
  maxInFlight?: number;
  queueTimeoutMs?: number;
}

/** The shared pipeline: user mapping → policy → rate limit → answer (scoped) → reply → audit. */
export function createBotRuntime(deps: BotRuntimeDeps) {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? ((m) => process.stderr.write(`${m}\n`));
  const allow = createRateLimiter(deps.bots.perUserPerMinute, now);
  const slots = createSlots(
    deps.maxInFlight ?? MAX_IN_FLIGHT,
    deps.queueTimeoutMs ?? QUEUE_TIMEOUT_MS,
  );
  const started: BotAdapter[] = [];

  async function handle(adapter: BotAdapter, event: QuestionEvent): Promise<void> {
    const question = event.text.trim();
    if (event.isBotAuthor || question === '') return;
    if (adapter.selfId !== undefined && event.externalUserId === adapter.selfId) return;

    // acknowledge inside the platform deadline, before any search or LLM work
    try {
      await adapter.acknowledge(event);
    } catch (err) {
      log(`warn: bot ${event.platform}: acknowledge failed: ${(err as Error).message}`);
    }

    let user: User | undefined;
    const audit = (outcome: 'ok' | 'denied' | 'error', detail: Record<string, unknown>): void => {
      deps.audit({
        at: now().toISOString(),
        event: 'bot.ask',
        outcome,
        user: user?.name ?? null,
        via: `bot:${event.platform}`,
        object: null,
        detail: {
          questionChars: question.length,
          ...(deps.auditQueries ? { question } : {}),
          ...(user ? {} : { externalUserId: event.externalUserId }),
          ...detail,
        },
      });
    };
    const send = (markdown: string, sources: AnswerSource[] = []) =>
      adapter.reply(event, { markdown, sources });

    try {
      const found = deps.resolveUser(event.platform, event.externalUserId);
      user = found && !found.disabled ? found : undefined;
      if (!user && deps.bots.unlinkedUsers === 'deny') {
        audit('denied', { reason: 'unlinked' });
        await send(UNLINKED_REPLY(event));
        return;
      }
      if (!allow(user ? `user:${user.name}` : `${event.platform}:${event.externalUserId}`)) {
        audit('denied', { reason: 'rate_limited' });
        await send(RATE_LIMITED_REPLY);
        return;
      }
      const answer = await slots.run(() => deps.answer(question, user ?? null));
      audit('ok', { sources: answer.sources.length, usedLlm: answer.usedLlm });
      await send(answer.text, answer.sources);
    } catch (err) {
      // details go to stderr only, never to the chat
      log(`error: bot ${event.platform}: ${(err as Error).stack ?? String(err)}`);
      try {
        audit('error', { reason: err instanceof QueueTimeoutError ? 'timeout' : 'exception' });
        await send(ERROR_REPLY);
      } catch (inner) {
        log(`error: bot ${event.platform}: reply failed: ${(inner as Error).message}`);
      }
    }
  }

  return {
    handle,
    get inFlight() {
      return slots.active;
    },
    async start(adapters: BotAdapter[], registerRoute: RegisterRoute): Promise<void> {
      for (const adapter of adapters) {
        const prefix = `/bots/${adapter.platform}/`;
        await adapter.start({
          onQuestion: (event) => handle(adapter, event),
          registerRoute: (method, path, handler) => {
            if (!path.startsWith(prefix)) {
              throw new Error(`bot ${adapter.platform}: routes must live under ${prefix}`);
            }
            registerRoute(method, path, handler);
          },
        });
        started.push(adapter);
      }
    },
    async stop(): Promise<void> {
      for (const adapter of started.splice(0).reverse()) {
        try {
          await adapter.stop();
        } catch (err) {
          log(`warn: bot ${adapter.platform}: stop failed: ${(err as Error).message}`);
        }
      }
    },
  };
}
