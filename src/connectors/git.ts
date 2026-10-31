import path from 'node:path';
import type { GitSource } from '../config.js';
import { defaultRun, type RunGit } from '../git.js';
import { makeId, type WaymarkDoc } from '../store/doc.js';
import { syncDocs } from './git-docs.js';
import type { Connector } from './types.js';

const LOG_FORMAT = '%x1e%H%x1f%an%x1f%aI%x1f%cI%x1f%s%x1f%b%x1f';

type Remote =
  | { host: 'github'; owner: string; repo: string }
  | { host: 'azure'; org: string; project: string; repo: string };

export function parseRemote(remote: string | undefined): Remote | undefined {
  const r = remote?.trim();
  if (!r) return undefined;
  const gh = r.match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/);
  if (gh) return { host: 'github', owner: gh[1] ?? '', repo: gh[2] ?? '' };
  // https://[org@]dev.azure.com/<org>/<project>/_git/<repo>
  const https = r.match(/^https:\/\/(?:[^@/]+@)?dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^/]+)$/);
  // <org>@vs-ssh.visualstudio.com:v3/<org>/<project>/<repo> or git@ssh.dev.azure.com:v3/...
  const ssh = r.match(
    /(?:vs-ssh\.visualstudio\.com|ssh\.dev\.azure\.com):v3\/([^/]+)\/([^/]+)\/([^/]+)$/,
  );
  const az = https ?? ssh;
  return az
    ? { host: 'azure', org: az[1] ?? '', project: az[2] ?? '', repo: az[3] ?? '' }
    : undefined;
}

export function githubCommitUrl(remote: string | undefined, sha: string): string | undefined {
  const m = parseRemote(remote);
  return m?.host === 'github' ? `https://github.com/${m.owner}/${m.repo}/commit/${sha}` : undefined;
}

export function blobUrl(remote: string | undefined, sha: string, file: string): string | undefined {
  const m = parseRemote(remote);
  if (m?.host === 'github') return `https://github.com/${m.owner}/${m.repo}/blob/${sha}/${file}`;
  if (m?.host === 'azure') {
    return `https://dev.azure.com/${m.org}/${m.project}/_git/${m.repo}?path=/${file}&version=GC${sha}`;
  }
  return undefined;
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
    let intact = false;
    if (ctx.cursor !== null) {
      intact = await run(['merge-base', '--is-ancestor', ctx.cursor, 'HEAD'], repo).then(
        () => true,
        () => false,
      );
      if (intact) range = `${ctx.cursor}..HEAD`;
      else ctx.log('history rewritten, full resync');
    }

    const remote = await run(['remote', 'get-url', 'origin'], repo).catch(() => undefined);
    let count = 0;
    let removed = 0;
    if (source.include.includes('commits')) {
      // quotePath=false keeps non-ASCII file names readable instead of octal-escaped
      const args = ['-c', 'core.quotePath=false', 'log', '--no-color', '--no-merges'];
      args.push(`--format=${LOG_FORMAT}`, '--name-only');
      if (source.maxCommits !== undefined) args.push(`--max-count=${source.maxCommits}`);
      args.push(range);
      const docs = parseGitLog(source.id, await run(args, repo), remote);
      for (const doc of docs) await ctx.emit(doc);
      count += docs.length;
    }
    if (source.include.includes('docs')) {
      const res = await syncDocs(ctx, run, {
        sourceId: source.id,
        repo,
        head,
        incremental: intact,
        globs: source.docs,
        urlFor: (sha, file) => blobUrl(remote, sha, file),
      });
      count += res.emitted;
      removed = res.removed;
    }
    return { cursor: head, count, removed };
  };
}
