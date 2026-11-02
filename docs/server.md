# Waymark team server

Waymark is growing from a single-user tool into a server a team shares
([ADR-0003](adr/0003-team-server.md)). Serving over the network comes later (#95); this page
covers the account model that exists today.

## Users and tokens

The local CLI and the stdio MCP server run as the **owner**: no token, full access. Anyone who can
read `$WAYMARK_HOME` is an owner. Accounts are for network access and live in
`$WAYMARK_HOME/auth/auth.db`. Unlike `db/`, this is **not a cache**: `reindex` never touches it and
it must be backed up.

```bash
waymark user add alice --display "Alice Souza" --group backend
waymark user add root --admin
waymark user update alice --group backend --group oncall   # --group replaces the list
waymark user update alice --disable                        # tokens stop working immediately
waymark user link alice github alice-s
waymark user link alice slack U01ABC23DEF
waymark user unlink alice slack
waymark user list [--json]

waymark token create alice --label laptop --expires 90     # prints the token on stdout, once
waymark token list [--user alice] [--json]
waymark token revoke tok_1a2b3c4d
```

- Names and groups match `^[a-z0-9][a-z0-9._-]{0,62}$`. There are no e-mails or passwords.
- Linkable providers: `github` (login, case-insensitive), `slack` (`U…`/`W…`), `teams` (Entra
  object id), `discord` (snowflake), `linear` (user UUID), `oidc` (`<issuer>|<subject>`). An
  identity belongs to one user; a user has one identity per provider.
- Tokens look like `wmk_` plus 43 characters. Only their SHA-256 is stored, so a lost token cannot
  be recovered: revoke it and create another. Send them in an `Authorization` header or an
  environment variable, never in a URL.
- Secrets pasted into notes are redacted, including `wmk_` tokens.
