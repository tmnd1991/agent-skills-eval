# agent-skills-eval

[![npm version](https://img.shields.io/npm/v/agent-skills-eval.svg)](https://www.npmjs.com/package/agent-skills-eval)
[![CI](https://github.com/darkrishabh/agent-skills-eval/actions/workflows/ci.yml/badge.svg)](https://github.com/darkrishabh/agent-skills-eval/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)
[![node](https://img.shields.io/node/v/agent-skills-eval.svg)](./package.json)
[![docs](https://img.shields.io/badge/docs-GitHub%20Pages-0f766e.svg)](https://darkrishabh.github.io/agent-skills-eval/)

SDK and CLI for evaluating [`agentskills.io`](https://agentskills.io)-style skills.

`agent-skills-eval` loads skill folders, runs skill-aware and baseline model calls, grades outputs with a judge model, writes portable artifacts, and generates static reports. It was split from Bench AI's Skills Eval implementation so skill authors can build custom evaluators without depending on the Bench AI web app or suite engine.

## Features

- Agentskills.io-style `SKILL.md` and `evals/evals.json` loading.
- CLI and TypeScript SDK.
- OpenAI-compatible provider included; custom providers supported.
- YAML and JSON config files.
- `with_skill` vs `without_skill` baseline comparison.
- Pretty console logs, JSONL event logs, and silent mode.
- Static HTML reports from artifact folders.
- Official `iteration-N` workspace layout.
- Tool-call assertions for deterministic agent behavior checks.

## Install

```sh
npm install agent-skills-eval
```

Or run directly:

```sh
npx agent-skills-eval --help
```

## Quickstart

```sh
OPENAI_BASE_URL=https://api.openai.com/v1 OPENAI_API_KEY=... \
  npx agent-skills-eval ./skills \
  --target gpt-4o-mini \
  --judge gpt-4o-mini \
  --workspace ./agent-skills-workspace \
  --baseline \
  --strict
```

The default CLI layout writes:

```text
agent-skills-workspace/
  iteration-1/
    meta.json
    benchmark.json
    eval-basic/
      with_skill/
        prompts.json
        timing.json
        grading.json
        outputs/response.txt
      without_skill/
        ...
    report/
      index.html
```

## YAML Config

Create `agent-skills-eval.yaml`:

```yaml
root: ./skills
workspace: ./agent-skills-workspace
baseline: true
target: gpt-4o-mini
judge: gpt-4o-mini
baseUrl: https://api.openai.com/v1
apiKeyEnv: OPENAI_API_KEY
include:
  - "skills/**"
exclude:
  - "**/draft-*"
concurrency: 4
layout: iteration
strict: true
report:
  enabled: true
  title: Agent Skills Report
logging:
  format: pretty # pretty, jsonl, or silent
  verbose: false
  color: auto
targetParams:
  temperature: 0
judgeParams:
  temperature: 0
```

Run it:

```sh
OPENAI_API_KEY=... npx agent-skills-eval --config agent-skills-eval.yaml
```

CLI flags override config values.

## CLI Options

```sh
npx agent-skills-eval [root] \
  --config agent-skills-eval.yaml \
  --workspace ./agent-skills-workspace \
  --baseline \
  --target gpt-4o-mini \
  --judge gpt-4o-mini \
  --base-url https://api.openai.com/v1 \
  --api-key-env OPENAI_API_KEY \
  --include "skills/**" \
  --exclude "**/draft-*" \
  --concurrency 4 \
  --layout iteration \
  --strict \
  --log-format pretty \
  --report
```

Logging modes:

- `pretty`: buffered human-readable console logs.
- `jsonl`: one machine-readable JSON object per event.
- `silent`: no event logs.

## SDK

```ts
import {
  OpenAICompatibleProvider,
  consoleReporter,
  evaluateSkills,
} from "agent-skills-eval";

const provider = new OpenAICompatibleProvider({
  baseUrl: "https://api.openai.com/v1",
  apiKey: process.env.OPENAI_API_KEY!,
  model: "gpt-4o-mini",
  providerName: "openai",
});

const result = await evaluateSkills({
  root: "./skills",
  workspace: "./agent-skills-workspace",
  baseline: true,
  concurrency: 4,
  workspaceLayout: "iteration",
  strict: true,
  target: { model: provider.model, provider },
  judge: { model: provider.model, provider },
  onEvent: consoleReporter(),
});

console.log(result);
```

Load config programmatically:

```ts
import { loadConfigFile } from "agent-skills-eval";

const config = loadConfigFile("./agent-skills-eval.yaml");
```

Use JSONL events:

```ts
import { jsonlReporter } from "agent-skills-eval";

const reporter = jsonlReporter({ file: "./events.jsonl" });

await evaluateSkills({
  // ...
  onEvent: reporter.onEvent,
});

await reporter.close();
```

## Custom Providers

Any backend can be used by implementing `Provider`:

```ts
import type { Provider, ProviderResult } from "agent-skills-eval";

export const provider: Provider = {
  name: "my-provider",
  model: "my-model",
  async complete(prompt: string): Promise<ProviderResult> {
    return {
      provider: "my-provider",
      model: "my-model",
      output: "model output",
      latencyMs: 0,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    };
  },
};
```

## Skill Layout

```text
my-skill/
  SKILL.md
  references/
    notes.md
  scripts/
    helper.sh
  evals/
    evals.json
    files/
      input.csv
```

`SKILL.md`:

```md
---
name: my-skill
description: Analyze small CSV files.
license: MIT
compatibility: Works with text-capable chat models.
---

When given a CSV file, identify the most important trend and cite the relevant rows.
```

`evals/evals.json`:

```json
{
  "skill_name": "my-skill",
  "evals": [
    {
      "id": "basic",
      "name": "basic behavior",
      "prompt": "Use the attached data to summarize revenue.",
      "files": ["evals/files/input.csv"],
      "expected_output": "The response identifies the highest revenue month.",
      "assertions": [
        "The output identifies the highest revenue month."
      ]
    }
  ]
}
```

If `assertions` are omitted but `expected_output` is present, the SDK turns the expected output into a judge assertion so minimal agentskills.io eval files still produce pass/fail grading.

## Reports

The static report reads artifacts from disk and summarizes:

- Pass rate by skill and eval.
- Assertion evidence.
- Target output.
- Prompt and judge prompt details.
- Timing and token usage.
- Tool calls, when present.

Use `--report-output` or `report.output` in YAML to choose a report directory.

## Examples

See [`examples/basic-skill`](./examples/basic-skill) and [`examples/agent-skills-eval.yaml`](./examples/agent-skills-eval.yaml).

## agentskills.io Compatibility

Supported:

- `SKILL.md` YAML frontmatter with required `name` and `description`.
- Optional `license`, `compatibility`, `metadata`, and `allowed-tools` frontmatter fields.
- Strict validation for name length, lowercase hyphenated name format, parent directory match, description length, and compatibility length.
- Optional `scripts/`, `references/`, and `assets/` directories. Markdown references are included in the skill context; scripts are exposed by manifest by default.
- `evals/evals.json` with `skill_name`, `evals[].id`, `prompt`, `expected_output`, `files`, and `assertions`.
- Official eval artifacts: `iteration-N/<eval>/<mode>/outputs`, `timing.json`, `grading.json`, and `benchmark.json`.
- Baseline comparison via `with_skill` and `without_skill`.

SDK extensions:

- `defaults`, model `params`, tool definitions, and deterministic `tool_assertions`.
- `workspaceLayout: "flat"` for multi-skill dashboards and report generation.

## Development

```sh
npm ci
npm test
npm pack --dry-run
```

## Documentation

The docs site lives in [`docs/`](./docs) and is deployed with GitHub Pages.

Local preview:

```sh
python3 -m http.server 8080 --directory docs
```

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md), [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md), and [SECURITY.md](./SECURITY.md).

## License

MIT. See [LICENSE](./LICENSE).
