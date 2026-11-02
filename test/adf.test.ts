import { describe, expect, it } from 'vitest';
import { type AdfNode, adfToMarkdown } from '../src/connectors/atlassian/adf.js';

const t = (text: string, marks?: AdfNode['marks']): AdfNode => ({
  type: 'text',
  text,
  ...(marks ? { marks } : {}),
});
const p = (...content: AdfNode[]): AdfNode => ({ type: 'paragraph', content });
const doc = (...content: AdfNode[]): AdfNode => ({ type: 'doc', version: 1, content }) as AdfNode;

const cases: Array<[string, AdfNode | null | undefined, string]> = [
  ['null', null, ''],
  ['missing', undefined, ''],
  ['paragraphs', doc(p(t('a')), p(t('b'))), 'a\n\nb'],
  ['strong', doc(p(t('x', [{ type: 'strong' }]))), '**x**'],
  ['em', doc(p(t('x', [{ type: 'em' }]))), '_x_'],
  ['code mark', doc(p(t('x', [{ type: 'code' }]))), '`x`'],
  ['link', doc(p(t('t', [{ type: 'link', attrs: { href: 'https://e.x' } }]))), '[t](https://e.x)'],
  ['heading', doc({ type: 'heading', attrs: { level: 2 }, content: [t('H')] }), '## H'],
  [
    'bulletList',
    doc({
      type: 'bulletList',
      content: [
        { type: 'listItem', content: [p(t('a'))] },
        { type: 'listItem', content: [p(t('b'))] },
      ],
    }),
    '- a\n- b',
  ],
  [
    'orderedList',
    doc({
      type: 'orderedList',
      content: [
        { type: 'listItem', content: [p(t('a'))] },
        { type: 'listItem', content: [p(t('b'))] },
      ],
    }),
    '1. a\n2. b',
  ],
  [
    'nested lists',
    doc({
      type: 'bulletList',
      content: [
        {
          type: 'listItem',
          content: [
            p(t('a')),
            {
              type: 'orderedList',
              content: [
                { type: 'listItem', content: [p(t('a1'))] },
                { type: 'listItem', content: [p(t('a2'))] },
              ],
            },
          ],
        },
        { type: 'listItem', content: [p(t('b'))] },
      ],
    }),
    '- a\n  1. a1\n  2. a2\n- b',
  ],
  [
    'codeBlock',
    doc({ type: 'codeBlock', attrs: { language: 'ts' }, content: [t('let a;')] }),
    '```ts\nlet a;\n```',
  ],
  ['blockquote', doc({ type: 'blockquote', content: [p(t('q1')), p(t('q2'))] }), '> q1\n> \n> q2'],
  ['hardBreak', doc(p(t('a'), { type: 'hardBreak' }, t('b'))), 'a\nb'],
  ['rule', doc(p(t('a')), { type: 'rule' }, p(t('b'))), 'a\n\n---\n\nb'],
  ['mention', doc(p({ type: 'mention', attrs: { id: '1', text: '@Dana' } })), '@Dana'],
  ['emoji', doc(p({ type: 'emoji', attrs: { shortName: ':x:', text: '❌' } })), '❌'],
  ['inlineCard', doc(p({ type: 'inlineCard', attrs: { url: 'https://e.x/1' } })), 'https://e.x/1'],
  ['blockCard', doc({ type: 'blockCard', attrs: { url: 'https://e.x/2' } }), 'https://e.x/2'],
  ['panel', doc({ type: 'panel', attrs: { panelType: 'info' }, content: [p(t('note'))] }), 'note'],
  [
    'table',
    doc({
      type: 'table',
      content: [
        {
          type: 'tableRow',
          content: [
            { type: 'tableHeader', content: [p(t('A'))] },
            { type: 'tableHeader', content: [p(t('B'))] },
          ],
        },
        {
          type: 'tableRow',
          content: [
            { type: 'tableCell', content: [p(t('1'))] },
            { type: 'tableCell', content: [p(t('2'))] },
          ],
        },
      ],
    }),
    'A | B\n1 | 2',
  ],
  ['null child', { type: 'doc', content: [null, p(t('ok'))] } as unknown as AdfNode, 'ok'],
  [
    'pipe in cell',
    doc({
      type: 'table',
      content: [{ type: 'tableRow', content: [{ type: 'tableCell', content: [p(t('a|b'))] }] }],
    }),
    'a\\|b',
  ],
  ['unknown node recurses', doc({ type: 'mystery', content: [p(t('kept'))] }), 'kept'],
];

describe('adfToMarkdown', () => {
  it.each(cases)('%s', (_name, input, expected) => {
    expect(adfToMarkdown(input)).toBe(expected);
  });
});
