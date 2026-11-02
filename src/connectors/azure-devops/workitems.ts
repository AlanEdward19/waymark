import { makeId, type WaymarkDoc } from '../../store/doc.js';
import { day, indent } from '../github/conversation.js';
import { htmlToMarkdown } from '../html.js';
import type { SyncContext } from '../types.js';
import type { AdoComment, AdoIdentity, AdoWorkItem, AzureDevOpsApi } from './api.js';

const BATCH = 200;
const WIQL_LIMIT = 20_000;

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
// only the display name: uniqueName is an e-mail address
const name = (v: unknown): string => str((v as AdoIdentity | undefined)?.displayName).trim();
const md = (html: unknown): string => htmlToMarkdown(str(html)).trim();

export function renderWorkItem(
  sourceId: string,
  organization: string,
  project: string,
  item: AdoWorkItem,
  comments: AdoComment[],
): WaymarkDoc {
  const f = item.fields;
  const type = str(f['System.WorkItemType']);
  const state = str(f['System.State']);
  const creator = name(f['System.CreatedBy']);
  const commenters = comments.filter((c) => md(c.text) !== '');
  const commenter = (c: AdoComment) => name(c.createdBy) || 'unknown';
  const authors = [
    ...new Set(
      [...(creator ? [creator] : []), ...commenters.map(commenter)].filter((a) => a !== 'unknown'),
    ),
  ];
  const tags = str(f['System.Tags'])
    .split(';')
    .map((t) => t.trim())
    .filter(Boolean);

  const sections = [
    `#${item.id} · ${type} · ${state} · @${creator || 'unknown'}`,
    md(f['System.Description']) || '_No description._',
  ];
  const criteria = md(f['Microsoft.VSTS.Common.AcceptanceCriteria']);
  if (criteria) sections.push(`## Acceptance criteria\n\n${criteria}`);
  const repro = md(f['Microsoft.VSTS.TCM.ReproSteps']);
  if (repro) sections.push(`## Repro steps\n\n${repro}`);
  if (commenters.length > 0) {
    const lines = commenters.map(
      (c) => `- **${commenter(c)}** (${day(c.createdDate)}): ${indent(md(c.text), '  ')}`,
    );
    sections.push(`## Conversation\n\n${lines.join('\n')}`);
  }

  return {
    id: makeId(sourceId, 'issue', String(item.id)),
    kind: 'issue',
    sourceId,
    title: str(f['System.Title']),
    url: `https://dev.azure.com/${organization}/${encodeURIComponent(project)}/_workitems/edit/${item.id}`,
    authors,
    createdAt: str(f['System.CreatedDate']),
    updatedAt: str(f['System.ChangedDate']),
    tags: [`state:${state}`, `type:${type}`, ...tags.map((t) => `label:${t}`)],
    body: sections.join('\n\n'),
  };
}

export async function syncWorkItems(
  ctx: SyncContext,
  api: AzureDevOpsApi,
  organization: string,
  project: string,
  since: string | undefined,
): Promise<{ cursor: string | undefined; count: number }> {
  const where = since === undefined ? '' : ` AND [System.ChangedDate] > '${since}'`;
  const ids = await api.queryIds(
    `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project${where} ORDER BY [System.ChangedDate] ASC`,
  );
  if (ids.length >= WIQL_LIMIT) {
    ctx.log(`azure-devops: more than ${WIQL_LIMIT} changed work items; run sync again to continue`);
  }
  let newest = since;
  let count = 0;
  for (let i = 0; i < ids.length; i += BATCH) {
    for (const item of await api.getWorkItems(ids.slice(i, i + BATCH))) {
      const comments = await api.comments(item.id);
      await ctx.emit(renderWorkItem(ctx.sourceId, organization, project, item, comments));
      count++;
      const changed = str(item.fields['System.ChangedDate']);
      // ADO timestamps have variable fractional precision: compare as dates, not strings
      if (changed && (newest === undefined || Date.parse(changed) > Date.parse(newest))) {
        newest = changed;
      }
    }
  }
  return { cursor: newest, count };
}
