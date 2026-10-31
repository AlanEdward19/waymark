import type { DocKind, WaymarkDoc } from '../store/doc.js';

export interface SyncContext {
  sourceId: string;
  cursor: string | null; // last saved cursor, null on first run
  emit: (doc: WaymarkDoc) => Promise<void>; // writes to wiki + index
  remove: (id: string) => Promise<void>; // deletes from wiki + index
  readDoc: (id: string) => Promise<WaymarkDoc | null>; // stored doc, for merging
  listIds: (kind?: DocKind) => string[]; // ids this source has in the index
  log: (msg: string) => void; // stderr
}
export interface SyncResult {
  cursor: string | null;
  count: number;
  removed?: number;
}
export type Connector = (ctx: SyncContext) => Promise<SyncResult>;
