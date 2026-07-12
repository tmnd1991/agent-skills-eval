/**
 * Single source of truth for the on-disk run-artifact layout: file/directory
 * paths and naming conventions shared by every writer (`artifacts.ts`,
 * `evaluate-skills.ts`) and reader (`report.ts`). See
 * `plan-21-report-artifacts-implicit-contract-dead-fallback.md` (removed) for
 * the rationale — the two sides used to hand-match string literals with no
 * shared contract, which had already silently drifted once.
 */
import path from "node:path";
import type { RunMode } from "./types.js";

export const RUN_MODES: readonly RunMode[] = ["with_skill", "without_skill"];
export const EVAL_DIR_PREFIX = "eval-";

export function isEvalDirName(name: string): boolean {
  return name.startsWith(EVAL_DIR_PREFIX);
}

// --- skill-level paths (parent: skillDir) ---
export const metaJsonPath = (skillDir: string) => path.join(skillDir, "meta.json");
export const benchmarkJsonPath = (skillDir: string) => path.join(skillDir, "benchmark.json");

// --- run-level paths (parent: runDir = <evalDir>/<mode>) ---
export const runDirFor = (evalDir: string, mode: RunMode) => path.join(evalDir, mode);
export const timingJsonPath = (runDir: string) => path.join(runDir, "timing.json");
export const gradingJsonPath = (runDir: string) => path.join(runDir, "grading.json");
export const promptsJsonPath = (runDir: string) => path.join(runDir, "prompts.json");
export const toolCallsJsonPath = (runDir: string) => path.join(runDir, "tool_calls.json");
export const outputsDirPath = (runDir: string) => path.join(runDir, "outputs");
export const responseTxtPath = (runDir: string) => path.join(outputsDirPath(runDir), "response.txt");
