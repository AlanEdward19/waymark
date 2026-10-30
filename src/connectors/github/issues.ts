import { makeId, type WaymarkDoc } from '../../store/doc.js';
import type { SyncContext } from '../types.js';
import type { GhIssue, GhIssueComment, GithubApi } from './api.js';
import { conversationSection, humanIssueComments, isBot } from './conversation.js';

export function renderIssue(
  sourceId: string,
  issue: GhIssue,
  comments: GhIssueComment[],
): WaymarkDoc {
  const state = issue.state === 'closed' && issue.state_reason ? issue.state_reason : issue.state;
  const author = issue.user?.login ?? 'ghost';
  const human = humanIssueComments(comments);
  const authors = [
    ...new Set([
      ...(isBot(issue.user) ? [] : [author]),
      ...human.map((c) => (c.user as { login: string }).login),
    ]),
  ];
  const labels = issue.labels.map((l) => (typeof l === 'string' ? l : l.name));
  const sections = [
    `#${issue.number} · ${state} · @${author}`,
    issue.body?.trim() || '_No description._',
  ];
  const conv = conversationSection(human);
  if (conv) sections.push(conv);

  return {
    id: makeId(sourceId, 'issue', String(issue.number)),
    kind: 'issue',
    sourceId,
    title: issue.title,
    url: issue.html_url,
    authors,
    createdAt: issue.created_at,
    updatedAt: issue.updated_at,
    tags: [`state:${state}`, ...labels.map((l) => `label:${l}`)],
    body: sections.join('\n\n'),
  };
}

export async function syncIssues(
  ctx: SyncContext,
  api: GithubApi,
  owner: string,
  repo: string,
  since: string | undefined,
): Promise<{ cursor: string | undefined; count: number }> {
  let newest = since;
  let count = 0;
  for await (const page of api.issuePages(owner, repo, since)) {
    for (const issue of page) {
      if (issue.pull_request !== undefined) continue;
      const comments = await api.issueComments(owner, repo, issue.number);
      await ctx.emit(renderIssue(ctx.sourceId, issue, comments));
      count++;
      if (newest === undefined || issue.updated_at > newest) newest = issue.updated_at;
    }
  }
  return { cursor: newest, count };
}
