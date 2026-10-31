import fs from 'node:fs/promises';
import path from 'node:path';
import * as z from 'zod';
import type { WaymarkPaths } from './paths.js';
import { ensureWikiRepo } from './store/wikigit.js';

const SourceId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/);
// ADR-0002: 'app' = Waymark's own identity at the source, 'personal' = dev-only personal token
const Auth = z.enum(['app', 'personal']).default('app');

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
export const SourceSchema = z.discriminatedUnion('type', [
  GitSourceSchema,
  GithubSourceSchema,
  LinearSourceSchema,
]);
export const EmbeddingsSchema = z.object({
  url: z.url(), // OpenAI-compatible base URL, e.g. http://localhost:11434/v1
  model: z.string().min(1),
  batchSize: z.number().int().min(1).max(256).default(32),
});
export const ConfigSchema = z.object({
  version: z.literal(1),
  sources: z.array(SourceSchema).default([]),
  embeddings: EmbeddingsSchema.optional(),
});
export type Config = z.infer<typeof ConfigSchema>;
export type GithubSource = z.infer<typeof GithubSourceSchema>;
export type GithubSourceInput = z.input<typeof GithubSourceSchema>;
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

  const r = raw as { sources?: unknown; embeddings?: unknown } | null;
  const secretHolders = [...(Array.isArray(r?.sources) ? r.sources : []), r?.embeddings];
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
