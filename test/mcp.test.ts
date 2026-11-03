import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startContext } from '../src/agents/session.js';
import { initHome } from '../src/config.js';
import { openDb, upsertDoc } from '../src/index/db.js';
import { resolvePaths } from '../src/paths.js';
import { docRelPath } from '../src/store/doc.js';
import { writeDoc } from '../src/store/markdown.js';

let tmp: string;
let client: Client;

const textOf = (r: unknown) =>
  (r as { content: { text: string }[] }).content.map((c) => c.text).join('');

beforeAll(async () => {
  if (!fs.existsSync('dist/cli.js')) throw new Error('run "npm run build" first');
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'waymark-'));
  await initHome(resolvePaths({ WAYMARK_HOME: tmp }));
  client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ['dist/cli.js', 'mcp'],
      env: { ...(process.env as Record<string, string>), WAYMARK_HOME: tmp },
    }),
  );
});

afterAll(async () => {
  await client?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('waymark mcp', () => {
  it('lists the tools', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'claim_handoff',
      'create_handoff',
      'get_document',
      'list_handoffs',
      'save_note',
      'search',
      'who_knows',
    ]);
  });

  it('start-up context names every tool the server registers', async () => {
    const { tools } = await client.listTools();
    const db = openDb(resolvePaths({ WAYMARK_HOME: tmp }).db);
    try {
      const out = startContext(db);
      for (const t of tools) expect(out).toContain(`\`${t.name}\``);
    } finally {
      db.close();
    }
  });

  it('who_knows matches CLI text with synthetic path facts and validates limits', async () => {
    const paths = resolvePaths({ WAYMARK_HOME: tmp });
    const db = openDb(paths.db);
    try {
      const { doc } = await writeDoc(paths.wiki, {
        id: 'fixture/commit/expertise',
        kind: 'commit',
        sourceId: 'fixture',
        title: 'Synthetic path expertise',
        authors: ['river-login'],
        tags: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        body: '## Files\n\n- src/synthetic.ts',
      });
      upsertDoc(db, doc, docRelPath(doc.id));
    } finally {
      db.close();
    }
    const result = await client.callTool({
      name: 'who_knows',
      arguments: { path: 'src', sources: ['fixture'] },
    });
    const cli = execFileSync(
      process.execPath,
      ['dist/cli.js', 'experts', 'src', '--source', 'fixture'],
      {
        env: { ...process.env, WAYMARK_HOME: tmp },
        encoding: 'utf8',
      },
    );
    expect(textOf(result)).toBe(cli);
    expect(cli).toContain('river-login  score 1.0');
    const bad = await client.callTool({ name: 'who_knows', arguments: { path: 'src', limit: 21 } });
    expect(bad.isError).toBe(true);
    const tool = (await client.listTools()).tools.find((tool) => tool.name === 'who_knows');
    expect(tool?.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });
  });

  it('create, list and claim a handoff once', async () => {
    const created = await client.callTool({
      name: 'create_handoff',
      arguments: { title: 'Wire up quokka', summary: 'Done A', next_steps: 'Do B', project: 'p1' },
    });
    expect(created.isError).toBeFalsy();
    const id = textOf(created).replace('Saved handoff ', '');
    const listed = await client.callTool({ name: 'list_handoffs', arguments: { project: 'p1' } });
    expect(textOf(listed)).toContain(`- Wire up quokka (${id},`);
    const claimed = await client.callTool({ name: 'claim_handoff', arguments: { id } });
    expect(textOf(claimed)).toContain('## Claimed');
    const again = await client.callTool({ name: 'claim_handoff', arguments: { id } });
    expect(again.isError).toBe(true);
    expect(textOf(again)).toBe(`Handoff already claimed: ${id}`);
    const none = await client.callTool({ name: 'list_handoffs', arguments: { project: 'p1' } });
    expect(textOf(none)).toBe('No open handoffs.');
  });

  it('save_note, search and get_document round-trip', async () => {
    const saved = await client.callTool({
      name: 'save_note',
      arguments: { title: 'Zebrafish convention', body: 'Always use zebrafish ids.', tags: ['x'] },
    });
    expect(saved.isError).toBeFalsy();
    const id = textOf(saved).replace('Saved ', '');
    expect(id).toMatch(/^agent\/note\/\d{8}-\d{6}-zebrafish-convention$/);

    const found = await client.callTool({ name: 'search', arguments: { query: 'zebrafish' } });
    expect(textOf(found)).toContain(id);

    const doc = await client.callTool({ name: 'get_document', arguments: { id } });
    expect(textOf(doc)).toContain('Always use zebrafish ids.');
  });

  it('validates all superseded notes before writing and prefixes show/get_document without changing the old file', async () => {
    const old = await client.callTool({
      name: 'save_note',
      arguments: { title: 'Old synthetic convention', body: 'Original synthetic guidance.' },
    });
    const id = textOf(old).replace('Saved ', '');
    const paths = resolvePaths({ WAYMARK_HOME: tmp });
    const file = path.join(paths.wiki, docRelPath(id));
    const original = fs.readFileSync(file, 'utf8');
    const db = openDb(paths.db);
    const count = () => db.prepare('SELECT COUNT(*) AS n FROM docs').get();
    const before = count();
    const noteFiles = () => fs.readdirSync(path.join(paths.wiki, 'agent', 'note')).sort();
    const filesBefore = noteFiles();
    try {
      for (const [target, expected] of [
        ['agent/note/missing', 'Note not found: agent/note/missing'],
        ['../bad', 'Note not found: ../bad'],
        ['fixture/commit/expertise', 'Cannot supersede fixture/commit/expertise: not a note'],
      ]) {
        const failed = await client.callTool({
          name: 'save_note',
          arguments: {
            title: 'Invalid synthetic replacement',
            body: 'Should never be written.',
            supersedes: [id, target],
          },
        });
        expect(failed.isError).toBe(true);
        expect(textOf(failed)).toBe(expected);
        expect(count()).toEqual(before);
        expect(noteFiles()).toEqual(filesBefore);
      }
      const tooMany = await client.callTool({
        name: 'save_note',
        arguments: {
          title: 'Too many synthetic targets',
          body: 'Should never be written.',
          supersedes: Array(11).fill(id),
        },
      });
      expect(tooMany.isError).toBe(true);
      expect(count()).toEqual(before);
      expect(noteFiles()).toEqual(filesBefore);
      const saved = await client.callTool({
        name: 'save_note',
        arguments: {
          title: 'New synthetic convention',
          body: 'Replacement synthetic guidance.',
          supersedes: [id],
        },
      });
      expect(saved.isError).toBeFalsy();
      const newId = textOf(saved).replace('Saved ', '');
      const result = await client.callTool({ name: 'get_document', arguments: { id } });
      const expected = `> Note: superseded by ${newId}\n\n${original}`;
      expect(textOf(result)).toBe(expected);
      const cli = execFileSync(process.execPath, ['dist/cli.js', 'show', id], {
        env: { ...process.env, WAYMARK_HOME: tmp },
        encoding: 'utf8',
      });
      expect(cli).toBe(expected);
      expect(fs.readFileSync(file, 'utf8')).toBe(original);
    } finally {
      db.close();
    }
  });

  it('unknown id is an error and the server keeps answering', async () => {
    for (const id of ['agent/note/nope', '../etc/passwd']) {
      const r = await client.callTool({ name: 'get_document', arguments: { id } });
      expect(r.isError).toBe(true);
      expect(textOf(r)).toBe(`Document not found: ${id}`);
    }
    const next = await client.callTool({ name: 'search', arguments: { query: 'zebrafish' } });
    expect(next.isError).toBeFalsy();
  });

  it('rejects an out-of-range limit and stays alive', async () => {
    const r = await client.callTool({ name: 'search', arguments: { query: 'a', limit: 500 } });
    expect(r.isError).toBe(true);
    expect((await client.listTools()).tools).toHaveLength(7);
  });
});
