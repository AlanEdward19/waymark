import { Octokit } from '@octokit/rest';
import type { GithubApi } from './api.js';

export function mapGithubError(err: unknown, owner: string, repo: string): unknown {
  const e = err as {
    status?: number;
    response?: { headers?: Record<string, string | number | undefined> };
  };
  const headers = e?.response?.headers ?? {};
  if (
    (e?.status === 403 || e?.status === 429) &&
    String(headers['x-ratelimit-remaining']) === '0'
  ) {
    const reset = new Date(Number(headers['x-ratelimit-reset']) * 1000).toISOString();
    return new Error(`GitHub rate limit exceeded; resets at ${reset}`);
  }
  if (e?.status === 404) {
    return new Error(`GitHub repo ${owner}/${repo} not found or token lacks access`);
  }
  return err;
}

export function createGithubApi(token: string): GithubApi {
  const octokit = new Octokit({ auth: token, userAgent: 'waymark' });
  const wrap = async <T>(owner: string, repo: string, run: () => Promise<T>): Promise<T> => {
    try {
      return await run();
    } catch (err) {
      throw mapGithubError(err, owner, repo);
    }
  };
  return {
    async *pullPages(owner, repo) {
      try {
        const pages = octokit.paginate.iterator(octokit.rest.pulls.list, {
          owner,
          repo,
          state: 'all',
          sort: 'updated',
          direction: 'desc',
          per_page: 100,
        });
        for await (const page of pages) yield page.data as never;
      } catch (err) {
        throw mapGithubError(err, owner, repo);
      }
    },
    async *issuePages(owner, repo, since) {
      try {
        const pages = octokit.paginate.iterator(octokit.rest.issues.listForRepo, {
          owner,
          repo,
          state: 'all',
          sort: 'updated',
          direction: 'asc',
          per_page: 100,
          ...(since === undefined ? {} : { since }),
        });
        for await (const page of pages) yield page.data as never;
      } catch (err) {
        throw mapGithubError(err, owner, repo);
      }
    },
    reviews: (owner, repo, n) =>
      wrap(owner, repo, () =>
        octokit.paginate(octokit.rest.pulls.listReviews, {
          owner,
          repo,
          pull_number: n,
          per_page: 100,
        }),
      ) as never,
    reviewComments: (owner, repo, n) =>
      wrap(owner, repo, () =>
        octokit.paginate(octokit.rest.pulls.listReviewComments, {
          owner,
          repo,
          pull_number: n,
          per_page: 100,
        }),
      ) as never,
    issueComments: (owner, repo, n) =>
      wrap(owner, repo, () =>
        octokit.paginate(octokit.rest.issues.listComments, {
          owner,
          repo,
          issue_number: n,
          per_page: 100,
        }),
      ) as never,
  };
}
