#!/usr/bin/env node
// Fake `opencode run --format json` for tests. Reads the full prompt from
// stdin, inspects it for marker strings, and emits canned NDJSON events that
// mimic the real CLI's event shapes (see OpencodeProvider's parser).

function emit(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function emitStepFinishPair() {
  emit({
    type: "step_finish",
    part: { type: "step-finish", tokens: { input: 100, output: 10, reasoning: 5 }, cost: 0.001 },
  });
  emit({
    type: "step_finish",
    part: { type: "step-finish", tokens: { input: 50, output: 7, reasoning: 3 }, cost: 0.0005 },
  });
}

let stdin = "";
process.stdin.setEncoding("utf-8");
process.stdin.on("data", (chunk) => {
  stdin += chunk;
});
process.stdin.on("end", () => {
  if (stdin.includes("__FAKE_OPENCODE_ERROR__")) {
    emit({ type: "error", error: { name: "UnknownError", data: { message: "fake opencode error" } } });
    process.exit(1);
  }

  if (stdin.includes("__FAKE_OPENCODE_HANG__")) {
    // Never write output, never exit — keeps the event loop alive so the
    // caller's timeout/kill path can be exercised.
    setInterval(() => {}, 1000);
    return;
  }

  if (stdin.includes("__FAKE_OPENCODE_ECHO_ARGV__")) {
    emit({ type: "text", part: { id: "p1", text: JSON.stringify(process.argv.slice(2)) } });
    emitStepFinishPair();
    process.exit(0);
  }

  if (stdin.includes("__FAKE_OPENCODE_ECHO_STDIN__")) {
    const echoed = stdin.replace("__FAKE_OPENCODE_ECHO_STDIN__", "").trim();
    emit({ type: "text", part: { id: "p1", text: echoed } });
    emitStepFinishPair();
    process.exit(0);
  }

  const assertionsMatch = stdin.match(/Assertions:\n([\s\S]*?)\nModel output:/);
  if (assertionsMatch) {
    let assertions = [];
    try {
      assertions = JSON.parse(assertionsMatch[1]);
    } catch {
      assertions = [];
    }
    const assertionResults = assertions.map((text) => ({
      text,
      passed: true,
      evidence: "fake judge: assumed satisfied",
    }));
    const passed = assertionResults.length;
    const grading = {
      assertion_results: assertionResults,
      summary: { passed, failed: 0, total: passed, pass_rate: passed > 0 ? 1 : 0 },
    };
    emit({ type: "text", part: { id: "p1", text: JSON.stringify(grading) } });
    emitStepFinishPair();
    process.exit(0);
  }

  emit({ type: "text", part: { id: "p1", text: "FAKE_OPENCODE_OK" } });
  emitStepFinishPair();
  process.exit(0);
});
