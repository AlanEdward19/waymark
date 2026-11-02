# ADR-0003: Team server model: users, groups, linked identities and API tokens

- Status: Accepted
- Date: 2026-11-02

## Context

Waymark today is single-user: whoever can read `$WAYMARK_HOME` sees everything, and the only
transport is stdio. To serve a team from one server (epic #18) and answer in chat (epic #19),
Waymark must know **who is asking**. This ADR records the model; the account store and its admin CLI
ship with it. Nothing is served over the network yet (#95).

## Decision

1. **Trust boundary.** The local CLI and the stdio MCP server run as the **owner**: full access, no
   token. Anyone who can read `$WAYMARK_HOME` is an owner. Network access (#95) always requires a
   user identity.
2. **Accounts are state, not cache.** They live in `$WAYMARK_HOME/auth/auth.db` (SQLite, WAL),
   separate from `db/`. `db/` is a rebuildable cache; accounts are not, so `reindex` and deleting
   `db/` never touch `auth/`, and `auth/` must be backed up. The directory is created with mode
   `0o700` and the file with `0o600` on POSIX systems. On Windows protection relies on the inherited
   NTFS ACLs, so keep `WAYMARK_HOME` in a user-private directory.
3. **Users.** `name` (`^[a-z0-9][a-z0-9._-]{0,62}$`, unique), `displayName`, `role` (`admin` |
   `member`), `groups` (same regex as `name`), `disabled`, `createdAt`. No e-mails, no passwords.
4. **Linked identities.** `(provider, externalId) → user`, unique per provider and id. Providers:
   `github` (login, case-insensitive), `slack` (`U…`/`W…` id), `teams` (Entra object id GUID),
   `discord` (snowflake), `linear` (user UUID), `oidc` (`<issuer>|<subject>`). A user has at most
   one identity per provider.
5. **API tokens.** Format `wmk_` + 32 random bytes base64url (43 chars). Only the SHA-256 of the
   token is stored, with `id` (`tok_` + 16 hex), user, label, `createdAt`, optional `expiresAt`,
   `lastUsedAt` and `revokedAt`. The plaintext is printed once. Verification hashes the presented token
   before the lookup, so timing reveals nothing about the secret (comparing the hashes with
   `timingSafeEqual` is defence in depth), and returns the user and token id, or a reason (`invalid`, `expired`, `revoked`,
   `disabled`). Disabling a user stops their tokens immediately. `lastUsedAt` is updated at most
   once per minute per token. `wmk_` tokens are also a redaction rule (`waymark-token`), so one
   pasted into a note never reaches the wiki.
6. **Authorization model** (implemented later): groups grant access to sources (#97); optionally
   the origin system decides (#99).
7. **Alternatives considered.** Only OAuth/SSO: too heavy for small self-hosted teams, added later
   as #100. Users in `config.json`: mixes secrets-adjacent state with config and lets token hashes
   be edited by hand. Tables inside `db/`: that file is a rebuildable cache that `reindex` and a manual
   delete may recreate, so accounts there would be lost. A slow KDF (bcrypt, argon2) for tokens:
   those protect low-entropy passwords; tokens are 256 random bits, which cannot be brute-forced,
   and a fast hash keeps per-request verification cheap.
8. **Failure reasons are for operators.** The detailed verification reasons (`expired`, `revoked`,
   `disabled`) are for logs and audit only; the server (#95) answers every failure with a generic
   401.

## Consequences

- Admins manage accounts with `waymark user` and `waymark token` (local, owner only); see
  [docs/server.md](../server.md).
- Backups must include `auth/auth.db`; losing it loses all users and tokens. Under WAL, copy the
  whole `auth/` directory while Waymark is stopped, or use `sqlite3 auth.db ".backup <file>"`.
- Tokens are bearer secrets: transport them in headers or the environment, never in URLs, and
  revoke on suspected misuse.
- Later issues build on this: network serving (#95), audit (#94), access enforcement (#97),
  origin-aware scoping (#99), SSO (#100), and the chat bots of epic #19 (via linked identities).
