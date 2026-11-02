/** Atlassian Document Format (Jira Cloud, Confluence) to markdown. Shared by the Jira and Confluence connectors. */
export interface AdfNode {
  type?: string;
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: Array<{ type: string; attrs?: Record<string, unknown> }>;
  content?: AdfNode[];
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const kids = (n: AdfNode) => n.content ?? [];
const inline = (n: AdfNode) => kids(n).map(render).join('');
const blocks = (n: AdfNode) => kids(n).map(render).join('\n\n');
const pad = (s: string, p: string) => s.replace(/\n/g, `\n${p}`);

function withMarks(n: AdfNode): string {
  let out = n.text ?? '';
  for (const m of n.marks ?? []) {
    if (m.type === 'strong') out = `**${out}**`;
    else if (m.type === 'em') out = `_${out}_`;
    else if (m.type === 'code') out = `\`${out}\``;
    else if (m.type === 'link') out = `[${out}](${str(m.attrs?.href)})`;
  }
  return out;
}

function list(n: AdfNode, marker: (i: number) => string): string {
  return kids(n)
    .map((item, i) => {
      const m = marker(i);
      return m + pad(kids(item).map(render).join('\n'), ' '.repeat(m.length));
    })
    .join('\n');
}

function table(n: AdfNode): string {
  return kids(n)
    .map((row) =>
      kids(row)
        .map((cell) =>
          kids(cell)
            .map(render)
            .join(' ')
            .replace(/\s*\n\s*/g, ' ')
            .trim(),
        )
        .join(' | '),
    )
    .join('\n');
}

function render(n: AdfNode): string {
  switch (n.type) {
    case 'text':
      return withMarks(n);
    case 'paragraph':
      return inline(n);
    case 'heading':
      return `${'#'.repeat(Math.min(6, Math.max(1, Number(n.attrs?.level) || 1)))} ${inline(n)}`;
    case 'bulletList':
      return list(n, () => '- ');
    case 'orderedList':
      return list(n, (i) => `${i + 1}. `);
    case 'codeBlock':
      return `\`\`\`${str(n.attrs?.language)}\n${inline(n)}\n\`\`\``;
    case 'blockquote':
      return `> ${pad(blocks(n), '> ')}`;
    case 'hardBreak':
      return '\n';
    case 'rule':
      return '---';
    case 'mention':
    case 'emoji':
      return str(n.attrs?.text);
    case 'inlineCard':
    case 'blockCard':
      return str(n.attrs?.url);
    case 'table':
      return table(n);
    default: // doc, panel, listItem, unknown: keep the content
      return blocks(n);
  }
}

export function adfToMarkdown(node: AdfNode | null | undefined): string {
  return node ? render(node).trim() : '';
}
