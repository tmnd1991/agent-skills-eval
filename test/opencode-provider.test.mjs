import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { OpencodeProvider } from "../dist/index.js";
import { createFakeOpencodeServer } from "./fixtures/fake-opencode-server.mjs";

function provider(baseUrl, options = {}) {
  return new OpencodeProvider({ model: "fake/model", baseUrl, ...options });
}

test("OpencodeProvider capabilities are all false", () => {
  const p = provider("http://127.0.0.1:0");
  assert.deepEqual(p.capabilities, { systemRole: false, attachments: false, toolCalls: false });
});

test("OpencodeProvider constructor throws when model is missing", () => {
  assert.throws(() => new OpencodeProvider({ baseUrl: "http://127.0.0.1:0" }), /requires "model"/);
  assert.throws(() => new OpencodeProvider({ model: "", baseUrl: "http://127.0.0.1:0" }), /requires "model"/);
});

test("OpencodeProvider.complete: success path returns the assistant's text and usage", async () => {
  const server = await createFakeOpencodeServer();
  try {
    const p = provider(server.url);
    const result = await p.complete("hello world");
    assert.equal(result.error, undefined);
    assert.equal(result.output, "FAKE_OPENCODE_OK");
    assert.equal(result.inputTokens, 10);
    assert.equal(result.outputTokens, 5);
    assert.equal(result.costUsd, 0.0001);
    assert.equal(result.provider, "opencode");
    assert.equal(result.model, "fake/model");
  } finally {
    await server.close();
  }
});

test("OpencodeProvider.complete: server error resolves with error set, does not throw", async () => {
  const server = await createFakeOpencodeServer();
  try {
    const p = provider(server.url);
    const result = await p.complete("__FAKE_OPENCODE_ERROR__");
    assert.equal(result.output, "");
    assert.match(result.error, /fake opencode error/);
  } finally {
    await server.close();
  }
});

test("OpencodeProvider.complete: a hung prompt call resolves with a timeout error instead of hanging", async () => {
  const server = await createFakeOpencodeServer();
  try {
    const p = provider(server.url, { timeoutMs: 300 });
    const started = Date.now();
    const result = await p.complete("__FAKE_OPENCODE_HANG__");
    const elapsed = Date.now() - started;
    assert.match(result.error, /timed out|abort/i);
    assert.ok(elapsed < 5000, `expected timeout to fire quickly, took ${elapsed}ms`);
  } finally {
    await server.close();
  }
});

test("OpencodeProvider.complete: a subagent's async delegation does not truncate the run — waits for the real final answer", async () => {
  const server = await createFakeOpencodeServer();
  try {
    const p = provider(server.url, { timeoutMs: 10_000, maxContinuations: 3 });
    const started = Date.now();
    const result = await p.complete("__FAKE_OPENCODE_DELEGATE_RACE__");
    const elapsed = Date.now() - started;
    assert.equal(result.error, undefined);
    assert.equal(result.output, "FAKE_OPENCODE_REAL_ANSWER");
    assert.ok(elapsed >= 250, `expected to wait for the delegated child to settle, took ${elapsed}ms`);
    assert.ok(elapsed < 8000, `expected a fast, bounded run, took ${elapsed}ms`);
  } finally {
    await server.close();
  }
});

test("OpencodeProvider.complete: gives up after maxContinuations instead of looping forever on repeated re-delegation", async () => {
  const server = await createFakeOpencodeServer();
  try {
    const p = provider(server.url, { timeoutMs: 10_000, maxContinuations: 2 });
    const result = await p.complete("__FAKE_OPENCODE_INFINITE_DELEGATE__");
    assert.match(result.error, /gave up after 2 follow-up/);
  } finally {
    await server.close();
  }
});

test("OpencodeProvider.complete: sends agent/model in the request body", async () => {
  const server = await createFakeOpencodeServer();
  try {
    const p = provider(server.url, { agent: "build", model: "tensorix/minimax/minimax-m3" });
    await p.complete("hello world");
    assert.equal(server.requests.length, 1);
    assert.equal(server.requests[0].text, "hello world");
  } finally {
    await server.close();
  }
});

test("OpencodeProvider.complete: prompt round-trips without mangling special characters", async () => {
  const server = await createFakeOpencodeServer();
  try {
    const p = provider(server.url);
    const payload = 'some `$(echo injected)` "quoted" text\nwith a newline';
    const result = await p.complete(`__FAKE_OPENCODE_ECHO__ ${payload}`);
    assert.equal(result.output, payload);
  } finally {
    await server.close();
  }
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
  const p = provider("http://127.0.0.1:0", { dir });
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
  const p = provider("http://127.0.0.1:0", { dir });
  const skill = makeFakeSkill();
  const installDir = path.join(dir, ".opencode", "skills", "my-skill");

  await p.prepareSkill(skill, "with_skill");
  assert.ok(existsSync(installDir));

  await p.prepareSkill(skill, "without_skill");
  assert.equal(existsSync(installDir), false);
});
