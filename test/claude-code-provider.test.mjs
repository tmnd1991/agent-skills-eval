import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ClaudeCodeProvider } from "../dist/index.js";

const FAKE_BINARY = fileURLToPath(new URL("./fixtures/fake-claude-code-binary.mjs", import.meta.url));

function provider(options = {}) {
  return new ClaudeCodeProvider({ model: "fake-model", claudeBinary: FAKE_BINARY, ...options });
}

test("ClaudeCodeProvider capabilities: no attachments/systemRole/toolCalls, shared install dir", () => {
  const p = provider();
  assert.deepEqual(p.capabilities, { systemRole: false, attachments: false, toolCalls: false, sharedInstallDir: true });
});

test("ClaudeCodeProvider constructor throws when model is missing", () => {
  assert.throws(() => new ClaudeCodeProvider({ claudeBinary: FAKE_BINARY }), /requires "model"/);
  assert.throws(() => new ClaudeCodeProvider({ model: "", claudeBinary: FAKE_BINARY }), /requires "model"/);
});

test("ClaudeCodeProvider.complete: success path returns the assistant's text and usage", async () => {
  const p = provider();
  const result = await p.complete("hello world");
  assert.equal(result.error, undefined);
  assert.equal(result.output, "FAKE_CLAUDE_OK");
  assert.equal(result.inputTokens, 10);
  assert.equal(result.outputTokens, 5);
  assert.equal(result.costUsd, 0.0001);
  assert.equal(result.provider, "claude-code");
  assert.equal(result.model, "fake-model");
});

test("ClaudeCodeProvider.complete: a failed run resolves with error set, does not throw", async () => {
  const p = provider();
  const result = await p.complete("__FAKE_CLAUDE_ERROR__");
  assert.equal(result.output, "fake claude-code error");
  assert.match(result.error, /fake claude-code error/);
});

test("ClaudeCodeProvider.complete: a hung run is killed and resolves with a timeout error instead of hanging", async () => {
  const p = provider({ timeoutMs: 300 });
  const started = Date.now();
  const result = await p.complete("__FAKE_CLAUDE_HANG__");
  const elapsed = Date.now() - started;
  assert.match(result.error, /timed out/i);
  assert.ok(elapsed < 5000, `expected timeout to fire quickly, took ${elapsed}ms`);
});

test("ClaudeCodeProvider.complete: a run that exits without a result event surfaces a diagnostic error", async () => {
  const p = provider();
  const result = await p.complete("__FAKE_CLAUDE_NO_RESULT__");
  assert.equal(result.output, "");
  assert.match(result.error, /produced no result/);
});

test("ClaudeCodeProvider.complete: captures tool calls, including a skill invocation with its parsed arguments", async () => {
  const p = provider();
  const result = await p.complete("__FAKE_CLAUDE_TOOL_CALL__");
  assert.equal(result.error, undefined);
  assert.equal(result.output, "Review complete.");
  const skillCall = result.toolCalls?.find((c) => c.function.name === "Skill");
  assert.ok(skillCall, "expected a Skill tool call to be captured");
  assert.equal(skillCall.parsedArguments.skill, "quick-review");
});

test("ClaudeCodeProvider.complete: forwards model/agent/auto/allowedTools/disallowedTools as CLI flags", async () => {
  const p = provider({
    model: "fake-model",
    agent: "build",
    auto: true,
    allowedTools: ["Bash", "Read"],
    disallowedTools: ["WebFetch"],
  });
  const result = await p.complete("__FAKE_CLAUDE_ARGS__");
  assert.equal(result.error, undefined);
  const forwardedArgs = JSON.parse(result.output);
  assert.ok(forwardedArgs.includes("--dangerously-skip-permissions"));
  assert.deepEqual(forwardedArgs.slice(forwardedArgs.indexOf("--agent") + 1, forwardedArgs.indexOf("--agent") + 2), ["build"]);
  assert.deepEqual(
    forwardedArgs.slice(forwardedArgs.indexOf("--model") + 1, forwardedArgs.indexOf("--model") + 2),
    ["fake-model"]
  );
  assert.deepEqual(
    forwardedArgs.slice(forwardedArgs.indexOf("--allowedTools") + 1, forwardedArgs.indexOf("--allowedTools") + 2),
    ["Bash Read"]
  );
  assert.deepEqual(
    forwardedArgs.slice(
      forwardedArgs.indexOf("--disallowedTools") + 1,
      forwardedArgs.indexOf("--disallowedTools") + 2
    ),
    ["WebFetch"]
  );
});

test("ClaudeCodeProvider.complete: prompt round-trips over stdin without mangling special characters", async () => {
  const p = provider();
  const payload = 'some `$(echo injected)` "quoted" text\nwith a newline';
  const result = await p.complete(`__FAKE_CLAUDE_ECHO__ ${payload}`);
  assert.equal(result.output, payload);
});

function makeFakeSkill() {
  const skillDir = mkdtempSync(path.join(tmpdir(), "claude-code-skill-"));
  writeFileSync(path.join(skillDir, "SKILL.md"), "---\nname: my-skill\ndescription: test\n---\nbody");
  mkdirSync(path.join(skillDir, "references"));
  writeFileSync(path.join(skillDir, "references", "notes.md"), "notes");
  mkdirSync(path.join(skillDir, "scripts"));
  writeFileSync(path.join(skillDir, "scripts", "helper.sh"), "#!/bin/sh\necho hi");
  writeFileSync(path.join(skillDir, "LICENSE"), "MIT");
  mkdirSync(path.join(skillDir, "evals"));
  writeFileSync(path.join(skillDir, "evals", "evals.json"), '{"evals":[]}');
  return { name: "my-skill", dir: skillDir };
}

test("ClaudeCodeProvider.prepareSkill: with_skill symlinks every skill-dir entry except evals/", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "claude-code-dir-"));
  const p = provider({ dir });
  const skill = makeFakeSkill();
  const installDir = path.join(dir, ".claude", "skills", "my-skill");

  await p.prepareSkill(skill, "with_skill");

  assert.ok(lstatSync(path.join(installDir, "SKILL.md")).isSymbolicLink());
  assert.equal(readlinkSync(path.join(installDir, "SKILL.md")), path.join(skill.dir, "SKILL.md"));
  assert.ok(lstatSync(path.join(installDir, "references")).isSymbolicLink());
  assert.ok(lstatSync(path.join(installDir, "scripts")).isSymbolicLink());
  assert.ok(lstatSync(path.join(installDir, "LICENSE")).isSymbolicLink());
  assert.equal(existsSync(path.join(installDir, "evals")), false);

  await p.cleanupSkill(skill);
  assert.equal(existsSync(installDir), false);
});

test("ClaudeCodeProvider.prepareSkill: without_skill installs nothing and removes any prior install", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "claude-code-dir-"));
  const p = provider({ dir });
  const skill = makeFakeSkill();
  const installDir = path.join(dir, ".claude", "skills", "my-skill");

  await p.prepareSkill(skill, "with_skill");
  assert.ok(existsSync(installDir));

  await p.prepareSkill(skill, "without_skill");
  assert.equal(existsSync(installDir), false);
});

test("ClaudeCodeProvider.prepareSkill: rejects a skill name that escapes the skills directory", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "claude-code-dir-"));
  const p = provider({ dir });
  const skill = { ...makeFakeSkill(), name: "../../../../tmp/pwned-claude-code" };
  const escapedDir = path.join(tmpdir(), "tmp", "pwned-claude-code");

  await assert.rejects(() => p.prepareSkill(skill, "with_skill"), /escapes skills directory/);
  assert.equal(existsSync(escapedDir), false);
});

test("ClaudeCodeProvider.cleanupSkill: rejects a skill name that escapes the skills directory", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "claude-code-dir-"));
  const p = provider({ dir });
  const skill = { ...makeFakeSkill(), name: "../../../../tmp/pwned-claude-code-cleanup" };
  const escapedDir = path.join(tmpdir(), "tmp", "pwned-claude-code-cleanup");

  await assert.rejects(() => p.cleanupSkill(skill), /escapes skills directory/);
  assert.equal(existsSync(escapedDir), false);
});
