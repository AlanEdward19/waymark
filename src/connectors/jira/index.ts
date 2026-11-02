import type { JiraSource } from '../../config.js';
import { makeId, type WaymarkDoc } from '../../store/doc.js';
import { type AdfNode, adfToMarkdown } from '../atlassian/adf.js';
import { atlassianBase, atlassianCloudId, atlassianTokenProvider } from '../auth/atlassian.js';
import { day, tail } from '../github/conversation.js';
import { envToken, fetchJson } from '../http.js';
import type { Connector } from '../types.js';

const FIELDS = [
  'summary',
  'description',
  'status',
  'labels',
  'issuetype',
  'reporter',
  'created',
  'updated',
  'comment',
];
const MAX_COMMENTS = 500;
const OVERLAP_MS = 24 * 60 * 60 * 1000; // covers any profile time zone; re-processing is idempotent

export interface JiraDeps {
  fetch?: typeof fetch;
  env?: NodeJS.ProcessEnv;
}

interface JiraComment {
  author?: { displayName?: string; accountType?: string } | null;
  body?: AdfNode | null;
  created: string;
}
interface JiraIssue {
  key: string;
  fields: {
    summary: string;
    description?: AdfNode | null;
    status: { name: string; statusCategory?: { key: string } };
    labels?: string[];
    issuetype: { name: string };
    reporter?: { displayName?: string } | null;
    created: string;
    updated: string;
    comment?: { comments: JiraComment[]; total: number };
  };
}
interface SearchPage {
  issues: JiraIssue[];
  nextPageToken?: string;
  isLast?: boolean;
}
interface CommentPage {
  comments: JiraComment[];
}

const iso = (s: string) => new Date(s).toISOString();
const jqlString = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

export function buildJql(source: JiraSource, cursor: string | null): string {
  const base = source.project !== undefined ? `project = ${jqlString(source.project)}` : source.jql;
  let jql = `(${base})`;
  if (cursor !== null) {
    const since = new Date(Date.parse(cursor) - OVERLAP_MS).toISOString();
    jql += ` AND updated >= "${since.slice(0, 10)} ${since.slice(11, 16)}"`;
  }
  return `${jql} ORDER BY updated ASC`;
}

export function renderIssue(
  sourceId: string,
  site: string,
  issue: JiraIssue,
  comments: JiraComment[],
): WaymarkDoc {
  const f = issue.fields;
  const reporter = f.reporter?.displayName;
  const human = comments.filter((c) => c.author?.accountType !== 'app');
  const commenters = human.map((c) => c.author?.displayName).filter((n): n is string => !!n);
  const sections = [
    `${issue.key} · ${f.issuetype.name} · ${f.status.name} · @${reporter ?? 'unknown'}`,
    adfToMarkdown(f.description) || '_No description._',
  ];
  const lines = human.map(
    (c) =>
      `- **${c.author?.displayName ?? 'unknown'}** (${day(iso(c.created))})${tail(adfToMarkdown(c.body), '  ')}`,
  );
  if (lines.length > 0) sections.push(`## Conversation\n\n${lines.join('\n')}`);
  const category = f.status.statusCategory?.key;
  return {
    id: makeId(sourceId, 'issue', issue.key),
    kind: 'issue',
    sourceId,
    title: f.summary,
    url: `https://${site}/browse/${issue.key}`,
    authors: [...new Set([...(reporter ? [reporter] : []), ...commenters])],
    createdAt: iso(f.created),
    updatedAt: iso(f.updated),
    tags: [
      ...(category ? [`state:${category}`] : []),
      `type:${f.issuetype.name}`,
      ...(f.labels ?? []).map((l) => `label:${l}`),
    ],
    body: sections.join('\n\n'),
  };
}

export function jiraConnector(source: JiraSource, deps: JiraDeps = {}): Connector {
  const fetchImpl = deps.fetch ?? fetch;
  const env = deps.env ?? process.env;
  return async (ctx) => {
    let base: () => Promise<string>;
    let authorization: () => Promise<string>;
    if (source.auth === 'personal') {
      ctx.log(
        `warn: ${source.id} uses a personal token; production must use the Waymark service account (docs/adr/0002-own-identity.md)`,
      );
      const email = envToken(source.id, ['JIRA_EMAIL'], 'Your Atlassian account e-mail.');
      const token = envToken(
        source.id,
        ['JIRA_API_TOKEN'],
        'Create one at id.atlassian.com → Security → API tokens.',
      );
      const basic = `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`;
      base = async () => `https://${source.site}`;
      authorization = async () => basic;
    } else {
      const provider = atlassianTokenProvider(env, fetchImpl);
      base = async () => atlassianBase('jira', await atlassianCloudId(source.site, fetchImpl));
      authorization = async () => `Bearer ${await provider.getToken()}`;
    }
    const call = async <T>(path: string, init: RequestInit = {}): Promise<T> =>
      fetchJson<T>(`${await base()}${path}`, {
        ...init,
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          authorization: await authorization(),
        },
        fetchImpl,
      });

    const jql = buildJql(source, ctx.cursor);
    let newest: string | null = ctx.cursor;
    let count = 0;
    let nextPageToken: string | undefined;
    for (;;) {
      const page = await call<SearchPage>('/rest/api/3/search/jql', {
        method: 'POST',
        body: JSON.stringify({ jql, maxResults: 100, fields: FIELDS, nextPageToken }),
      }).catch((err: Error) => {
        const status = /responded (400|404) /.exec(err.message)?.[1];
        if (status === undefined) throw err;
        throw new Error(
          `Source "${source.id}": Jira rejected the query (${status}). Check "project"/"jql" in config.json`,
        );
      });
      for (const issue of page.issues) {
        let comments = issue.fields.comment?.comments ?? [];
        const total = issue.fields.comment?.total ?? comments.length;
        if (total > comments.length) {
          comments = [];
          while (comments.length < Math.min(total, MAX_COMMENTS)) {
            const more = await call<CommentPage>(
              `/rest/api/3/issue/${encodeURIComponent(issue.key)}/comment?startAt=${comments.length}&maxResults=100`,
            );
            if (more.comments.length === 0) break;
            comments.push(...more.comments);
          }
          comments = comments.slice(0, MAX_COMMENTS);
        }
        if (total > MAX_COMMENTS) {
          ctx.log(`${issue.key}: ${total} comments, only the first ${MAX_COMMENTS} ingested`);
        }
        await ctx.emit(renderIssue(ctx.sourceId, source.site, issue, comments));
        count++;
        const updated = iso(issue.fields.updated);
        if (newest === null || updated > newest) newest = updated;
      }
      if (page.isLast || !page.nextPageToken) break;
      nextPageToken = page.nextPageToken;
    }
    return { cursor: newest, count };
  };
}
