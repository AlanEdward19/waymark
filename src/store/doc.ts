export const DOC_KINDS = ['commit', 'pull_request', 'issue', 'session', 'note'] as const;
export type DocKind = (typeof DOC_KINDS)[number];

export interface WaymarkDoc {
  id: string;
  kind: DocKind;
  sourceId: string;
  title: string;
  url?: string;
  authors: string[];
  createdAt: string;
  updatedAt: string;
  tags: string[];
  body: string;
}

export function isDocKind(value: unknown): value is DocKind {
  return typeof value === 'string' && (DOC_KINDS as readonly string[]).includes(value);
}

export function makeId(sourceId: string, kind: DocKind, nativeId: string): string {
  const safe = nativeId
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .replace(/-{2,}/g, '-')
    .slice(0, 120);
  if (safe === '') {
    throw new Error(`Cannot build document id from empty native id: "${nativeId}"`);
  }
  const id = `${sourceId}/${kind}/${safe}`;
  parseId(id);
  return id;
}

export function parseId(id: string): { sourceId: string; kind: DocKind; nativeId: string } {
  const parts = id.split('/');
  const [sourceId, kind, nativeId] = parts;
  if (
    parts.length !== 3 ||
    !sourceId ||
    !nativeId ||
    !isDocKind(kind) ||
    // keep ids inside the wiki dir
    sourceId === '.' ||
    sourceId === '..' ||
    /\|:/.test(id)
  ) {
    throw new Error(`Invalid document id: ${id}`);
  }
  return { sourceId, kind, nativeId };
}

export function docRelPath(id: string): string {
  parseId(id);
  return `${id}.md`;
}
