import type { User } from '../auth/store.js';
import type { Config } from '../config.js';
import type { Db } from '../index/db.js';
import { hybridSearch, type QueryEmbedder } from '../index/hybrid.js';
import type { SearchOptions } from '../index/search.js';
import { DOC_KINDS } from '../store/doc.js';
import type { Answer, AnswerEngine } from './types.js';

export const NO_HITS = "I couldn't find anything about this in the knowledge base.";
const MAX_CHARS = 3500;
const SHOWN = 5;

const NOT_SESSIONS = DOC_KINDS.filter((k) => k !== 'session');

/**
 * Search filter for what `user` may see (#97 rules): admins everything; members the sources with
 * no `access` or one of their groups, plus agent notes and handoffs; `null` (unlinked, `public`)
 * only sources with no `access`. Agent sessions are only for admins. `undefined` = nothing visible.
 */
export function visibleScope(
  config: Config,
  user: User | null,
): Pick<SearchOptions, 'kinds' | 'sourceIds'> | undefined {
  if (user?.role === 'admin') return {};
  const sourceIds = config.sources
    .filter((s) => !s.access || (user && s.access.groups.some((g) => user.groups.includes(g))))
    .map((s) => s.id);
  if (user) sourceIds.push('agent');
  // an empty list would mean "no filter" to search: never let it through
  return sourceIds.length === 0 ? undefined : { sourceIds, kinds: NOT_SESSIONS };
}

/** Cut to `max` characters at a line boundary, marking the cut with `…`. */
export function clip(text: string, max = MAX_CHARS): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const nl = cut.lastIndexOf('\n');
  return `${nl > 0 ? cut.slice(0, nl) : cut}\n…`;
}

/**
 * Answer engine without an LLM: the best sources for the question, scoped to the asking user.
 * #101 adds the LLM path behind the same contract.
 */
export function createSearchAnswerEngine(deps: {
  db: Db;
  config: Config;
  embedQuery?: QueryEmbedder;
}): AnswerEngine {
  return async (question, user): Promise<Answer> => {
    const scope = visibleScope(deps.config, user);
    const hits = scope
      ? await hybridSearch(deps.db, { query: question, limit: SHOWN, ...scope }, deps.embedQuery)
      : [];
    if (hits.length === 0) return { text: NO_HITS, sources: [], usedLlm: false };
    const sources = hits.map((h, i) => ({
      n: i + 1,
      id: h.id,
      title: h.title,
      ...(h.url ? { url: h.url } : {}),
    }));
    const lines = hits.map((h, i) => {
      const where = h.url ? h.url : `\`${h.id}\``;
      const snippet = h.snippet.split('\n').find((l) => l.trim() !== '') ?? '';
      return `${i + 1}. ${h.title} — ${where}${snippet ? `\n   ${snippet.trim()}` : ''}`;
    });
    return { text: clip(`I found these sources:\n\n${lines.join('\n')}`), sources, usedLlm: false };
  };
}
