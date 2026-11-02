export interface GhUser {
  login: string;
  type: string; // "Bot" for bots
}
export interface GhPull {
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  merged_at: string | null;
  created_at: string;
  updated_at: string;
  html_url: string;
  user: GhUser | null;
  labels: { name: string }[];
  base: { ref: string };
  head: { ref: string };
}
export interface GhIssue {
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  state_reason?: string | null;
  created_at: string;
  updated_at: string;
  html_url: string;
  user: GhUser | null;
  labels: Array<{ name: string } | string>;
  pull_request?: unknown;
}
export interface GhReview {
  id: number;
  user: GhUser | null;
  state: string;
  body: string | null;
  submitted_at: string | null;
  html_url: string;
}
export interface GhReviewComment {
  id: number;
  in_reply_to_id?: number;
  user: GhUser | null;
  body: string;
  path: string;
  line: number | null;
  original_line: number | null;
  diff_hunk: string;
  created_at: string;
  html_url: string;
}
export interface GhIssueComment {
  id: number;
  user: GhUser | null;
  body: string | null;
  created_at: string;
  html_url: string;
}

/** GitHub returns at most this many files per pull request. */
export const PULL_FILES_MAX = 3000;

export interface GhPullFile {
  filename: string;
  previous_filename?: string;
}

export interface GithubApi {
  pullPages(owner: string, repo: string): AsyncIterable<GhPull[]>; // sorted by updated desc
  issuePages(owner: string, repo: string, since?: string): AsyncIterable<GhIssue[]>; // sort=updated, direction=asc
  reviews(owner: string, repo: string, n: number): Promise<GhReview[]>;
  reviewComments(owner: string, repo: string, n: number): Promise<GhReviewComment[]>;
  pullFiles(owner: string, repo: string, n: number): Promise<GhPullFile[]>; // all pages, max 3000
  issueComments(owner: string, repo: string, n: number): Promise<GhIssueComment[]>;
}
