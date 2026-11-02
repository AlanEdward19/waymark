# Chat bots

Waymark can answer questions in Slack, Teams, Discord, GitHub and Linear. Every platform shares one
runtime: who is asking, may they ask, what may they see, how fast must the bot acknowledge, and how
it avoids loops and floods. Each platform only adds its transport (socket, webhook, interactions)
and its formatting. This page covers the shared part; each platform gets its own section when its
adapter lands.

## Architecture

There is one server process. `waymark serve` (#95) hosts MCP over HTTP and the bots configured in
`config.json`. Bots that need inbound webhooks register routes on the same server, always under
`/bots/<platform>/…`. Every incoming question goes through one pipeline:

```
platform event → ignore bots / own messages / empty text
               → acknowledge (inside the platform deadline)
               → platform user → Waymark user (linked identities)
               → policy (unlinked users) → rate limit
               → answer engine, scoped to that user (max 4 in flight)
               → reply (converted to the platform format) → audit
```

1. Events from bots, from the bot's own identity, and questions that are empty once the mention is
   removed are ignored. This stops reply loops between bots.
2. The adapter acknowledges at once, before any search or LLM work: a typing indicator, a reaction
   or a deferred response, whatever the platform needs. Platform deadlines (checked 2026-11-01):
   Slack Socket Mode events 3 s, Linear webhooks 5 s (agent activity 10 s), GitHub webhooks 10 s,
   and Discord Gateway messages have no deadline.
3. `(platform, user id)` is resolved to a Waymark user through linked identities. A disabled user
   counts as unlinked.
4. Unlinked users get `I can only answer people linked to a Waymark account. Ask an admin to run:
   waymark user link <name> <platform> <externalUserId>` unless `unlinkedUsers` is `public`.
5. Each Waymark user (or, under `public`, each platform user id) may ask `perUserPerMinute`
   questions in any 60 seconds. Over the limit the bot replies
   `You're asking too fast; try again in a minute.`
6. The answer engine runs scoped to the user (see [Policy](#policy)). At most 4 questions are
   answered at once per server; the rest wait in order. A question that waits more than 60 s gets
   the error reply.
7. The reply is neutral Markdown (bold, links, lists, inline code) that the adapter converts to the
   platform format, splitting or truncating to the platform's message limit.
8. Any error replies `Sorry, something went wrong answering this.` The details go to stderr only,
   never to the chat.

## Configuration

```json
{
  "bots": {
    "unlinkedUsers": "deny",
    "perUserPerMinute": 6,
    "slack": { … },
    "discord": { … }
  }
}
```

| Key | Default | Meaning |
| --- | --- | --- |
| `unlinkedUsers` | `deny` | `deny`: only linked users get answers. `public`: unlinked users get answers from sources with no `access` setting only, and never from agent notes, handoffs or sessions |
| `perUserPerMinute` | `6` | Questions per user in any 60 seconds (1-60) |
| `slack`, `teams`, `discord`, `github`, `linear` | absent | One section per bot, defined by that platform's adapter. An absent section means that bot is off; no `bots` key means no bots |

Bot secrets come from environment variables, like every other credential. A `token` or `apiKey` key
in a bot section is rejected.

## Identities per bot

Each bot is a separate app, named "Waymark Bot", apart from the read-only connector identities
([ADR-0002](adr/0002-own-identity.md)). Connectors only read; posting needs write scopes, so the bot
app gets write scopes only where it posts (for example GitHub Issues: write for replying in issues),
and the connector app keeps its read-only grant. A leaked bot credential can post as the bot but
cannot widen what the connectors read.

## Linking users

The bot answers people, not platform accounts. An admin links each person's platform id to their
Waymark user once ([users and tokens](server.md#users-and-tokens)):

```bash
waymark user add alice --group backend
waymark user link alice slack U01ABC23DEF
waymark user link alice github alice-s
```

An unlinked user who asks gets the exact command to send to an admin, with their platform id filled
in. Self-service linking is not supported yet.

## Policy

What an answer may draw on depends on who asks (the source-level rules of #97):

| Asker | Sees |
| --- | --- |
| Admin | everything |
| Linked member | sources with no `access`, sources whose `access.groups` include one of their groups, agent notes and handoffs; no agent sessions |
| Unlinked, under `public` | sources with no `access` only |

```json
{ "id": "security-jira", "type": "jira", "project": "SEC", "access": { "groups": ["security"] } }
```

## Rate limits

The limit is a sliding 60-second window per Waymark user, so linking two platform accounts to one
user shares one budget. Under `public` it is per platform user id. Over the limit the question is not
answered and is audited as `denied` with reason `rate_limited`.

## Audit

Every question that reaches step 3 writes one `bot.ask` line to `$WAYMARK_HOME/audit/YYYY-MM.jsonl`
(UTC month, append-only, `0o600`):

```json
{ "at": "2026-11-02T10:00:00.000Z", "event": "bot.ask", "outcome": "ok", "user": "alice", "via": "bot:slack", "object": null, "detail": { "questionChars": 16, "sources": 3, "usedLlm": false } }
```

- `outcome`: `ok`, `denied` (`reason`: `unlinked` or `rate_limited`) or `error` (`reason`:
  `exception` or `timeout`).
- `user` is `null` for unlinked askers; `detail.externalUserId` then holds the platform id, so an
  admin can link it.
- The question text is logged only when `"audit": { "queries": true }` is set; otherwise only its
  length is. All strings are redacted and control characters escaped.

## Privacy

- Answers come from the knowledge base. Treat it as untrusted text: a document can contain
  instructions aimed at the bot (OWASP LLM01). The answer engine only quotes and cites sources and
  never acts on them.
- A question in a public channel shows the answer to everyone in that channel, scoped to the asker's
  visibility, not the channel's. Ask about restricted sources in a direct message.
- The question and the source text go to the LLM endpoint when `llm` is configured (#101).

## Checking the setup: `waymark bot test`

```bash
waymark bot test slack --user U01ABC23DEF how do we deploy
```

This runs the full pipeline (linking, policy, rate limit, scoped answer, audit) with a console
adapter. It prints the reply as the platform would format it on stdout and the acknowledgement on
stderr, so you can check linking and access without the platform.

## Status

The runtime, the policy, the rate limits, the audit lines and `waymark bot test` are in place. Still
to land:

- `waymark serve` (#95) starts the configured bots and hosts their webhook routes.
- The answer engine (#101) adds the LLM path; until then answers list the best sources.
- The platform adapters: one issue each for Slack, Teams, Discord, GitHub and Linear.
