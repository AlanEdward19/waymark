# Waymark team server

Waymark is growing from a single-user tool into a server a team shares
([ADR-0003](adr/0003-team-server.md)). Serving over the network comes later (#95); this page
covers the account model that exists today.

## Users and tokens

The local CLI and the stdio MCP server run as the **owner**: no token, full access. Anyone who can
read `$WAYMARK_HOME` is an owner. Accounts are for network access and live in
`$WAYMARK_HOME/auth/auth.db`. Unlike `db/`, this is **not a cache**: `reindex` never touches it and
it must be backed up: copy the whole `auth/` directory while Waymark is stopped (the database runs
in WAL mode, so copying `auth.db` alone while it is open can lose data), or use
`sqlite3 auth.db ".backup <file>"`. The directory is created `0o700` and the file `0o600`; on Windows
protection relies on the inherited NTFS ACLs, so keep `WAYMARK_HOME` in a user-private directory.

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
waymark token revoke tok_1a2b3c4d5e6f7a8b
```

- Names and groups match `^[a-z0-9][a-z0-9._-]{0,62}$`. There are no e-mails or passwords.
- Linkable providers: `github` (login, case-insensitive), `slack` (`U…`/`W…`), `teams` (Entra
  object id), `discord` (snowflake), `linear` (user UUID), `oidc` (`<issuer>|<subject>`). An
  identity belongs to one user; a user has one identity per provider.
- Tokens look like `wmk_` plus 43 characters. Only their SHA-256 is stored, so a lost token cannot
  be recovered: revoke it and create another. Send them in an `Authorization` header or an
  environment variable, never in a URL.
- Secrets pasted into notes are redacted, including `wmk_` tokens.

## Audit log

Security events are appended to `$WAYMARK_HOME/audit/YYYY-MM.jsonl`, using the UTC month.
Each JSON line records `at` (ISO UTC), `event`, `outcome` (`ok`, `denied`, or `error`),
`user`, `via`, `object`, and event-specific `detail`. Network producers can also provide `ip`
and `tokenId`; token IDs identify credentials without exposing their secret values.
Local account changes use `user: owner` and `via: cli`. Listing accounts and local CLI
search/show do not create events. Network read/write producers are added with the network server.

```bash
waymark audit --since 7d --user alice
waymark audit --since 2026-11-01 --until 2026-12-01 --event user.created --event token.created
waymark audit --outcome denied --limit 50 --json
```

The reader selects overlapping monthly files, prints newest events first (100 by default),
and skips malformed lines with one stderr warning per affected file. `--json` emits JSON Lines;
text output includes the timestamp, event, outcome, user, channel, address and a compact summary.
ISO dates and timestamps with a timezone are accepted; date-only boundaries mean midnight UTC.

Query text is private by default: search events store `detail.queryChars` instead of the query.
To include redacted query text, add `"audit": { "queries": true }` to `config.json`.
Bot questions follow the same config switch. All event strings are redacted and control
characters escaped; producers must never include raw tokens, hashes, request bodies or document text.
Account events contain IDs and small metadata, never the generated token.

The writer only appends, creates directories with mode `0o700` and files with `0o600` where
supported, and completes the write before returning. On Windows, keep `WAYMARK_HOME` under
private NTFS ACLs. Audit logs are state, not an index cache: back them up with account state.
Waymark never expires or deletes logs; admins should set retention appropriate to their team,
archive old monthly files, and delete expired archives themselves. Query logging can retain
sensitive business information even after secret redaction.

```bash
# Which credentials were used, from where?
jq -c 'select(.tokenId != null) | {at,user,tokenId,ip,event}' "$WAYMARK_HOME"/audit/*.jsonl
# Who read a particular document?
jq -c 'select(.event == "document.read" and .object == "notes/note/design") | {at,user,via,ip}' "$WAYMARK_HOME"/audit/*.jsonl
# Account changes from the local CLI
waymark audit --event user.created --event token.revoked --json | jq '{at,event,object}'
```
