import path from "node:path";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import type { Provider } from "./provider.js";
import {
  allocateHistoryIteration,
  allocateIterationWorkspace,
  buildBenchmark,
  ensureSkillWorkspaceDir,
  snapshotSkillToHistory,
} from "./artifacts.js";
import { consoleReporter } from "./console-reporter.js";
import { discoverSkills, type SkillRef } from "./discover.js";
import { generateReport } from "./report.js";
import { evalSlug, runEval, type RunMode } from "./run-eval.js";
import { loadSkill } from "./skill.js";
import { slugify } from "./fs-utils.js";
import type { AgentSkillsEval, Skill, SkillsEvent } from "./types.js";

export interface EvaluateSkillsArgs {
  root: string;
  workspace: string;
  baseline?: boolean;
  target: { model: string; provider: Provider };
  judge: { model: string; provider: Provider };
  include?: string[];
  exclude?: string[];
  /**
   * Caller-level inference param defaults applied to every case's target
   * model. Lowest precedence — a skill's `defaults.target.params` and a
   * case's own `params` block both override this.
   */
  targetParams?: Record<string, unknown>;
  /** Same idea for the judge model. */
  judgeParams?: Record<string, unknown>;
  /**
   * Structured progress events. If neither `onEvent` nor `onLog` is provided,
   * the bundled rich `consoleReporter()` is used as a default so CLI users
   * see prompts, outputs, assertions, and timings out of the box.
   */
  onEvent?: (event: SkillsEvent) => void;
  /** Legacy flat-string log stream. Suppressed when `onEvent` is supplied. */
  onLog?: (line: string) => void;
  /**
   * Loop / EDD mode: in addition to the canonical flat layout, snapshot every
   * skill's freshly-written workspace directory into
   * `<workspace>/.history/iteration-N/<slug>/` so successive runs can be
   * compared. Off by default. Useful only for developers iterating on a skill.
   */
  loop?: boolean;
  /**
   * Render an NYC-style HTML report at `<workspace>/report/index.html` after
   * evaluation completes. Default true; pass `false` to skip.
   */
  report?: boolean;
  /** Optional report title. */
  reportTitle?: string;
  /** Optional report output directory. Defaults to `<workspace>/report`. */
  reportOutput?: string;
  /**
   * Maximum number of eval cases run in parallel. Defaults to 4. Each
   * in-flight case makes one target call + one judge call to the configured
   * providers, so effective concurrent gateway requests is up to 2× this
   * number. Pass `1` to restore strict-serial behavior (handy for debugging).
   */
  concurrency?: number;
  /**
   * Artifact layout. "iteration" follows agentskills.io:
   * `<workspace>/iteration-N/<eval>/<mode>/...` for one skill, or
   * `<workspace>/iteration-N/<skill>/<eval>/<mode>/...` for multiple skills.
   * "flat" keeps the Bench AI-style current-run layout:
   * `<workspace>/<skill>/<eval>/<mode>/...`. Default: "flat" for backwards
   * compatibility; the CLI defaults to "iteration".
   */
  workspaceLayout?: "flat" | "iteration";
  /**
   * Validate SKILL.md frontmatter against agentskills.io naming and metadata
   * requirements before running. Default false for compatibility with legacy
   * local skills.
   */
  strict?: boolean;
}

export interface EvaluateSkillsResult {
  passed: number;
  failed: number;
  /** Number of (eval, mode) runs that failed with an infra error rather than completing a grading run. */
  errored: number;
  skills: {
    skill: string;
    slug: string;
    relPath: string;
    evals: number;
    passRate: number | null;
    benchmarkPath: string;
    errored: number;
  }[];
  /** Set when `loop: true` — the freshly-allocated `.history/iteration-N` slot. */
  historyIteration?: number;
  /** Set when `workspaceLayout: "iteration"` — the official eval iteration slot. */
  iteration?: number;
  /** Root directory that contains the artifacts for this run. */
  workspaceRoot: string;
  /** Set when `report` is enabled (default true). */
  reportPath?: string;
}

interface PreparedSkill {
  ref: SkillRef;
  skill: Skill;
  slug: string;
  skillDir: string;
  aggregateRuns: { mode: RunMode; passRate: number | null; durationMs: number; tokens: number }[];
  passed: number;
  failed: number;
  errored: number;
  completed: number;
}

interface Task {
  prepared: PreparedSkill;
  evalCase: AgentSkillsEval;
  index: number;
}

/**
 * Tiny bounded-concurrency worker pool. Each worker grabs the next item off a
 * shared FIFO queue and runs `work` on it; resolves once the queue is drained.
 * Order of completion is non-deterministic across items.
 */
async function runPool<T>(items: T[], n: number, work: (t: T) => Promise<void>): Promise<void> {
  const queue = items.slice();
  const workers = Array.from({ length: Math.max(1, Math.min(n, items.length)) }, async () => {
    while (queue.length > 0) {
      const next = queue.shift();
      if (next === undefined) return;
      // Defense in depth: `work` should isolate its own errors (it does, via
      // the try/catch/finally in `runTask` below), but a future caller that
      // forgets to catch inside `work` shouldn't be able to abort every
      // sibling task in the pool via `Promise.all`.
      try {
        await work(next);
      } catch (err) {
        console.error(err);
      }
    }
  });
  await Promise.all(workers);
}

/**
 * Per-key async mutex: withLock(k, fn) waits for any prior withLock(k, ...)
 * to settle before running fn. Distinct keys never block each other.
 */
function createKeyedLock(): <T>(key: string, fn: () => Promise<T>) => Promise<T> {
  const tail = new Map<string, Promise<void>>();
  return function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = tail.get(key) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    tail.set(
      key,
      run.then(
        () => undefined,
        () => undefined
      )
    );
    return run;
  };
}

export async function evaluateSkills(args: EvaluateSkillsArgs): Promise<EvaluateSkillsResult> {
  const refs = discoverSkills(args.root, { include: args.include, exclude: args.exclude }).filter((ref) => ref.hasEvals);
  const modes: RunMode[] = args.baseline ? ["with_skill", "without_skill"] : ["with_skill"];
  const workspaceLayout = args.workspaceLayout ?? "flat";
  const runWorkspace =
    workspaceLayout === "iteration"
      ? allocateIterationWorkspace(args.workspace)
      : { dir: args.workspace, iteration: undefined as number | undefined };

  // Default to the bundled rich reporter when the caller didn't wire any
  // observability — keeps the out-of-the-box CLI experience informative.
  const emit: ((event: SkillsEvent) => void) | undefined = args.onEvent
    ? args.onEvent
    : args.onLog
      ? undefined
      : consoleReporter();

  const concurrency = Math.max(1, args.concurrency ?? 4);

  // A provider that can't report which tools were actually called has no way
  // to grade tool_assertions, so those assertions would always grade against
  // an empty tool-call list. Warn once so failures aren't mistaken for model
  // regressions.
  const supportsToolAssertions =
    args.target.provider.capabilities?.reportsToolCalls !== false &&
    args.judge.provider.capabilities?.reportsToolCalls !== false;
  let warnedToolAssertions = false;

  // prepareSkill/cleanupSkill are only ever invoked on the target provider
  // (never the judge — see run-eval.ts), so only its capability matters here.
  const serializeSkillInstalls = args.target.provider.capabilities?.sharedInstallDir === true;
  if (serializeSkillInstalls && concurrency > 1) {
    process.stderr.write(
      "info: this provider installs skills at one shared on-disk path per skill name — evals of the same skill are automatically serialized regardless of --concurrency to avoid corrupting concurrent installs; evals of different skills still run up to --concurrency in parallel (see README \"Shared working directory\").\n"
    );
  }

  // Providers such as OpencodeProvider/ClaudeCodeProvider route calls through
  // a subprocess CLI rather than a chat-completions API, so there's no
  // channel to carry per-call inference params. Warn once so a caller relying
  // on e.g. `temperature: 0` for reproducibility isn't silently ignored
  // (see README caveats).
  const supportsTargetParams = args.target.provider.capabilities?.params !== false;
  const supportsJudgeParams = args.judge.provider.capabilities?.params !== false;
  let warnedParams = false;
  // CLI-wrapper providers (opencode, claude-code) fold their own system-prompt/
  // tool-schema overhead into the token counts they report, so the Δ vs
  // baseline "tokens" figure isn't apples-to-apples with --run-mode api. Warn
  // once so the report's token delta isn't mistaken for pure skill overhead
  // (see README caveats).
  const overheadProviders = new Set(["opencode", "claude-code"]);
  const overheadProviderName = overheadProviders.has(args.target.provider.name)
    ? args.target.provider.name
    : overheadProviders.has(args.judge.provider.name)
      ? args.judge.provider.name
      : undefined;
  if (args.baseline && overheadProviderName) {
    process.stderr.write(
      `warning: token totals from --run-mode ${overheadProviderName} include that CLI's own system-prompt/tool-schema overhead and aren't apples-to-apples with --run-mode api; the Δ vs baseline "tokens" figure in the HTML report and end-of-run summary reflects that overhead too, not just the skill's own usage — see README "opencode run mode"/"claude-code run mode" caveats.\n`
    );
  }

  // ─── Phase 1: sequential discovery prep ───────────────────────────────────
  // Allocate skillDir + write meta.json + emit suite-start in discovery order
  // so the start-of-run banner is stable run-to-run regardless of pool size.
  const prepared: PreparedSkill[] = [];
  for (const ref of refs) {
    args.onLog?.(`skill ${ref.name}: loading ${ref.relPath}`);
    const skill = loadSkill(ref.dir, { strict: args.strict });
    if (
      !supportsToolAssertions &&
      !warnedToolAssertions &&
      skill.evals.some((e) => e.tool_assertions && e.tool_assertions.length > 0)
    ) {
      process.stderr.write(
        "warning: tool_assertions are not supported by the current provider and will always grade against an empty tool-call list — this provider cannot report which tools were called.\n"
      );
      warnedToolAssertions = true;
    }
    const hasNonEmpty = (p?: Record<string, unknown>) => Boolean(p && Object.keys(p).length > 0);
    const targetParamsDropped =
      !supportsTargetParams &&
      (hasNonEmpty(args.targetParams) ||
        hasNonEmpty(skill.defaults?.target?.params) ||
        skill.evals.some((e) => hasNonEmpty(e.params)));
    const judgeParamsDropped =
      !supportsJudgeParams &&
      (hasNonEmpty(args.judgeParams) || hasNonEmpty(skill.defaults?.judge?.params));
    if (!warnedParams && (targetParamsDropped || judgeParamsDropped)) {
      process.stderr.write(
        "warning: targetParams/judgeParams (e.g. temperature, top_p) are not supported by the current provider and will be silently ignored (e.g. --run-mode opencode or --run-mode claude-code) — see README \"opencode run mode\"/\"claude-code run mode\" caveats.\n"
      );
      warnedParams = true;
    }
    const slug = slugify(skill.name);
    const skillDir =
      workspaceLayout === "flat"
        ? ensureSkillWorkspaceDir(runWorkspace.dir, slug)
        : refs.length === 1
          ? prepareIterationSkillDir(runWorkspace.dir)
          : prepareIterationSkillDir(path.join(runWorkspace.dir, slug));
    writeFileSync(
      path.join(skillDir, "meta.json"),
      `${JSON.stringify(
        {
          name: skill.name,
          slug,
          relPath: ref.relPath,
          target: args.target.model,
          judge: args.judge.model,
          modes,
          generated_at: new Date().toISOString(),
        },
        null,
        2
      )}\n`,
      "utf-8"
    );

    emit?.({
      type: "suite-start",
      skill: skill.name,
      relPath: ref.relPath,
      evalsCount: skill.evals.length,
      modes,
      target: args.target.model,
      judge: args.judge.model,
    });

    prepared.push({ ref, skill, slug, skillDir, aggregateRuns: [], passed: 0, failed: 0, errored: 0, completed: 0 });
  }

  // ─── Phase 2: flatten (skill, evalCase) tasks + run via worker pool ───────
  // Cross-skill ordering note: with concurrency > 1, suite-end for skill A
  // may fire before suite-end for skill B even if A appears later in
  // discovery — completion order tracks the pool, not the discovery walk.
  // Per-eval ordering is preserved: eval-start strictly precedes exactly one
  // of eval-end/eval-error for the same case (enforced inside runEval).
  const tasks: Task[] = [];
  for (const p of prepared) {
    if (p.skill.evals.length === 0) {
      // No evals — finalize immediately so we still emit a benchmark + suite-end.
      const benchmark = buildBenchmark([]);
      const benchmarkPath = path.join(p.skillDir, "benchmark.json");
      writeFileSync(benchmarkPath, `${JSON.stringify(benchmark, null, 2)}\n`, "utf-8");
      emit?.({ type: "suite-end", skill: p.skill.name, benchmarkPath, benchmark });
      continue;
    }
    for (let index = 0; index < p.skill.evals.length; index++) {
      tasks.push({ prepared: p, evalCase: p.skill.evals[index], index });
    }
  }

  async function runTask(task: Task): Promise<void> {
    const { prepared: p, evalCase, index } = task;
    args.onLog?.(`skill ${p.skill.name}: eval ${evalCase.name ?? evalCase.id ?? index + 1}`);
    try {
      const result = await runEval({
        skill: p.skill,
        eval: evalCase,
        index,
        modes,
        target: args.target,
        judge: args.judge,
        workspace: runWorkspace.dir,
        evalRootDir: p.skillDir,
        iteration: 0,
        targetParams: args.targetParams,
        judgeParams: args.judgeParams,
        onEvent: emit,
      });

      // JS is single-threaded between awaits; the stat updates below run
      // atomically relative to other workers, so no explicit lock is needed.
      for (const mode of modes) {
        const modeResult = result.modes[mode];
        if (!modeResult) continue;
        if (modeResult.error) {
          // Don't push a zeroed run into aggregateRuns — it would falsely
          // improve mean latency/pass-rate for the skill.
          p.errored++;
          continue;
        }
        p.aggregateRuns.push({
          mode,
          passRate: modeResult.grading.summary.pass_rate,
          durationMs: modeResult.timing.duration_ms,
          tokens: modeResult.timing.total_tokens,
        });
      }

      const withSkill = result.modes.with_skill;
      if (withSkill && !withSkill.error) {
        p.passed += withSkill.grading.summary.passed;
        p.failed += withSkill.grading.summary.failed;
      }
    } catch (err) {
      // Safety net only: `runEval` isolates per-mode failures internally and
      // should not reject. If it somehow does (a bug outside the per-mode
      // loop), count every mode as errored rather than losing the whole run.
      p.errored += modes.length;
      emit?.({
        type: "eval-error",
        skill: p.skill.name,
        evalIndex: index,
        evalSlug: evalSlug(evalCase, index),
        evalName: evalCase.name,
        evalId: evalCase.id,
        mode: modes[0],
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      p.completed++;
      if (p.completed === p.skill.evals.length) {
        const benchmark = buildBenchmark(p.aggregateRuns);
        const benchmarkPath = path.join(p.skillDir, "benchmark.json");
        writeFileSync(benchmarkPath, `${JSON.stringify(benchmark, null, 2)}\n`, "utf-8");
        emit?.({
          type: "suite-end",
          skill: p.skill.name,
          benchmarkPath,
          benchmark,
        });
      }
    }
  }

  const withSkillLock = serializeSkillInstalls ? createKeyedLock() : undefined;
  await runPool(tasks, concurrency, (task) =>
    withSkillLock ? withSkillLock(task.prepared.skill.name, () => runTask(task)) : runTask(task)
  );

  // ─── Phase 3: aggregate result + history snapshot + HTML report ───────────
  let totalPassed = 0;
  let totalFailed = 0;
  let totalErrored = 0;
  const skills: EvaluateSkillsResult["skills"] = [];
  const writtenSkillDirs: { slug: string; dir: string }[] = [];
  for (const p of prepared) {
    totalPassed += p.passed;
    totalFailed += p.failed;
    totalErrored += p.errored;
    const total = p.passed + p.failed;
    skills.push({
      skill: p.skill.name,
      slug: p.slug,
      relPath: p.ref.relPath,
      evals: p.skill.evals.length,
      passRate: total === 0 ? null : p.passed / total,
      benchmarkPath: path.join(p.skillDir, "benchmark.json"),
      errored: p.errored,
    });
    writtenSkillDirs.push({ slug: p.slug, dir: p.skillDir });
  }

  // Loop mode: snapshot the freshly-written workspace into a history slot so
  // the developer can compare this run against earlier iterations.
  let historyIteration: number | undefined;
  if (args.loop && writtenSkillDirs.length > 0) {
    const history = allocateHistoryIteration(args.workspace);
    for (const { slug, dir } of writtenSkillDirs) {
      snapshotSkillToHistory(dir, history.dir, slug);
    }
    historyIteration = history.iteration;
  }

  // Render the static HTML report unless explicitly disabled. `report.ts`
  // reads everything from disk, so it works equally well against a freshly
  // finished run or against a `.history/iteration-N/` snapshot later.
  let reportPath: string | undefined;
  if (args.report !== false) {
    const result = generateReport({
      workspace: runWorkspace.dir,
      target: args.target.model,
      judge: args.judge.model,
      provider: args.target.provider.name,
      title: args.reportTitle,
      output: args.reportOutput,
    });
    reportPath = result.reportPath;
  }

  return {
    passed: totalPassed,
    failed: totalFailed,
    errored: totalErrored,
    skills,
    historyIteration,
    iteration: runWorkspace.iteration,
    workspaceRoot: runWorkspace.dir,
    reportPath,
  };
}

function prepareIterationSkillDir(dir: string): string {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}
