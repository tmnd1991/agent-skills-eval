import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import path from "node:path";
import type { Provider, ProviderResult, SkillSource, ToolCall } from "./provider.js";

export interface ClaudeCodeOptions {
  /** Shown as `provider` in ProviderResult. Default "claude-code". */
  providerName?: string;
  /** Required. Model id or alias accepted by `claude --model` (e.g. "claude-sonnet-5", "sonnet", "opus"). */
  model: string;
  /** Forwarded as `claude --agent`. Omitted when unset. */
  agent?: string;
  /** Working directory the `claude` process runs in (cwd) and where skills are installed. Default process.cwd(). */
  dir?: string;
  /** Auto-approve every permission prompt via `--dangerously-skip-permissions`. Dangerous — see class doc comment. Default false. */
  auto?: boolean;
  /** Hard deadline per call, ms. The subprocess is SIGTERM'd (then SIGKILL'd if it doesn't exit) once this elapses. Default 300_000 (5 minutes). */
  timeoutMs?: number;
  /** Tool names forwarded as `--allowedTools`, space-separated. Omitted (all built-in tools available) by default. */
  allowedTools?: string[];
  /** Tool names forwarded as `--disallowedTools`, space-separated. */
  disallowedTools?: string[];
  /** Path to the `claude` executable. Default "claude" (resolved via PATH). */
  claudeBinary?: string;
}

interface RunOutcome {
  text: string;
  toolCalls: ToolCall[];
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  errorMessage?: string;
}

/** Grace period between SIGTERM and SIGKILL when a run exceeds `timeoutMs`. */
const KILL_GRACE_MS = 3000;

interface ClaudeToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}

interface ClaudeAssistantEvent {
  type: "assistant";
  message: { content: Array<ClaudeToolUseBlock | { type: string }> };
}

interface ClaudeResultEvent {
  type: "result";
  is_error: boolean;
  result?: string;
  total_cost_usd?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

function isToolUseBlock(block: { type: string }): block is ClaudeToolUseBlock {
  return block.type === "tool_use";
}

function toolCallFrom(block: ClaudeToolUseBlock): ToolCall {
  return {
    id: block.id,
    type: "function",
    function: { name: block.name, arguments: JSON.stringify(block.input) },
    parsedArguments: block.input,
  };
}

/** Parses the buffered NDJSON stdout of a finished `claude -p --output-format stream-json` run. */
function parseOutcome(stdout: string): RunOutcome {
  const toolCalls: ToolCall[] = [];
  let result: ClaudeResultEvent | undefined;

  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    let event: { type?: string };
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type === "assistant") {
      const assistant = event as ClaudeAssistantEvent;
      toolCalls.push(...assistant.message.content.filter(isToolUseBlock).map(toolCallFrom));
    } else if (event.type === "result") {
      result = event as ClaudeResultEvent;
    }
  }

  if (!result) {
    return {
      text: "",
      toolCalls,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      errorMessage: "claude-code run produced no result event",
    };
  }

  const usage = result.usage ?? {};
  const inputTokens =
    (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);

  return {
    text: result.result ?? "",
    toolCalls,
    inputTokens,
    outputTokens: usage.output_tokens ?? 0,
    costUsd: result.total_cost_usd ?? 0,
    errorMessage: result.is_error ? result.result || "claude-code run failed with no error message" : undefined,
  };
}

/**
 * Wraps the `claude` CLI's non-interactive batch mode (`claude -p`) as a
 * `Provider`. Each `complete()` call spawns a fresh `claude` subprocess with
 * the prompt piped over stdin and `--output-format stream-json --verbose`,
 * waits for it to exit, and parses the buffered NDJSON transcript.
 *
 * Unlike opencode's HTTP server, `claude -p` runs the entire agentic turn —
 * including any subagent (`Task` tool) delegation — synchronously within one
 * process and doesn't return until it's done, so there's no async
 * delegation/polling/continuation machinery needed here (contrast
 * `OpencodeProvider`). The final NDJSON `result` event already carries
 * cumulative token usage and cost for the whole run.
 *
 * Implements `prepareSkill`/`cleanupSkill`: rather than injecting the skill
 * into the prompt, it symlinks every entry of the skill's directory (except
 * `evals/`, which holds the answer key) into `<dir>/.claude/skills/<name>/`
 * so Claude Code's own project-skill discovery finds and loads it exactly as
 * it would in real-world use. `runEval` calls this instead of building a
 * system message whenever the provider exposes these hooks.
 *
 * Caveats (see README "claude-code run mode" for detail): token/cost numbers
 * include Claude Code's own system-prompt/tool-schema overhead and are not
 * comparable to raw chat-completion counts from OpenAICompatibleProvider for
 * the same model; `auto: true` passes `--dangerously-skip-permissions`,
 * bypassing every permission prompt unattended, and is off by default;
 * capabilities are all false except `sharedInstallDir`, so callers always
 * merge system+user into one string before calling `complete()`. Session
 * persistence is disabled (`--no-session-persistence`) since each call is a
 * one-shot, non-resumable run. The installed skill directory is shared
 * across every call using the same `dir`; evals of the same skill are
 * automatically serialized by the runner (see `sharedInstallDir` on
 * `capabilities`) — evals of *different* skills still race on unrelated
 * shared state in `dir` (e.g. concurrent git operations, or a skill that
 * writes output files into `dir` itself).
 */
export class ClaudeCodeProvider implements Provider {
  readonly capabilities = { systemRole: false, attachments: false, toolCalls: false, sharedInstallDir: true };
  readonly name: string;
  readonly model: string;
  private agent?: string;
  private dir: string;
  private auto: boolean;
  private timeoutMs: number;
  private allowedTools?: string[];
  private disallowedTools?: string[];
  private claudeBinary: string;

  constructor(options: ClaudeCodeOptions) {
    if (!options.model) {
      throw new Error('ClaudeCodeProvider requires "model" (e.g. "claude-sonnet-5")');
    }
    this.name = options.providerName ?? "claude-code";
    this.model = options.model;
    this.agent = options.agent;
    this.dir = options.dir ?? process.cwd();
    this.auto = options.auto ?? false;
    this.timeoutMs = options.timeoutMs ?? 5 * 60 * 1000;
    this.allowedTools = options.allowedTools;
    this.disallowedTools = options.disallowedTools;
    this.claudeBinary = options.claudeBinary ?? "claude";
  }

  /**
   * Removes any previously installed copy of `skill`, then — only when
   * `mode` is `"with_skill"` — symlinks it into place so Claude Code's own
   * project-skill discovery finds it under `<dir>/.claude/skills/<name>/`.
   * Every entry in `skill.dir` is linked except `evals/`, which holds the
   * answer key.
   */
  async prepareSkill(skill: SkillSource, mode: "with_skill" | "without_skill"): Promise<void> {
    const installDir = this.skillInstallDir(skill.name);
    rmSync(installDir, { recursive: true, force: true });
    if (mode !== "with_skill") return;

    mkdirSync(installDir, { recursive: true });
    for (const entry of readdirSync(skill.dir, { withFileTypes: true })) {
      if (entry.name === "evals") continue;
      symlinkSync(
        path.join(skill.dir, entry.name),
        path.join(installDir, entry.name),
        entry.isDirectory() ? "dir" : "file"
      );
    }
  }

  /** Removes whatever `prepareSkill` installed for `skill`, regardless of mode. */
  async cleanupSkill(skill: SkillSource): Promise<void> {
    rmSync(this.skillInstallDir(skill.name), { recursive: true, force: true });
  }

  private skillInstallDir(name: string): string {
    return path.join(this.dir, ".claude", "skills", name);
  }

  async complete(prompt: string): Promise<ProviderResult> {
    const start = Date.now();
    try {
      const outcome = await this.runClaude(prompt);
      const latencyMs = Date.now() - start;
      return {
        provider: this.name,
        model: this.model,
        output: outcome.text,
        latencyMs,
        inputTokens: outcome.inputTokens,
        outputTokens: outcome.outputTokens,
        costUsd: outcome.costUsd,
        toolCalls: outcome.toolCalls,
        error: outcome.errorMessage,
      };
    } catch (err) {
      return {
        provider: this.name,
        model: this.model,
        output: "",
        latencyMs: Date.now() - start,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private buildArgs(): string[] {
    const args = [
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--no-session-persistence",
      "--model",
      this.model,
    ];
    if (this.agent) args.push("--agent", this.agent);
    if (this.auto) args.push("--dangerously-skip-permissions");
    if (this.allowedTools?.length) args.push("--allowedTools", this.allowedTools.join(" "));
    if (this.disallowedTools?.length) args.push("--disallowedTools", this.disallowedTools.join(" "));
    return args;
  }

  private runClaude(prompt: string): Promise<RunOutcome> {
    return new Promise((resolve, reject) => {
      const child: ChildProcess = spawn(this.claudeBinary, this.buildArgs(), {
        cwd: this.dir,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      let settled = false;
      let timedOut = false;

      const timeoutTimer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        const killTimer = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
        killTimer.unref();
      }, this.timeoutMs);
      timeoutTimer.unref();

      child.stdout?.on("data", (chunk) => {
        stdout += String(chunk);
      });
      child.stderr?.on("data", (chunk) => {
        stderr += String(chunk);
      });

      child.on("error", (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutTimer);
        reject(err);
      });

      child.on("close", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutTimer);
        if (timedOut) {
          const outcome = parseOutcome(stdout);
          resolve({ ...outcome, errorMessage: `claude-code run timed out after ${this.timeoutMs}ms` });
          return;
        }
        const outcome = parseOutcome(stdout);
        if (!outcome.text && !outcome.errorMessage && stderr.trim()) {
          resolve({ ...outcome, errorMessage: stderr.trim() });
          return;
        }
        resolve(outcome);
      });

      child.stdin?.on("error", () => {
        // Swallow EPIPE from writing to a stdin the process already closed
        // (e.g. it exited immediately on a bad flag) — the real failure
        // surfaces via the "close"/"error" handlers above.
      });
      child.stdin?.end(prompt);
    });
  }
}
