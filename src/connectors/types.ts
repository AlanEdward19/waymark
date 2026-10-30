import type { WaymarkDoc } from '../store/doc.js';

export interface SyncContext {
  sourceId: string;
  cursor: string | null; // last saved cursor, null on first run
  emit: (doc: WaymarkDoc) => Promise<void>; // writes to wiki + index
  log: (msg: string) => void; // stderr
}
export interface SyncResult {
  cursor: string | null;
  count: number;
}
export type Connector = (ctx: SyncContext) => Promise<SyncResult>;
