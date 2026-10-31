# Waymark identities

Waymark reads every source as its own application identity, never as a person
([ADR-0002](adr/0002-own-identity.md)). One section per source: what to create, permissions, the
environment variables Waymark reads, and how to rotate. Name the identity `Waymark` or
`Waymark (<environment>)`.

Every source in `config.json` has `"auth": "app"` (default) or `"auth": "personal"`. `personal` is
a development fallback only and logs a warning on every sync.

## GitHub

### Create the GitHub App

1. Org settings, Developer settings, GitHub Apps, New GitHub App. Name it `Waymark`.
2. Disable webhooks. Repository permissions, all **read-only**: Contents, Pull requests, Issues,
   Metadata (Metadata is always on).
3. Create the app, note its **App ID**, then generate a **private key** (a `.pem` file).
4. Install the app on the org, selecting only the repositories Waymark should read.

### Environment variables

| Variable                              | Meaning                                                                              |
| ------------------------------------- | ------------------------------------------------------------------------------------ |
| `WAYMARK_GITHUB_APP_ID`               | App ID (or client ID). Required.                                                     |
| `WAYMARK_GITHUB_APP_PRIVATE_KEY`      | PEM content (`\n` escapes allowed). Required unless the path is set.                 |
| `WAYMARK_GITHUB_APP_PRIVATE_KEY_PATH` | Path to the `.pem` file. Alternative to the line above.                              |
| `WAYMARK_GITHUB_INSTALLATION_ID`      | Optional. Otherwise resolved per repo with `GET /repos/{owner}/{repo}/installation`. |

```json
{ "id": "waymark-gh", "type": "github", "repo": "AlanEdward19/waymark" }
```

### Local testing with a personal token

```json
{ "id": "waymark-gh", "type": "github", "repo": "AlanEdward19/waymark", "auth": "personal" }
```

This reads `GITHUB_TOKEN`, then `GH_TOKEN`, and logs `warn: ... uses a personal token`.

### Rotate

Generate a new private key in the app settings, update the env var or key file, then delete the old
key. Installation tokens expire after 1 hour on their own; Waymark never stores them.

## Azure DevOps

See #62 (Entra provider) and #53, #67.

## Microsoft Teams

See #62 and #67.

## Jira

See #63 (Atlassian provider) and #56.

## Confluence

See #63 and #64.

## Linear

See #55.

## Notion

See #57.

## Slack

See #66.

## Discord

Waymark reads Discord as a **bot user of a Discord application named `Waymark`**. `"auth":
"personal"` is rejected for Discord: user tokens are against Discord's terms.

### Create the bot

1. [discord.com/developers](https://discord.com/developers/applications), New Application, name it
   `Waymark`. Bot tab: reset and copy the **token**.
2. Bot tab, Privileged Gateway Intents: enable **Message Content**. Without it Discord returns
   empty `content` and Waymark logs `discord: empty message content — is the Message Content intent enabled?`.
3. Invite the bot (OAuth2 URL generator, scope `bot`) with only **View Channel** and **Read Message
   History**. It reads only the channels it can see, and Waymark indexes only the channels listed in
   the source config.
4. Channel ids: Discord settings, Advanced, Developer Mode, then right-click a channel, Copy Channel ID.

### Environment variables

| Variable            | Meaning              |
| ------------------- | -------------------- |
| `DISCORD_BOT_TOKEN` | Bot token. Required. |

```json
{ "id": "team-chat", "type": "discord", "channels": ["123456789012345678"], "backlogDays": 30 }
```

One `chat` doc per channel per UTC day. First sync reads back `backlogDays` (default 30, max 365);
later syncs read only messages after the saved cursor. Bots, system messages, DMs, threads,
attachments and embeds are not indexed.

### Rotate

Reset the token in the Bot tab, update `DISCORD_BOT_TOKEN`. The old token stops working at once.
