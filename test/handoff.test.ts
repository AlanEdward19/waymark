import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claimHandoff, createHandoff, listOpenHandoffs } from '../src/agents/handoff.js';
import { startContext } from '../src/agents/session.js';
import { openDb, reindex } from '../src/index/db.js';
import { readDoc } from '../src/store/markdown.js';

let dir: string;
let wiki: string;
let dbPath: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'waymark-'));
  wiki = path.join(dir, 'wiki');
  dbPath = path.join(dir, 'db', 'index.sqlite');
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const input = (project: string, title = 'Finish auth') => ({
  title,
  summary: 'Did X',
  nextSteps: 'Do Y',
  project,
  from: 'cursor',
});

describe('handoffs', () => {
  it('creates, lists, claims once and reports unknown ids', async () => {
    const db = openDb(dbPath);
    try {
      const now = new Date('2026-10-30T10:00:00.000Z');
      const id = await createHandoff(db, wiki, input('waymark'), now);
      expect(id).toBe('agent/handoff/20261030-100000-finish-auth');
      const file = await readDoc(wiki, id);
      expect(file?.tags).toEqual(['status:open', 'project:waymark', 'from:cursor']);
      expect(file?.body).toBe('## Summary\n\nDid X\n\n## Next steps\n\nDo Y');
      await expect(fs.stat(path.join(wiki, '.git'))).resolves.toBeTruthy();

      await createHandoff(db, wiki, input('other', 'Other work'), now);
      expect(listOpenHandoffs(db, 'waymark').map((h) => h.id)).toEqual([id]);
      expect(listOpenHandoffs(db)).toHaveLength(2);

      const claimed = await claimHandoff(db, wiki, id);
      expect(claimed.ok).toBe(true);
      const after = await readDoc(wiki, id);
      expect(after?.tags).toContain('status:claimed');
      expect(after?.tags).not.toContain('status:open');
      expect(after?.body).toContain('## Claimed');
      expect(listOpenHandoffs(db, 'waymark')).toEqual([]);

      expect(await claimHandoff(db, wiki, id)).toEqual({ ok: false, reason: 'already_claimed' });
      expect(await claimHandoff(db, wiki, 'agent/handoff/nope')).toEqual({
        ok: false,
        reason: 'not_found',
      });
    } finally {
      db.close();
    }
  });

  it('only one of two connections wins a claim', async () => {
    const a = openDb(dbPath);
    const b = openDb(dbPath);
    try {
      const id = await createHandoff(a, wiki, input('waymark'));
      const results = await Promise.all([claimHandoff(a, wiki, id), claimHandoff(b, wiki, id)]);
      expect(results.filter((r) => r.ok)).toHaveLength(1);
    } finally {
      a.close();
      b.close();
    }
  });

  it('reindex keeps a claimed handoff claimed', async () => {
    const db = openDb(dbPath);
    const id = await createHandoff(db, wiki, input('waymark'));
    await claimHandoff(db, wiki, id);
    db.close();
    await fs.rm(path.dirname(dbPath), { recursive: true, force: true });
    const fresh = openDb(dbPath);
    try {
      await reindex(fresh, wiki);
      expect(listOpenHandoffs(fresh)).toEqual([]);
    } finally {
      fresh.close();
    }
  });

  it('startContext lists open handoffs for the project only', async () => {
    const db = openDb(dbPath);
    try {
      expect(startContext(db, 'waymark')).toContain('leave a handoff with create_handoff.');
      await createHandoff(db, wiki, input('waymark'));
      await createHandoff(db, wiki, input('other', 'Other work'));
      const out = startContext(db, 'waymark');
      expect(out).toContain('- Finish auth (agent/handoff/');
      expect(out).not.toContain('Other work');
    } finally {
      db.close();
    }
  });
});
