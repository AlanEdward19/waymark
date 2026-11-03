import fs from 'node:fs';
import path from 'node:path';
import { type AuditEvent, auditLine } from './audit.js';

export interface AuditFlags {
  since?: string;
  until?: string;
  user?: string;
  event?: string[];
  outcome?: string;
  limit?: string;
  json?: boolean;
}

function isoDate(value: string, flag: string): number {
  if (!/^\d{4}-\d\d-\d\d(?:T\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d))?$/.test(value)) {
    throw new Error(
      `Invalid --${flag}: use an ISO date${flag === 'since' ? ' or a duration such as 7d' : ''}`,
    );
  }
  const time = Date.parse(value);
  const day = value.slice(0, 10);
  if (!Number.isFinite(time) || new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) !== day) {
    throw new Error(`Invalid --${flag}: use a valid ISO date`);
  }
  return time;
}

function isEvent(value: unknown): value is AuditEvent {
  if (!value || typeof value !== 'object') return false;
  const e = value as AuditEvent;
  return (
    typeof e.at === 'string' &&
    Number.isFinite(Date.parse(e.at)) &&
    typeof e.event === 'string' &&
    ['ok', 'denied', 'error'].includes(e.outcome) &&
    (typeof e.user === 'string' || e.user === null) &&
    typeof e.via === 'string' &&
    (typeof e.object === 'string' || e.object === null) &&
    e.detail !== null &&
    typeof e.detail === 'object' &&
    !Array.isArray(e.detail)
  );
}

function summary(e: AuditEvent): string {
  const d = e.detail;
  switch (e.event) {
    case 'search':
      return `${typeof d.query === 'string' ? JSON.stringify(d.query) : `${d.queryChars ?? 0} query characters`} (${d.results ?? 0} results)`;
    case 'auth.denied':
      return `${d.reason ?? 'denied'}${e.tokenId ? ` ${e.tokenId}` : ''}`;
    case 'user.created':
    case 'user.updated':
    case 'user.linked':
    case 'user.unlinked':
    case 'token.created':
    case 'token.revoked':
    case 'document.read':
    case 'note.saved':
    case 'handoff.created':
    case 'handoff.claimed':
    case 'session.saved':
      return [e.object, Object.keys(d).length ? JSON.stringify(d) : ''].filter(Boolean).join(' ');
    case 'bot.ask':
      return `${d.questionChars ?? 0} question characters (${d.sources ?? 0} sources)`;
    default:
      return JSON.stringify(d);
  }
}

/** Read overlapping monthly files only; never modifies audit data. */
export function runAuditCommand(
  dir: string,
  flags: AuditFlags,
  now = new Date(),
  warn: (message: string) => void = (message) => {
    process.stderr.write(`${message}\n`);
  },
): string {
  const duration = flags.since?.match(/^(\d+)d$/);
  const since = duration
    ? now.getTime() - Number(duration[1]) * 86_400_000
    : flags.since
      ? isoDate(flags.since, 'since')
      : -Infinity;
  const until = flags.until ? isoDate(flags.until, 'until') : Infinity;
  if ((duration && !Number.isFinite(since)) || since > until)
    throw new Error('Invalid audit range: --since must be before --until');
  if (flags.outcome && !['ok', 'denied', 'error'].includes(flags.outcome))
    throw new Error('Invalid --outcome: use ok, denied or error');
  const limit = flags.limit === undefined ? 100 : Number(flags.limit);
  if (
    (flags.limit !== undefined && !/^\d+$/.test(flags.limit)) ||
    !Number.isSafeInteger(limit) ||
    limit < 1
  )
    throw new Error('Invalid --limit: use a positive whole number');
  let files: string[];
  try {
    files = fs.readdirSync(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw new Error(`Cannot read audit directory ${dir}: ${(err as Error).message}`);
  }
  const month = (time: number) => new Date(time).toISOString().slice(0, 7);
  const matches: AuditEvent[] = [];
  for (const file of files
    .filter(
      (f) =>
        /^\d{4}-(?:0[1-9]|1[0-2])\.jsonl$/.test(f) &&
        (since === -Infinity || f.slice(0, 7) >= month(since)) &&
        (until === Infinity || f.slice(0, 7) <= month(until)),
    )
    .sort()
    .reverse()) {
    let contents: string;
    try {
      contents = fs.readFileSync(path.join(dir, file), 'utf8');
    } catch (err) {
      throw new Error(`Cannot read audit file ${path.join(dir, file)}: ${(err as Error).message}`);
    }
    let malformed = false;
    for (const line of contents.split('\n')) {
      if (!line.trim()) continue;
      let e: unknown;
      try {
        e = JSON.parse(line);
      } catch {
        malformed = true;
        continue;
      }
      if (!isEvent(e)) {
        malformed = true;
        continue;
      }
      const at = Date.parse(e.at);
      if (
        at < since ||
        at > until ||
        (flags.user !== undefined && e.user !== flags.user) ||
        (flags.event?.length && !flags.event.includes(e.event)) ||
        (flags.outcome && e.outcome !== flags.outcome)
      )
        continue;
      matches.push(e);
    }
    if (malformed) warn(`warning: skipped malformed audit lines in ${path.join(dir, file)}`);
  }
  return matches
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    .slice(0, limit)
    .map((e) => {
      // Sanitize manually edited or older files too; preserve queries already authorized by their producer.
      const safe = JSON.parse(auditLine(e, { queries: true })) as AuditEvent;
      if (flags.json) return `${JSON.stringify(safe)}\n`;
      return `${new Date(safe.at)
        .toISOString()
        .replace('T', ' ')
        .replace(
          /\.\d{3}Z$/,
          'Z',
        )}  ${safe.event}  ${safe.outcome}  ${safe.user ?? '-'}  ${safe.via}  ${safe.ip ?? '-'}  ${summary(safe)}\n`;
    })
    .join('');
}
