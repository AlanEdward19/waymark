# Hermes Agent

## MCP

Hermes talks to Waymark as an MCP client. See [mcp.md](mcp.md) for the `mcp_servers` block.

## Hooks

`waymark hook hermes` handles two Hermes shell hooks:

- `pre_llm_call`: on the first turn of a session, injects Waymark start-up context into the user message (wrapped in `<waymark-context>` markers; stripped again before saving).
- `post_llm_call`: saves the conversation as a `session` doc (`agent/session/<session id>`, tags `harness:hermes` and `project:<cwd basename>`). The same doc is rewritten each turn with the full history. Secrets are redacted on write. `sender_id`, `model` and `platform` are never stored.

Add to `~/.hermes/config.yaml` (or `%LOCALAPPDATA%\hermes\config.yaml` on Windows installs):

```yaml
hooks:
  pre_llm_call:
    - command: "waymark hook hermes"
  post_llm_call:
    - command: "waymark hook hermes"
```

Hooks never break Hermes: the command always exits 0, and does nothing if `waymark init` has not been run.

### Consent

Hermes asks for approval once per `(event, command)` pair. For gateway or cron runs, which never prompt, set `hooks_auto_accept: true` or `HERMES_ACCEPT_HOOKS=1`.

### Windows

Hermes runs hooks without a shell, so the npm shim `waymark.cmd` is not found by `waymark`. Use the full command instead:

```yaml
hooks:
  pre_llm_call:
    - command: "node C:/path/to/waymark/dist/cli.js hook hermes"
  post_llm_call:
    - command: "node C:/path/to/waymark/dist/cli.js hook hermes"
```
