# Contributing

Thanks for improving `agent-skills-eval`.

## Development

```sh
npm ci
npm test
```

Useful commands:

```sh
npm run build
npm run typecheck
npm pack --dry-run
```

## Pull Requests

Before opening a PR:

- Keep changes focused.
- Add or update tests for evaluator behavior, config parsing, CLI behavior, or artifact output.
- Run `npm test`.
- Include docs updates when public behavior changes.

## Release Process

Releases are published from GitHub releases through `.github/workflows/publish.yml`.

Maintainers should:

1. Update `CHANGELOG.md`.
2. Bump `package.json`.
3. Push to `main`.
4. Create a GitHub release tag.
5. Ensure `NPM_TOKEN` is configured in repository secrets.
