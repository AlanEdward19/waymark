import type { GhIssueComment, GhUser } from './api.js';

// true when the user is missing or a bot
export const isBot = (u: GhUser | null) =>
  u === null || u.type === 'Bot' || u.login.endsWith('[bot]');
export const day = (iso: string) => iso.slice(0, 10);
// GitHub bodies often use CRLF; a lone CR is a line break in CommonMark
export const lf = (text: string) => text.replace(/\r\n?/g, '\n');
export const indent = (text: string, pad: string) => lf(text).trim().replace(/\n/g, `\n${pad}`);
/** `: <body>` with continuation lines indented, or '' when the body is empty. */
export const tail = (text: string | null, pad: string) => {
  const body = indent(text ?? '', pad);
  return body ? `: ${body}` : '';
};

/** Human (non-bot) issue comments, in API order. */
export const humanIssueComments = (comments: GhIssueComment[]) =>
  comments.filter((c) => !isBot(c.user));

/** The "## Conversation" section for already-filtered comments, or null when empty. */
export function conversationSection(comments: GhIssueComment[]): string | null {
  if (comments.length === 0) return null;
  const lines = comments.map(
    (c) => `- **@${(c.user as GhUser).login}** (${day(c.created_at)})${tail(c.body, '  ')}`,
  );
  return `## Conversation\n\n${lines.join('\n')}`;
}
