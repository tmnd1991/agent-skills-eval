#!/usr/bin/env bash
# Runs the quick-review eval through claude-code instead of opencode:
#   1. builds dist/ (claude-code-provider.ts etc. need compiling)
#   2. (re)builds the fixture repo the claude agent will act on
#   3. runs the CLI with the quick-review claude-code config, which pins
#      runMode: claude-code, claudeCode.dir at the fixture repo,
#      claudeCode.auto, target, and concurrency: 1
set -e

cd "$(dirname "${BASH_SOURCE[0]}")/.."

npm run build

uv run examples/quick-review/evals/setup_fixture.py

node dist/cli.js --config examples/agent-skills-eval.quick-review.claude-code.yaml
