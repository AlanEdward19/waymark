# Docker

The image runs the `waymark` CLI as the non-root `node` user (uid 1000). All state lives in the `/data` volume (`WAYMARK_HOME=/data`).

```bash
docker build -t waymark .
```

## Init and sync

```bash
docker run --rm -v waymark:/data waymark init
```

Edit `config.json` in the volume and add a git source that points at the mount path:

```json
{ "version": 1, "sources": [{ "id": "myrepo", "type": "git", "path": "/repos/myrepo" }] }
```

Mount the repository read-only and sync:

```bash
docker run --rm -v waymark:/data -v /path/to/repo:/repos/myrepo:ro waymark sync
```

The mount is owned by another uid, so the image sets `safe.directory=*` through `GIT_CONFIG_*` env vars to avoid git's "dubious ownership" error. Run `sync` on a schedule with cron or a Kubernetes CronJob against the same volume.

GitHub sources need a token from the environment, e.g. `-e GITHUB_TOKEN`.

## MCP server

```bash
docker run -i --rm -v waymark:/data waymark mcp
```
