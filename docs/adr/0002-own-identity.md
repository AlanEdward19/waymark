# ADR-0002: Waymark uses its own identity at every source

- Status: Accepted
- Date: 2026-10-30

## Context

Waymark reads company systems (repos, trackers, wikis, chat) continuously. It must do so as its own
identity at every source, never with an employee's personal token:

- access is granted, scoped and revoked by admins for "Waymark", independently of any person;
- it survives people leaving the company;
- audit logs at the source show "Waymark" as the actor;
- permission-aware retrieval (#18) needs to know exactly what Waymark can see.

## Decision

Every connector authenticates as a Waymark-owned application identity. Personal tokens are accepted
**only** as an explicit development fallback: a source sets `"auth": "personal"` in `config.json`
(the default is `"app"`), and the connector logs a warning once per sync.

| Source                        | Waymark identity                                                                                                                  | Reference                                                                                                                                                                                                                                                                                             |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GitHub                        | GitHub App installed on the org/repos; installation access tokens (1 h) minted from a JWT signed with the app's private key       | [installation auth](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation), [JWT](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-json-web-token-jwt-for-a-github-app) |
| Azure DevOps, Microsoft Teams | Microsoft Entra service principal or managed identity (no PAT); added to the ADO org as a user with an access level               | [service principal](https://learn.microsoft.com/en-us/azure/devops/integrate/get-started/authentication/service-principal-managed-identity)                                                                                                                                                           |
| Jira, Confluence              | Atlassian service account with an OAuth 2.0 client-credentials credential; calls go to `api.atlassian.com/ex/{product}/{cloudId}` | [service account credential](https://support.atlassian.com/user-management/docs/create-oauth-2-0-credential-for-service-accounts/)                                                                                                                                                                    |
| Linear                        | OAuth app using the `client_credentials` grant, giving an app-actor token (30 days, public teams)                                 | [OAuth 2.0](https://linear.app/developers/oauth-2-0-authentication)                                                                                                                                                                                                                                   |
| Slack                         | Slack app installed in the workspace; bot token (`xoxb-`)                                                                         | [tokens](https://docs.slack.dev/authentication/tokens/)                                                                                                                                                                                                                                               |
| Discord                       | Bot user of a Discord application                                                                                                 | [authentication](https://docs.discord.com/developers/reference#authentication)                                                                                                                                                                                                                        |
| Notion                        | Internal integration (a bot user named after the integration)                                                                     | [authorization](https://developers.notion.com/docs/authorization)                                                                                                                                                                                                                                     |

### Naming

The identity is called `Waymark` or `Waymark (<environment>)` everywhere it is created, so source
audit logs read "Waymark".

### Least privilege

Read-only scopes only, and only the projects, spaces, channels or repos Waymark is configured to
read. Grant nothing it does not use.

### Secrets

Environment variables only, never `config.json` (the loader rejects `token` and `apiKey` keys).
Prefer certificates or managed identity over client secrets where the source supports them.

### Shared plumbing

`src/connectors/auth/index.ts` defines `TokenProvider` and `cachedToken` (a token is reused until
5 minutes before it expires). Each source adds a provider under `src/connectors/auth/`.

## GitHub

GitHub App, read-only permissions: Contents, Pull requests, Issues, Metadata. Waymark signs an RS256
JWT (`iat = now - 60 s`, `exp = now + 9 min`, `iss` = app id) with the app's private key, then
exchanges it for a 1 hour installation token with `POST /app/installations/{id}/access_tokens`. The
installation id comes from `WAYMARK_GITHUB_INSTALLATION_ID`, or is looked up with
`GET /repos/{owner}/{repo}/installation`. Setup steps are in [docs/identities.md](../identities.md#github).

## Consequences

- Existing GitHub sources without `auth` now default to `app` and fail until a GitHub App exists.
  The error says how to switch to `"auth": "personal"` for local testing.
- Each new connector must ship its app-identity provider and its section in `docs/identities.md`.
- No new dependencies: JWT signing uses `node:crypto`.
