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

export interface GithubApi {
  pullPages(owner: string, repo: string): AsyncIterable<GhPull[]>; // sorted by updated desc
  reviews(owner: string, repo: string, n: number): Promise<GhReview[]>;
  reviewComments(owner: string, repo: string, n: number): Promise<GhReviewComment[]>;
  issueComments(owner: string, repo: string, n: number): Promise<GhIssueComment[]>;
}
