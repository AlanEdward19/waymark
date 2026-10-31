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

Azure DevOps accepts Microsoft Entra tokens for application identities only (no PATs). Waymark
uses an Entra **service principal**, or a **managed identity** when it runs on Azure.

### Create the identity

1. Entra admin center, App registrations, New registration. Name it `Waymark`. Single tenant.
2. Prefer a **certificate**: Certificates & secrets, Certificates, upload the public `.cer`. Keep
   the private key and the certificate together in one PEM file. A client secret works but is the
   weakest option. On Azure, prefer a managed identity and create no secret at all.
3. In Azure DevOps, Organization settings, Users, Add users. Add the service principal by the
   **Object ID of its Enterprise application** (not the app registration's Object ID), with access
   level **Basic** (Azure Repos needs it), and put it in a group with read-only permissions on the
   projects Waymark should read.

### Environment variables

First match wins:

| Credential       | Variables                                                                               |
| ---------------- | --------------------------------------------------------------------------------------- |
| Certificate      | `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_CERTIFICATE_PATH` (PEM: key + cert) |
| Client secret    | `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`                             |
| Managed identity | `WAYMARK_USE_MANAGED_IDENTITY=1`, optional `AZURE_CLIENT_ID` (user-assigned)            |

Waymark requests the scope `https://app.vssps.visualstudio.com/.default`. Tokens are cached in
memory and renewed 5 minutes before they expire.

### Rotate

Upload a new certificate (or create a new secret), update the PEM file or env var, then delete the
old credential in the app registration.

## Microsoft Teams

Teams is read through Microsoft Graph (scope `https://graph.microsoft.com/.default`) with the same
Entra identity and the same environment variables as [Azure DevOps](#azure-devops). Reuse the
`Waymark` app registration and grant the Graph **application** permissions with admin consent
described in #67.

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

The identity is an internal integration named `Waymark`. Notion has no personal fallback:
`"auth": "personal"` is rejected (`notion sources only support auth: 'app'`).

### Create the integration

1. notion.so/profile/integrations, New integration, type **Internal**, name it `Waymark`.
2. Capabilities: **Read content** only. Disable insert, update and user information.
3. Copy the **Internal Integration Secret**.
4. On each page or teamspace to index: `...` menu, Connections, add `Waymark`. Waymark sees nothing else.

### Environment variables

| Variable       | Meaning                                |
| -------------- | -------------------------------------- |
| `NOTION_TOKEN` | Internal integration secret. Required. |

```json
{ "id": "waymark-notion", "type": "notion" }
```

### Rotate

Integration settings, Secrets, regenerate; update `NOTION_TOKEN`. Remove the connection from a page
to stop indexing it (the next sync does not delete docs already synced unless the page is trashed).

## Slack

See #66.

## Discord

See #58.
