# Claude Code

Waymark plugs into Claude Code in two ways: the MCP server (search and save notes) and lifecycle hooks (capture sessions, inject start-up context).

## MCP setup

See [mcp.md](mcp.md) to register the Waymark MCP server with Claude Code.

## Hooks

Add this to `.claude/settings.json` (project) or `~/.claude/settings.json` (user):

```json
{
  "hooks": {
    "SessionStart": [{ "hooks": [{ "type": "command", "command": "waymark hook claude-code" }] }],
    "PreCompact": [{ "hooks": [{ "type": "command", "command": "waymark hook claude-code" }] }],
    "Stop": [
      { "hooks": [{ "type": "command", "command": "waymark hook claude-code", "async": true }] }
    ],
    "SessionEnd": [{ "hooks": [{ "type": "command", "command": "waymark hook claude-code" }] }]
  }
}
```

- `SessionStart` adds a short block to the model context: how to use the Waymark MCP tools, the 5 most recently updated notes, and open handoffs for this project (the folder name of `cwd`).
- `Stop` (after every turn), `PreCompact` and `SessionEnd` save the session transcript as a `session` document (`agent/session/<session_id>`). Later events for the same session overwrite it with the fuller transcript. Keep `Stop`: an app that closes or archives a session may never send `SessionEnd`, and `async` keeps it from delaying your turn.
- Only what you and Claude wrote is kept: tool calls, sub-agent traffic, harness notifications and injected skill text are skipped; a single turn is clipped at 20,000 characters and the whole transcript at 200,000 (oldest turns dropped first).

Transcripts are stored locally in the wiki after secret redaction. If you do not want session capture, keep only the `SessionStart` entry.

The hook never breaks your session: it always exits 0, and does nothing if Waymark is not initialised (`waymark init`).
