# Security

## Supported Versions

Security fixes target the latest published version.

## Reporting A Vulnerability

Please do not open a public issue for a security report.

Email the maintainer or use GitHub private vulnerability reporting when it is enabled for the repository.

Include:

- Affected version or commit.
- Reproduction steps.
- Impact and whether credentials, local files, or model-provider traffic are exposed.

## Notes For Users

`agent-skills-eval` reads local skill files and sends prompts, selected file contents, and optional tool definitions to the configured model provider. Review skills and eval files before running them against sensitive workspaces or private data.
