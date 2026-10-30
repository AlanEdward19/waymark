import path from 'node:path';
import type { GitSource } from '../config.js';
import { defaultRun, type RunGit } from '../git.js';
import { makeId, type WaymarkDoc } from '../store/doc.js';
import type { Connector } from './types.js';

const LOG_FORMAT = '%x1e%H%x1f%an%x1f%aI%x1f%cI%x1f%s%x1f%b%x1f';

export function githubCommitUrl(remote: string | undefined, sha: string): string | undefined {
  const m = remote?.trim().match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/);
  return m ? `https://github.com/${m[1]}/${m[2]}/commit/${sha}` : undefined;
}

export function parseGitLog(sourceId: string, output: string, remote?: string): WaymarkDoc[] {
  return output
    .split('\x1e')
    .slice(1)
    .map((record) => {
      const [
        sha = '',
        author = '',
        authorDate = '',
        commitDate = '',
        subject = '',
        body = '',
        filesBlock = '',
      ] = record.split('\x1f');
      const files = filesBlock
        .split('\n')
        .map((f) => f.trim())
        .filter(Boolean);
      const parts = [subject];
      if (body.trim()) parts.push(body.trim());
      if (files.length > 0) parts.push(`## Files\n\n${files.map((f) => `- ${f}`).join('\n')}`);
      return {
        id: makeId(sourceId, 'commit', sha),
        kind: 'commit' as const,
        sourceId,
        title: subject,
        url: githubCommitUrl(remote, sha),
        authors: [author],
        createdAt: new Date(authorDate).toISOString(),
        updatedAt: new Date(commitDate).toISOString(),
        tags: [],
        body: parts.join('\n\n'),
      };
    })
    .map(({ url, ...doc }) => (url === undefined ? doc : { ...doc, url }));
}

export function gitConnector(
  source: GitSource,
  configDir: string,
  run: RunGit = defaultRun,
): Connector {
  return async (ctx) => {
    const repo = path.resolve(configDir, source.path);
    try {
      await run(['rev-parse', '--is-inside-work-tree'], repo);
    } catch {
      throw new Error(`Source "${source.id}": ${repo} is not a git repository`);
    }
    const head = (await run(['rev-parse', 'HEAD'], repo)).trim();
    if (ctx.cursor === head) return { cursor: head, count: 0 };

    let range = 'HEAD';
    if (ctx.cursor !== null) {
      const intact = await run(['merge-base', '--is-ancestor', ctx.cursor, 'HEAD'], repo).then(
        () => true,
        () => false,
      );
      if (intact) range = `${ctx.cursor}..HEAD`;
      else ctx.log('history rewritten, full resync');
    }

    const remote = await run(['remote', 'get-url', 'origin'], repo).catch(() => undefined);
    // quotePath=false keeps non-ASCII file names readable instead of octal-escaped
    const args = ['-c', 'core.quotePath=false', 'log', '--no-color', '--no-merges'];
    args.push(`--format=${LOG_FORMAT}`, '--name-only');
    if (source.maxCommits !== undefined) args.push(`--max-count=${source.maxCommits}`);
    args.push(range);
    const docs = parseGitLog(source.id, await run(args, repo), remote);
    for (const doc of docs) await ctx.emit(doc);
    return { cursor: head, count: docs.length };
  };
}
