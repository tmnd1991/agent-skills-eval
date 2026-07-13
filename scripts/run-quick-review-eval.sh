#!/usr/bin/env bash
# Runs the quick-review eval:
#   1. builds dist/ (provider .ts sources need compiling)
#   2. (re)builds the fixture repo the agent will act on
#   3. runs the CLI with the given quick-review config, e.g.
#      examples/agent-skills-eval.quick-review.yaml (opencode) or
#      examples/agent-skills-eval.quick-review.claude-code.yaml (claude-code)
set -e

cd "$(dirname "${BASH_SOURCE[0]}")/.."

config="${1:-examples/agent-skills-eval.quick-review.yaml}"

npm run build

uv run examples/quick-review/evals/setup_fixture.py

node dist/cli.js --config "$config"
