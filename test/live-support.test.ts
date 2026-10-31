import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { containsSecret, countFilesWithSecrets, enabled } from '../test-live/support.js';

const SECRET = 'synthetic-secret-value-123';
let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'waymark-'));
  await fs.mkdir(path.join(dir, 'wiki', 'a'), { recursive: true });
  await fs.mkdir(path.join(dir, 'db'));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('secret-leak scan', () => {
  it('finds a secret in nested wiki and binary db files and counts files only', async () => {
    await fs.writeFile(path.join(dir, 'wiki', 'a', 'doc.md'), `token=${SECRET}\n`);
    await fs.writeFile(
      path.join(dir, 'db', 'x.db'),
      Buffer.concat([Buffer.from([0, 1]), Buffer.from(SECRET)]),
    );
    await fs.writeFile(path.join(dir, 'wiki', 'clean.md'), 'nothing here');
    expect(await countFilesWithSecrets([dir], [SECRET])).toBe(2);
  });

  it('returns 0 for clean files, empty secrets and missing dirs', async () => {
    await fs.writeFile(path.join(dir, 'wiki', 'clean.md'), 'nothing here');
    expect(await countFilesWithSecrets([dir], [SECRET])).toBe(0);
    expect(await countFilesWithSecrets([dir], [''])).toBe(0);
    expect(await countFilesWithSecrets([path.join(dir, 'missing')], [SECRET])).toBe(0);
  });

  it('checks text for secrets', () => {
    expect(containsSecret(`log ${SECRET}`, [SECRET])).toBe(true);
    expect(containsSecret('log', [SECRET, ''])).toBe(false);
  });
});

describe('connector selection', () => {
  it('honours LIVE_CONNECTORS', () => {
    const prev = process.env.LIVE_CONNECTORS;
    try {
      delete process.env.LIVE_CONNECTORS;
      expect(enabled('notion')).toBe(true);
      process.env.LIVE_CONNECTORS = 'all';
      expect(enabled('notion')).toBe(true);
      process.env.LIVE_CONNECTORS = 'git, linear';
      expect(enabled('linear')).toBe(true);
      expect(enabled('notion')).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.LIVE_CONNECTORS;
      else process.env.LIVE_CONNECTORS = prev;
    }
  });
});
