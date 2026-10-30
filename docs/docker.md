# Docker

The image (Alpine, one bundled JS file plus the two native modules; ~67 MB compressed) runs the `waymark` CLI as the non-root `node` user (uid 1000). All state lives in the `/data` volume (`WAYMARK_HOME=/data`). sqlite-vec is compiled for musl during the build from its pinned, checksum-verified release.

```bash
docker build -t waymark .
```

## Init and sync

```bash
docker run --rm -v waymark:/data waymark init
```

Write `config.json` into the volume with a git source that points at the mount path (the image has no editor, so use `node`):

```bash
docker run --rm -v waymark:/data --entrypoint node waymark -e "require('fs').writeFileSync('/data/config.json', JSON.stringify({ version: 1, sources: [{ id: 'myrepo', type: 'git', path: '/repos/myrepo' }] }))"
```

Or use a bind mount instead of a named volume (`-v /path/on/host/waymark:/data`) and edit `config.json` on the host.

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
