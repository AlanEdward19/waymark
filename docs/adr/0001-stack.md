# ADR-0001: TypeScript on Node.js 24 LTS

- Status: Accepted
- Date: 2026-10-30

## Context

Waymark needs an MCP server, a local full-text index, and adapters for many front-ends and sources:
Microsoft Teams, Slack, Discord, GitHub and Linear (see the README goals). The language should have
official, maintained SDKs for as many of these as possible, a reliable SQLite binding with FTS5, and
be easy for contributors and coding agents to work in.

## Decision

- **TypeScript** (strict, ESM, `nodenext`) on **Node.js 24 LTS**, a single npm package.
- **npm** as package manager, `package-lock.json` committed.
- **better-sqlite3** (FTS5) for the rebuildable index; markdown files are the source of truth.
- **MCP TypeScript SDK v2** (`@modelcontextprotocol/server` / `client`) for the MCP server.
- Tooling: `tsc` for builds, Vitest for tests, Biome for lint and formatting.

TypeScript is the only language with an official SDK for all of MCP (Tier 1), Teams, Slack, Discord
(discord.js), Linear and GitHub (Octokit).

## Alternatives

- **C#/.NET**: Tier 1 MCP SDK and Teams SDK, but no official Slack Bolt or Linear SDK, and sqlite-vec has no NuGet package.
- **Rust**: Tier 1 MCP SDK and single static binary, but no official Teams, Slack or Linear SDKs.
- **Python**: Tier 1 MCP SDK, Teams SDK and sqlite-vec on pip, but no official Linear SDK (TypeScript only) and slower to ship as one self-contained tool.
- **`node:sqlite`** instead of better-sqlite3: still release candidate, and on Node 22.14 FTS5 is missing (`no such module: fts5`).

## Consequences

- Distribution is npm and Docker. No single static binary for now.
- better-sqlite3 is a native module; it ships prebuilt binaries for common platforms, otherwise it needs a C/C++ toolchain to build.
- The npm name `waymark` is taken, so the package stays `"private": true` until a publishable name is chosen.
- Requires Node.js >= 24 (Active LTS).

## Evidence

| Claim                                                                                                                                                                                | Source                                                                                              |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| TypeScript, Python, C#, Go, Rust MCP SDKs are Tier 1                                                                                                                                 | https://modelcontextprotocol.io/docs/sdk                                                            |
| MCP TS SDK v2 is the stable line: `@modelcontextprotocol/server` / `client` (v2.4.0, Oct 2026); v1 only gets fixes for 6 months after 2026-07-27                                     | https://github.com/modelcontextprotocol/typescript-sdk                                              |
| Bot Framework SDK archived; Teams SDK (C#, TS/JS, Python) is the replacement                                                                                                         | https://learn.microsoft.com/en-us/microsoftteams/platform/concepts/build-and-test/tool-sdk-overview |
| Slack Bolt has an official JS framework                                                                                                                                              | https://docs.slack.dev/tools/bolt-js/                                                               |
| Linear's official SDK is TypeScript (`@linear/sdk`)                                                                                                                                  | https://linear.app/developers/sdk                                                                   |
| sqlite-vec ships npm, pip, cargo, go, gem packages (no NuGet); pre-v1                                                                                                                | https://github.com/asg017/sqlite-vec                                                                |
| `node:sqlite` is still release candidate (stable since v25.7 RC); on Node 22.14 `CREATE VIRTUAL TABLE t USING fts5(x)` fails with `no such module: fts5` (tested locally 2026-10-30) | https://nodejs.org/api/sqlite.html                                                                  |
| better-sqlite3 13.0.3 (SQLite 3.53.4) has FTS5 and loads sqlite-vec 0.1.9 (tested locally 2026-10-30)                                                                                | https://github.com/WiseLibs/better-sqlite3                                                          |
| Node 24 is LTS; production should use Active/Maintenance LTS                                                                                                                         | https://nodejs.org/en/about/previous-releases                                                       |
| Reference architecture: markdown wiki as truth + rebuildable SQLite index                                                                                                            | https://github.com/akitaonrails/ai-memory                                                           |
