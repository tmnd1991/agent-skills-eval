import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { OpencodeProvider } from "../dist/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.join(__dirname, "fixtures", "fake-opencode.mjs");
chmodSync(fixturePath, 0o755);

function provider(options = {}) {
  return new OpencodeProvider({ model: "fake/model", command: fixturePath, ...options });
}

test("OpencodeProvider capabilities are all false", () => {
  const p = provider();
  assert.deepEqual(p.capabilities, { systemRole: false, attachments: false, toolCalls: false });
});

test("OpencodeProvider constructor throws when model is missing", () => {
  assert.throws(() => new OpencodeProvider({ command: fixturePath }), /requires "model"/);
  assert.throws(() => new OpencodeProvider({ model: "", command: fixturePath }), /requires "model"/);
});

test("OpencodeProvider.complete: success path sums tokens/cost across step_finish events", async () => {
  const p = provider();
  const result = await p.complete("hello world");
  assert.equal(result.error, undefined);
  assert.equal(result.output, "FAKE_OPENCODE_OK");
  assert.equal(result.inputTokens, 150);
  assert.equal(result.outputTokens, 25);
  assert.equal(result.costUsd, 0.0015);
  assert.equal(result.provider, "opencode");
  assert.equal(result.model, "fake/model");
});

test("OpencodeProvider.complete: error event resolves with error set, does not throw", async () => {
  const p = provider();
  const result = await p.complete("__FAKE_OPENCODE_ERROR__");
  assert.equal(result.output, "");
  assert.match(result.error, /fake opencode error/);
});

test("OpencodeProvider.complete: timeout kills the subprocess and resolves with an error", async () => {
  const p = provider({ timeoutMs: 200 });
  const started = Date.now();
  const result = await p.complete("__FAKE_OPENCODE_HANG__");
  const elapsed = Date.now() - started;
  assert.match(result.error, /timed out/);
  assert.ok(elapsed < 5000, `expected timeout to fire quickly, took ${elapsed}ms`);
});

test("OpencodeProvider.complete: kills the process shortly after the completion signal instead of waiting out the full timeout", async () => {
  const p = provider({ timeoutMs: 60_000 });
  const started = Date.now();
  const result = await p.complete("__FAKE_OPENCODE_HANG_AFTER_STOP__");
  const elapsed = Date.now() - started;
  assert.equal(result.error, undefined);
  assert.equal(result.output, "FAKE_OPENCODE_OK");
  assert.ok(elapsed < 10_000, `expected early kill well before the 60s timeout, took ${elapsed}ms`);
});


test("OpencodeProvider.complete: passes agent/dir/auto through to argv", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "opencode-test-"));
  const p = provider({ agent: "build", dir, auto: true });
  const result = await p.complete("__FAKE_OPENCODE_ECHO_ARGV__");
  const argv = JSON.parse(result.output);
  assert.ok(argv.includes("--model"));
  assert.ok(argv.includes("fake/model"));
  assert.ok(argv.includes("--agent"));
  assert.ok(argv.includes("build"));
  assert.ok(argv.includes("--dir"));
  assert.ok(argv.includes(dir));
  assert.ok(argv.includes("--auto"));
});

test("OpencodeProvider.complete: prompt round-trips through stdin without shell interpretation", async () => {
  const p = provider();
  const payload = 'some `$(echo injected)` "quoted" text\nwith a newline';
  const result = await p.complete(`__FAKE_OPENCODE_ECHO_STDIN__ ${payload}`);
  assert.equal(result.output, payload);
});

function makeFakeSkill() {
  const skillDir = mkdtempSync(path.join(tmpdir(), "opencode-skill-"));
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

test("OpencodeProvider.prepareSkill: with_skill symlinks every skill-dir entry except evals/", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "opencode-dir-"));
  const p = provider({ dir });
  const skill = makeFakeSkill();
  const installDir = path.join(dir, ".opencode", "skills", "my-skill");

  await p.prepareSkill(skill, "with_skill");

  assert.ok(lstatSync(path.join(installDir, "SKILL.md")).isSymbolicLink());
  assert.equal(readlinkSync(path.join(installDir, "SKILL.md")), path.join(skill.dir, "SKILL.md"));
  assert.ok(lstatSync(path.join(installDir, "references")).isSymbolicLink());
  assert.ok(lstatSync(path.join(installDir, "scripts")).isSymbolicLink());
  assert.ok(lstatSync(path.join(installDir, "LICENSE")).isSymbolicLink());
  assert.equal(existsSync(path.join(installDir, "evals")), false);

  await p.cleanupSkill(skill, "with_skill");
  assert.equal(existsSync(installDir), false);
});

test("OpencodeProvider.prepareSkill: without_skill installs nothing and removes any prior install", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "opencode-dir-"));
  const p = provider({ dir });
  const skill = makeFakeSkill();
  const installDir = path.join(dir, ".opencode", "skills", "my-skill");

  await p.prepareSkill(skill, "with_skill");
  assert.ok(existsSync(installDir));

  await p.prepareSkill(skill, "without_skill");
  assert.equal(existsSync(installDir), false);
});
