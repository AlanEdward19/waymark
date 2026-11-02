import fs from 'node:fs/promises';
import path from 'node:path';
import * as z from 'zod';
import { createPeopleResolver, isEmailLike } from './memory/people.js';
import type { WaymarkPaths } from './paths.js';
import { ensureWikiRepo } from './store/wikigit.js';

const SourceId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/);
// ADR-0002: 'app' = Waymark's own identity at the source, 'personal' = dev-only personal token
const Auth = z.enum(['app', 'personal']).default('app');

export const DiscordSourceSchema = z.object({
  id: SourceId,
  type: z.literal('discord'),
  // user tokens are against Discord's terms: the Waymark bot is the only identity
  auth: z
    .literal('app', {
      error: 'discord has no personal-token mode; remove "auth" (the Waymark bot is used)',
    })
    .default('app'),
  channels: z.array(z.string().regex(/^\d{17,20}$/)).min(1),
  backlogDays: z.number().int().min(1).max(365).default(30),
});
export const GitSourceSchema = z.object({
  id: SourceId,
  type: z.literal('git'),
  auth: Auth,
  path: z.string().min(1), // absolute or relative to the config file dir
  maxCommits: z.number().int().positive().optional(),
  include: z.array(z.enum(['commits', 'docs'])).default(['commits', 'docs']),
  docs: z.array(z.string().min(1)).optional(), // glob pathspecs; default DOC_GLOBS
});
export const GithubSourceSchema = z.object({
  id: SourceId,
  type: z.literal('github'),
  auth: Auth,
  repo: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/), // "owner/name"
  include: z.array(z.enum(['pulls', 'issues'])).default(['pulls', 'issues']),
});
export const LinearSourceSchema = z.object({
  id: SourceId,
  type: z.literal('linear'),
  auth: Auth,
  team: z.string().min(1).optional(), // team key, e.g. "ENG"
});
export const JiraSourceSchema = z
  .object({
    id: SourceId,
    type: z.literal('jira'),
    auth: Auth,
    site: z.string().regex(/^[a-z0-9-]+\.atlassian\.net$/), // e.g. "acme.atlassian.net"
    project: z.string().min(1).optional(),
    jql: z.string().min(1).optional(),
  })
  .refine((s) => (s.project === undefined) !== (s.jql === undefined), {
    message: 'jira sources need exactly one of "project" or "jql"',
  })
  .refine((s) => s.jql === undefined || !/\border\s+by\b/i.test(s.jql), {
    message: 'jira: remove ORDER BY from jql; Waymark orders by updated',
  });
export const NotionSourceSchema = z.object({
  id: SourceId,
  type: z.literal('notion'),
  // the internal integration "Waymark" is the identity; there is no personal fallback
  auth: Auth.refine((a) => a === 'app', { message: "notion sources only support auth: 'app'" }),
});
export const AzureDevOpsSourceSchema = z.object({
  id: SourceId,
  type: z.literal('azure-devops'),
  auth: Auth,
  organization: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]*$/),
  project: z.string().min(1),
  include: z.array(z.enum(['workitems', 'pulls'])).default(['workitems', 'pulls']),
  repos: z.array(z.string().min(1)).optional(), // used by #54
});
export const SourceSchema = z.discriminatedUnion('type', [
  AzureDevOpsSourceSchema,
  DiscordSourceSchema,
  GitSourceSchema,
  GithubSourceSchema,
  LinearSourceSchema,
  JiraSourceSchema,
  NotionSourceSchema,
]);
// keys come from env vars: no credentials, query or fragment in endpoint URLs
const EndpointUrl = z.url({ protocol: /^https?$/ }).refine((u) => {
  const x = URL.parse(u); // null when z.url already failed: refine still runs
  return !x || (!x.username && !x.password && !x.search && !x.hash);
}, 'use a plain http(s) URL without credentials, query or fragment');
export const EmbeddingsSchema = z.object({
  url: EndpointUrl, // OpenAI-compatible base URL, e.g. http://localhost:11434/v1
  model: z.string().min(1),
  batchSize: z.number().int().min(1).max(256).default(32),
});
export const PersonSchema = z.object({
  name: z.string().min(1).max(100),
  aliases: z.array(z.string().min(1).max(100)).min(1).max(50),
});
export const LlmSchema = z.strictObject({
  url: EndpointUrl, // OpenAI-compatible base URL, e.g. http://localhost:11434/v1
  model: z.string().min(1),
  maxTokens: z.number().int().min(1).max(8192).default(800),
  temperature: z.number().min(0).max(2).optional(), // omitted from requests unless set
  timeoutMs: z.number().int().min(1000).max(300000).default(60000),
});
export const ConfigSchema = z.object({
  version: z.literal(1),
  sources: z.array(SourceSchema).default([]),
  embeddings: EmbeddingsSchema.optional(),
  llm: LlmSchema.optional(),
  people: z.array(PersonSchema).default([]),
});
export type Config = z.infer<typeof ConfigSchema>;
export type AzureDevOpsSource = z.infer<typeof AzureDevOpsSourceSchema>;
export type DiscordSource = z.infer<typeof DiscordSourceSchema>;
export type GithubSource = z.infer<typeof GithubSourceSchema>;
export type GithubSourceInput = z.input<typeof GithubSourceSchema>;
export type JiraSource = z.infer<typeof JiraSourceSchema>;
export type LinearSource = z.infer<typeof LinearSourceSchema>;
export type GitSource = z.infer<typeof GitSourceSchema>;
export type SourceConfig = z.infer<typeof SourceSchema>;

export async function loadConfig(paths: WaymarkPaths): Promise<Config> {
  let text: string;
  try {
    text = await fs.readFile(paths.config, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error('Waymark is not initialised. Run "waymark init" first.');
    }
    throw err;
  }
  const invalid = (detail: string) => new Error(`Invalid config at ${paths.config}: ${detail}`);

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw invalid((err as Error).message);
  }

  const r = raw as { sources?: unknown; embeddings?: unknown; llm?: unknown } | null;
  const secretHolders = [...(Array.isArray(r?.sources) ? r.sources : []), r?.embeddings, r?.llm];
  for (const s of secretHolders) {
    if (s !== null && typeof s === 'object' && ('token' in s || 'apiKey' in s)) {
      throw invalid('tokens must come from environment variables, not config');
    }
  }

  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) throw invalid(z.prettifyError(parsed.error));

  const seen = new Set<string>();
  for (const s of parsed.data.sources) {
    if (seen.has(s.id)) throw invalid(`duplicate source id "${s.id}"`);
    seen.add(s.id);
  }

  // display names and logins only: never e-mail addresses (epic #20)
  for (const p of parsed.data.people ?? []) {
    for (const v of [p.name, ...p.aliases]) {
      if (isEmailLike(v)) {
        throw invalid(`people: use display names or logins, not e-mail addresses ("${v}")`);
      }
    }
  }
  try {
    createPeopleResolver(parsed.data.people);
  } catch (err) {
    throw invalid((err as Error).message);
  }
  return parsed.data;
}

export async function initHome(paths: WaymarkPaths): Promise<{ created: boolean }> {
  await fs.mkdir(paths.wiki, { recursive: true });
  await fs.mkdir(path.dirname(paths.db), { recursive: true });
  await ensureWikiRepo(paths.wiki);
  try {
    // 'wx' fails if the file exists: never overwrites user config.
    await fs.writeFile(paths.config, `${JSON.stringify({ version: 1, sources: [] }, null, 2)}\n`, {
      flag: 'wx',
    });
    return { created: true };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return { created: false };
    throw err;
  }
}
