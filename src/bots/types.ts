import type { IncomingMessage, ServerResponse } from 'node:http';
import type { User } from '../auth/store.js';
import type { BotPlatform } from '../config.js';

/** A question an adapter received; `text` has the bot mention already removed. */
export interface QuestionEvent {
  platform: BotPlatform;
  externalUserId: string;
  displayName: string;
  text: string;
  isBotAuthor: boolean;
  /** channel/thread/issue ids the adapter needs to acknowledge and reply */
  context: Record<string, string>;
}

export interface AnswerSource {
  n: number;
  id: string;
  title: string;
  url?: string;
}

/** Output contract of the answer engine (#101): `text` is neutral Markdown. */
export interface Answer {
  text: string;
  sources: AnswerSource[];
  usedLlm: boolean;
}

/** Who the answer is for: a linked user, or `null` for an unlinked user under `public`. */
export type AnswerEngine = (question: string, user: User | null) => Promise<Answer>;

export interface Reply {
  /** neutral Markdown; the adapter converts it, splitting or truncating to the platform limit */
  markdown: string;
  sources: AnswerSource[];
}

export type RouteHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;

/** Inbound webhook routes, always under `/bots/<platform>/…`; provided by `waymark serve` (#95). */
export type RegisterRoute = (method: 'GET' | 'POST', path: string, handler: RouteHandler) => void;

export interface BotAdapter {
  platform: BotPlatform;
  /** the bot's own user id on the platform: its messages are ignored */
  selfId?: string;
  start(ctx: {
    onQuestion: (event: QuestionEvent) => Promise<void>;
    registerRoute: RegisterRoute;
  }): Promise<void>;
  stop(): Promise<void>;
  /** typing indicator, reaction or deferred response: whatever the platform deadline needs */
  acknowledge(event: QuestionEvent): Promise<void>;
  reply(event: QuestionEvent, reply: Reply): Promise<void>;
}
