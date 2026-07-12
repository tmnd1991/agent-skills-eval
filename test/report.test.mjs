import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { generateReport } from "../dist/index.js";

function tempRoot() {
  return mkdtempSync(path.join(tmpdir(), "agent-skills-eval-report-"));
}

/** Writes a single-skill workspace with a with_skill/without_skill delta, mirroring the
 * layout `collectSkill` expects (src/report.ts). */
function writeSkillWorkspace(root, { withDelta = true } = {}) {
  const skillDir = path.join(root, "csv-analyzer");
  const evalDir = path.join(skillDir, "eval-top-months");
  mkdirSync(evalDir, { recursive: true });

  writeFileSync(
    path.join(skillDir, "meta.json"),
    JSON.stringify({
      name: "csv-analyzer",
      slug: "csv-analyzer",
      relPath: "csv-analyzer",
      target: "target-model",
      judge: "judge-model",
      modes: withDelta ? ["with_skill", "without_skill"] : ["with_skill"],
    })
  );

  writeFileSync(
    path.join(skillDir, "benchmark.json"),
    JSON.stringify({
      run_summary: {
        with_skill: { pass_rate: { mean: 1, stddev: 0 }, time_seconds: { mean: 1, stddev: 0 }, tokens: { mean: 10, stddev: 0 } },
        without_skill: withDelta
          ? { pass_rate: { mean: 0.5, stddev: 0 }, time_seconds: { mean: 2, stddev: 0 }, tokens: { mean: 5, stddev: 0 } }
          : undefined,
        delta: withDelta ? { pass_rate: 0.5, time_seconds: -1, tokens: 5 } : undefined,
      },
    })
  );

  const modes = withDelta ? ["with_skill", "without_skill"] : ["with_skill"];
  for (const mode of modes) {
    const runDir = path.join(evalDir, mode);
    mkdirSync(path.join(runDir, "outputs"), { recursive: true });
    writeFileSync(
      path.join(runDir, "grading.json"),
      JSON.stringify({
        assertion_results: [{ text: "mentions top months", passed: true, evidence: "ok" }],
        summary: { passed: 1, failed: 0, total: 1, pass_rate: 1 },
      })
    );
    writeFileSync(path.join(runDir, "timing.json"), JSON.stringify({ total_tokens: 10, duration_ms: 1000 }));
    writeFileSync(path.join(runDir, "outputs", "response.txt"), "Top revenue months: Jan");
  }

  return skillDir;
}

test("generateReport shows the token-overhead caveat for opencode/claude-code baselines", () => {
  const root = tempRoot();
  const workspace = path.join(root, "workspace");
  writeSkillWorkspace(workspace);

  const result = generateReport({ workspace, provider: "claude-code" });
  const html = readFileSync(result.reportPath, "utf-8");

  assert.match(html, /<div class="caveat">/);
  assert.match(html, /<span class="caveat-flag"/);
});

test("generateReport omits the token-overhead caveat for a non-CLI-wrapper provider", () => {
  const root = tempRoot();
  const workspace = path.join(root, "workspace");
  writeSkillWorkspace(workspace);

  const result = generateReport({ workspace, provider: "openai-compatible" });
  const html = readFileSync(result.reportPath, "utf-8");

  assert.doesNotMatch(html, /<div class="caveat">/);
  assert.doesNotMatch(html, /<span class="caveat-flag"/);
});

test("generateReport omits the token-overhead caveat when there is no baseline delta", () => {
  const root = tempRoot();
  const workspace = path.join(root, "workspace");
  writeSkillWorkspace(workspace, { withDelta: false });

  const result = generateReport({ workspace, provider: "opencode" });
  const html = readFileSync(result.reportPath, "utf-8");

  assert.doesNotMatch(html, /<div class="caveat">/);
  assert.doesNotMatch(html, /<span class="caveat-flag"/);
});
