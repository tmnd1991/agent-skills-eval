import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  buildBenchmark,
  discoverSkills,
  ensureIterationDir,
  evaluateSkills,
  generateReport,
  gradeOutputs,
  jsonlReporter,
  loadConfigFile,
  loadSkill,
  runEval,
  runToolAssertions,
} from "../dist/index.js";

function tempRoot() {
  return mkdtempSync(path.join(tmpdir(), "agent-skills-eval-"));
}

function writeSkill(root, name = "csv-analyzer") {
  const dir = path.join(root, name);
  mkdirSync(path.join(dir, "references"), { recursive: true });
  mkdirSync(path.join(dir, "scripts"), { recursive: true });
  mkdirSync(path.join(dir, "evals", "files"), { recursive: true });
  writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: Analyze CSV files.\n---\n\nUse CSV-specific checks.\n`);
  writeFileSync(path.join(dir, "references", "REFERENCE.md"), "Reference details");
  writeFileSync(path.join(dir, "scripts", "helper.sh"), "#!/usr/bin/env bash\necho helper\n");
  writeFileSync(path.join(dir, "evals", "files", "data.csv"), "month,revenue\nJan,10\n");
  writeFileSync(path.join(dir, "evals", "evals.json"), JSON.stringify({
    skill_name: name,
    evals: [{
      id: 1,
      name: "top-months",
      prompt: "Find top revenue months.",
      expected_output: "A summary of the top months.",
      files: ["evals/files/data.csv", "evals/files/missing.csv"],
      assertions: ["The output mentions top revenue months."]
    }]
  }));
  return dir;
}

function provider(output, extra = {}) {
  return {
    name: "mock",
    model: "mock-model",
    prompts: [],
    async complete(prompt) {
      this.prompts.push(prompt);
      return { provider: "mock", model: "mock-model", output, latencyMs: 25, inputTokens: 3, outputTokens: 4, costUsd: 0 };
    },
    ...extra,
  };
}

function judgeProvider(passed = true, extra = {}) {
  return provider(JSON.stringify({
    assertion_results: [{ text: "placeholder", passed, evidence: passed ? "Output contains the required phrase." : "Missing required phrase." }],
    summary: { passed: passed ? 1 : 0, failed: passed ? 0 : 1, total: 1, pass_rate: passed ? 1 : 0 }
  }), extra);
}

async function captureStderr(fn) {
  const original = process.stderr.write.bind(process.stderr);
  const writes = [];
  process.stderr.write = (chunk) => {
    writes.push(String(chunk));
    return true;
  };
  try {
    await fn();
  } finally {
    process.stderr.write = original;
  }
  return writes;
}

test("loadSkill reads spec files and safe attachment states", () => {
  const root = tempRoot();
  const dir = writeSkill(root);
  const skill = loadSkill(dir);
  assert.equal(skill.name, "csv-analyzer");
  assert.equal(skill.references[0].kind, "text");
  assert.equal(skill.scripts[0].content, "#!/usr/bin/env bash");
  assert.equal(skill.evals.length, 1);
});

test("loadSkill sorts nested references by POSIX-relative path", () => {
  const root = tempRoot();
  const dir = writeSkill(root);
  mkdirSync(path.join(dir, "references", "z"), { recursive: true });
  writeFileSync(path.join(dir, "references", "z", "b.md"), "b");
  writeFileSync(path.join(dir, "references", "m.mdx"), "m");
  const skill = loadSkill(dir);
  assert.deepEqual(
    skill.references.map((f) => f.path),
    ["references/m.mdx", "references/REFERENCE.md", "references/z/b.md"]
  );
});

test("discoverSkills finds nested skills", () => {
  const root = tempRoot();
  const plugin = path.join(root, "domain", "plugin");
  writeSkill(path.join(plugin, "skills"), "csv-analyzer");
  const refs = discoverSkills(root);
  assert.equal(refs.length, 1);
  assert.equal("pluginName" in refs[0], false);
  assert.equal(refs[0].hasEvals, true);
});

test("gradeOutputs returns spec grading JSON and fails closed", async () => {
  const good = await gradeOutputs({
    modelOutput: "Top revenue months: Jan",
    assertions: ["The output mentions top revenue months."],
    judge: { model: "judge", provider: judgeProvider(true) },
  });
  assert.deepEqual(good.grading.summary, { passed: 1, failed: 0, total: 1, pass_rate: 1 });

  const badJudge = provider("not json");
  const bad = await gradeOutputs({
    modelOutput: "x",
    assertions: ["Must pass"],
    judge: { model: "judge", provider: badJudge },
  });
  assert.equal(bad.grading.summary.failed, 1);
  assert.match(bad.grading.assertion_results[0].evidence, /unparseable/);
});

test("buildBenchmark and ensureIterationDir follow spec shapes", () => {
  const benchmark = buildBenchmark([
    { mode: "with_skill", passRate: 1, durationMs: 1000, tokens: 10 },
    { mode: "without_skill", passRate: 0.5, durationMs: 2000, tokens: 5 },
  ]);
  assert.equal(benchmark.run_summary.delta.pass_rate, 0.5);
  assert.equal(benchmark.run_summary.with_skill.time_seconds.mean, 1);

  const root = tempRoot();
  assert.equal(ensureIterationDir(root).iteration, 1);
  assert.equal(ensureIterationDir(root).iteration, process.env.CI === "true" ? 1 : 2);
});

test("runEval supports complete-only provider fallback and writes artifacts", async () => {
  const root = tempRoot();
  const skill = loadSkill(writeSkill(root));
  const workspace = path.join(root, "workspace");
  const target = provider("Top revenue months: Jan");
  const result = await runEval({
    skill,
    eval: skill.evals[0],
    modes: ["with_skill", "without_skill"],
    target: { model: "target", provider: target },
    judge: { model: "judge", provider: judgeProvider(true) },
    workspace,
    iteration: 1,
  });
  assert.ok(target.prompts[0].includes("---USER REQUEST---"));
  assert.ok(target.prompts[0].includes("<file path=\"evals/files/data.csv\""));
  assert.ok(target.prompts[1].includes("<file path=\"evals/files/data.csv\""));
  assert.ok(!target.prompts[1].includes("<skill name="));
  assert.equal(result.modes.without_skill.fileCount, result.modes.with_skill.fileCount);
  assert.equal(result.modes.without_skill.fileCount, 2);
  assert.ok(existsSync(path.join(workspace, "iteration-1", result.slug, "with_skill", "grading.json")));
  assert.ok(existsSync(path.join(workspace, "iteration-1", result.slug, "without_skill", "timing.json")));
});

test("evaluateSkills produces spec workspace layout and summary", async () => {
  const root = tempRoot();
  writeSkill(root);
  const workspace = path.join(root, "bench-workspace");
  const result = await evaluateSkills({
    root,
    workspace,
    baseline: true,
    target: { model: "target", provider: provider("Top revenue months: Jan") },
    judge: { model: "judge", provider: judgeProvider(true) },
  });
  assert.equal(result.failed, 0);
  assert.equal(result.skills.length, 1);
  const benchmark = JSON.parse(readFileSync(result.skills[0].benchmarkPath, "utf8"));
  assert.ok(benchmark.run_summary.with_skill);
  assert.ok(benchmark.run_summary.without_skill);
  assert.ok(existsSync(path.join(workspace, "csv-analyzer", "eval-top-months", "with_skill", "outputs")));
});

test("evaluateSkills warns once when a baseline run uses an overhead-prone provider", async () => {
  const root = tempRoot();
  writeSkill(root);
  const workspace = path.join(root, "bench-workspace");

  const written = [];
  const originalWrite = process.stderr.write;
  process.stderr.write = (chunk, ...rest) => {
    written.push(chunk.toString());
    return true;
  };
  try {
    await evaluateSkills({
      root,
      workspace,
      baseline: true,
      report: false,
      target: { model: "target", provider: provider("Top revenue months: Jan", { name: "opencode" }) },
      judge: { model: "judge", provider: judgeProvider(true) },
    });
  } finally {
    process.stderr.write = originalWrite;
  }

  assert.ok(
    written.some((line) => /token totals from --run-mode opencode/.test(line)),
    "expected a stderr warning about opencode token overhead",
  );
});

test("evaluateSkills does not warn about token overhead for a plain provider or without baseline", async () => {
  const root = tempRoot();
  writeSkill(root);

  const written = [];
  const originalWrite = process.stderr.write;
  process.stderr.write = (chunk, ...rest) => {
    written.push(chunk.toString());
    return true;
  };
  try {
    // Overhead-prone provider, but no baseline: no delta is ever computed, so
    // nothing to warn about.
    await evaluateSkills({
      root,
      workspace: path.join(root, "workspace-no-baseline"),
      baseline: false,
      report: false,
      target: { model: "target", provider: provider("Top revenue months: Jan", { name: "opencode" }) },
      judge: { model: "judge", provider: judgeProvider(true) },
    });

    // Baseline, but a plain (non-overhead) provider.
    await evaluateSkills({
      root,
      workspace: path.join(root, "workspace-plain-provider"),
      baseline: true,
      report: false,
      target: { model: "target", provider: provider("Top revenue months: Jan") },
      judge: { model: "judge", provider: judgeProvider(true) },
    });
  } finally {
    process.stderr.write = originalWrite;
  }

  assert.ok(
    !written.some((line) => /token totals from --run-mode/.test(line)),
    "did not expect a token-overhead warning",
  );
});

test("loadSkill normalizes mixed-shape assertions to strings", () => {
  const root = tempRoot();
  const name = "mixed-assertions";
  const dir = path.join(root, name);
  mkdirSync(path.join(dir, "evals"), { recursive: true });
  writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: Mixed-shape assertions test.\n---\n\nBody.\n`);
  writeFileSync(path.join(dir, "evals", "evals.json"), JSON.stringify({
    skill_name: name,
    evals: [{
      id: 1,
      name: "mixed",
      prompt: "Do the thing.",
      assertions: [
        "plain string assertion",
        { text: "object form text" },
        { value: "object form value" },
        { criterion: "object form criterion" },
      ],
    }],
  }));
  const skill = loadSkill(dir);
  assert.equal(skill.evals.length, 1);
  assert.deepEqual(skill.evals[0].assertions, [
    "plain string assertion",
    "object form text",
    "object form value",
    "object form criterion",
  ]);
});

test("loadSkill throws with path-aware message on malformed assertion entry", () => {
  const root = tempRoot();
  const name = "bad-assertions";
  const dir = path.join(root, name);
  mkdirSync(path.join(dir, "evals"), { recursive: true });
  writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: Bad assertion test.\n---\n\nBody.\n`);
  writeFileSync(path.join(dir, "evals", "evals.json"), JSON.stringify({
    skill_name: name,
    evals: [{
      id: 1,
      name: "bad",
      prompt: "Do the thing.",
      assertions: ["ok", { foo: "bar" }],
    }],
  }));
  assert.throws(
    () => loadSkill(dir),
    (err) => /evals\[0\]\.assertions\[1\]/.test(err.message) && /text\|value\|criterion/.test(err.message),
  );
});

test("evaluateSkills runs eval cases in parallel under concurrency", async () => {
  const root = tempRoot();
  const name = "concurrent-skill";
  const dir = path.join(root, name);
  mkdirSync(path.join(dir, "evals"), { recursive: true });
  writeFileSync(
    path.join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: Concurrency test.\n---\n\nBody.\n`,
  );
  writeFileSync(
    path.join(dir, "evals", "evals.json"),
    JSON.stringify({
      skill_name: name,
      evals: [
        { id: 1, name: "case-a", prompt: "do A", assertions: ["mentions A"] },
        { id: 2, name: "case-b", prompt: "do B", assertions: ["mentions B"] },
        { id: 3, name: "case-c", prompt: "do C", assertions: ["mentions C"] },
      ],
    }),
  );

  // Slow stub provider — every call sleeps 200ms before returning. Used for
  // both target and judge so each eval = 1 target + 1 judge = ~400ms serial.
  function slowProvider(output) {
    return {
      name: "slow",
      model: "slow-model",
      async complete() {
        await new Promise((r) => setTimeout(r, 200));
        return {
          provider: "slow",
          model: "slow-model",
          output,
          latencyMs: 200,
          inputTokens: 1,
          outputTokens: 1,
          costUsd: 0,
        };
      },
      async completeChat() {
        await new Promise((r) => setTimeout(r, 200));
        return {
          provider: "slow",
          model: "slow-model",
          output,
          latencyMs: 200,
          inputTokens: 1,
          outputTokens: 1,
          costUsd: 0,
        };
      },
    };
  }

  const judgeOutput = JSON.stringify({
    assertion_results: [{ text: "mentions thing", passed: true, evidence: "ok" }],
    summary: { passed: 1, failed: 0, total: 1, pass_rate: 1 },
  });

  const workspace = path.join(root, "bench-workspace");
  const t0 = Date.now();
  const result = await evaluateSkills({
    root,
    workspace,
    target: { model: "target", provider: slowProvider("ok response") },
    judge: { model: "judge", provider: slowProvider(judgeOutput) },
    concurrency: 3,
    report: false,
  });
  const elapsed = Date.now() - t0;

  // Sequentially: 3 evals × (200ms target + 200ms judge) = ~1200ms.
  // With concurrency:3 the whole batch should finish in ~400ms; allow slack
  // for CI jitter / Node startup but still well under the serial floor.
  assert.ok(
    elapsed < 500,
    `expected concurrent run to finish in <500ms, got ${elapsed}ms`,
  );

  assert.equal(result.skills.length, 1);
  const slug = result.skills[0].slug;
  for (const evalSlug of ["eval-case-a", "eval-case-b", "eval-case-c"]) {
    assert.ok(
      existsSync(path.join(workspace, slug, evalSlug, "with_skill", "grading.json")),
      `missing grading.json for ${evalSlug}`,
    );
    assert.ok(
      existsSync(path.join(workspace, slug, evalSlug, "with_skill", "timing.json")),
      `missing timing.json for ${evalSlug}`,
    );
  }
  assert.ok(existsSync(result.skills[0].benchmarkPath), "benchmark.json should be written");
});

function writeConcurrencySkill(root, name, evalCount) {
  const dir = path.join(root, name);
  mkdirSync(path.join(dir, "evals"), { recursive: true });
  writeFileSync(
    path.join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: Concurrency test.\n---\n\nBody.\n`,
  );
  writeFileSync(
    path.join(dir, "evals", "evals.json"),
    JSON.stringify({
      skill_name: name,
      evals: Array.from({ length: evalCount }, (_, i) => ({
        id: i + 1,
        name: `case-${i + 1}`,
        prompt: `do ${i + 1}`,
        assertions: ["ok"],
      })),
    }),
  );
  return dir;
}

const FIXED_JUDGE_OUTPUT = JSON.stringify({
  assertion_results: [{ text: "ok", passed: true, evidence: "ok" }],
  summary: { passed: 1, failed: 0, total: 1, pass_rate: 1 },
});

function fixedJudgeProvider() {
  return {
    name: "judge",
    model: "judge-model",
    async complete() {
      return {
        provider: "judge",
        model: "judge-model",
        output: FIXED_JUDGE_OUTPUT,
        latencyMs: 1,
        inputTokens: 1,
        outputTokens: 1,
        costUsd: 0,
      };
    },
  };
}

test("evaluateSkills serializes prepareSkill/cleanupSkill for the same skill under concurrency", async () => {
  const root = tempRoot();
  const name = "shared-install-skill";
  writeConcurrencySkill(root, name, 4);

  const installed = new Set();
  const violations = [];
  const targetProvider = {
    name: "shared-install",
    model: "shared-install-model",
    capabilities: { sharedInstallDir: true },
    async prepareSkill(skill) {
      if (installed.has(skill.name)) violations.push(`re-entrant install of ${skill.name}`);
      installed.add(skill.name);
      await new Promise((r) => setTimeout(r, 20));
    },
    async cleanupSkill(skill) {
      installed.delete(skill.name);
    },
    async complete() {
      await new Promise((r) => setTimeout(r, 20));
      return {
        provider: "shared-install",
        model: "shared-install-model",
        output: "ok response",
        latencyMs: 20,
        inputTokens: 1,
        outputTokens: 1,
        costUsd: 0,
      };
    },
  };

  const result = await evaluateSkills({
    root,
    workspace: path.join(root, "bench-workspace"),
    target: { model: "target", provider: targetProvider },
    judge: { model: "judge", provider: fixedJudgeProvider() },
    concurrency: 4,
    report: false,
  });

  assert.deepEqual(violations, []);
  assert.equal(result.skills.length, 1);
  assert.equal(result.skills[0].evals, 4);
});

test("evaluateSkills does not regress to global serialization across different skills", async () => {
  const root = tempRoot();
  const perCallMs = 100;
  const evalsPerSkill = 3;
  writeConcurrencySkill(root, "skill-one", evalsPerSkill);
  writeConcurrencySkill(root, "skill-two", evalsPerSkill);

  function slowSharedInstallProvider() {
    return {
      name: "shared-install",
      model: "shared-install-model",
      capabilities: { sharedInstallDir: true },
      async prepareSkill() {},
      async cleanupSkill() {},
      async complete() {
        await new Promise((r) => setTimeout(r, perCallMs));
        return {
          provider: "shared-install",
          model: "shared-install-model",
          output: "ok response",
          latencyMs: perCallMs,
          inputTokens: 1,
          outputTokens: 1,
          costUsd: 0,
        };
      },
    };
  }

  const t0 = Date.now();
  const result = await evaluateSkills({
    root,
    workspace: path.join(root, "bench-workspace"),
    target: { model: "target", provider: slowSharedInstallProvider() },
    judge: { model: "judge", provider: fixedJudgeProvider() },
    concurrency: 4,
    report: false,
  });
  const elapsed = Date.now() - t0;

  // Same-skill evals serialize (evalsPerSkill * perCallMs each), but the two
  // skills run concurrently — total should be close to one skill's serial
  // time, not evalsPerSkill * 2 * perCallMs (full global serialization).
  assert.ok(
    elapsed < evalsPerSkill * perCallMs * 2,
    `expected cross-skill parallelism, got ${elapsed}ms (global-serial floor is ${evalsPerSkill * 2 * perCallMs}ms)`,
  );
  assert.equal(result.skills.length, 2);
});

test("evaluateSkills warns once about automatic same-skill serialization", async () => {
  const originalWrite = process.stderr.write.bind(process.stderr);
  const messages = [];
  process.stderr.write = (chunk, ...rest) => {
    messages.push(String(chunk));
    return originalWrite(chunk, ...rest);
  };

  try {
    const root = tempRoot();
    writeConcurrencySkill(root, "warn-skill", 2);
    const sharedInstallProvider = {
      name: "shared-install",
      model: "shared-install-model",
      capabilities: { sharedInstallDir: true },
      async prepareSkill() {},
      async cleanupSkill() {},
      async complete() {
        return {
          provider: "shared-install",
          model: "shared-install-model",
          output: "ok response",
          latencyMs: 1,
          inputTokens: 1,
          outputTokens: 1,
          costUsd: 0,
        };
      },
    };

    await evaluateSkills({
      root,
      workspace: path.join(root, "warn-workspace"),
      target: { model: "target", provider: sharedInstallProvider },
      judge: { model: "judge", provider: fixedJudgeProvider() },
      concurrency: 4,
      report: false,
    });
    const matches = messages.filter((m) => m.includes("automatically serialized"));
    assert.equal(matches.length, 1, `expected exactly one warning, got ${matches.length}`);

    messages.length = 0;
    await evaluateSkills({
      root,
      workspace: path.join(root, "warn-workspace-serial"),
      target: { model: "target", provider: sharedInstallProvider },
      judge: { model: "judge", provider: fixedJudgeProvider() },
      concurrency: 1,
      report: false,
    });
    assert.equal(
      messages.filter((m) => m.includes("automatically serialized")).length,
      0,
      "no warning expected when concurrency is 1",
    );

    messages.length = 0;
    await evaluateSkills({
      root,
      workspace: path.join(root, "warn-workspace-nocap"),
      target: { model: "target", provider: fixedJudgeProvider() },
      judge: { model: "judge", provider: fixedJudgeProvider() },
      concurrency: 4,
      report: false,
    });
    assert.equal(
      messages.filter((m) => m.includes("automatically serialized")).length,
      0,
      "no warning expected when provider doesn't declare sharedInstallDir",
    );
  } finally {
    process.stderr.write = originalWrite;
  }
});

test("strict loadSkill validates required agentskills.io frontmatter", () => {
  const root = tempRoot();
  const dir = path.join(root, "bad-name");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "SKILL.md"), `---\nname: BadName\ndescription: Valid description.\n---\n\nBody.\n`);
  assert.throws(
    () => loadSkill(dir, { strict: true }),
    (err) =>
      /frontmatter\.name/.test(err.message) &&
      /lowercase/.test(err.message),
  );
});

test("non-strict loadSkill still rejects a malformed skill name", () => {
  const root = tempRoot();
  const dir = path.join(root, "bad-name");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "SKILL.md"), `---\nname: BadName\ndescription: Valid description.\n---\n\nBody.\n`);
  assert.throws(
    () => loadSkill(dir, { strict: false }),
    /Invalid skill name/,
  );
});

test("non-strict loadSkill rejects a path-traversal skill name", () => {
  const root = tempRoot();
  const dir = path.join(root, "evil-skill");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "SKILL.md"),
    `---\nname: ../../../../tmp/pwned\ndescription: Valid description.\n---\n\nBody.\n`,
  );
  assert.throws(() => loadSkill(dir, { strict: false }), /Invalid skill name/);
});

test("non-strict loadSkill rejects a skill name with a path separator", () => {
  const root = tempRoot();
  const dir = path.join(root, "slash-skill");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "SKILL.md"),
    `---\nname: foo/bar\ndescription: Valid description.\n---\n\nBody.\n`,
  );
  assert.throws(() => loadSkill(dir, { strict: false }), /Invalid skill name/);
});

test("non-strict loadSkill rejects a skill name over 64 characters", () => {
  const root = tempRoot();
  const dir = path.join(root, "long-name-skill");
  mkdirSync(dir, { recursive: true });
  const longName = "a".repeat(65);
  writeFileSync(
    path.join(dir, "SKILL.md"),
    `---\nname: ${longName}\ndescription: Valid description.\n---\n\nBody.\n`,
  );
  assert.throws(() => loadSkill(dir, { strict: false }), /Invalid skill name/);
});

test("expected_output becomes a judge assertion when assertions are omitted", async () => {
  const root = tempRoot();
  const dir = path.join(root, "expected-output");
  mkdirSync(path.join(dir, "evals"), { recursive: true });
  writeFileSync(
    path.join(dir, "SKILL.md"),
    `---\nname: expected-output\ndescription: Tests expected output fallback.\n---\n\nBody.\n`,
  );
  writeFileSync(path.join(dir, "evals", "evals.json"), JSON.stringify({
    skill_name: "expected-output",
    evals: [{
      id: 1,
      prompt: "Summarize the revenue.",
      expected_output: "A concise revenue summary.",
    }],
  }));

  const judge = judgeProvider(true);
  const skill = loadSkill(dir, { strict: true });
  const result = await runEval({
    skill,
    eval: skill.evals[0],
    modes: ["with_skill"],
    target: { model: "target", provider: provider("Concise revenue summary") },
    judge: { model: "judge", provider: judge },
    workspace: path.join(root, "workspace"),
    iteration: 1,
  });

  assert.equal(result.modes.with_skill.grading.summary.passed, 1);
  assert.match(result.modes.with_skill.judgePrompt, /A concise revenue summary/);
});

test("evaluateSkills can write the official iteration-N agentskills workspace layout", async () => {
  const root = tempRoot();
  writeSkill(root);
  const workspace = path.join(root, "workspace");
  const result = await evaluateSkills({
    root,
    workspace,
    baseline: true,
    workspaceLayout: "iteration",
    strict: true,
    report: false,
    target: { model: "target", provider: provider("Top revenue months: Jan") },
    judge: { model: "judge", provider: judgeProvider(true) },
  });

  assert.equal(result.iteration, 1);
  assert.equal(result.workspaceRoot, path.join(workspace, "iteration-1"));
  assert.equal(result.skills[0].benchmarkPath, path.join(workspace, "iteration-1", "benchmark.json"));
  assert.ok(existsSync(path.join(workspace, "iteration-1", "eval-top-months", "with_skill", "outputs")));
  assert.ok(existsSync(path.join(workspace, "iteration-1", "eval-top-months", "without_skill", "grading.json")));
});

test("loadConfigFile accepts YAML config for evaluator options", () => {
  const root = tempRoot();
  const configPath = path.join(root, "agent-skills-eval.yaml");
  writeFileSync(configPath, [
    "root: ./skills",
    "workspace: ./workspace",
    "baseline: true",
    "target: gpt-4o-mini",
    "judge: gpt-4.1-mini",
    "baseUrl: https://api.example.test/v1",
    "apiKeyEnv: TEST_API_KEY",
    "include:",
    "  - skills/**",
    "concurrency: 2",
    "layout: iteration",
    "strict: true",
    "report:",
    "  enabled: true",
    "  title: Skills Report",
    "logging:",
    "  format: jsonl",
    "  file: ./events.jsonl",
    "targetParams:",
    "  temperature: 0",
  ].join("\n"));

  const config = loadConfigFile(configPath);
  assert.equal(config.root, "./skills");
  assert.equal(config.workspace, "./workspace");
  assert.equal(config.baseline, true);
  assert.equal(config.target, "gpt-4o-mini");
  assert.equal(config.judge, "gpt-4.1-mini");
  assert.deepEqual(config.include, ["skills/**"]);
  assert.equal(config.concurrency, 2);
  assert.equal(config.layout, "iteration");
  assert.equal(config.strict, true);
  assert.deepEqual(config.report, { enabled: true, title: "Skills Report", output: undefined });
  assert.deepEqual(config.logging, {
    format: "jsonl",
    verbose: undefined,
    color: undefined,
    snippetLength: undefined,
    file: "./events.jsonl",
  });
  assert.deepEqual(config.targetParams, { temperature: 0 });
});

test("jsonlReporter emits machine-readable event logs", async () => {
  const lines = [];
  const reporter = jsonlReporter({ out: (line) => lines.push(line) });
  reporter.onEvent({
    type: "suite-start",
    skill: "demo",
    relPath: "demo",
    evalsCount: 1,
    modes: ["with_skill"],
    target: "target",
    judge: "judge",
  });
  await reporter.close();

  assert.equal(lines.length, 1);
  const event = JSON.parse(lines[0]);
  assert.equal(event.type, "suite-start");
  assert.equal(event.skill, "demo");
  assert.match(event.ts, /^\d{4}-\d{2}-\d{2}T/);
});

test("runEval never rejects on a prepareSkill failure, and still calls cleanupSkill", async () => {
  const root = tempRoot();
  const skill = loadSkill(writeSkill(root));
  const workspace = path.join(root, "workspace");
  let cleanupCalls = 0;
  const target = {
    name: "prepare-fail",
    model: "prepare-fail-model",
    async prepareSkill() {
      throw new Error("prepare boom");
    },
    async cleanupSkill() {
      cleanupCalls++;
    },
    async complete() {
      return {
        provider: "prepare-fail",
        model: "prepare-fail-model",
        output: "should not be reached",
        latencyMs: 1,
        inputTokens: 1,
        outputTokens: 1,
        costUsd: 0,
      };
    },
  };

  const result = await runEval({
    skill,
    eval: skill.evals[0],
    modes: ["with_skill", "without_skill"],
    target: { model: "target", provider: target },
    judge: { model: "judge", provider: judgeProvider(true) },
    workspace,
    iteration: 1,
  });

  assert.equal(result.modes.with_skill.error, "prepare boom");
  assert.equal(result.modes.without_skill.error, "prepare boom");
  assert.equal(result.modes.with_skill.grading.summary.total, 0);
  assert.equal(result.modes.with_skill.grading.summary.pass_rate, 0);
  assert.equal(cleanupCalls, 2);
  const runDir = path.join(workspace, "iteration-1", result.slug, "with_skill");
  assert.ok(existsSync(path.join(runDir, "error.json")));
  assert.ok(!existsSync(path.join(runDir, "grading.json")));
});

test("evaluateSkills tolerates one task's prepareSkill failure and completes the whole run", async () => {
  const root = tempRoot();
  const name = "prepare-fail-skill";
  writeConcurrencySkill(root, name, 3);

  let prepareCalls = 0;
  const targetProvider = {
    name: "prepare-fail",
    model: "prepare-fail-model",
    async prepareSkill() {
      prepareCalls++;
      if (prepareCalls === 2) throw new Error("prepare boom for case-2");
    },
    async cleanupSkill() {},
    async complete() {
      return {
        provider: "prepare-fail",
        model: "prepare-fail-model",
        output: "ok response",
        latencyMs: 10,
        inputTokens: 1,
        outputTokens: 1,
        costUsd: 0,
      };
    },
  };

  const workspace = path.join(root, "bench-workspace");
  const result = await evaluateSkills({
    root,
    workspace,
    target: { model: "target", provider: targetProvider },
    judge: { model: "judge", provider: fixedJudgeProvider() },
    concurrency: 1,
  });

  assert.equal(result.errored, 1);
  assert.equal(result.passed + result.failed, 2);
  assert.ok(result.reportPath && existsSync(result.reportPath));

  const skillResult = result.skills[0];
  assert.equal(skillResult.errored, 1);

  const benchmark = JSON.parse(readFileSync(skillResult.benchmarkPath, "utf8"));
  // Mean over only the 2 successful runs (10ms each = 0.01s) — not diluted by
  // a zeroed-out 3rd run, which would pull the mean toward 0.
  assert.equal(benchmark.run_summary.with_skill.time_seconds.mean, 0.01);

  const erroredRunDir = path.join(workspace, skillResult.slug, "eval-case-2", "with_skill");
  assert.ok(existsSync(path.join(erroredRunDir, "error.json")));
  assert.ok(!existsSync(path.join(erroredRunDir, "grading.json")));
});

test("report.ts renders an errored run without throwing", () => {
  const root = tempRoot();
  const workspace = path.join(root, "workspace");
  const skillDir = path.join(workspace, "report-test-skill");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    path.join(skillDir, "meta.json"),
    JSON.stringify({
      name: "report-test-skill",
      slug: "report-test-skill",
      relPath: "report-test-skill",
      target: "target",
      judge: "judge",
      modes: ["with_skill"],
      generated_at: new Date().toISOString(),
    }),
  );

  const erroredDir = path.join(skillDir, "eval-errored-case", "with_skill");
  mkdirSync(erroredDir, { recursive: true });
  writeFileSync(
    path.join(erroredDir, "error.json"),
    JSON.stringify({ error: "prepare boom", timestamp: new Date().toISOString() }),
  );

  const okDir = path.join(skillDir, "eval-ok-case", "with_skill");
  mkdirSync(path.join(okDir, "outputs"), { recursive: true });
  writeFileSync(
    path.join(okDir, "grading.json"),
    JSON.stringify({
      assertion_results: [{ text: "ok", passed: true, evidence: "ok" }],
      summary: { passed: 1, failed: 0, total: 1, pass_rate: 1 },
    }),
  );
  writeFileSync(path.join(okDir, "timing.json"), JSON.stringify({ total_tokens: 5, duration_ms: 10 }));
  writeFileSync(path.join(okDir, "outputs", "response.txt"), "ok output");
  writeFileSync(path.join(okDir, "prompts.json"), JSON.stringify({ user: "do it", fileCount: 0 }));

  const result = generateReport({ workspace });
  assert.ok(existsSync(result.reportPath));

  const html = readFileSync(result.reportPath, "utf8");
  assert.match(html, /ERRORED/);
  assert.match(html, /eval errored/);
  assert.match(html, /ok output/);
});

function toolCall(name, parsedArguments) {
  return { type: "function", function: { name, arguments: JSON.stringify(parsedArguments) }, parsedArguments };
}

test("tool-arg-equals ignores object key order but stays array order-sensitive", () => {
  const calls = [toolCall("search", { b: 2, a: 1 })];

  const reordered = runToolAssertions(calls, [
    { type: "tool-arg-equals", name: "search", path: "", value: { a: 1, b: 2 } },
  ]);
  assert.equal(reordered[0].passed, true);

  const nested = runToolAssertions(
    [toolCall("search", { filter: { b: 2, a: 1 } })],
    [{ type: "tool-arg-equals", name: "search", path: "filter", value: { a: 1, b: 2 } }],
  );
  assert.equal(nested[0].passed, true);

  const arrayOrder = runToolAssertions(
    [toolCall("search", { items: [1, 2] })],
    [{ type: "tool-arg-equals", name: "search", path: "items", value: [2, 1] }],
  );
  assert.equal(arrayOrder[0].passed, false);

  const structurallyDifferent = runToolAssertions(calls, [
    { type: "tool-arg-equals", name: "search", path: "", value: { a: 1, b: 2, c: 3 } },
  ]);
  assert.equal(structurallyDifferent[0].passed, false);

  const nan = runToolAssertions(
    [toolCall("search", { n: NaN })],
    [{ type: "tool-arg-equals", name: "search", path: "n", value: NaN }],
  );
  assert.equal(nan[0].passed, true);
});

test("gradeOutputs reports pass_rate: null (not 1) when there is nothing to grade", async () => {
  const result = await gradeOutputs({
    modelOutput: "anything",
    assertions: [],
    judge: { model: "judge", provider: judgeProvider(true) },
  });
  assert.equal(result.grading.summary.total, 0);
  assert.equal(result.grading.summary.pass_rate, null);
});

test("evaluateSkills reports passRate: null (not 1) for a skill whose eval cases declare no assertions", async () => {
  const root = tempRoot();
  const name = "no-assertions-skill";
  const dir = path.join(root, name);
  mkdirSync(path.join(dir, "evals"), { recursive: true });
  writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: Has no gradeable assertions.\n---\n\nBody.\n`);
  writeFileSync(path.join(dir, "evals", "evals.json"), JSON.stringify({
    skill_name: name,
    evals: [{ id: 1, name: "ungraded-case", prompt: "do something" }],
  }));

  const workspace = path.join(root, "workspace");
  const result = await evaluateSkills({
    root,
    workspace,
    target: { model: "target", provider: provider("some output") },
    judge: { model: "judge", provider: judgeProvider(true) },
    report: false,
  });
  assert.equal(result.skills.length, 1);
  assert.equal(result.skills[0].passRate, null);
});

test("generateReport shows a 'no assertions' badge (not a 100% one) for a zero-assertion skill", () => {
  const root = tempRoot();
  const workspace = path.join(root, "workspace");
  const skillDir = path.join(workspace, "ungraded-skill");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    path.join(skillDir, "meta.json"),
    JSON.stringify({ name: "ungraded-skill", slug: "ungraded-skill", relPath: "ungraded-skill", modes: ["with_skill"] }),
  );

  const runDir = path.join(skillDir, "eval-ungraded-case", "with_skill");
  mkdirSync(path.join(runDir, "outputs"), { recursive: true });
  writeFileSync(
    path.join(runDir, "grading.json"),
    JSON.stringify({ assertion_results: [], summary: { passed: 0, failed: 0, total: 0, pass_rate: null } }),
  );
  writeFileSync(path.join(runDir, "timing.json"), JSON.stringify({ total_tokens: 5, duration_ms: 10 }));
  writeFileSync(path.join(runDir, "outputs", "response.txt"), "some output");
  writeFileSync(path.join(runDir, "prompts.json"), JSON.stringify({ user: "do something", fileCount: 0 }));

  const result = generateReport({ workspace });
  assert.ok(existsSync(result.reportPath));

  const html = readFileSync(result.reportPath, "utf8");
  assert.match(html, /no assertions/);
  assert.doesNotMatch(html, /100\.0%/);
});

test("generateReport does not flag a regression when the with_skill run has zero assertions", () => {
  const root = tempRoot();
  const workspace = path.join(root, "workspace");
  const skillDir = path.join(workspace, "flaky-skill");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    path.join(skillDir, "meta.json"),
    JSON.stringify({ name: "flaky-skill", slug: "flaky-skill", relPath: "flaky-skill", modes: ["with_skill", "without_skill"] }),
  );

  const evalDir = path.join(skillDir, "eval-case");
  const withDir = path.join(evalDir, "with_skill");
  const withoutDir = path.join(evalDir, "without_skill");
  mkdirSync(path.join(withDir, "outputs"), { recursive: true });
  mkdirSync(path.join(withoutDir, "outputs"), { recursive: true });

  // with_skill: nothing graded (total: 0, pass_rate: null).
  writeFileSync(
    path.join(withDir, "grading.json"),
    JSON.stringify({ assertion_results: [], summary: { passed: 0, failed: 0, total: 0, pass_rate: null } }),
  );
  writeFileSync(path.join(withDir, "timing.json"), JSON.stringify({ total_tokens: 5, duration_ms: 10 }));
  writeFileSync(path.join(withDir, "outputs", "response.txt"), "with-skill output");
  writeFileSync(path.join(withDir, "prompts.json"), JSON.stringify({ user: "do it", fileCount: 0 }));

  // without_skill: a genuine pass.
  writeFileSync(
    path.join(withoutDir, "grading.json"),
    JSON.stringify({
      assertion_results: [{ text: "ok", passed: true, evidence: "ok" }],
      summary: { passed: 1, failed: 0, total: 1, pass_rate: 1 },
    }),
  );
  writeFileSync(path.join(withoutDir, "timing.json"), JSON.stringify({ total_tokens: 5, duration_ms: 10 }));
  writeFileSync(path.join(withoutDir, "outputs", "response.txt"), "without-skill output");
  writeFileSync(path.join(withoutDir, "prompts.json"), JSON.stringify({ user: "do it", fileCount: 0 }));

  const result = generateReport({ workspace });
  const html = readFileSync(result.reportPath, "utf8");
  assert.doesNotMatch(html, /baseline tied\/won/);
});

const PARAMS_WARNING = /targetParams\/judgeParams .* are not supported/;

test("evaluateSkills warns once when targetParams are dropped by a params-incapable provider, across multiple skills", async () => {
  const root = tempRoot();
  writeSkill(root, "skill-a");
  writeSkill(root, "skill-b");
  const workspace = path.join(root, "workspace");

  const writes = await captureStderr(() =>
    evaluateSkills({
      root,
      workspace,
      report: false,
      targetParams: { temperature: 0 },
      target: { model: "target", provider: provider("Top revenue months: Jan", { capabilities: { params: false } }) },
      judge: { model: "judge", provider: judgeProvider(true) },
    })
  );

  assert.equal(writes.filter((w) => PARAMS_WARNING.test(w)).length, 1);
});

test("evaluateSkills emits no params warning when no params are configured anywhere", async () => {
  const root = tempRoot();
  writeSkill(root);
  const workspace = path.join(root, "workspace");

  const writes = await captureStderr(() =>
    evaluateSkills({
      root,
      workspace,
      report: false,
      target: { model: "target", provider: provider("Top revenue months: Jan", { capabilities: { params: false } }) },
      judge: { model: "judge", provider: judgeProvider(true, { capabilities: { params: false } }) },
    })
  );

  assert.ok(!writes.some((w) => PARAMS_WARNING.test(w)));
});

test("evaluateSkills emits no params warning when the provider supports params (capabilities.params unset)", async () => {
  const root = tempRoot();
  writeSkill(root);
  const workspace = path.join(root, "workspace");

  const writes = await captureStderr(() =>
    evaluateSkills({
      root,
      workspace,
      report: false,
      targetParams: { temperature: 0 },
      judgeParams: { temperature: 0 },
      target: { model: "target", provider: provider("Top revenue months: Jan") },
      judge: { model: "judge", provider: judgeProvider(true) },
    })
  );

  assert.ok(!writes.some((w) => PARAMS_WARNING.test(w)));
});

test("evaluateSkills warns when only target params or only judge params are dropped", async () => {
  const root = tempRoot();
  writeSkill(root);

  const targetOnlyWrites = await captureStderr(() =>
    evaluateSkills({
      root,
      workspace: path.join(root, "workspace-target-only"),
      report: false,
      targetParams: { temperature: 0 },
      target: { model: "target", provider: provider("Top revenue months: Jan", { capabilities: { params: false } }) },
      judge: { model: "judge", provider: judgeProvider(true) },
    })
  );
  assert.equal(targetOnlyWrites.filter((w) => PARAMS_WARNING.test(w)).length, 1);

  const judgeOnlyWrites = await captureStderr(() =>
    evaluateSkills({
      root,
      workspace: path.join(root, "workspace-judge-only"),
      report: false,
      judgeParams: { temperature: 0 },
      target: { model: "target", provider: provider("Top revenue months: Jan") },
      judge: { model: "judge", provider: judgeProvider(true, { capabilities: { params: false } }) },
    })
  );
  assert.equal(judgeOnlyWrites.filter((w) => PARAMS_WARNING.test(w)).length, 1);
});

function writeSkillWithToolAssertions(root, name = "tool-skill") {
  const dir = path.join(root, name);
  mkdirSync(path.join(dir, "evals"), { recursive: true });
  writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: Skill with tool assertions.\n---\n\nBody.\n`);
  writeFileSync(path.join(dir, "evals", "evals.json"), JSON.stringify({
    skill_name: name,
    evals: [{
      id: 1,
      name: "case",
      prompt: "Do the thing.",
      assertions: ["ok"],
      tool_assertions: [{ type: "tool-not-called", name: "rm" }],
    }],
  }));
  return dir;
}

test("evaluateSkills warns when the target provider cannot report tool calls", async () => {
  const root = tempRoot();
  writeSkillWithToolAssertions(root);
  const nonReporting = provider("ok", { capabilities: { reportsToolCalls: false } });
  const writes = await captureStderr(() =>
    evaluateSkills({
      root,
      workspace: path.join(root, "workspace"),
      target: { model: "target", provider: nonReporting },
      judge: { model: "judge", provider: judgeProvider(true) },
      report: false,
    })
  );
  assert.ok(writes.some((w) => /tool_assertions are not supported/.test(w)));
});

test("evaluateSkills does not warn for opencode/claude-code-shaped capabilities (reportsToolCalls true, acceptsToolSchema false)", async () => {
  const root = tempRoot();
  writeSkillWithToolAssertions(root);
  const reportingNoSchema = provider("ok", { capabilities: { acceptsToolSchema: false, reportsToolCalls: true } });
  const writes = await captureStderr(() =>
    evaluateSkills({
      root,
      workspace: path.join(root, "workspace"),
      target: { model: "target", provider: reportingNoSchema },
      judge: { model: "judge", provider: judgeProvider(true) },
      report: false,
    })
  );
  assert.equal(writes.length, 0);
});
