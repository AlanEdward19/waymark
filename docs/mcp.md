# MCP server

`waymark mcp` runs an MCP server over stdio. Any MCP client (Claude Code, Cursor, Hermes Agent) can then search the knowledge base and save notes. Run `waymark init` first.

Tools:

| Tool           | What it does                                                                                                                                                                                                  |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `search`       | Ranked keyword search (plus semantic search when embeddings are configured, see [search.md](search.md)) over commits, PRs, issues, notes, sessions and handoffs. Optional `kinds`, `sources`, `limit` (1-50). |
| `get_document` | Full markdown of one document by id (ids come from `search`).                                                                                                                                                 |
| `save_note`    | Save a durable note (`title`, `body`, optional `tags`) as `agent/note/...`. Secrets are redacted.                                                                                                             |

The handoff tools (`create_handoff`, `list_handoffs`, `claim_handoff`) are described under Handoffs below.

`waymark` must be on your `PATH` (`npm link` in the repo for now). To use a non-default data directory, set `WAYMARK_HOME` through the client's `env` setting.

## Handoffs

A handoff is a baton between agent sessions. The agent that stops early writes where it stopped and the next steps with `create_handoff` (stored as `agent/handoff/...`, tags `status:open` and `project:<name>`, optional `from:<harness>`). The next session sees the open handoffs for its project at start-up (the Claude Code hook uses the working directory's folder name as the project), or calls `list_handoffs`, and takes one with `claim_handoff`.

| Tool             | Arguments                                                     |
| ---------------- | ------------------------------------------------------------- |
| `create_handoff` | `title`, `summary`, `next_steps`, `project`, optional `from`. |
| `list_handoffs`  | Optional `project`. Lists open (unclaimed) handoffs.          |
| `claim_handoff`  | `id`. Returns the full text; fails if already claimed.        |

Each handoff is claimed exactly once: the claim is a conditional update in the SQLite index, so two agents on the same machine cannot both win (the loser gets `Handoff already claimed`). The claimed state is also written to the markdown file, so it survives a `reindex`. Cross-machine locking is out of scope.

## Claude Code

```bash
claude mcp add waymark -- waymark mcp
```

Or in `.mcp.json`:

```json
{
  "mcpServers": {
    "waymark": { "command": "waymark", "args": ["mcp"] }
  }
}
```

## Cursor

`.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "waymark": { "command": "waymark", "args": ["mcp"] }
  }
}
```

## Hermes Agent

`~/.hermes/config.yaml`:

```yaml
mcp_servers:
  waymark:
    command: waymark
    args: [mcp]
```

## Notes

- stdout carries only JSON-RPC; logs and errors go to stderr.
- If Waymark is not initialised, the server prints an error to stderr and exits 1.
