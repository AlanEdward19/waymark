# Organisational memory

## People

The same person shows up under different names depending on the source: the git author name (`Alan Oliveira`), the GitHub login (`AlanEdward19`), a Linear or Discord display name. Features that count people ("who knows this path", "seen from 2 reviewers") would count one person twice, or merge two people with the same display name. The optional `people` section of `config.json` maps aliases to one canonical name:

```json
{
  "version": 1,
  "sources": [],
  "people": [{ "name": "Alan Oliveira", "aliases": ["AlanEdward19", "alan.oliveira", "Alan O."] }]
}
```

- `name`: 1-100 characters. `aliases`: 1-50 strings of 1-100 characters.
- Matching is case-insensitive after trimming and stripping one leading `@` (so `@AlanEdward19` matches `AlanEdward19`). A name that is not listed stays as stored, minus a leading `@`.
- An alias listed under two different names fails the config load.
- **No e-mail addresses.** Waymark stores display names and logins only. A name or alias shaped like an e-mail (`@` followed later by a `.`) fails the config load.

`waymark people` lists every person name found in the `authors` of indexed documents, grouped by canonical name, with document counts per source id. Use it to find the aliases to add:

```
Alan Oliveira  (41 docs)
  aliases seen: AlanEdward19 (waymark-git 40, waymark-gh 1)
bob  (3 docs)
  aliases seen: bob (waymark-gh 3)
```

`waymark people --json` prints `[{ name, total, aliases: [{ alias, bySource: { <sourceId>: count } }] }]`. Names ending in `[bot]` are listed last under a `bots` heading. Expertise excludes bots; the people command lists them apart. Authors shaped like an e-mail address are never listed.

## LLM (optional)

Waymark works with zero API keys. Some features (phrasing convention candidates, chat bot answers) can use a text-generation model. They share one optional `llm` section in `config.json`, for any OpenAI-compatible chat completions endpoint, local or hosted. When it is absent those features fall back to their no-LLM behaviour.

Ollama (local):

```json
{ "llm": { "url": "http://localhost:11434/v1", "model": "llama3.1:8b" } }
```

OpenAI:

```json
{ "llm": { "url": "https://api.openai.com/v1", "model": "gpt-4o-mini", "maxTokens": 800 } }
```

- `url` and `model` are required. `maxTokens` (1-8192, default 800) is sent as `max_tokens`, the one parameter every compatible server documents. `timeoutMs` (1000-300000, default 60000).
- `temperature` (0-2) is optional and has no default: it is left out of requests unless you set it, which is the portable choice across providers.
- The API key comes only from the `WAYMARK_LLM_API_KEY` environment variable (sent as `Authorization: Bearer <key>`). `apiKey` or `token` inside `llm` fails the config load.
- When `WAYMARK_LLM_API_KEY` is set, `url` must be `https:`; plain `http:` is allowed only for `localhost`, `127.0.0.1` and `[::1]`, so the key is never sent in cleartext. Unknown keys inside `llm` fail the config load. Responses over 1 MB and redirects are rejected.
- Requests retry on 429 and 503 (honouring `Retry-After`). Errors never include the key, the request or the response body.
- Check the setup with `waymark llm test`: it prints `LLM ok: <model> at <host> replied "..." in <ms> ms`.

**Text sent to the endpoint is document text (already secret-redacted); use a local model to keep everything on your machine.**

## Path facts

Waymark indexes which repository paths each commit, pull request and repo doc touches, and who touched them (author, reviewer, review commenter). They live in the `path_facts` table of the index, which `waymark reindex` rebuilds from the wiki.

- GitHub pull request documents end with a `## Files` section (at most 1000 files). Fetching it costs one extra `pulls.listFiles` API call per 100 changed files of each synced pull request.
- Upgrading: the first run on an existing index derives facts from the documents already stored. Pull requests synced before the upgrade have no `## Files` section until they are updated on GitHub and re-synced, because sync is incremental.

## Expertise

`waymark experts <path> [--since <days>] [--limit <n>] [--source <id>]... [--json]` ranks people from indexed path facts, without an LLM. A file matches exactly; a directory matches whole path segments. A trailing `/` is ignored; `.` or an empty path queries the whole repository. Names use the `people` aliases above.

Each person's document and role count once, using its most recent activity even when a commit touches many matching files. Contributions decay with a 180-day half-life:

| Role             | Weight | Half-life |
| ---------------- | ------ | --------- |
| Commit author    | 1.0    | 180 days  |
| Review commenter | 0.8    | 180 days  |
| Reviewer         | 0.6    | 180 days  |
| PR author        | 0.5    | 180 days  |

Scores sum `weight × 0.5 ^ (ageDays / 180)` and ties use the most recent activity. Results default to 5 people (maximum 20), with counts and up to 3 recent distinct document ids per person. `--since` requires a positive integer number of days; `--source` can repeat. JSON contains `path`, `documents`, and `experts` with `name`, `score` (one decimal), `lastActive`, role `counts` and `evidence`.

Empty people and canonical names ending in `[bot]` are excluded. Sources and older synced documents without file lists contribute no expertise; sync supported git/GitHub sources with path facts first. Repo document path tags identify files but do not contribute person scores. The MCP `who_knows` tool returns the same explained text.

## Conflicts and supersession

The index derives document flags from content and rebuilds them on upsert, deletion and reindex. Stored source markdown stays unchanged. `waymark show` and MCP `get_document` prefix flagged documents with `> Note:` warnings.

| Signal                                                | Result                                                                                                        |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| ADR status begins with Superseded                     | `superseded`; resolves another ADR in the same source from its number or relative Markdown link when possible |
| ADR status begins with Deprecated or Rejected         | `deprecated`                                                                                                  |
| Commit contains `This reverts commit <40-hex sha>.`   | Target commit is `reverted` by that commit, even before the target is indexed                                 |
| Issue tagged `state:not_planned` or `state:duplicate` | `not_planned`                                                                                                 |
| Note tagged `supersedes:<note id>`                    | Target note is `superseded` by that note                                                                      |

ADR status matching accepts list items, bold text and case differences. Self-references are ignored; multiple flags can apply. Removing a reverting commit or replacing note also removes the flags it created. These flags do not yet change search ranking.

Pass `supersedes: ["agent/note/<old-id>"]` to MCP `save_note` to replace up to 10 notes. All targets must exist and be notes; validation completes before writing anything. The new note stores the supersession tags, and the old note's file is untouched.
