# Waymark

> Open-source, self-hosted **context layer** for software teams and their AI coding agents.

Waymark answers "why is it built this way, who knows about it, and what did we already try?" by combining
what lives in your code, issues, docs and conversations with what your agents learn while working.
Agents (and humans) get one reconciled, source-linked answer instead of ten tabs of search results.

**Status:** v0.1 MVP plus agent integrations: git + GitHub (PRs, reviews, issues) ingest into a git-versioned markdown wiki, SQLite FTS5 search with optional semantic (embeddings) search, MCP server, session capture hooks for Claude Code, Cursor and Hermes Agent, and handoffs between agent sessions. Local and single-user; no auth yet.

## Quickstart

Node 24 required. The package is not on npm yet.

```bash
git clone https://github.com/AlanEdward19/waymark && cd waymark
npm ci && npm run build && npm link
waymark init
# edit ~/.waymark/config.json (see Configuration)
GITHUB_TOKEN=$(gh auth token) waymark sync
waymark search "why sqlite"
```

## Documentation

- [docs/search.md](docs/search.md): how search ranks results and how to enable optional semantic search.
- [docs/mcp.md](docs/mcp.md): MCP server (`waymark mcp`) tools and client setup.
- [docs/claude-code.md](docs/claude-code.md): Claude Code integration via MCP and lifecycle hooks.
- [docs/cursor.md](docs/cursor.md): Cursor integration via MCP and lifecycle hooks.
- [docs/hermes.md](docs/hermes.md): Hermes Agent integration via MCP and shell hooks.
- [docs/docker.md](docs/docker.md): run the CLI from the Docker image with a `/data` volume.
- [docs/adr/0001-stack.md](docs/adr/0001-stack.md): ADR-0001, TypeScript on Node.js 24.
- [docs/adr/0002-own-identity.md](docs/adr/0002-own-identity.md): ADR-0002, Waymark uses its own identity at every source.
- [docs/identities.md](docs/identities.md): create the Waymark app identity per source (GitHub App first).

## Why

AI coding agents are only as good as the context they receive. Team knowledge is scattered across
repos, PR reviews, issue trackers, chat and docs, and most of it is never written down. Existing solutions are
either closed SaaS products or narrowly focused on single-session agent memory. Waymark aims to be an open,
self-hostable project that covers both organizational knowledge and agent memory.

## Goals

- **Cross-source knowledge**: ingest code, git history, PRs and review comments, issues, docs and chat into one searchable knowledge graph.
- **Organizational memory**: extract unwritten conventions and decisions (for example from PR review feedback) and identify who has expertise in each area.
- **Agent memory**: capture agent sessions via hooks, consolidate them into readable pages, and hand work off between agents, tools and machines.
- **Source-linked answers**: every answer cites where it came from; conflicting sources are reconciled by recency, authority and proximity.
- **Permission-aware**: results are scoped at query time to what the asking user is allowed to see.
- **Agent-native delivery**: MCP server first, then CLI, HTTP API, and chat/web front-ends.
- **Bots where the team works**: Microsoft Teams, Slack, Discord, GitHub, Linear and more, via pluggable adapters.
- **Bring your own model or agent**: API keys for hosted/local models, plus keyless integration with agent tools such as Claude Code, Cursor and Hermes Agent through MCP, hooks and plugins.
- **Self-hosted, zero-LLM default**: capture, search and handoffs work without an API key; LLM and embeddings are optional upgrades.
- **Transparent storage**: markdown (git-versioned) is the source of truth; indexes are rebuildable.

## Non-goals

- Not a hosted SaaS (at least initially).
- Not a general-purpose chatbot or an agent framework; Waymark supplies context to agents, it does not replace them.
- No training on user data, ever.

## Roadmap

1. ✅ Feature survey and issue breakdown.
2. ✅ Architecture decisions: language/runtime, storage layout, plugin model for sources.
3. ✅ MVP: ingest a git repo + PRs, markdown store, FTS search, MCP server.

Open epics:

- [#15](https://github.com/AlanEdward19/waymark/issues/15) Hybrid retrieval (embeddings, RRF, recency)
- [#16](https://github.com/AlanEdward19/waymark/issues/16) Organisational memory (conventions, expertise, conflicts)
- [#17](https://github.com/AlanEdward19/waymark/issues/17) Agent harness integrations and handoffs
- [#18](https://github.com/AlanEdward19/waymark/issues/18) Permissions, auth and remote access
- [#19](https://github.com/AlanEdward19/waymark/issues/19) Chat bots (Teams, Slack, Discord, GitHub, Linear)
- [#20](https://github.com/AlanEdward19/waymark/issues/20) More source connectors

## Configuration

`waymark init` creates the data directory (`$WAYMARK_HOME`, default `~/.waymark`) with `config.json`, `wiki/` and `db/`. Example `config.json`:

```json
{
  "version": 1,
  "sources": [
    { "id": "waymark-git", "type": "git", "path": "C:/code/waymark" },
    { "id": "waymark-gh", "type": "github", "repo": "AlanEdward19/waymark", "auth": "personal" }
  ]
}
```

- `git` sources: `path` is absolute or relative to the folder of `config.json`; optional `maxCommits` limits each sync.
- `github` sources: `repo` is `owner/name`; optional `include` is `["pulls", "issues"]` (default both).
- Secrets never go in the config. Every source has `auth`: `app` (default, Waymark's own identity, see [docs/identities.md](docs/identities.md)) or `personal` (development only; GitHub then reads `GITHUB_TOKEN`, then `GH_TOKEN`).
- Optional `embeddings` (`url`, `model`) enables semantic search; see [docs/search.md](docs/search.md). Its API key comes from `WAYMARK_EMBED_API_KEY`.

Other commands: `waymark embed` embeds new or changed documents, `waymark sync --source <id>` syncs one source, `waymark show <id>` prints a document, `waymark reindex` rebuilds the search index from the wiki.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Early stage: open an issue to discuss ideas before sending a PR.

## License

[MIT](LICENSE)
