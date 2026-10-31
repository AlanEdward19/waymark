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

### Create the OAuth app

1. Linear, Settings, API, OAuth applications, New. Name it `Waymark`.
2. Enable **client credentials** for the app and note the **client ID** and **client secret**.
3. Waymark requests the `read` scope only. Always keep it the same: requesting different scopes
   revokes the app's existing tokens.

Waymark exchanges the credentials with `POST https://api.linear.app/oauth/token`
(`grant_type=client_credentials`, `scope=read`) for an app-actor token valid 30 days, cached and
renewed automatically.

The app token sees **public teams** only. To read a private team, grant the app access to it on the
app's details page in Linear.

| Variable                       | Meaning                        |
| ------------------------------ | ------------------------------ |
| `WAYMARK_LINEAR_CLIENT_ID`     | OAuth client ID. Required.     |
| `WAYMARK_LINEAR_CLIENT_SECRET` | OAuth client secret. Required. |

```json
{ "id": "waymark-linear", "type": "linear", "team": "ENG" }
```

`team` (the team key) is optional; without it every visible team is read.

### Local testing with a personal key

```json
{ "id": "waymark-linear", "type": "linear", "auth": "personal" }
```

This reads `LINEAR_API_KEY` (Linear, Settings, Security & access, Personal API keys), sent as
`Authorization: <key>` without `Bearer`, and logs `warn: ... uses a personal token`.

### Rotate

Create a new client secret in the app settings, update the env var, then revoke the old one.

## Notion

See #57.

## Slack

See #66.

## Discord

See #58.
