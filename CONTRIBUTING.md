# Contributing to Waymark

Thanks for helping make Waymark better. This guide covers how to contribute and what we look for in a pull request.

By participating you agree to follow our [Code of Conduct](CODE_OF_CONDUCT.md).

## Ways to contribute

- **Report a bug** or **request a feature** with the [issue templates](https://github.com/AlanEdward19/waymark/issues/new/choose).
- **Pick up an issue.** Issues labelled [`good first issue`](https://github.com/AlanEdward19/waymark/labels/good%20first%20issue) are small and well scoped; [`help wanted`](https://github.com/AlanEdward19/waymark/labels/help%20wanted) ones are bigger.
- **Build an adapter**: a source connector, a chat/bot front-end or an agent integration.
- **Improve the docs.**

For larger changes, please open an issue first so we can agree on the approach before you invest time in it.

## Development setup

Waymark is TypeScript on Node.js 24 LTS ([ADR-0001](docs/adr/0001-stack.md)).

1. Install [Node.js 24](https://nodejs.org/) (`.nvmrc` pins it for nvm/fnm users).
2. Install dependencies: `npm ci`
3. Run all checks (Biome lint/format, `tsc` build, Vitest tests): `npm run check`

`npm run format` fixes formatting. Coding agents: read [AGENTS.md](AGENTS.md).

## Branches and pull requests

1. Fork the repo and create a branch from `main`: `feat/…`, `fix/…`, `docs/…`, `chore/…`.
2. Never push to `main` directly; `main` is protected and changes land through pull requests.
3. Keep the change focused. Unrelated refactors make reviews slow.
4. Add or update tests for behaviour you change.
5. Run the same checks as CI before you push.
6. Fill in the pull request template and link the issue (`Closes #123`).

### Code style

- Match the style of the surrounding code.
- Keep dependencies to a minimum; discuss new ones in the issue first.
- Never commit secrets, API keys or real user data. Test fixtures must be synthetic.

### Commit messages

We use [Conventional Commits](https://www.conventionalcommits.org/): `feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`. Write the subject in the imperative ("add", not "added").

## Reporting security issues

Please don't open public issues for vulnerabilities. See [SECURITY.md](SECURITY.md).

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
