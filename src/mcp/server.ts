import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';
import { claimHandoff, createHandoff, listOpenHandoffs } from '../agents/handoff.js';
import { loadConfig } from '../config.js';
import { type Db, openDb, upsertDoc } from '../index/db.js';
import { formatHits } from '../index/format.js';
import { search } from '../index/search.js';
import type { WaymarkPaths } from '../paths.js';
import { DOC_KINDS, docRelPath, noteStampId } from '../store/doc.js';
import { readDoc, serializeDoc, writeDoc } from '../store/markdown.js';
import { commitWiki } from '../store/wikigit.js';

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

const text = (t: string): ToolResult => ({ content: [{ type: 'text', text: t }] });
const fail = (t: string): ToolResult => ({ isError: true, content: [{ type: 'text', text: t }] });

/** Wraps a handler so one bad call never takes the server down. */
async function guard(fn: () => ToolResult | Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await fn();
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

export function createServer(deps: { db: Db; wikiDir: string }): McpServer {
  const { db, wikiDir } = deps;
  const server = new McpServer({ name: 'waymark', version: '0.0.0' });

  server.registerTool(
    'search',
    {
      title: 'Search knowledge base',
      description:
        "Search the team's knowledge base (commits, pull requests and review comments, issues, agent notes and sessions). Use before changing unfamiliar code or when asked why something is built a certain way. Returns ranked results with ids and source links; call get_document for full text.",
      inputSchema: z.object({
        query: z.string().min(1),
        kinds: z.array(z.enum(DOC_KINDS)).optional(),
        sources: z.array(z.string()).optional(),
        limit: z.number().int().min(1).max(50).optional(),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ query, kinds, sources, limit }) =>
      guard(() => text(formatHits(search(db, { query, kinds, sourceIds: sources, limit })))),
  );

  server.registerTool(
    'get_document',
    {
      title: 'Get document',
      description:
        'Get the full markdown of one knowledge-base document by id (ids come from search results).',
      inputSchema: z.object({ id: z.string() }),
      annotations: { readOnlyHint: true },
    },
    ({ id }) =>
      guard(async () => {
        let doc: Awaited<ReturnType<typeof readDoc>> = null;
        try {
          doc = await readDoc(wikiDir, id);
        } catch (err) {
          // invalid ids are "not found"; real read/parse errors surface via guard
          if (!(err instanceof Error && err.message.startsWith('Invalid document id'))) throw err;
        }
        return doc ? text(serializeDoc(doc)) : fail(`Document not found: ${id}`);
      }),
  );

  server.registerTool(
    'save_note',
    {
      title: 'Save note',
      description:
        "Save a durable note to the team's knowledge base: a decision, convention, gotcha or finding worth remembering across sessions. Do not save secrets or transient progress.",
      inputSchema: z.object({
        title: z.string().min(1).max(200),
        body: z.string().min(1),
        tags: z.array(z.string()).max(20).optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    ({ title, body, tags }) =>
      guard(async () => {
        const nowDate = new Date();
        const now = nowDate.toISOString();
        const id = noteStampId('note', title, nowDate);
        await writeDoc(wikiDir, {
          id,
          kind: 'note',
          sourceId: 'agent',
          title,
          authors: [],
          createdAt: now,
          updatedAt: now,
          tags: tags ?? [],
          body,
        });
        // index the redacted copy from disk, not the raw input
        const stored = await readDoc(wikiDir, id);
        if (!stored) throw new Error(`Note was not written: ${id}`);
        upsertDoc(db, stored, docRelPath(id));
        await commitWiki(wikiDir, `note: ${title}`);
        return text(`Saved ${id}`);
      }),
  );

  server.registerTool(
    'create_handoff',
    {
      title: 'Create handoff',
      description:
        'Leave a handoff for the next agent session in this project: what was done, where you stopped and the exact next steps. Use when stopping before the task is finished.',
      inputSchema: z.object({
        title: z.string().min(1).max(200),
        summary: z.string().min(1),
        next_steps: z.string().min(1),
        project: z.string().min(1).max(100),
        from: z.string().max(50).optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    ({ title, summary, next_steps, project, from }) =>
      guard(async () => {
        const id = await createHandoff(db, wikiDir, {
          title,
          summary,
          nextSteps: next_steps,
          project,
          from,
        });
        return text(`Saved handoff ${id}`);
      }),
  );

  server.registerTool(
    'list_handoffs',
    {
      title: 'List handoffs',
      description: 'List open (unclaimed) handoffs, optionally for one project.',
      inputSchema: z.object({ project: z.string().optional() }),
      annotations: { readOnlyHint: true },
    },
    ({ project }) =>
      guard(() => {
        const rows = listOpenHandoffs(db, project);
        return text(
          rows.length === 0
            ? 'No open handoffs.'
            : rows.map((r) => `- ${r.title} (${r.id}, ${r.updatedAt.slice(0, 10)})`).join('\n'),
        );
      }),
  );

  server.registerTool(
    'claim_handoff',
    {
      title: 'Claim handoff',
      description:
        'Claim an open handoff and get its full text. Each handoff can be claimed once; claim it only if you are going to continue that work now.',
      inputSchema: z.object({ id: z.string() }),
      annotations: { readOnlyHint: false, idempotentHint: false },
    },
    ({ id }) =>
      guard(async () => {
        const r = await claimHandoff(db, wikiDir, id);
        if (r.ok) return text(serializeDoc(r.doc));
        return fail(
          r.reason === 'not_found' ? `Handoff not found: ${id}` : `Handoff already claimed: ${id}`,
        );
      }),
  );

  return server;
}

export async function runStdio(paths: WaymarkPaths): Promise<void> {
  await loadConfig(paths); // throws "not initialised" before anything is connected
  const db = openDb(paths.db);
  const server = createServer({ db, wikiDir: paths.wiki });
  await server.connect(new StdioServerTransport());
}
