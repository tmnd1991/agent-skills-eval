#!/usr/bin/env node
// Regenerates <workspace>/report/index.html from eval artifacts already on
// disk (meta.json, benchmark.json, eval-*/**), without re-running any evals.
// Run `npm run build` first if src/report.ts changed since the last build.
//
// Usage:
//   node scripts/render-report.mjs <workspace> [options]
//
// Options:
//   --output <dir>     Output directory (default: <workspace>/report)
//   --title <title>    Report title
//   --target <model>   Target model, shown in the header
//   --judge <model>    Judge model, shown in the header
//   --provider <name>  Provider/run mode, shown in the header (e.g. opencode, claude-code)

import { generateReport } from "../dist/index.js";

const [workspace, ...rest] = process.argv.slice(2);

if (!workspace || workspace === "--help" || workspace === "-h") {
  console.error(
    "Usage: node scripts/render-report.mjs <workspace> [--output <dir>] [--title <title>] [--target <model>] [--judge <model>] [--provider <name>]"
  );
  process.exit(workspace ? 0 : 1);
}

const flags = {};
for (let i = 0; i < rest.length; i += 2) {
  flags[rest[i].replace(/^--/, "")] = rest[i + 1];
}

const result = generateReport({
  workspace,
  output: flags.output,
  title: flags.title,
  target: flags.target,
  judge: flags.judge,
  provider: flags.provider,
});

console.log(`Rendered ${result.skills} skill(s), ${result.evals} eval(s) -> ${result.reportPath}`);
