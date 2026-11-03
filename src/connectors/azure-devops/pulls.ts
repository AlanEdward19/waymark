import { makeId, type WaymarkDoc } from '../../store/doc.js';
import { day, indent } from '../github/conversation.js';
import { fetchJson } from '../http.js';
import { lf } from '../text.js';
import type { SyncContext } from '../types.js';
import type { AdoIdentity } from './api.js';

export interface AdoRepository {
  id: string;
  name: string;
}
export interface AdoPullRequest {
  pullRequestId: number;
  title: string;
  description?: string;
  status: string;
  creationDate: string;
  closedDate?: string;
  createdBy?: AdoIdentity;
  sourceRefName: string;
  targetRefName: string;
  reviewers?: Array<AdoIdentity & { vote: number }>;
}
export interface AdoPullComment {
  author?: AdoIdentity;
  content?: string;
  publishedDate: string;
  lastUpdatedDate?: string;
  commentType: string;
  isDeleted?: boolean;
  parentCommentId?: number;
}
export interface AdoPullThread {
  comments?: AdoPullComment[];
  status?: string;
  lastUpdatedDate?: string;
  threadContext?: { filePath: string; rightFileStart?: { line: number } } | null;
}
export interface AdoPullsApi {
  repositories(): Promise<AdoRepository[]>;
  pullRequests(repoId: string, skip: number): Promise<AdoPullRequest[]>;
  pullRequest(repoId: string, id: number): Promise<AdoPullRequest>;
  threads(repoId: string, id: number): Promise<AdoPullThread[]>;
}

export function createPullsApi(
  organization: string,
  project: string,
  authorization: () => Promise<string>,
  fetchImpl?: typeof fetch,
): AdoPullsApi {
  const base = `https://dev.azure.com/${organization}/${encodeURIComponent(project)}/_apis/git/repositories`;
  const call = async <T>(url: string): Promise<T> => {
    try {
      return await fetchJson<T>(url, {
        redirect: 'error',
        headers: { authorization: await authorization(), accept: 'application/json' },
        ...(fetchImpl ? { fetchImpl } : {}),
      });
    } catch (err) {
      if (err instanceof Error && / responded (401|403)\b/.test(err.message)) {
        throw new Error(
          `${err.message}; check the identity's Basic access and repository Read permission: docs/identities.md#azure-devops`,
        );
      }
      throw err;
    }
  };
  const repoUrl = (repoId: string) => `${base}/${encodeURIComponent(repoId)}/pullRequests`;
  return {
    async repositories() {
      return (await call<{ value: AdoRepository[] }>(`${base}?api-version=7.1`)).value;
    },
    async pullRequests(repoId, skip) {
      return (
        await call<{ value: AdoPullRequest[] }>(
          `${repoUrl(repoId)}?searchCriteria.status=all&$top=100&$skip=${skip}&api-version=7.1`,
        )
      ).value;
    },
    async pullRequest(repoId, id) {
      return call<AdoPullRequest>(`${repoUrl(repoId)}/${id}?api-version=7.1`);
    },
    async threads(repoId, id) {
      return (
        await call<{ value: AdoPullThread[] }>(`${repoUrl(repoId)}/${id}/threads?api-version=7.1`)
      ).value;
    },
  };
}

const votes: Record<number, string> = {
  10: 'approved',
  5: 'approved-with-suggestions',
  '-5': 'waiting',
  '-10': 'rejected',
};
const name = (identity?: AdoIdentity) => identity?.displayName?.trim() || 'unknown';
const comments = (thread: AdoPullThread) =>
  (thread.comments ?? []).filter((c) => c.commentType === 'text' && !c.isDeleted);

export function renderPullRequest(
  sourceId: string,
  organization: string,
  project: string,
  repoName: string,
  pr: AdoPullRequest,
  threads: AdoPullThread[],
): WaymarkDoc {
  const human = threads.filter((t) => comments(t).length > 0);
  const reviewers = (pr.reviewers ?? []).filter((r) => votes[r.vote] !== undefined);
  const sections = [
    `!${pr.pullRequestId} · ${pr.status} · @${name(pr.createdBy)} · ${pr.targetRefName.replace(/^refs\/heads\//, '')} ← ${pr.sourceRefName.replace(/^refs\/heads\//, '')}`,
    lf(pr.description ?? '').trim() || '_No description._',
  ];
  if (reviewers.length)
    sections.push(
      `## Reviews\n\n${reviewers.map((r) => `- **${name(r)}** ${votes[r.vote]}`).join('\n')}`,
    );
  const renderComments = (thread: AdoPullThread) =>
    comments(thread)
      .map((c) => {
        const pad = c.parentCommentId ? '  ' : '';
        return `${pad}- **${name(c.author)}** (${day(c.publishedDate)}): ${indent(c.content ?? '', `${pad}  `)}`;
      })
      .join('\n');
  const files = human.filter((t) => t.threadContext);
  if (files.length)
    sections.push(
      `## Review comments\n\n${files
        .map((t) => {
          const context = t.threadContext;
          const status = t.status && t.status !== 'active' ? ` (${t.status})` : '';
          return `### \`${context?.filePath}\`${context?.rightFileStart ? ` line ${context.rightFileStart.line}` : ''}${status}\n\n${renderComments(t)}`;
        })
        .join('\n\n')}`,
    );
  const conversation = human.filter((t) => !t.threadContext);
  if (conversation.length)
    sections.push(`## Conversation\n\n${conversation.map(renderComments).join('\n')}`);
  const dates = [
    pr.creationDate,
    pr.closedDate,
    ...human.flatMap((t) => [
      t.lastUpdatedDate,
      ...comments(t).flatMap((c) => [c.publishedDate, c.lastUpdatedDate]),
    ]),
  ].filter((d): d is string => d !== undefined && !Number.isNaN(Date.parse(d)));
  const updatedAt = dates.reduce(
    (latest, date) => (Date.parse(date) > Date.parse(latest) ? date : latest),
    pr.creationDate,
  );
  return {
    id: makeId(sourceId, 'pull_request', `${repoName}-${pr.pullRequestId}`),
    kind: 'pull_request',
    sourceId,
    title: pr.title,
    url: `https://dev.azure.com/${organization}/${encodeURIComponent(project)}/_git/${encodeURIComponent(repoName)}/pullrequest/${pr.pullRequestId}`,
    authors: [
      ...new Set(
        [
          name(pr.createdBy),
          ...reviewers.map(name),
          ...human.flatMap((t) => comments(t).map((c) => name(c.author))),
        ].filter((n) => n !== 'unknown'),
      ),
    ],
    createdAt: new Date(pr.creationDate).toISOString(),
    updatedAt: new Date(updatedAt).toISOString(),
    tags: [
      `state:${pr.status}`,
      `repo:${repoName}`,
      ...reviewers.map((r) => `vote:${name(r)}:${votes[r.vote]}`),
    ],
    body: sections.join('\n\n'),
  };
}

export async function syncPulls(
  ctx: SyncContext,
  api: AdoPullsApi,
  organization: string,
  project: string,
  since: string | undefined,
  repoNames?: string[],
): Promise<{ cursor: string | undefined; count: number }> {
  const all = await api.repositories();
  for (const requested of repoNames ?? [])
    if (!all.some((r) => r.name === requested))
      throw new Error(
        `Azure DevOps repository "${requested}" was not found in project "${project}"`,
      );
  const repos = repoNames === undefined ? all : all.filter((r) => repoNames.includes(r.name));
  const cutoff = since === undefined ? undefined : Date.parse(since) - 30 * 86400000;
  let newest = since;
  let count = 0;
  for (const repo of repos) {
    for (let skip = 0; ; skip += 100) {
      const page = await api.pullRequests(repo.id, skip);
      if (page.length === 0) break;
      // shortcut: closed PRs created over 30 days before the cursor are missed; widen the window if needed.
      const qualified = page.filter(
        (pr) =>
          cutoff === undefined || pr.status === 'active' || Date.parse(pr.creationDate) >= cutoff,
      );
      for (const listed of qualified) {
        // The list endpoint truncates descriptions to 400 characters.
        const pr = await api.pullRequest(repo.id, listed.pullRequestId);
        const threads = await api.threads(repo.id, pr.pullRequestId);
        await ctx.emit(
          renderPullRequest(ctx.sourceId, organization, project, repo.name, pr, threads),
        );
        count++;
        if (newest === undefined || Date.parse(pr.creationDate) > Date.parse(newest))
          newest = new Date(pr.creationDate).toISOString();
      }
      if (
        (qualified.length === 0 &&
          cutoff !== undefined &&
          page.every((pr) => Date.parse(pr.creationDate) < cutoff)) ||
        page.length < 100
      )
        break;
    }
  }
  return { cursor: newest, count };
}
