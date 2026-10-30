export interface RedactRule {
  type: string;
  pattern: RegExp;
  group?: number;
}

export const RULES: readonly RedactRule[] = [
  {
    type: 'private-key',
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  },
  {
    type: 'github-token',
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{22,255})\b/g,
  },
  { type: 'anthropic-key', pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { type: 'openai-key', pattern: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g },
  { type: 'aws-access-key', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { type: 'slack-token', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  { type: 'google-api-key', pattern: /\bAIza[0-9A-Za-z_-]{35}/g },
  { type: 'stripe-key', pattern: /\b[rs]k_live_[A-Za-z0-9]{20,}/g },
  { type: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  {
    type: 'connection-string',
    pattern: /\b(?:AccountKey|SharedAccessKey|Password|Pwd)=([^;\s"']+)/gi,
    group: 1,
  },
  { type: 'bearer', pattern: /\b[Bb]earer\s+([A-Za-z0-9._~+/-]{20,}=*)/g, group: 1 },
  {
    type: 'assignment',
    pattern:
      /\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret)\b["']?\s*[:=]\s*["']?([^\s"'`,;]{8,})/gi,
    group: 1,
  },
];

const MARK = '[REDACTED:';

export function redact(text: string): string {
  let out = text;
  for (const rule of RULES) {
    const placeholder = `${MARK}${rule.type}]`;
    const { group } = rule;
    if (group === undefined) {
      out = out.replace(rule.pattern, placeholder);
      continue;
    }
    out = out.replace(rule.pattern, (match: string, ...args: unknown[]) => {
      const value = args[group - 1] as string;
      if (value.startsWith(MARK)) return match;
      // the value is the tail of the match for all current group rules
      const at = match.lastIndexOf(value);
      return match.slice(0, at) + placeholder + match.slice(at + value.length);
    });
  }
  return out;
}
