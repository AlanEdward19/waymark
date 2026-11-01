import type { Config } from '../config.js';
import type { Db } from '../index/db.js';

export type PeopleConfig = NonNullable<Config['people']>;
export type Resolver = (raw: string) => string;

/** Lookup key: trimmed, one leading `@` stripped, lower-cased. */
export function personKey(raw: string, lower = true): string {
  const t = raw.trim();
  const k = (t.startsWith('@') ? t.slice(1) : t).trim();
  return lower ? k.toLowerCase() : k;
}

/** E-mail shape (after trim and one leading `@`): `@` followed later by `.`. Never stored or shown. */
export function isEmailLike(raw: string): boolean {
  return /@.*\./.test(personKey(raw, false));
}

function stripAt(raw: string): string {
  return raw.startsWith('@') ? raw.slice(1) : raw;
}

/** Canonical-name lookup built from the `people` config. Unmapped names resolve to themselves. */
export function createPeopleResolver(people: PeopleConfig = []): Resolver {
  const byKey = new Map<string, string>();
  for (const p of people) {
    for (const alias of [p.name, ...p.aliases]) {
      const k = personKey(alias);
      const prev = byKey.get(k);
      if (prev !== undefined && prev !== p.name) {
        throw new Error(`people: alias "${alias}" is listed under both "${prev}" and "${p.name}"`);
      }
      byKey.set(k, p.name);
    }
  }
  return (raw) => byKey.get(personKey(raw)) ?? stripAt(raw);
}

export interface PersonAlias {
  alias: string;
  bySource: Record<string, number>;
}
export interface PersonSummary {
  name: string;
  total: number;
  aliases: PersonAlias[];
}

const isBot = (name: string) => name.toLowerCase().endsWith('[bot]');

/** Every person in `authors` of indexed docs, grouped by canonical name; bots last. */
export function listPeople(db: Db, resolve: Resolver): PersonSummary[] {
  const rows = db.prepare('SELECT source_id, authors FROM docs').all() as Array<{
    source_id: string;
    authors: string;
  }>;
  const groups = new Map<string, { total: number; aliases: Map<string, Map<string, number>> }>();
  for (const row of rows) {
    const seenInDoc = new Set<string>();
    for (const raw of JSON.parse(row.authors) as string[]) {
      const alias = stripAt(raw.trim());
      if (alias === '' || isEmailLike(alias)) continue;
      const name = resolve(raw.trim());
      const g = groups.get(name) ?? { total: 0, aliases: new Map<string, Map<string, number>>() };
      groups.set(name, g);
      if (!seenInDoc.has(name)) {
        seenInDoc.add(name);
        g.total++;
      }
      const a = g.aliases.get(alias) ?? new Map<string, number>();
      g.aliases.set(alias, a);
      a.set(row.source_id, (a.get(row.source_id) ?? 0) + 1);
    }
  }
  const sum = (m: Map<string, number>) => [...m.values()].reduce((x, y) => x + y, 0);
  const out: PersonSummary[] = [...groups].map(([name, g]) => ({
    name,
    total: g.total,
    aliases: [...g.aliases]
      .sort((a, b) => sum(b[1]) - sum(a[1]) || a[0].localeCompare(b[0]))
      .map(([alias, m]) => ({
        alias,
        bySource: Object.fromEntries(
          [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
        ),
      })),
  }));
  return out.sort(
    (a, b) =>
      Number(isBot(a.name)) - Number(isBot(b.name)) ||
      b.total - a.total ||
      a.name.localeCompare(b.name),
  );
}

export function formatPeople(people: PersonSummary[]): string {
  if (people.length === 0) return 'No people found. Run "waymark sync" first.\n';
  const block = (p: PersonSummary) => {
    const seen = p.aliases
      .map(
        (a) =>
          `${a.alias} (${Object.entries(a.bySource)
            .map(([s, n]) => `${s} ${n}`)
            .join(', ')})`,
      )
      .join(', ');
    return `${p.name}  (${p.total} docs)\n  aliases seen: ${seen}\n`;
  };
  const humans = people.filter((p) => !isBot(p.name));
  const bots = people.filter((p) => isBot(p.name));
  return humans.map(block).join('') + (bots.length > 0 ? `bots\n${bots.map(block).join('')}` : '');
}
