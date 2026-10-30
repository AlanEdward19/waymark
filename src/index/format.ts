import type { SearchHit } from './search.js';

export function formatHits(hits: SearchHit[]): string {
  if (hits.length === 0) return 'No results.';
  return hits
    .map((h, i) => {
      const lines = [
        `${i + 1}. ${h.title}  [${h.kind} · ${h.sourceId} · ${h.updatedAt.slice(0, 10)}]`,
        `   id: ${h.id}`,
      ];
      if (h.url) lines.push(`   ${h.url}`);
      lines.push(`   ${h.snippet}`);
      return lines.join('\n');
    })
    .join('\n\n');
}
