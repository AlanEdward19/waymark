# Cursor

Waymark gives Cursor agents start-up context and captures their sessions into the wiki.

## MCP

Add the Waymark MCP server to `.cursor/mcp.json`; see [docs/mcp.md](mcp.md) for the block.

## Hooks

Create `.cursor/hooks.json` (project) or `~/.cursor/hooks.json` (user):

```json
{
  "version": 1,
  "hooks": {
    "sessionStart": [{ "command": "waymark hook cursor" }],
    "preCompact": [{ "command": "waymark hook cursor" }],
    "sessionEnd": [{ "command": "waymark hook cursor" }]
  }
}
```

- `sessionStart` injects Waymark usage hints and recent notes as `additional_context`.
- `preCompact` and `sessionEnd` save the transcript as a `session` doc tagged `harness:cursor`; saving again updates the same doc.

## Notes

- Capture needs Cursor transcripts enabled: `transcript_path` is null otherwise and nothing is saved.
- Sub-agent transcripts are not captured.
- Transcripts are stored locally, after secret redaction. Other hook fields (`user_email`, `model`, ...) are never stored.
- The hook always exits 0, so it never breaks a Cursor session.
