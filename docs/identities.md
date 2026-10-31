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

See #58.
