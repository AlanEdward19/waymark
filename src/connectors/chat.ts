import { makeId, type WaymarkDoc } from '../store/doc.js';

/** One chat message, already normalised by a connector (Discord, Slack, Teams). */
export interface ChatLine {
  id: string; // native message id, unique per channel
  author: string;
  time: string; // ISO 8601 UTC
  text: string;
  isReply: boolean;
}

/** All messages of one channel on one UTC day. */
export interface ChatDay {
  channelKey: string; // native channel id, part of the doc id
  day: string; // YYYY-MM-DD (UTC)
  title: string;
  url: string;
  tags: string[];
  lines: ChatLine[];
}

interface Entry {
  id: string;
  hhmm: string;
  block: string;
}

const MARKER = /<!-- m:(\S+) -->\s*$/;
const HEAD = /^- \*\*[\s\S]*?\*\* (\d\d:\d\d) — /;

export function chatDocId(sourceId: string, channelKey: string, day: string): string {
  return makeId(sourceId, 'chat', `${channelKey}-${day}`);
}

function cmpId(a: string, b: string): number {
  return a.length - b.length || (a < b ? -1 : a > b ? 1 : 0); // numeric-like ids: longer is later
}

function renderLine(l: ChatLine): Entry {
  const hhmm = l.time.slice(11, 16);
  const author = l.author.replace(/\s+/g, ' ');
  // "<!--" in message text could forge a merge marker
  const text = l.text.replaceAll('<!--', '&lt;!--').replace(/\r?\n/g, '\n  ');
  const block = `- **${author}** ${hhmm} — ${l.isReply ? '↪ ' : ''}${text} <!-- m:${l.id} -->`;
  return { id: l.id, hhmm, block };
}

function parseEntries(body: string): Entry[] {
  const out: Entry[] = [];
  let cur: string[] = [];
  const flush = () => {
    const block = cur.join('\n');
    const id = MARKER.exec(block)?.[1];
    if (id !== undefined) out.push({ id, hhmm: HEAD.exec(block)?.[1] ?? '00:00', block });
    cur = [];
  };
  for (const line of body.split('\n')) {
    if (line.startsWith('- **')) flush();
    if (cur.length > 0 || line.startsWith('- **')) cur.push(line);
  }
  flush();
  return out;
}

/**
 * Builds the day doc, merging into `existing` by `<!-- m:<id> -->` markers: earlier lines are
 * kept, a line with a known id is replaced (edit), new ids are added, oldest first.
 */
export function buildChatDoc(
  sourceId: string,
  day: ChatDay,
  existing: WaymarkDoc | null,
): WaymarkDoc {
  const byId = new Map<string, Entry>();
  for (const e of existing ? parseEntries(existing.body) : []) byId.set(e.id, e);
  for (const l of day.lines) byId.set(l.id, renderLine(l));
  const entries = [...byId.values()].sort(
    (a, b) => a.hhmm.localeCompare(b.hhmm) || cmpId(a.id, b.id),
  );
  const latest =
    day.lines
      .map((l) => l.time)
      .sort()
      .at(-1) ?? '';
  return {
    id: chatDocId(sourceId, day.channelKey, day.day),
    kind: 'chat',
    sourceId,
    title: day.title,
    url: day.url,
    authors: [...new Set([...(existing?.authors ?? []), ...day.lines.map((l) => l.author)])],
    createdAt: existing?.createdAt ?? `${day.day}T00:00:00.000Z`,
    updatedAt: existing && existing.updatedAt > latest ? existing.updatedAt : latest,
    tags: day.tags,
    body: entries.map((e) => e.block).join('\n'),
  };
}
