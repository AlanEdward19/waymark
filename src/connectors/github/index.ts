import type { GithubSource } from '../../config.js';
import { makeId, type WaymarkDoc } from '../../store/doc.js';
import type { Connector, SyncContext } from '../types.js';
import type {
  GhIssueComment,
  GhPull,
  GhReview,
  GhReviewComment,
  GhUser,
  GithubApi,
} from './api.js';
import { createGithubApi } from './client.js';
import { conversationSection, day, humanIssueComments, isBot, lf, tail } from './conversation.js';
import { syncIssues } from './issues.js';

interface Cursor {
  pulls?: string;
  issues?: string;
}

function parseCursor(raw: string | null): Cursor {
  if (raw === null) return {};
  try {
    const v: unknown = JSON.parse(raw);
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Cursor) : {};
  } catch {
    return {};
  }
}

export function renderPull(
  sourceId: string,
  pr: GhPull,
  reviews: GhReview[],
  reviewComments: GhReviewComment[],
  issueComments: GhIssueComment[],
): WaymarkDoc {
  const state = pr.merged_at ? 'merged' : pr.state;
  const author = pr.user?.login ?? 'ghost';
  const login = (u: GhUser | null) => (u as GhUser).login;

  const humanReviews = reviews.filter(
    (r) => !isBot(r.user) && !(r.state === 'COMMENTED' && !r.body?.trim()),
  );
  const humanComments = reviewComments
    .filter((c) => !isBot(c.user))
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
  const humanConv = humanIssueComments(issueComments);

  const events = [
    ...reviews.flatMap((r) =>
      !isBot(r.user) && r.submitted_at ? [{ at: r.submitted_at, who: login(r.user) }] : [],
    ),
    ...humanComments.map((c) => ({ at: c.created_at, who: login(c.user) })),
    ...humanConv.map((c) => ({ at: c.created_at, who: login(c.user) })),
  ].sort((a, b) => a.at.localeCompare(b.at));
  const authors = [
    ...new Set([...(isBot(pr.user) ? [] : [login(pr.user)]), ...events.map((e) => e.who)]),
  ];

  const sections = [
    `#${pr.number} · ${state} · @${author} · ${pr.base.ref} ← ${pr.head.ref}`,
    pr.body?.trim() || '_No description._',
  ];

  if (humanReviews.length > 0) {
    const lines = humanReviews.map((r) => {
      const date = r.submitted_at ? ` (${day(r.submitted_at)})` : '';
      const text = lf(r.body ?? '')
        .trim()
        .replace(/\n/g, ' ');
      return `- **@${login(r.user)}** ${r.state}${date}${text ? `: ${text}` : ''}`;
    });
    sections.push(`## Reviews\n\n${lines.join('\n')}`);
  }

  if (humanComments.length > 0) {
    const byId = new Map(humanComments.map((c) => [c.id, c]));
    // walk up to the top-most human comment: replies to replies join the thread, and replies
    // whose parent was a bot comment become roots themselves
    const rootOf = (c: GhReviewComment): GhReviewComment => {
      let cur = c;
      const seen = new Set<number>();
      while (
        cur.in_reply_to_id !== undefined &&
        byId.has(cur.in_reply_to_id) &&
        !seen.has(cur.id)
      ) {
        seen.add(cur.id);
        cur = byId.get(cur.in_reply_to_id) as GhReviewComment;
      }
      return cur;
    };
    const roots = humanComments.filter((c) => rootOf(c) === c);
    const entry = (c: GhReviewComment, lead: string, pad: string) =>
      `${lead}- **@${login(c.user)}** (${day(c.created_at)})${tail(c.body, pad)}`;
    const threads = roots.map((root) => {
      const n = root.line ?? root.original_line;
      const heading = `### \`${root.path}\`${n === null ? '' : ` line ${n}`}`;
      const hunk = root.diff_hunk.split('\n').slice(-6).join('\n');
      const lines = [
        entry(root, '', '  '),
        ...humanComments
          .filter((c) => c !== root && rootOf(c) === root)
          .map((c) => entry(c, '  ', '    ')),
      ];
      return `${heading}\n\n\`\`\`diff\n${hunk}\n\`\`\`\n\n${lines.join('\n')}`;
    });
    sections.push(`## Review comments\n\n${threads.join('\n\n')}`);
  }

  const conv = conversationSection(humanConv);
  if (conv) sections.push(conv);

  return {
    id: makeId(sourceId, 'pull_request', String(pr.number)),
    kind: 'pull_request',
    sourceId,
    title: pr.title,
    url: pr.html_url,
    authors,
    createdAt: pr.created_at,
    updatedAt: pr.updated_at,
    tags: [`state:${state}`, ...pr.labels.map((l) => `label:${l.name}`)],
    body: sections.join('\n\n'),
  };
}

async function syncPulls(
  ctx: SyncContext,
  api: GithubApi,
  owner: string,
  repo: string,
  since: string | undefined,
): Promise<{ cursor: string | undefined; count: number }> {
  let newest = since;
  let count = 0;
  pages: for await (const page of api.pullPages(owner, repo)) {
    for (const pr of page) {
      if (since !== undefined && pr.updated_at < since) break pages;
      // ponytail: sequential is fine for MVP, parallelise with a small pool if sync is slow
      const reviews = await api.reviews(owner, repo, pr.number);
      const comments = await api.reviewComments(owner, repo, pr.number);
      const conv = await api.issueComments(owner, repo, pr.number);
      await ctx.emit(renderPull(ctx.sourceId, pr, reviews, comments, conv));
      count++;
      if (newest === undefined || pr.updated_at > newest) newest = pr.updated_at;
    }
  }
  return { cursor: newest, count };
}

function tokenFor(sourceId: string): string {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (!token) {
    throw new Error(
      `Source "${sourceId}": set GITHUB_TOKEN (or GH_TOKEN) to sync GitHub. Tip: GITHUB_TOKEN=$(gh auth token) waymark sync`,
    );
  }
  return token;
}

export function githubConnector(source: GithubSource, api?: GithubApi): Connector {
  return async (ctx) => {
    const client = api ?? createGithubApi(tokenFor(source.id));
    const [owner = '', repo = ''] = source.repo.split('/');
    const cursor = parseCursor(ctx.cursor);
    let count = 0;

    if (source.include.includes('pulls')) {
      const r = await syncPulls(ctx, client, owner, repo, cursor.pulls);
      count += r.count;
      if (r.cursor !== undefined) cursor.pulls = r.cursor;
    }
    if (source.include.includes('issues')) {
      const r = await syncIssues(ctx, client, owner, repo, cursor.issues);
      count += r.count;
      if (r.cursor !== undefined) cursor.issues = r.cursor;
    }

    return { cursor: JSON.stringify(cursor), count };
  };
}
