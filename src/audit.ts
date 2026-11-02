import fs from 'node:fs';
import path from 'node:path';
import { redact } from './redact.js';

export type AuditOutcome = 'ok' | 'denied' | 'error';

export interface AuditEvent {
  at: string;
  event: string;
  outcome: AuditOutcome;
  user: string | null;
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
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clean(x)]));
  }
  return v;
};

/** Line written for an event: JSON, cleaned, newline-terminated. */
export const auditLine = (event: AuditEvent): string => `${JSON.stringify(clean(event))}\n`;

/**
 * Append-only sink writing `<dir>/YYYY-MM.jsonl` (UTC month of `at`). The write is synchronous,
 * so an event logged before a reply is on disk before the reply is sent.
 */
export function fileAuditSink(dir: string): AuditSink {
  return (event) => {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, `${event.at.slice(0, 7)}.jsonl`);
    fs.appendFileSync(file, auditLine(event), { mode: 0o600, flag: 'a' });
  };
}
