# Live smoke tests

Opt-in, **read-only** tests that sync real accounts with Waymark's own identity
([docs/identities.md](../docs/identities.md), [ADR-0002](../docs/adr/0002-own-identity.md)). They are
not part of `npm test` or `npm run check`, and CI never runs them. A test whose variables are missing
is **skipped**, never failed.

```bash
npm run test:live
```

Each connector test syncs one source twice into a temp `WAYMARK_HOME` and checks: no source error,
`count > 0`, the second run not larger than the first, every doc has the expected `kind`, a title, a
`url` on the source's host and the expected tags, and no credential value appears in the wiki, the db
or stderr. Tests print counts only. The Entra and Atlassian tests check the token and the cloud id
(there is no connector for them yet).

Set `LIVE_CONNECTORS` to a comma list (`git,github,linear,notion,discord,entra,atlassian`) to run only
some; unset or `all` runs every connector whose variables are present.

## Variables

| Connector                                | Required                                                                                                                              | Optional                                                         |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| git repo docs (`git`)                    | none (uses this repo)                                                                                                                 |                                                                  |
| GitHub App (`github`)                    | `LIVE_GITHUB_REPO` (`owner/name`), `WAYMARK_GITHUB_APP_ID`, `WAYMARK_GITHUB_APP_PRIVATE_KEY` or `WAYMARK_GITHUB_APP_PRIVATE_KEY_PATH` | `WAYMARK_GITHUB_INSTALLATION_ID`                                 |
| GitHub personal (`github`)               | `LIVE_GITHUB_REPO`, `GITHUB_TOKEN` or `GH_TOKEN`                                                                                      |                                                                  |
| Linear app (`linear`)                    | `WAYMARK_LINEAR_CLIENT_ID`, `WAYMARK_LINEAR_CLIENT_SECRET`                                                                            | `LIVE_LINEAR_TEAM` (team key)                                    |
| Linear personal (`linear`)               | `LINEAR_API_KEY`                                                                                                                      | `LIVE_LINEAR_TEAM`                                               |
| Notion (`notion`)                        | `NOTION_TOKEN`                                                                                                                        |                                                                  |
| Discord (`discord`)                      | `DISCORD_BOT_TOKEN`, `LIVE_DISCORD_CHANNEL` (channel id)                                                                              |                                                                  |
| Entra token (`entra`)                    | `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, and `AZURE_CLIENT_CERTIFICATE_PATH` or `AZURE_CLIENT_SECRET`                                    | `LIVE_ADO_ORG`, `LIVE_ADO_PROJECT` (read-only Azure DevOps call) |
| Atlassian token + cloud id (`atlassian`) | `WAYMARK_ATLASSIAN_CLIENT_ID`, `WAYMARK_ATLASSIAN_CLIENT_SECRET`, `LIVE_ATLASSIAN_SITE` (`acme.atlassian.net`)                        |                                                                  |

## GitHub Actions

`.github/workflows/live.yml` is manual (`workflow_dispatch`, input `connectors`) and runs in the `live`
environment. Put the secrets above in that environment's secrets and the `LIVE_*` targets in its
variables. The personal GitHub token is the secret `LIVE_GITHUB_PERSONAL_TOKEN` (exported as
`GITHUB_TOKEN` to the tests). The Entra managed-identity mode is not available on GitHub-hosted runners.
