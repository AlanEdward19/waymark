# Agent guide

- Stack: TypeScript (strict, ESM, nodenext), Node >= 24, npm. See docs/adr/0001-stack.md.
- Verify before you say done: `npm run check` (biome + tsc + vitest) must pass.
- Layout: `src/` code, `test/` vitest tests (`*.test.ts`), `docs/adr/` decisions.
- stdout is reserved for command output, MCP protocol and hook responses. Log only to stderr.
- Errors: throw `Error` with an actionable message; `src/cli.ts` prints `error: <message>` to stderr and exits 1.
- Tests: no network, no real tokens, synthetic fixtures only. Use a temp dir from `fs.mkdtemp(path.join(os.tmpdir(), 'waymark-'))` and remove it in `afterEach`.
- External services are injected as function parameters so tests can pass fakes.
- Dates are ISO 8601 UTC strings (`new Date().toISOString()`).
- Paths: build with `node:path`; document ids always use `/`.
- Dependencies: prefer Node stdlib; any new runtime dependency must be named in the issue.
- Commits: Conventional Commits (`feat:`, `fix:`, `docs:`, `test:`, `chore:`).
