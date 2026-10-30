import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { initHome } from '../src/config.js';
import { resolvePaths } from '../src/paths.js';

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
  it('lists the six tools', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'claim_handoff',
      'create_handoff',
      'get_document',
      'list_handoffs',
      'save_note',
      'search',
    ]);
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
    expect((await client.listTools()).tools).toHaveLength(6);
  });
});
