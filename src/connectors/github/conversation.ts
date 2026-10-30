import type { GhIssueComment, GhUser } from './api.js';

// true when the user is missing or a bot
export const isBot = (u: GhUser | null) =>
  u === null || u.type === 'Bot' || u.login.endsWith('[bot]');
export const day = (iso: string) => iso.slice(0, 10);
export const indent = (text: string, pad: string) => text.trim().replace(/\n/g, `\n${pad}`);

/** Human (non-bot) issue comments, in API order. */
export const humanIssueComments = (comments: GhIssueComment[]) =>
  comments.filter((c) => !isBot(c.user));

/** The "## Conversation" section for already-filtered comments, or null when empty. */
export function conversationSection(comments: GhIssueComment[]): string | null {
  if (comments.length === 0) return null;
  const lines = comments.map(
    (c) =>
      `- **@${(c.user as GhUser).login}** (${day(c.created_at)}): ${indent(c.body ?? '', '  ')}`,
  );
  return `## Conversation\n\n${lines.join('\n')}`;
}
