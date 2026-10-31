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

## Jira and Confluence

One Atlassian Cloud service account serves both products. Requires the centralized user management
experience ([service accounts](https://support.atlassian.com/user-management/docs/understand-service-accounts/)).

### Create the service account

1. admin.atlassian.com, Directory, Service accounts, create one named `Waymark`.
2. Give it product access (Jira, Confluence) to the configured projects and spaces only.
3. Create an **OAuth 2.0 credential** for it
   ([how](https://support.atlassian.com/user-management/docs/create-oauth-2-0-credential-for-service-accounts/))
   with read scopes only: `read:jira-work` (Jira); `read:page:confluence`, `read:space:confluence`
   (Confluence).
4. Note the client id and secret and set the variables below.

### Environment variables

| Variable                          | Meaning                                       |
| --------------------------------- | --------------------------------------------- |
| `WAYMARK_ATLASSIAN_CLIENT_ID`     | OAuth 2.0 credential client id. Required.     |
| `WAYMARK_ATLASSIAN_CLIENT_SECRET` | OAuth 2.0 credential client secret. Required. |

Waymark exchanges them at `https://auth.atlassian.com/oauth/token` (`client_credentials`, token valid
60 minutes, refreshed automatically), resolves the site's cloud id with
`GET https://<site>/_edge/tenant_info`, and calls
`https://api.atlassian.com/ex/jira/<cloudId>` or `https://api.atlassian.com/ex/confluence/<cloudId>`.

### Local testing with a personal token

`"auth": "personal"` uses your email plus an API token with Basic auth against
`https://<site>`. Development only; it logs a warning on every sync.

### Rotate

Create a new credential for the service account, update both variables, then delete the old
credential.

## Linear

See #55.

## Notion

See #57.

## Slack

See #66.

## Discord

See #58.
