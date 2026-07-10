#!/usr/bin/env node
// Fake `claude` binary for tests. Reads the prompt from stdin (matching how
// ClaudeCodeProvider feeds it) and emits an NDJSON transcript on stdout
// shaped like real `claude -p --output-format stream-json --verbose`
// output, scripted by marker strings in the prompt text — mirroring
// test/fixtures/fake-opencode-server.mjs's approach for OpencodeProvider,
// but faking a subprocess instead of an HTTP server.
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const prompt = readFileSync(0, "utf-8");

function flagValue(name) {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
}

function write(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function resultEvent(overrides = {}) {
  return {
    type: "result",
    subtype: overrides.is_error ? "error_during_execution" : "success",
    is_error: false,
    result: "",
    total_cost_usd: 0.0001,
    usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    ...overrides,
  };
}

function assistantTextEvent(text) {
  return { type: "assistant", message: { content: [{ type: "text", text }] } };
}

function assistantToolUseEvent(name, input) {
  return { type: "assistant", message: { content: [{ type: "tool_use", id: "toolu_fake_1", name, input }] } };
}

write({ type: "system", subtype: "init", model: flagValue("--model") ?? "fake-model" });

if (prompt.includes("__FAKE_CLAUDE_HANG__")) {
  // Never emits a result and never exits on its own — installs no signal
  // handlers, so the default SIGTERM action (immediate termination) applies
  // when the caller's timeout fires.
  setInterval(() => {}, 1 << 30);
} else if (prompt.includes("__FAKE_CLAUDE_ERROR__")) {
  write(resultEvent({ is_error: true, result: "fake claude-code error" }));
  process.exit(1);
} else if (prompt.includes("__FAKE_CLAUDE_NO_RESULT__")) {
  write(assistantTextEvent("partial output before crash"));
  process.exit(1);
} else if (prompt.includes("__FAKE_CLAUDE_TOOL_CALL__")) {
  write(assistantToolUseEvent("Skill", { skill: "quick-review" }));
  write(assistantTextEvent("Review complete."));
  write(resultEvent({ result: "Review complete." }));
} else if (prompt.includes("__FAKE_CLAUDE_ARGS__")) {
  write(resultEvent({ result: JSON.stringify(args) }));
} else if (prompt.includes("__FAKE_CLAUDE_ECHO__ ")) {
  const payload = prompt.slice(prompt.indexOf("__FAKE_CLAUDE_ECHO__ ") + "__FAKE_CLAUDE_ECHO__ ".length);
  write(resultEvent({ result: payload }));
} else if (/Assertions:\n[\s\S]*?\nModel output:/.test(prompt)) {
  // Judge grading call (see grade.ts's renderRubricPrompt) — answer every
  // assertion as satisfied so CLI integration tests can exercise a full
  // with_skill/without_skill run without a real judge model.
  const match = prompt.match(/Assertions:\n([\s\S]*?)\nModel output:/);
  let assertions = [];
  try {
    assertions = match ? JSON.parse(match[1]) : [];
  } catch {
    assertions = [];
  }
  const assertionResults = assertions.map((a) => ({ text: a, passed: true, evidence: "fake judge: assumed satisfied" }));
  const passed = assertionResults.length;
  const grading = {
    assertion_results: assertionResults,
    summary: { passed, failed: 0, total: passed, pass_rate: passed > 0 ? 1 : 0 },
  };
  write(resultEvent({ result: JSON.stringify(grading) }));
} else {
  write(assistantTextEvent("FAKE_CLAUDE_OK"));
  write(resultEvent({ result: "FAKE_CLAUDE_OK" }));
}
