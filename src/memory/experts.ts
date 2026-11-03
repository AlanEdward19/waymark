import type { Db } from '../index/db.js';
import { factsByPathPrefix, type PathFact } from './paths.js';
import { type PeopleResolver, printable } from './people.js';

const WEIGHTS = { commit_author: 1, review_commenter: 0.8, reviewer: 0.6, pr_author: 0.5 };
type ExpertiseRole = keyof typeof WEIGHTS;
export interface Expert {
  name: string;
  score: number;
  lastActive: string;
  counts: Record<ExpertiseRole, number>;
  evidence: string[];
}
export interface Expertise {
  path: string;
  documents: number;
  experts: Expert[];
}

export function findExperts(
  db: Db,
  path: string,
  resolve: PeopleResolver,
  options: { limit?: number; sinceDays?: number; sourceIds?: string[]; now?: number } = {},
): Expertise {
  const limit = options.limit ?? 5;
  if (!Number.isInteger(limit) || limit < 1 || limit > 20)
    throw new Error(`invalid limit "${limit}"`);
  if (
    options.sinceDays !== undefined &&
    (!Number.isInteger(options.sinceDays) || options.sinceDays < 1)
  )
    throw new Error(`invalid since "${options.sinceDays}"`);
  const now = options.now ?? Date.now();
  const facts = new Map<string, PathFact>();
  for (const fact of factsByPathPrefix(db, path)) {
    if (fact.role === 'doc' || fact.person.trim() === '') continue;
    if (options.sourceIds?.length && !options.sourceIds.includes(fact.sourceId)) continue;
    const person = resolve(fact.person.trim()).trim();
    if (person === '' || person.toLowerCase().endsWith('[bot]')) continue;
    const at = Date.parse(fact.at);
    if (!Number.isFinite(at)) continue;
    if (options.sinceDays !== undefined && at < now - options.sinceDays * 86_400_000) continue;
    const key = JSON.stringify([person, fact.docId, fact.role]);
    const previous = facts.get(key);
    if (!previous || Date.parse(previous.at) < at) facts.set(key, { ...fact, person });
  }
  const people = new Map<string, { expert: Expert; documents: Map<string, string> }>();
  for (const fact of facts.values()) {
    const role = fact.role as ExpertiseRole;
    const group = people.get(fact.person) ?? {
      expert: {
        name: fact.person,
        score: 0,
        lastActive: fact.at,
        counts: { commit_author: 0, reviewer: 0, review_commenter: 0, pr_author: 0 },
        evidence: [],
      },
      documents: new Map<string, string>(),
    };
    people.set(fact.person, group);
    const at = Date.parse(fact.at);
    group.expert.score += WEIGHTS[role] * 0.5 ** ((now - at) / 86_400_000 / 180);
    group.expert.counts[role]++;
    if (at > Date.parse(group.expert.lastActive)) group.expert.lastActive = fact.at;
    const previous = group.documents.get(fact.docId);
    if (!previous || Date.parse(previous) < at) group.documents.set(fact.docId, fact.at);
  }
  const experts = [...people.values()]
    .map(({ expert, documents }) => ({
      ...expert,
      evidence: [...documents]
        .sort((a, b) => Date.parse(b[1]) - Date.parse(a[1]) || a[0].localeCompare(b[0]))
        .slice(0, 3)
        .map(([id]) => id),
    }))
    .sort(
      (a, b) =>
        b.score - a.score ||
        Date.parse(b.lastActive) - Date.parse(a.lastActive) ||
        a.name.localeCompare(b.name),
    )
    .slice(0, limit)
    .map((expert) => ({ ...expert, score: Math.round(expert.score * 10) / 10 }));
  return { path, documents: new Set([...facts.values()].map((fact) => fact.docId)).size, experts };
}

export function formatExperts(result: Expertise): string {
  const path = printable(result.path);
  if (result.experts.length === 0) return `No one found for "${path}".\n`;
  return `Experts for ${path} (from ${result.documents} documents)\n\n${result.experts
    .map((expert, i) => {
      const counts = expert.counts;
      return (
        `${i + 1}. ${printable(expert.name)}  score ${expert.score.toFixed(1)}  last active ${expert.lastActive.slice(0, 10)}\n` +
        `   commits ${counts.commit_author} · reviews ${counts.reviewer} · review comments ${counts.review_commenter} · PRs authored ${counts.pr_author}\n` +
        `   evidence: ${expert.evidence.map(printable).join(', ')}\n`
      );
    })
    .join('')}`;
}
