/**
 * Static HTML report generator (NYC-style) for skill eval runs.
 *
 * Reads the canonical flat workspace layout written by `evaluateSkills`:
 *
 *   <workspace>/
 *     <skill-slug>/
 *       meta.json
 *       benchmark.json
 *       eval-<slug>/
 *         with_skill/
 *           grading.json
 *           timing.json
 *           prompts.json
 *           outputs/response.txt
 *         without_skill/...   (only if --baseline)
 *
 * Emits a single self-contained HTML file at `<workspace>/report/index.html`.
 * No external assets, no build step. Uses `<details>` for collapsibles so it
 * works in any browser, including offline; a few lines of inline JS expand
 * the right `<details>` when a link points at a specific eval (plain closed
 * `<details>` elements don't auto-open on fragment navigation).
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { BenchmarkJson, GradingJson, ToolCall } from "./types.js";

export interface GenerateReportArgs {
  /** Workspace directory that contains per-skill subfolders. */
  workspace: string;
  /** Override output dir. Defaults to `<workspace>/report`. */
  output?: string;
  /** Display title in the report header. Defaults to "Agent Skills Eval report". */
  title?: string;
  /** Target model used for the run, surfaced in the header for context. */
  target?: string;
  /** Judge model used for the run, surfaced in the header for context. */
  judge?: string;
  /** Provider (run mode) used for the run, e.g. "claude-code", "opencode", surfaced in the header for context. */
  provider?: string;
}

export interface GenerateReportResult {
  reportPath: string;
  skills: number;
  evals: number;
}

interface RunPromptsFile {
  system?: string;
  user: string;
  judgePrompt?: string;
  fileCount: number;
}

interface TimingFile {
  total_tokens: number;
  duration_ms: number;
}

interface SkillMeta {
  name: string;
  slug: string;
  relPath: string;
  target?: string;
  judge?: string;
  modes?: string[];
  generated_at?: string;
}

interface ReportRunOk {
  mode: "with_skill" | "without_skill";
  output: string;
  grading: GradingJson;
  timing: TimingFile;
  prompts?: RunPromptsFile;
  toolCalls?: ToolCall[];
  error?: undefined;
}

interface ReportRunError {
  mode: "with_skill" | "without_skill";
  error: string;
}

type ReportRun = ReportRunOk | ReportRunError;

/** `error` alone doesn't discriminate the union soundly (it's a plain `string`, not a literal), so use an explicit type guard. */
function isErrorRun(run: ReportRun): run is ReportRunError {
  return typeof run.error === "string";
}

interface ReportEval {
  slug: string;
  modes: ReportRun[];
}

interface ReportSkill {
  meta: SkillMeta;
  benchmark?: BenchmarkJson;
  evals: ReportEval[];
  totals: {
    passed: number;
    failed: number;
    total: number;
    passRate: number | null;
    avgDurationMs: number;
    avgTokens: number;
    withoutPassed: number;
    withoutTotal: number;
    withoutPassRate: number | null;
    regressions: number;
    errored: number;
  };
}

function readJson<T>(filePath: string): T | undefined {
  if (!existsSync(filePath)) return undefined;
  try {
    return JSON.parse(readFileSync(filePath, "utf-8")) as T;
  } catch {
    return undefined;
  }
}

function readText(filePath: string): string {
  if (!existsSync(filePath)) return "";
  try {
    return readFileSync(filePath, "utf-8");
  } catch {
    return "";
  }
}

function isSkillDir(dir: string): boolean {
  return existsSync(path.join(dir, "meta.json")) || existsSync(path.join(dir, "benchmark.json"));
}

function collectSkill(skillDir: string): ReportSkill | undefined {
  if (!statSync(skillDir).isDirectory()) return undefined;
  const meta = readJson<SkillMeta>(path.join(skillDir, "meta.json")) ?? {
    name: path.basename(skillDir),
    slug: path.basename(skillDir),
    relPath: skillDir,
  };
  const benchmark = readJson<BenchmarkJson>(path.join(skillDir, "benchmark.json"));

  const entries = readdirSync(skillDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("eval-"))
    .sort((a, b) => a.name.localeCompare(b.name));

  const evals: ReportEval[] = [];
  let passed = 0;
  let failed = 0;
  let totalDuration = 0;
  let totalTokens = 0;
  let withSkillRuns = 0;
  let withoutPassed = 0;
  let withoutFailed = 0;
  let regressions = 0;
  let errored = 0;

  for (const entry of entries) {
    const evalDir = path.join(skillDir, entry.name);
    const modes: ReportRun[] = [];

    for (const mode of ["with_skill", "without_skill"] as const) {
      const runDir = path.join(evalDir, mode);
      if (!existsSync(runDir)) continue;
      const errorFile = readJson<{ error: string }>(path.join(runDir, "error.json"));
      if (errorFile) {
        modes.push({ mode, error: errorFile.error });
        if (mode === "with_skill") errored += 1;
        continue;
      }
      const grading = readJson<GradingJson>(path.join(runDir, "grading.json"));
      const timing = readJson<TimingFile>(path.join(runDir, "timing.json"));
      if (!grading || !timing) continue;
      const prompts = readJson<RunPromptsFile>(path.join(runDir, "prompts.json"));
      const toolCalls = readJson<ToolCall[]>(path.join(runDir, "tool_calls.json"));
      const output =
        readText(path.join(runDir, "outputs", "raw_output.txt")) ||
        readText(path.join(runDir, "outputs", "response.txt"));
      modes.push({ mode, output, grading, timing, prompts, toolCalls });

      if (mode === "with_skill") {
        passed += grading.summary.passed;
        failed += grading.summary.failed;
        totalDuration += timing.duration_ms;
        totalTokens += timing.total_tokens;
        withSkillRuns += 1;
      } else {
        withoutPassed += grading.summary.passed;
        withoutFailed += grading.summary.failed;
      }
    }

    const withRun = modes.find((m) => m.mode === "with_skill");
    const withoutRun = modes.find((m) => m.mode === "without_skill");
    if (
      withRun &&
      !isErrorRun(withRun) &&
      withoutRun &&
      !isErrorRun(withoutRun) &&
      withRun.grading.summary.total > 0 &&
      withoutRun.grading.summary.total > 0 &&
      withoutRun.grading.summary.pass_rate! >= withRun.grading.summary.pass_rate!
    ) {
      regressions += 1;
    }

    if (modes.length > 0) {
      evals.push({ slug: entry.name, modes });
    }
  }

  const total = passed + failed;
  const withoutTotal = withoutPassed + withoutFailed;
  return {
    meta,
    benchmark,
    evals,
    totals: {
      passed,
      failed,
      total,
      passRate: total === 0 ? null : passed / total,
      avgDurationMs: withSkillRuns === 0 ? 0 : totalDuration / withSkillRuns,
      avgTokens: withSkillRuns === 0 ? 0 : totalTokens / withSkillRuns,
      withoutPassed,
      withoutTotal,
      withoutPassRate: withoutTotal === 0 ? null : withoutPassed / withoutTotal,
      regressions,
      errored,
    },
  };
}

function collectReport(workspace: string): ReportSkill[] {
  const root = path.resolve(workspace);
  if (!existsSync(root)) return [];
  if (isSkillDir(root)) {
    const skill = collectSkill(root);
    return skill ? [skill] : [];
  }
  const out: ReportSkill[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name === "report" || entry.name === ".history" || entry.name.startsWith(".")) continue;
    const dir = path.join(root, entry.name);
    if (!isSkillDir(dir)) continue;
    const skill = collectSkill(dir);
    if (skill) out.push(skill);
  }
  return out.sort((a, b) => {
    const ra = a.totals.passRate;
    const rb = b.totals.passRate;
    if (ra === null && rb === null) return 0;
    if (ra === null) return 1; // ungraded skills sort last
    if (rb === null) return -1;
    return ra - rb; // failures first
  });
}

// ─── HTML rendering ──────────────────────────────────────────────────────────

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function pctOrNA(value: number | null): string {
  return value === null ? "n/a" : pct(value);
}

function ms(value: number): string {
  if (value < 1000) return `${Math.round(value)}ms`;
  return `${(value / 1000).toFixed(2)}s`;
}

function formatDate(date: Date): string {
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function modeLabel(mode: ReportRun["mode"]): string {
  return mode === "with_skill" ? "With Skill" : "Without Skill";
}

/** Turns an `eval-<slug>` directory name into a readable label, e.g. "eval-review-branch" -> "Review Branch". */
function humanizeEvalName(slug: string): string {
  const stripped = slug.startsWith("eval-") ? slug.slice(5) : slug;
  return stripped
    .split("-")
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(" ");
}

function rateClass(passRate: number | null): string {
  if (passRate === null) return "muted";
  if (passRate >= 0.8) return "ok";
  if (passRate >= 0.5) return "warn";
  return "bad";
}

function renderBar(passRate: number | null): string {
  const cls = rateClass(passRate);
  const width = passRate === null ? 0 : Math.round(passRate * 100);
  return `<div class="bar ${cls}"><div class="fill" style="width:${width}%"></div></div>`;
}

function renderDeltaCell(t: ReportSkill["totals"]): string {
  if (t.withoutTotal === 0 || t.passRate === null || t.withoutPassRate === null) {
    return `<td class="num delta-cell muted">—</td>`;
  }
  const deltaPp = (t.passRate - t.withoutPassRate) * 100;
  const cls = deltaPp > 0 ? "ok" : deltaPp < 0 ? "bad" : "muted";
  const sign = deltaPp >= 0 ? "+" : "";
  return `<td class="num delta-cell ${cls}">${sign}${deltaPp.toFixed(1)}pp</td>`;
}

function renderSkillRow(skill: ReportSkill): string {
  const t = skill.totals;
  const cls = rateClass(t.passRate);
  return `
    <tr class="skill-row ${cls}">
      <td><a href="#skill-${escapeHtml(skill.meta.slug)}">${escapeHtml(skill.meta.name)}</a>
          <div class="muted">${escapeHtml(skill.meta.relPath)}</div></td>
      <td class="num">${skill.evals.length}</td>
      <td class="num">${t.passed}/${t.total}</td>
      <td class="num">${pctOrNA(t.passRate)}</td>
      <td class="bar-cell">${renderBar(t.passRate)}</td>
      ${renderDeltaCell(t)}
      <td class="num">${ms(t.avgDurationMs)}</td>
      <td class="num">${Math.round(t.avgTokens)}</td>
    </tr>
  `;
}

function renderAssertionsTable(grading: GradingJson): string {
  if (grading.assertion_results.length === 0) {
    return `<p class="muted">No assertions.</p>`;
  }
  const rows = grading.assertion_results
    .map(
      (r, i) => `
        <tr class="${r.passed ? "ok" : "bad"}">
          <td class="num">${i + 1}</td>
          <td>${r.passed ? "<span class='check'>\u2713</span>" : "<span class='x'>\u2717</span>"}</td>
          <td>${escapeHtml(r.text)}</td>
          <td><span class="evidence">${escapeHtml(r.evidence || "—")}</span></td>
        </tr>`
    )
    .join("\n");
  return `<div class="table-scroll"><table class="assertions"><thead><tr><th>#</th><th></th><th>Assertion</th><th>Evidence</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function renderToolCallsPanel(calls: ToolCall[] | undefined): string {
  if (!calls || calls.length === 0) return "";
  const rows = calls
    .map((c, i) => {
      const args = c.parsedArguments !== undefined
        ? JSON.stringify(c.parsedArguments, null, 2)
        : c.function.arguments || "(empty)";
      return `
        <tr>
          <td class="num">${i + 1}</td>
          <td class="tool-name">${escapeHtml(c.function.name)}</td>
          <td><pre class="tool-args">${escapeHtml(args)}</pre></td>
        </tr>`;
    })
    .join("\n");
  return `
    <details class="tools">
      <summary>tool calls (${calls.length})</summary>
      <div class="table-scroll">
        <table class="tool-calls">
          <thead><tr><th>#</th><th>Tool</th><th>Arguments</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </details>
  `;
}

/** Did a `with_skill` run's model actually call the `skill` tool for this skill? `undefined` when not applicable (without_skill mode, or no tool-call data captured). Tool name is matched case-insensitively — opencode calls it `skill`, Claude Code calls it `Skill`. The argument key also differs: opencode uses `name`, Claude Code uses `skill`. */
function skillWasInvoked(run: ReportRun, skillName: string): boolean | undefined {
  if (run.mode !== "with_skill" || isErrorRun(run) || !run.toolCalls) return undefined;
  return run.toolCalls.some((c) => {
    if (c.function.name.toLowerCase() !== "skill") return false;
    const args = c.parsedArguments as Record<string, unknown> | undefined;
    return args?.name === skillName || args?.skill === skillName;
  });
}

function renderRun(run: ReportRun, skillName: string): string {
  if (isErrorRun(run)) {
    return `
      <section class="run run-${run.mode}">
        <header class="run-head">
          <span class="mode mode-${run.mode}">${modeLabel(run.mode)}</span>
          <span class="status errored">ERRORED</span>
        </header>
        <details class="output" open><summary>error</summary><pre>${escapeHtml(run.error)}</pre></details>
      </section>
    `;
  }
  const summary = run.grading.summary;
  const passed = summary.failed === 0 && summary.total > 0;
  const status = summary.total === 0 ? "n/a" : passed ? "PASS" : "FAIL";
  const statusCls = summary.total === 0 ? "muted" : passed ? "ok" : "bad";
  const invoked = skillWasInvoked(run, skillName);
  const invokedBadge =
    invoked === undefined
      ? ""
      : invoked
        ? `<span class="skill-invoked ok">skill picked up</span>`
        : `<span class="skill-invoked bad">skill not picked up</span>`;
  return `
    <section class="run run-${run.mode}">
      <header class="run-head">
        <span class="mode mode-${run.mode}">${modeLabel(run.mode)}</span>
        <span class="status ${statusCls}">${status}</span>
        ${invokedBadge}
        <span class="muted">${ms(run.timing.duration_ms)} · ${run.timing.total_tokens} tokens · ${summary.passed}/${summary.total}</span>
      </header>
      ${
        run.prompts?.system
          ? `<details class="prompt"><summary>system prompt</summary><pre>${escapeHtml(run.prompts.system)}</pre></details>`
          : ""
      }
      <details class="output"><summary>output</summary><pre>${escapeHtml(run.output || "(empty)")}</pre></details>
      ${renderToolCallsPanel(run.toolCalls)}
      ${renderAssertionsTable(run.grading)}
      ${
        run.prompts?.judgePrompt
          ? `<details class="judge"><summary>judge prompt</summary><pre>${escapeHtml(run.prompts.judgePrompt)}</pre></details>`
          : ""
      }
    </section>
  `;
}

/** First non-errored run's user prompt — the same test case drives every mode, so it's identical across runs. */
function findUserPrompt(modes: ReportRun[]): string | undefined {
  for (const m of modes) {
    if (!isErrorRun(m) && m.prompts?.user) return m.prompts.user;
  }
  return undefined;
}

function renderEval(ev: ReportEval, skillName: string, skillSlug: string): string {
  const withSkillRun = ev.modes.find((m) => m.mode === "with_skill");
  const withoutSkillRun = ev.modes.find((m) => m.mode === "without_skill");
  const hasError = ev.modes.some(isErrorRun);
  const gradedRun = withSkillRun ?? ev.modes[0];
  const allPassed =
    gradedRun !== undefined &&
    !isErrorRun(gradedRun) &&
    gradedRun.grading.summary.failed === 0 &&
    gradedRun.grading.summary.total > 0;
  const cls = hasError ? "errored" : allPassed ? "ok" : "bad";
  const anchorId = `${escapeHtml(skillSlug)}--${escapeHtml(ev.slug)}`;
  const userPrompt = findUserPrompt(ev.modes) ?? "(unknown)";

  const isRegression =
    withSkillRun !== undefined &&
    !isErrorRun(withSkillRun) &&
    withoutSkillRun !== undefined &&
    !isErrorRun(withoutSkillRun) &&
    withSkillRun.grading.summary.total > 0 &&
    withoutSkillRun.grading.summary.total > 0 &&
    withoutSkillRun.grading.summary.pass_rate! >= withSkillRun.grading.summary.pass_rate!;

  const withSkillLabel =
    withSkillRun && !isErrorRun(withSkillRun)
      ? `<span class="muted">${withSkillRun.grading.summary.passed}/${withSkillRun.grading.summary.total} with skill</span>`
      : "";
  const baselineLabel =
    withoutSkillRun && !isErrorRun(withoutSkillRun)
      ? (() => {
          const delta =
            withSkillRun && !isErrorRun(withSkillRun)
              ? withSkillRun.grading.summary.passed - withoutSkillRun.grading.summary.passed
              : undefined;
          const deltaLabel = delta !== undefined ? ` <span class="muted">(\u0394 ${delta >= 0 ? "+" : ""}${delta})</span>` : "";
          return `<span class="muted">\u00b7 ${withoutSkillRun.grading.summary.passed}/${withoutSkillRun.grading.summary.total} baseline</span>${deltaLabel}`;
        })()
      : "";
  const regressionBadge = isRegression ? `<span class="regression-flag">\u2691 baseline tied/won</span>` : "";
  const errorBadge = hasError ? `<span class="skill-invoked bad">errored</span>` : "";

  return `
    <details class="eval ${cls}" id="${anchorId}">
      <summary>
        <span class="eval-status">${hasError ? "\u26a0" : allPassed ? "\u2713" : "\u2717"}</span>
        <span class="eval-name" title="${escapeHtml(ev.slug)}">${escapeHtml(humanizeEvalName(ev.slug))}</span>
        ${withSkillLabel}
        ${baselineLabel}
        ${regressionBadge}
        ${errorBadge}
      </summary>
      <div class="eval-body">
        <details class="prompt"><summary>user prompt</summary><pre>${escapeHtml(userPrompt)}</pre></details>
        <div class="runs">${ev.modes.map((run) => renderRun(run, skillName)).join("\n")}</div>
      </div>
    </details>
  `;
}

function renderSkillSection(skill: ReportSkill, tokenCaveat: boolean): string {
  const t = skill.totals;
  const benchmarkBlock = skill.benchmark?.run_summary.delta
    ? (() => {
        const d = skill.benchmark!.run_summary.delta!;
        const sign = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(2)}`;
        const ppDelta = d.pass_rate * 100;
        const cls = ppDelta > 0 ? "ok" : ppDelta < 0 ? "bad" : "muted";
        const caveatFlag = tokenCaveat
          ? ` <span class="caveat-flag" title="Token figure includes this run mode's own CLI overhead — not directly comparable across providers.">†</span>`
          : "";
        return `<div class="delta ${cls}">Δ vs baseline: pass-rate ${sign(ppDelta)}pp · time ${sign(d.time_seconds)}s · tokens ${sign(d.tokens)}${caveatFlag}</div>`;
      })()
    : "";
  return `
    <article class="skill" id="skill-${escapeHtml(skill.meta.slug)}">
      <header>
        <h2>${escapeHtml(skill.meta.name)} <span class="badge ${rateClass(t.passRate)}">${t.passRate === null ? "no assertions" : pct(t.passRate)}</span></h2>
        <div class="muted">${escapeHtml(skill.meta.relPath)}</div>
        <div class="muted">${t.passed}/${t.total} assertions · ${skill.evals.length} evals · ${ms(t.avgDurationMs)} avg · ${Math.round(t.avgTokens)} tokens avg</div>
        ${benchmarkBlock}
      </header>
      <div class="evals">${skill.evals.map((ev) => renderEval(ev, skill.meta.name, skill.meta.slug)).join("\n")}</div>
    </article>
  `;
}

const STYLES = `
  :root {
    --fg: #1a1f24;
    --muted: #6a737d;
    --bg: #ffffff;
    --bg-alt: #f6f8fa;
    --border: #e1e4e8;
    --ok: #1a7f37;
    --warn: #9a6700;
    --bad: #cf222e;
    --ok-bg: #dafbe1;
    --warn-bg: #fff8c5;
    --bad-bg: #ffebe9;
    --flag: #8250df;
    --flag-bg: #fbefff;
    --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
  }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; color: var(--fg); background: var(--bg); }
  header.hero { background: linear-gradient(180deg, #fafbfc 0%, #f0f2f5 100%); border-bottom: 1px solid var(--border); padding: 24px 32px; }
  header.hero h1 { margin: 0 0 4px; font-size: 22px; }
  header.hero .meta { color: var(--muted); font-size: 13px; }
  header.hero .totals { margin-top: 16px; display: flex; gap: 16px; flex-wrap: wrap; }
  header.hero .stat { background: var(--bg); border: 1px solid var(--border); border-radius: 8px; padding: 12px 16px; min-width: 120px; }
  header.hero .stat .label { display: block; font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.04em; }
  header.hero .stat .value { display: block; font-size: 22px; font-weight: 600; margin-top: 2px; }
  header.hero .stat.ok .value { color: var(--ok); }
  header.hero .stat.bad .value { color: var(--bad); }
  header.hero .stat.flag .value { color: var(--flag); }
  header.hero .stat.warn .value { color: var(--warn); }
  header.hero .totals-caption { margin-top: 10px; }
  header.hero .layout-switch { position: relative; display: inline-flex; margin-top: 14px; padding: 3px; background: var(--bg-alt); border: 1px solid var(--border); border-radius: 999px; }
  header.hero .layout-switch::before { content: ""; position: absolute; top: 3px; bottom: 3px; left: 3px; width: calc(50% - 3px); background: var(--bg); border: 1px solid var(--border); border-radius: 999px; box-shadow: 0 1px 2px rgba(0, 0, 0, 0.08); transition: transform 0.2s ease; z-index: 0; }
  header.hero .layout-switch:has(input[value="stacked"]:checked)::before { transform: translateX(100%); }
  header.hero .layout-switch .seg { position: relative; z-index: 1; flex: 1; display: flex; align-items: center; justify-content: center; gap: 5px; padding: 5px 16px; border-radius: 999px; font-size: 12px; font-weight: 500; color: var(--muted); cursor: pointer; white-space: nowrap; user-select: none; transition: color 0.15s ease; }
  header.hero .layout-switch .seg:has(input:checked) { color: var(--fg); }
  header.hero .layout-switch input { position: absolute; width: 1px; height: 1px; opacity: 0; }
  header.hero .layout-switch input:focus-visible + span { outline: 2px solid #0969da; outline-offset: 2px; border-radius: 4px; }
  main { padding: 24px 32px; max-width: 1200px; margin: 0 auto; }
  h2 { margin: 0 0 4px; font-size: 18px; }
  .muted { color: var(--muted); font-size: 12px; }
  table.summary { width: 100%; border-collapse: collapse; margin-bottom: 32px; background: var(--bg); border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
  table.summary th, table.summary td { padding: 10px 12px; border-bottom: 1px solid var(--border); text-align: left; }
  table.summary th { background: var(--bg-alt); font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); }
  table.summary td.num { text-align: right; font-variant-numeric: tabular-nums; }
  table.summary td.delta-cell.ok { color: var(--ok); }
  table.summary td.delta-cell.bad { color: var(--bad); }
  table.summary td.delta-cell.muted { color: var(--muted); }
  table.summary tr.skill-row.bad { background: var(--bad-bg); }
  table.summary tr.skill-row.warn { background: var(--warn-bg); }
  table.summary tr.skill-row.ok td { background: transparent; }
  table.summary tr.skill-row a { color: var(--fg); text-decoration: none; font-weight: 500; }
  table.summary tr.skill-row a:hover { text-decoration: underline; }
  .bar { width: 100px; height: 10px; background: var(--bg-alt); border-radius: 5px; overflow: hidden; }
  .bar .fill { height: 100%; }
  .bar.ok .fill { background: var(--ok); }
  .bar.warn .fill { background: var(--warn); }
  .bar.bad .fill { background: var(--bad); }
  article.skill { background: var(--bg); border: 1px solid var(--border); border-radius: 8px; padding: 20px; margin-bottom: 20px; }
  article.skill header h2 .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 12px; font-weight: 500; vertical-align: middle; margin-left: 8px; }
  article.skill header h2 .badge.ok { background: var(--ok-bg); color: var(--ok); }
  article.skill header h2 .badge.warn { background: var(--warn-bg); color: var(--warn); }
  article.skill header h2 .badge.bad { background: var(--bad-bg); color: var(--bad); }
  article.skill .delta { margin-top: 8px; font-size: 13px; }
  article.skill .delta.ok { color: var(--ok); }
  article.skill .delta.bad { color: var(--bad); }
  .caveat { margin-top: 6px; padding: 6px 10px; border-radius: 4px; background: var(--warn-bg); color: var(--warn); font-size: 13px; }
  .caveat-flag { cursor: help; color: var(--warn); }
  details.eval { border: 1px solid var(--border); border-radius: 6px; margin-top: 12px; }
  details.eval > summary { padding: 10px 14px; cursor: pointer; display: flex; gap: 10px; align-items: center; }
  details.eval[open] > summary { border-bottom: 1px solid var(--border); }
  details.eval.bad > summary { background: var(--bad-bg); }
  details.eval.ok > summary { background: var(--ok-bg); }
  details.eval.errored > summary { background: var(--warn-bg); }
  details.eval .eval-status { font-weight: 600; }
  details.eval.bad .eval-status { color: var(--bad); }
  details.eval.ok .eval-status { color: var(--ok); }
  details.eval.errored .eval-status { color: var(--warn); }
  .eval-body { padding: 12px 16px; display: flex; flex-direction: column; gap: 12px; }
  .runs { display: grid; grid-template-columns: repeat(auto-fit, minmax(420px, 1fr)); gap: 12px; align-items: start; }
  body:has(input[name="run-layout"][value="stacked"]:checked) .runs { grid-template-columns: 1fr; }
  .run { padding: 12px 14px; border-radius: 6px; border: 1px solid var(--border); min-width: 0; }
  .run.run-with_skill { background: #f1f8ff; border-color: #c8e1f8; }
  .run.run-without_skill { background: #fff8f0; border-color: #ffddb3; }
  .run-head { display: flex; align-items: center; gap: 12px; margin-bottom: 8px; }
  .mode { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 500; text-transform: uppercase; letter-spacing: 0.04em; }
  .mode-with_skill { background: #ddf4ff; color: #0969da; }
  .mode-without_skill { background: #fff1e5; color: #bc4c00; }
  .status.ok { color: var(--ok); font-weight: 600; }
  .status.bad { color: var(--bad); font-weight: 600; }
  .status.errored { color: var(--warn); font-weight: 600; }
  .skill-invoked { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 500; }
  .skill-invoked.ok { background: var(--ok-bg); color: var(--ok); }
  .skill-invoked.bad { background: var(--bad-bg); color: var(--bad); }
  .regression-flag { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 500; background: var(--flag-bg); color: var(--flag); }
  .eval-body details > summary { cursor: pointer; font-size: 12px; color: var(--muted); padding: 4px 0; }
  .eval-body details[open] > summary { color: var(--fg); }
  .eval-body pre { background: var(--bg-alt); border: 1px solid var(--border); border-radius: 6px; padding: 10px 12px; font-family: var(--mono); font-size: 12px; line-height: 1.45; overflow-x: auto; white-space: pre-wrap; word-break: break-word; max-height: 400px; overflow-y: auto; }
  .eval-body > details.prompt { background: var(--bg-alt); border: 1px solid var(--border); border-radius: 6px; padding: 4px 12px; }
  table.assertions { width: 100%; border-collapse: collapse; margin: 12px 0; font-size: 13px; }
  table.assertions th, table.assertions td { padding: 6px 8px; border-bottom: 1px solid var(--border); text-align: left; vertical-align: top; }
  table.assertions th { background: var(--bg-alt); font-size: 11px; text-transform: uppercase; color: var(--muted); }
  table.assertions tr.bad td { background: var(--bad-bg); }
  table.assertions .check { color: var(--ok); font-weight: 600; }
  table.assertions .x { color: var(--bad); font-weight: 600; }
  table.assertions .evidence { color: var(--muted); font-size: 12px; }
  details.tools { margin: 12px 0; }
  details.tools > summary { cursor: pointer; font-size: 12px; color: var(--muted); padding: 4px 0; }
  details.tools[open] > summary { color: var(--fg); font-weight: 500; }
  table.tool-calls { width: 100%; border-collapse: collapse; margin: 6px 0 8px; font-size: 13px; }
  table.tool-calls th, table.tool-calls td { padding: 6px 8px; border-bottom: 1px solid var(--border); text-align: left; vertical-align: top; }
  table.tool-calls th { background: var(--bg-alt); font-size: 11px; text-transform: uppercase; color: var(--muted); }
  table.tool-calls .tool-name { font-family: var(--mono); color: var(--warn); font-weight: 600; }
  pre.tool-args { background: var(--bg-alt); border: 1px solid var(--border); border-radius: 4px; padding: 6px 8px; margin: 0; font-family: var(--mono); font-size: 12px; line-height: 1.4; overflow-x: auto; white-space: pre-wrap; word-break: break-word; max-height: 240px; overflow-y: auto; }
  .empty { padding: 60px 20px; text-align: center; color: var(--muted); }
  .table-scroll { overflow-x: auto; }
`;

export function generateReport(args: GenerateReportArgs): GenerateReportResult {
  const skills = collectReport(args.workspace);
  const totalEvals = skills.reduce((sum, s) => sum + s.evals.length, 0);
  const totalAssertions = skills.reduce((sum, s) => sum + s.totals.total, 0);
  const totalPassed = skills.reduce((sum, s) => sum + s.totals.passed, 0);
  const totalFailed = totalAssertions - totalPassed;
  const overallRate = totalAssertions === 0 ? null : totalPassed / totalAssertions;
  const totalWithoutPassed = skills.reduce((sum, s) => sum + s.totals.withoutPassed, 0);
  const totalWithoutTotal = skills.reduce((sum, s) => sum + s.totals.withoutTotal, 0);
  const totalRegressions = skills.reduce((sum, s) => sum + s.totals.regressions, 0);
  const totalErrored = skills.reduce((sum, s) => sum + s.totals.errored, 0);
  const hasBaseline = totalWithoutTotal > 0;
  const overallWithoutRate = totalWithoutTotal === 0 ? null : totalWithoutPassed / totalWithoutTotal;
  const generatedAt = new Date();

  // CLI-wrapper run modes fold their own overhead into token counts, so the
  // Δ vs baseline "tokens" figure isn't directly comparable to --run-mode api
  // runs. Surface that once here and thread it into the per-skill delta.
  const overheadProviders = new Set(["opencode", "claude-code"]);
  const tokenCaveat = hasBaseline && args.provider !== undefined && overheadProviders.has(args.provider);

  const title = args.title ?? "Agent Skills Eval report";
  const summaryRows = skills.map(renderSkillRow).join("\n");
  const detailSections = skills.map((skill) => renderSkillSection(skill, tokenCaveat)).join("\n");

  const body =
    skills.length === 0
      ? `<div class="empty">No skill artifacts found in <code>${escapeHtml(args.workspace)}</code>.</div>`
      : `
        <div class="table-scroll">
          <table class="summary">
            <thead>
              <tr>
                <th>Skill</th>
                <th class="num">Evals</th>
                <th class="num">Passed</th>
                <th class="num">Pass rate</th>
                <th></th>
                <th class="num">Δ vs baseline</th>
                <th class="num">Avg time</th>
                <th class="num">Avg tokens</th>
              </tr>
            </thead>
            <tbody>${summaryRows}</tbody>
          </table>
        </div>
        ${detailSections}
      `;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>${STYLES}</style>
</head>
<body>
  <header class="hero">
    <h1>${escapeHtml(title)}</h1>
    <div class="meta">
      generated ${escapeHtml(formatDate(generatedAt))}
      ${args.provider ? `· provider <code>${escapeHtml(args.provider)}</code>` : ""}
      ${args.target ? `· target <code>${escapeHtml(args.target)}</code>` : ""}
      ${args.judge ? `· judge <code>${escapeHtml(args.judge)}</code>` : ""}
      ${tokenCaveat ? `<div class="caveat">⚠ Token deltas below include <code>${escapeHtml(args.provider!)}</code>'s own CLI overhead and aren't directly comparable to <code>--run-mode api</code> runs — see README caveats.</div>` : ""}
    </div>
    <div class="totals">
      <div class="stat"><span class="label">skills</span><span class="value">${skills.length}</span></div>
      <div class="stat"><span class="label">evals</span><span class="value">${totalEvals}</span></div>
      <div class="stat ok"><span class="label">passed</span><span class="value">${totalPassed}</span></div>
      <div class="stat ${totalFailed > 0 ? "bad" : ""}"><span class="label">failed</span><span class="value">${totalFailed}</span></div>
      <div class="stat ${rateClass(overallRate)}"><span class="label">pass rate</span><span class="value">${pctOrNA(overallRate)}</span></div>
      ${
        totalErrored > 0
          ? `<div class="stat warn"><span class="label">errored</span><span class="value">${totalErrored}</span></div>`
          : ""
      }
      ${
        hasBaseline
          ? `<div class="stat ${totalRegressions > 0 ? "flag" : ""}"><span class="label">regressions</span><span class="value">${totalRegressions}</span></div>`
          : ""
      }
    </div>
    ${
      hasBaseline
        ? `<div class="totals-caption muted">with_skill numbers above · without skill: ${totalWithoutPassed}/${totalWithoutTotal} passed · ${pctOrNA(overallWithoutRate)} pass rate</div>`
        : ""
    }
    ${
      skills.length === 0
        ? ""
        : `<div class="layout-switch" role="radiogroup" aria-label="Run layout">
      <label class="seg"><input type="radio" name="run-layout" value="side-by-side" checked><span>Side by side</span></label>
      <label class="seg"><input type="radio" name="run-layout" value="stacked"><span>Stacked</span></label>
    </div>`
    }
  </header>
  <main>${body}</main>
  <script>
    if (location.hash) {
      var target = document.getElementById(decodeURIComponent(location.hash.slice(1)));
      if (target && target.tagName === "DETAILS") {
        target.open = true;
        target.scrollIntoView();
      }
    }
  </script>
</body>
</html>`;

  const outputDir = args.output ?? path.join(args.workspace, "report");
  mkdirSync(outputDir, { recursive: true });
  const reportPath = path.join(outputDir, "index.html");
  writeFileSync(reportPath, html, "utf-8");

  return { reportPath, skills: skills.length, evals: totalEvals };
}
