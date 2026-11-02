import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initHome, loadConfig } from '../src/config.js';
import { createPeopleResolver } from '../src/memory/people.js';
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
    expect(await loadConfig(paths)).toEqual({ version: 1, sources: [], people: [] });
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

  it('parses an azure-devops source with default include and auth', async () => {
    await write({
      version: 1,
      sources: [{ id: 'ado', type: 'azure-devops', organization: 'contoso', project: 'Shop' }],
    });
    const cfg = await loadConfig(paths);
    expect(cfg.sources[0]).toMatchObject({ include: ['workitems', 'pulls'], auth: 'app' });
  });

  it.each(['bad org', '-x', 'a/b'])(
    'rejects azure-devops organization %j',
    async (organization) => {
      await write({
        version: 1,
        sources: [{ id: 'ado', type: 'azure-devops', organization, project: 'Shop' }],
      });
      await expect(loadConfig(paths)).rejects.toThrow('Invalid config');
    },
  );

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

  describe('people', () => {
    const people = (p: unknown) => write({ version: 1, sources: [], people: p });
    it('loads valid people', async () => {
      await people([{ name: 'Alan Oliveira', aliases: ['@AlanEdward19', 'Alan O.'] }]);
      expect((await loadConfig(paths)).people).toHaveLength(1);
    });
    it('rejects e-mail shaped names and aliases', async () => {
      await people([{ name: 'Alan', aliases: ['a@b.com'] }]);
      await expect(loadConfig(paths)).rejects.toThrow(
        `Invalid config at ${paths.config}: people: use display names or logins, not e-mail addresses ("a@b.com")`,
      );
      await people([{ name: 'a@b.com', aliases: ['x'] }]);
      await expect(loadConfig(paths)).rejects.toThrow('not e-mail addresses ("a@b.com")');
    });
    it('rejects an alias under two names', async () => {
      await people([
        { name: 'A', aliases: ['x'] },
        { name: 'B', aliases: ['x'] },
      ]);
      await expect(loadConfig(paths)).rejects.toThrow(
        `Invalid config at ${paths.config}: people: alias "x" is listed under both "A" and "B"`,
      );
    });
  });

  describe('llm', () => {
    it('loads without llm and with defaults', async () => {
      await write({ version: 1, sources: [] });
      expect((await loadConfig(paths)).llm).toBeUndefined();
      await write({
        version: 1,
        sources: [],
        llm: { url: 'http://localhost:11434/v1', model: 'm' },
      });
      expect((await loadConfig(paths)).llm).toEqual({
        url: 'http://localhost:11434/v1',
        model: 'm',
        maxTokens: 800,
        timeoutMs: 60000,
      });
    });
    it('rejects apiKey inside llm', async () => {
      await write({
        version: 1,
        sources: [],
        llm: { url: 'http://x/v1', model: 'm', apiKey: 'k' },
      });
      await expect(loadConfig(paths)).rejects.toThrow(
        'tokens must come from environment variables, not config',
      );
    });
  });
  describe('schema bounds', () => {
    const llm = { url: 'http://localhost:11434/v1', model: 'm' };
    const people = (p: unknown) => ({ people: p });
    const bad: Array<[string, unknown]> = [
      ['people name empty', people([{ name: '', aliases: ['a'] }])],
      ['people name 101', people([{ name: 'n'.repeat(101), aliases: ['a'] }])],
      ['people aliases empty', people([{ name: 'A', aliases: [] }])],
      [
        'people aliases 51',
        people([{ name: 'A', aliases: Array.from({ length: 51 }, (_, i) => `a${i}`) }]),
      ],
      ['people alias 101', people([{ name: 'A', aliases: ['a'.repeat(101)] }])],
      ['llm maxTokens 0', { llm: { ...llm, maxTokens: 0 } }],
      ['llm maxTokens 8193', { llm: { ...llm, maxTokens: 8193 } }],
      ['llm temperature -0.1', { llm: { ...llm, temperature: -0.1 } }],
      ['llm temperature 2.1', { llm: { ...llm, temperature: 2.1 } }],
      ['llm timeoutMs 999', { llm: { ...llm, timeoutMs: 999 } }],
      ['llm timeoutMs 300001', { llm: { ...llm, timeoutMs: 300001 } }],
      ['llm url not a url', { llm: { ...llm, url: 'not a url' } }],
      ['llm unknown key', { llm: { ...llm, api_key: 'k' } }],
      ['llm url ftp scheme', { llm: { ...llm, url: 'ftp://llm.test/v1' } }],
      ['llm url with credentials', { llm: { ...llm, url: 'https://u:sk-x@llm.test/v1' } }],
      ['llm url with query', { llm: { ...llm, url: 'https://llm.test/v1?api-key=x' } }],
      [
        'embeddings url with credentials',
        { embeddings: { url: 'https://u:p@e.test/v1', model: 'e' } },
      ],
    ];
    it.each(bad)('rejects %s', async (_name, extra) => {
      await write({ version: 1, sources: [], ...(extra as object) });
      await expect(loadConfig(paths)).rejects.toThrow(`Invalid config at ${paths.config}`);
    });
    it('passes temperature through', async () => {
      await write({ version: 1, sources: [], llm: { ...llm, temperature: 0.5 } });
      expect((await loadConfig(paths)).llm?.temperature).toBe(0.5);
    });
  });

  describe('people edge cases', () => {
    it('loads @first.last (leading @ stripped, not an e-mail)', async () => {
      await write({ version: 1, sources: [], people: [{ name: 'A', aliases: ['@first.last'] }] });
      expect((await loadConfig(paths)).people[0]?.aliases).toEqual(['@first.last']);
    });
    it('loads case-variant aliases of one name', async () => {
      await write({
        version: 1,
        sources: [],
        people: [{ name: 'Alan', aliases: ['alan', 'ALAN'] }],
      });
      const cfg = await loadConfig(paths);
      expect(createPeopleResolver(cfg.people)('alan')).toBe('Alan');
    });
  });
});
