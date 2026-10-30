# MCP server

`waymark mcp` runs an MCP server over stdio. Any MCP client (Claude Code, Cursor, Hermes Agent) can then search the knowledge base and save notes. Run `waymark init` first.

Tools:

| Tool           | What it does                                                                                                        |
| -------------- | ------------------------------------------------------------------------------------------------------------------- |
| `search`       | Ranked search over commits, pull requests, issues, notes and sessions. Optional `kinds`, `sources`, `limit` (1-50). |
| `get_document` | Full markdown of one document by id (ids come from `search`).                                                       |
| `save_note`    | Save a durable note (`title`, `body`, optional `tags`) as `agent/note/...`. Secrets are redacted.                   |

`waymark` must be on your `PATH` (`npm link` in the repo for now). To use a non-default data directory, set `WAYMARK_HOME` through the client's `env` setting.

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
