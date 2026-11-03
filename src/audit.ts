import fs from 'node:fs';
import path from 'node:path';
import { redact } from './redact.js';

export type AuditOutcome = 'ok' | 'denied' | 'error';
export type AuditEventName =
  | 'auth.denied'
  | 'user.created'
  | 'user.updated'
  | 'user.linked'
  | 'user.unlinked'
  | 'token.created'
  | 'token.revoked'
  | 'search'
  | 'document.read'
  | 'note.saved'
  | 'handoff.created'
  | 'handoff.claimed'
  | 'session.saved'
  | 'bot.ask';

export interface AuditEvent {
  at: string;
  event: AuditEventName;
  outcome: AuditOutcome;
  user: string | null;
  tokenId?: string;
  ip?: string;
  via: string;
  object: string | null;
  detail: Record<string, unknown>;
}

export type AuditSink = (event: AuditEvent) => void;

const CONTROL = /[\p{Cc}\u2028\u2029]/gu;

// strings are redacted and control characters escaped, so one event is always one line
const clean = (v: unknown): unknown => {
  if (typeof v === 'string') {
    return redact(v).replace(CONTROL, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
  }
  if (Array.isArray(v)) return v.map(clean);
  if (v !== null && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [clean(k), clean(x)]));
  }
  return v;
};

/** Line written for an event: JSON, cleaned, newline-terminated. */
export const auditLine = (event: AuditEvent, options: { queries?: boolean } = {}): string => {
  let detail = event.detail;
  if (event.event === 'search' && typeof detail.query === 'string' && !options.queries) {
    const { query, ...rest } = detail;
    detail = { ...rest, queryChars: query.length };
  }
  return `${JSON.stringify(clean({ ...event, detail }))}\n`;
};

/**
 * Append-only sink writing `<dir>/YYYY-MM.jsonl` (UTC month of `at`). The write is synchronous,
 * so an event logged before a reply is on disk before the reply is sent.
 */
export function fileAuditSink(dir: string, options: { queries?: boolean } = {}): AuditSink {
  return (event) => {
    const date = new Date(event.at);
    if (!Number.isFinite(date.getTime()))
      throw new Error('Invalid audit timestamp: use an ISO UTC date');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, `${date.toISOString().slice(0, 7)}.jsonl`);
    try {
      fs.appendFileSync(file, auditLine({ ...event, at: date.toISOString() }, options), {
        mode: 0o600,
        flag: 'a',
      });
    } catch (err) {
      throw new Error(`Cannot append audit log ${file}: ${(err as Error).message}`);
    }
  };
}
