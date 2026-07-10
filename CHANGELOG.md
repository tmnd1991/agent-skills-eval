# Changelog

All notable changes to this project are documented here.

## 0.2.0

- **Breaking type change**: `GradingJson.summary.pass_rate` and
  `EvaluateSkillsResult.skills[].passRate` are now `number | null`; `null` means no
  assertions were graded for that run/skill (previously reported as `1`, i.e. a
  zero-assertion skill silently showed up as 100% passing). Consumers doing unguarded
  arithmetic or `.toFixed()` on these fields need a null check.
- Fix the HTML report, skill summary sort order, and regression detection to treat a
  zero-assertion run as a distinct "no assertions" state instead of a false 100%/green
  result.

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
