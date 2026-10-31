const NAMED: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  '#39': "'",
  nbsp: ' ',
};

function decode(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code =
        e[1] === 'x' || e[1] === 'X' ? Number.parseInt(e.slice(2), 16) : Number(e.slice(1));
      try {
        return code === 39 ? "'" : String.fromCodePoint(code);
      } catch {
        return m;
      }
    }
    return NAMED[e.toLowerCase()] ?? m;
  });
}

export function htmlToMarkdown(html: string): string {
  const blocks: string[] = [];
  let s = html
    .replace(/\r\n?/g, '\n')
    .replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_m, inner: string) => {
      const code = decode(inner.replace(/<[^>]*>/g, '')).replace(/^\n|\n$/g, '');
      blocks.push(`\n\`\`\`\n${code}\n\`\`\`\n`);
      return `E000${blocks.length - 1}E000`;
    });
  s = s
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|tr)\s*>/gi, '\n')
    .replace(/<\/?[uo]l\b[^>]*>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '- ')
    .replace(/<h([1-6])\b[^>]*>/gi, (_m, l: string) => `${'#'.repeat(Number(l))} `)
    .replace(
      /<a\b[^>]*?href\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/a\s*>/gi,
      (_m, a: string | undefined, b: string | undefined, t: string) => `[${t}](${a ?? b})`,
    )
    .replace(/<\/?code\b[^>]*>/gi, '`')
    .replace(/<\/?(strong|b)\b[^>]*>/gi, '**')
    .replace(/<\/?(em|i)\b[^>]*>/gi, '_')
    .replace(/<[^>]*>/g, '');
  s = decode(s).replace(/E000(\d+)E000/g, (_m, i: string) => blocks[Number(i)] ?? '');
  return s.replace(/\n{3,}/g, '\n\n').trim();
}
