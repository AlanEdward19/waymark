# Waymark

> Open-source, self-hosted **context layer** for software teams and their AI coding agents.

Waymark answers "why is it built this way, who knows about it, and what did we already try?" by combining
what lives in your code, issues, docs and conversations with what your agents learn while working.
Agents (and humans) get one reconciled, source-linked answer instead of ten tabs of search results.

**Status:** early development. Project scaffold only (TypeScript on Node.js 24, see [ADR-0001](docs/adr/0001-stack.md)); the MVP is tracked in [#1](https://github.com/AlanEdward19/waymark/issues/1). See [Roadmap](#roadmap).

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

1. Feature survey and issue breakdown (next step).
2. Architecture decisions: language/runtime, storage layout, plugin model for sources.
3. MVP: ingest a git repo + PRs, markdown store, FTS search, MCP server.
4. Agent hooks, handoffs, more sources, permissions, front-ends.

## Configuration

`waymark init` creates the data directory (`$WAYMARK_HOME`, default `~/.waymark`) with `config.json`, `wiki/` and `db/`. Example `config.json`:

```json
{
  "version": 1,
  "sources": [
    { "id": "waymark-git", "type": "git", "path": "C:/code/waymark" },
    { "id": "waymark-gh", "type": "github", "repo": "AlanEdward19/waymark" }
  ]
}
```

Tokens never go in the config; they come from environment variables.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Early stage: open an issue to discuss ideas before sending a PR.

## License

[MIT](LICENSE)
