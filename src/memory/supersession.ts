import path from 'node:path';
import type { Db } from '../index/db.js';
import { makeId, type WaymarkDoc } from '../store/doc.js';

export interface DocumentFlag {
  flag: 'superseded' | 'deprecated' | 'reverted' | 'not_planned';
  by?: string;
}

interface Signal extends DocumentFlag {
  docId: string;
  referencePath?: string;
  referenceNumber?: string;
}

function extractSignals(doc: WaymarkDoc): Signal[] {
  const signals: Signal[] = [];
  if (doc.kind === 'doc' && doc.tags.includes('adr')) {
    for (const line of doc.body.split(/\r?\n/)) {
      const status = line.replace(/\*\*/g, '').match(/^\s*(?:[-*+]\s+)?Status:\s*(.*)$/i)?.[1];
      if (!status) continue;
      if (/^(Deprecated|Rejected)\b/i.test(status)) {
        signals.push({ docId: doc.id, flag: 'deprecated' });
      } else if (/^Superseded\b/i.test(status)) {
        const signal: Signal = { docId: doc.id, flag: 'superseded' };
        const number = status.match(/\bADR-(\d+)\b/i)?.[1];
        if (number) signal.referenceNumber = number.replace(/^0+(?=\d)/, '');
        const link = status.match(/\]\(([^\s)]+\.md)(?:#[^\s)]*)?\)/i)?.[1];
        const ownPath = doc.tags.find((tag) => tag.startsWith('path:'))?.slice(5);
        if (link && ownPath && !/^(?:[a-z]+:|\/)/i.test(link)) {
          signal.referencePath = path.posix.normalize(
            path.posix.join(path.posix.dirname(ownPath), link),
          );
        }
        signals.push(signal);
      }
    }
  } else if (doc.kind === 'commit') {
    for (const match of doc.body.matchAll(/This reverts commit ([a-f0-9]{40})\./gi)) {
      const docId = makeId(doc.sourceId, 'commit', (match[1] as string).toLowerCase());
      if (docId !== doc.id) signals.push({ docId, flag: 'reverted', by: doc.id });
    }
  } else if (doc.kind === 'issue') {
    if (doc.tags.some((tag) => tag === 'state:not_planned' || tag === 'state:duplicate')) {
      signals.push({ docId: doc.id, flag: 'not_planned' });
    }
  } else if (doc.kind === 'note') {
    for (const tag of doc.tags) {
      if (tag.startsWith('supersedes:') && tag.slice(11) && tag.slice(11) !== doc.id) {
        signals.push({ docId: tag.slice(11), flag: 'superseded', by: doc.id });
      }
    }
  }
  return signals;
}

/** Replace only the signals emitted by this document; incoming signals survive a re-sync. */
export function replaceDocumentFlags(db: Db, doc: WaymarkDoc): void {
  db.prepare('DELETE FROM doc_flags WHERE source_doc_id = ?').run(doc.id);
  const insert = db.prepare(`INSERT OR IGNORE INTO doc_flags
    (source_doc_id, doc_id, flag, by_id, reference_path, reference_number)
    VALUES (?, ?, ?, ?, ?, ?)`);
  for (const signal of extractSignals(doc)) {
    insert.run(
      doc.id,
      signal.docId,
      signal.flag,
      signal.by ?? '',
      signal.referencePath ?? '',
      signal.referenceNumber ?? '',
    );
  }
}

export function getDocumentFlags(db: Db, id: string): DocumentFlag[] {
  const rows = db
    .prepare(`SELECT f.flag, f.by_id AS byId, f.reference_path AS referencePath,
    f.reference_number AS referenceNumber, d.source_id AS sourceId
    FROM doc_flags f JOIN docs d ON d.id = f.source_doc_id
    WHERE f.doc_id = ? ORDER BY f.flag, f.by_id, f.source_doc_id`)
    .all(id) as {
    flag: DocumentFlag['flag'];
    byId: string;
    referencePath: string;
    referenceNumber: string;
    sourceId: string;
  }[];
  const flags: DocumentFlag[] = [];
  for (const row of rows) {
    let by = row.byId;
    if (row.referencePath || row.referenceNumber) {
      const candidates = db
        .prepare(`SELECT id, tags FROM docs WHERE source_id = ? AND kind = 'doc' ORDER BY id`)
        .all(row.sourceId) as { id: string; tags: string }[];
      const adrs = candidates
        .map((candidate) => ({ ...candidate, tags: JSON.parse(candidate.tags) as string[] }))
        .filter((candidate) => candidate.tags.includes('adr'));
      const target =
        adrs.find((candidate) => candidate.tags.includes(`path:${row.referencePath}`)) ??
        adrs.find((candidate) =>
          candidate.tags.some((tag) => {
            if (!tag.startsWith('path:') || !row.referenceNumber) return false;
            const number = path.posix
              .basename(tag.slice(5))
              .match(/^(?:ADR-)?(\d+)(?:[-_.]|$)/i)?.[1];
            return number?.replace(/^0+(?=\d)/, '') === row.referenceNumber;
          }),
        );
      if (target?.id === id) continue;
      by = target?.id ?? '';
    }
    const flag: DocumentFlag = { flag: row.flag, ...(by ? { by } : {}) };
    if (!flags.some((existing) => existing.flag === flag.flag && existing.by === flag.by))
      flags.push(flag);
  }
  return flags;
}

export function formatDocumentFlags(flags: readonly DocumentFlag[]): string {
  return flags
    .map(({ flag, by }) => {
      if (flag === 'deprecated') return '> Note: marked deprecated';
      if (flag === 'not_planned') return '> Note: closed as not planned';
      return `> Note: ${flag}${by ? ` by ${by}` : ''}`;
    })
    .join('\n');
}
