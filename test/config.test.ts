import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initHome, loadConfig } from '../src/config.js';
import { resolvePaths } from '../src/paths.js';

let tmp: string;
let paths: ReturnType<typeof resolvePaths>;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'waymark-'));
  paths = resolvePaths({ WAYMARK_HOME: tmp });
});
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

const write = (data: unknown) =>
  fs.writeFile(paths.config, typeof data === 'string' ? data : JSON.stringify(data));

describe('initHome', () => {
  it('is idempotent and never overwrites', async () => {
    expect(await initHome(paths)).toEqual({ created: true });
    const first = await fs.readFile(paths.config, 'utf8');
    expect(first).toBe('{\n  "version": 1,\n  "sources": []\n}\n');
    await fs.stat(paths.wiki);
    await fs.stat(path.dirname(paths.db));
    await write({ version: 1, sources: [] });
    const edited = await fs.readFile(paths.config, 'utf8');
    expect(await initHome(paths)).toEqual({ created: false });
    expect(await fs.readFile(paths.config, 'utf8')).toBe(edited);
  });
});

describe('loadConfig', () => {
  it('loads a fresh config', async () => {
    await initHome(paths);
    expect(await loadConfig(paths)).toEqual({ version: 1, sources: [] });
  });

  it('parses the README example and defaults include', async () => {
    await write({
      version: 1,
      sources: [
        { id: 'waymark-git', type: 'git', path: 'C:/code/waymark' },
        { id: 'waymark-gh', type: 'github', repo: 'AlanEdward19/waymark' },
      ],
    });
    const cfg = await loadConfig(paths);
    expect(cfg.sources[1]).toMatchObject({ include: ['pulls', 'issues'] });
  });

  it('errors when missing', async () => {
    await expect(loadConfig(paths)).rejects.toThrow(
      'Waymark is not initialised. Run "waymark init" first.',
    );
  });

  it.each([
    ['invalid JSON', '{nope'],
    ['version 2', { version: 2, sources: [] }],
    ['bad id', { version: 1, sources: [{ id: 'Bad Id', type: 'git', path: '.' }] }],
  ])('rejects %s', async (_n, data) => {
    await write(data);
    await expect(loadConfig(paths)).rejects.toThrow(`Invalid config at ${paths.config}:`);
  });

  it('rejects duplicate ids', async () => {
    await write({
      version: 1,
      sources: [
        { id: 'a', type: 'git', path: '.' },
        { id: 'a', type: 'github', repo: 'o/n' },
      ],
    });
    await expect(loadConfig(paths)).rejects.toThrow(
      `Invalid config at ${paths.config}: duplicate source id "a"`,
    );
  });

  it('rejects tokens in config', async () => {
    await write({ version: 1, sources: [{ id: 'a', type: 'github', repo: 'o/n', token: 'x' }] });
    await expect(loadConfig(paths)).rejects.toThrow(
      `Invalid config at ${paths.config}: tokens must come from environment variables, not config`,
    );
  });
});
