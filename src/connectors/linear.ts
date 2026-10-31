import type { LinearSource } from '../config.js';
import { makeId, type WaymarkDoc } from '../store/doc.js';
import { type LinearAppDeps, linearAppTokenProvider } from './auth/linear-app.js';
import { day, indent } from './github/conversation.js';
import { envToken, fetchJson } from './http.js';
import type { Connector } from './types.js';

const API = 'https://api.linear.app/graphql';
const COMMENTS_PER_ISSUE = 50;

const QUERY = `query Issues($after: String, $filter: IssueFilter) {
  issues(first: 25, after: $after, filter: $filter, orderBy: updatedAt, includeArchived: true) {
    pageInfo { hasNextPage endCursor }
    nodes {
      identifier title description url createdAt updatedAt archivedAt
      state { name type }
      labels { nodes { name } }
      creator { name }
      comments(first: ${COMMENTS_PER_ISSUE}) { nodes { body createdAt user { name } botActor { name } } }
    }
  }
}`;

interface LinearIssue {
  identifier: string;
  title: string;
  description: string | null;
  url: string;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  state: { name: string; type: string };
  labels: { nodes: Array<{ name: string }> };
  creator: { name: string } | null;
  comments: {
    nodes: Array<{
      body: string;
      createdAt: string;
      user: { name: string } | null;
      botActor: { name: string } | null;
    }>;
  };
}

interface Page {
  data?: {
    issues: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      nodes: LinearIssue[];
    };
  };
  errors?: Array<{ message: string }>;
}

export function renderIssue(sourceId: string, issue: LinearIssue): WaymarkDoc {
  const creator = issue.creator?.name;
  const human = issue.comments.nodes.filter((c) => c.botActor === null && c.user !== null);
  const name = (c: (typeof human)[number]) => (c.user as { name: string }).name;
  const authors = [...new Set([...(creator ? [creator] : []), ...human.map(name)])];
  const sections = [
    `${issue.identifier} · ${issue.state.name} · @${creator ?? 'unknown'}`,
    issue.description?.trim() || '_No description._',
  ];
  if (human.length > 0) {
    const lines = human.map((c) => {
      const body = indent(c.body, '  ');
      return `- **${name(c)}** (${day(c.createdAt)})${body ? `: ${body}` : ''}`;
    });
    sections.push(`## Conversation\n\n${lines.join('\n')}`);
  }
  return {
    id: makeId(sourceId, 'issue', issue.identifier),
    kind: 'issue',
    sourceId,
    title: issue.title,
    url: issue.url,
    authors,
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    tags: [
      `state:${issue.state.type}`,
      ...issue.labels.nodes.map((l) => `label:${l.name}`),
      ...(issue.archivedAt ? ['archived'] : []),
    ],
    body: sections.join('\n\n'),
  };
}

export function linearConnector(source: LinearSource, deps: LinearAppDeps = {}): Connector {
  return async (ctx) => {
    let authorization: () => Promise<string>;
    if (source.auth === 'personal') {
      ctx.log(
        `warn: ${source.id} uses a personal token; production must use the Waymark app identity (docs/adr/0002-own-identity.md)`,
      );
      const key = envToken(
        source.id,
        ['LINEAR_API_KEY'],
        'Create one at linear.app → Settings → Security & access → Personal API keys.',
      );
      authorization = async () => key; // personal API keys take no Bearer prefix
    } else {
      const provider = linearAppTokenProvider(source.id, deps);
      authorization = async () => `Bearer ${await provider.getToken()}`;
    }

    const filter: Record<string, unknown> = {};
    if (ctx.cursor !== null) filter.updatedAt = { gt: ctx.cursor };
    if (source.team !== undefined) filter.team = { key: { eq: source.team } };

    let newest = ctx.cursor;
    let count = 0;
    let after: string | null = null;
    for (;;) {
      const page: Page = await fetchJson<Page>(API, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: await authorization() },
        body: JSON.stringify({ query: QUERY, variables: { after, filter } }),
        ...(deps.fetch ? { fetchImpl: deps.fetch } : {}),
      });
      if (page.errors?.length) throw new Error(`Linear: ${page.errors[0]?.message}`);
      const issues = page.data?.issues;
      if (!issues) throw new Error('Linear: response had no data');
      for (const issue of issues.nodes) {
        if (issue.comments.nodes.length >= COMMENTS_PER_ISSUE) {
          ctx.log(
            `${issue.identifier}: comment page full, only the first ${COMMENTS_PER_ISSUE} ingested`,
          );
        }
        await ctx.emit(renderIssue(ctx.sourceId, issue));
        count++;
        if (newest === null || issue.updatedAt > newest) newest = issue.updatedAt;
      }
      if (!issues.pageInfo.hasNextPage || !issues.pageInfo.endCursor) break;
      after = issues.pageInfo.endCursor;
    }
    return { cursor: newest, count };
  };
}
