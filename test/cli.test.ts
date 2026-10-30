import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/cli.js';
import { writeDoc } from '../src/store/markdown.js';

function capture() {
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const text = (spy: typeof stdout) => spy.mock.calls.map((c) => String(c[0])).join('');
  return { out: () => text(stdout), err: () => text(stderr) };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('main', () => {
  it.each([['--version'], ['-v']])('%s prints the version', async (flag) => {
    const io = capture();
    expect(await main([flag])).toBe(0);
    expect(io.out()).toBe('0.0.0\n');
    expect(io.err()).toBe('');
  });

  it.each([['--help'], ['-h'], []])('%s prints usage', async (...args: string[]) => {
    const io = capture();
    expect(await main(args)).toBe(0);
    expect(io.out()).toContain('Usage: waymark');
    expect(io.err()).toBe('');
  });

  it('rejects an unknown command', async () => {
    const io = capture();
    expect(await main(['foo'])).toBe(1);
    expect(io.out()).toBe('');
    expect(io.err()).toBe('error: unknown command "foo"\n');
  });

  it('sync rejects more than one --source', async () => {
    const io = capture();
    expect(await main(['sync', '--source', 'a', '--source', 'b'])).toBe(1);
    expect(io.err()).toBe('error: sync takes at most one --source\n');
  });

  it('init creates the data dir, then reports it already exists', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'waymark-'));
    vi.stubEnv('WAYMARK_HOME', tmp);
    try {
      const io = capture();
      expect(await main(['init'])).toBe(0);
      expect(await main(['init'])).toBe(0);
      expect(io.out()).toBe(`Initialised Waymark at ${tmp}
Waymark already initialised at ${tmp}
`);
    } finally {
      vi.unstubAllEnvs();
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('reindex prints the document count', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'waymark-'));
    vi.stubEnv('WAYMARK_HOME', tmp);
    try {
      const io = capture();
      expect(await main(['init'])).toBe(0);
      expect(await main(['reindex'])).toBe(0);
      expect(io.out()).toContain('Indexed 0 documents\n');
    } finally {
      vi.unstubAllEnvs();
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});

describe('search and show', () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'waymark-'));
    vi.stubEnv('WAYMARK_HOME', tmp);
    capture();
    await main(['init']);
    await writeDoc(path.join(tmp, 'wiki'), {
      id: 'src/note/1',
      kind: 'note',
      sourceId: 'src',
      title: 'Hello',
      authors: [],
      createdAt: '2026-10-01T12:00:00.000Z',
      updatedAt: '2026-10-02T08:30:00.000Z',
      tags: [],
      body: 'findable body',
    });
    await main(['reindex']);
    vi.restoreAllMocks();
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('search --json prints a JSON array', async () => {
    const io = capture();
    expect(await main(['search', 'findable', '--json'])).toBe(0);
    const hits = JSON.parse(io.out());
    expect(hits).toHaveLength(1);
    expect(hits[0].id).toBe('src/note/1');
  });

  it('search prints formatted text, joins positionals, accepts filters', async () => {
    const io = capture();
    expect(await main(['search', 'findable', 'body', '--kind', 'note', '--source', 'src'])).toBe(0);
    expect(io.out()).toContain('id: src/note/1');
  });

  it('search errors on missing query and invalid kind', async () => {
    const io = capture();
    expect(await main(['search'])).toBe(1);
    expect(await main(['search', 'x', '--kind', 'bogus'])).toBe(1);
    expect(io.err()).toContain('error: search needs a query\n');
    expect(io.err()).toContain('invalid kind "bogus"');
  });

  it('show prints the markdown and exits 1 on unknown id', async () => {
    const io = capture();
    expect(await main(['show', 'src/note/1'])).toBe(0);
    expect(io.out()).toContain('title: Hello');
    expect(io.out()).toContain('findable body');
    expect(await main(['show', 'src/note/nope'])).toBe(1);
    expect(io.err()).toBe('error: document not found: src/note/nope\n');
  });
});
