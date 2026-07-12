# Changelog

All notable changes to this project are documented here.

## 0.2.0

### Added

- **opencode run mode** (`--run-mode opencode`): route target/judge calls
  through a local `opencode` server via `@opencode-ai/sdk` instead of calling
  an OpenAI-compatible API directly. New flags: `--opencode-agent`,
  `--opencode-dir`, `--opencode-auto`/`--no-opencode-auto`,
  `--opencode-timeout`, `--opencode-judge-timeout` (and equivalent
  `opencode.*` YAML config keys). Skills are loaded natively via opencode's
  own `skill` tool by symlinking the skill directory into
  `.opencode/skills/<name>/` for `with_skill` runs, rather than being injected
  into the prompt.
- **claude-code run mode** (`--run-mode claude-code`): route target/judge
  calls through the `claude -p` non-interactive batch CLI instead of calling
  an OpenAI-compatible API directly. New flags: `--claude-code-agent`,
  `--claude-code-dir`, `--claude-code-auto`/`--no-claude-code-auto`,
  `--claude-code-timeout`, `--claude-code-judge-timeout`,
  `--claude-code-binary`, `--claude-code-allowed-tools`/
  `--claude-code-disallowed-tools` (and equivalent `claudeCode.*` YAML config
  keys). Skills are loaded natively by symlinking into
  `.claude/skills/<name>/`, mirroring the opencode provider's approach.
- HTML report: "skill picked up" / "skill not picked up" badge per run,
  derived from whether the skill's tool was actually invoked during that run.
- HTML report: a stacked/side-by-side layout toggle for comparing
  `with_skill`/`without_skill` runs.
- HTML report: runs are now tinted by mode (`with_skill` vs `without_skill`)
  for faster visual scanning, and the (identical) user prompt is deduplicated
  per eval instead of repeated per run.
- `scripts/render-report.mjs`: standalone script to re-render `report.html`
  from existing run artifacts without re-running evals.

### Changed

- HTML report markup/CSS reworked for readability and accessibility (e.g.
  `role="radiogroup"`/`aria-label` on the new layout switch).
- **Breaking type change**: `GradingJson.summary.pass_rate` and
  `EvaluateSkillsResult.skills[].passRate` are now `number | null`; `null` means no
  assertions were graded for that run/skill (previously reported as `1`, i.e. a
  zero-assertion skill silently showed up as 100% passing). Consumers doing unguarded
  arithmetic or `.toFixed()` on these fields need a null check.
- Fix the HTML report, skill summary sort order, and regression detection to treat a
  zero-assertion run as a distinct "no assertions" state instead of a false 100%/green
  result.
- Remove the unused `pluginName` field from `SkillRef` and the discovery-time
  `.claude-plugin/plugin.json` lookup that populated it. No shipped feature
  consumed this field; removing it also drops a per-skill filesystem walk on
  every `discoverSkills()` call. Breaking change for TypeScript consumers that
  reference `SkillRef["pluginName"]`.

## 0.1.1

- Improve npm package discoverability metadata.
- Add repository, homepage, bugs, funding, and expanded package keywords to the publish payload.
- Align package metadata with the GitHub repository and documentation site.

## 0.1.0

Initial public release.

- SDK for loading and evaluating agentskills.io-style skills.
- CLI with OpenAI-compatible model provider support.
- YAML and JSON config support.
- Pretty, JSONL, and silent logging modes.
- Static HTML reports.
- Baseline comparison with `with_skill` and `without_skill` modes.
- Official `iteration-N` artifact layout.
- Tool-call assertions and custom provider interface.
