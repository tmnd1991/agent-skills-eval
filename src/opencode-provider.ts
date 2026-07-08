import { spawn } from "node:child_process";
import type { Provider, ProviderResult } from "./provider.js";

export interface OpencodeOptions {
  /** Shown as `provider` in ProviderResult. Default "opencode". */
  providerName?: string;
  /** Required. "provider/model" form expected by `opencode run -m`, e.g. "anthropic/claude-sonnet-5". */
  model: string;
  /** Path/name of the opencode binary to spawn. Default "opencode" (resolved via PATH). */
  command?: string;
  /** Forwarded as `--agent <name>`. Omitted from argv when unset. */
  agent?: string;
  /** Forwarded as `--dir <path>` and used as the subprocess cwd. Default process.cwd(). */
  dir?: string;
  /** Forwarded as `--auto` when true. Dangerous — see class doc comment. Default false. */
  auto?: boolean;
  /** Hard kill timeout for the subprocess, ms. Default 300_000 (5 minutes). */
  timeoutMs?: number;
  /** Extra argv entries appended verbatim after the standard flags. */
  extraArgs?: string[];
}

interface ParsedRun {
  text: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  errorMessage?: string;
}

/** Grace period between SIGTERM and SIGKILL when the timeout fires. */
const KILL_GRACE_MS = 5000;

/**
 * Wraps `opencode run --format json` as a `Provider`. Spawns one fresh,
 * session-less `opencode run` subprocess per `complete()` call (no `-c`/`-s`
 * reuse — every call is independent).
 *
 * Caveats (see README "opencode run mode" for detail): token/cost numbers
 * include opencode's own system-prompt/tool-schema overhead and are not
 * comparable to raw chat-completion counts from OpenAICompatibleProvider for
 * the same model; `auto: true` auto-approves opencode's own permission
 * prompts (bash/file-edit tools) unattended and is off by default;
 * capabilities are all false, so callers always merge system+user into one
 * string before calling `complete()`.
 */
export class OpencodeProvider implements Provider {
  readonly capabilities = { systemRole: false, attachments: false, toolCalls: false };
  readonly name: string;
  readonly model: string;
  private command: string;
  private agent?: string;
  private dir: string;
  private auto: boolean;
  private timeoutMs: number;
  private extraArgs: string[];

  constructor(options: OpencodeOptions) {
    if (!options.model) {
      throw new Error('OpencodeProvider requires "model" (e.g. "anthropic/claude-sonnet-5")');
    }
    this.name = options.providerName ?? "opencode";
    this.model = options.model;
    this.command = options.command ?? "opencode";
    this.agent = options.agent;
    this.dir = options.dir ?? process.cwd();
    this.auto = options.auto ?? false;
    this.timeoutMs = options.timeoutMs ?? 5 * 60 * 1000;
    this.extraArgs = options.extraArgs ?? [];
  }

  async complete(prompt: string): Promise<ProviderResult> {
    const start = Date.now();
    try {
      const { stdout, stderr, exitCode, timedOut } = await this.runSubprocess(prompt);
      const latencyMs = Date.now() - start;
      const parsed = parseOpencodeNdjson(stdout);

      if (timedOut) {
        return this.errorResult(`opencode run timed out after ${this.timeoutMs}ms (killed)`, latencyMs, parsed);
      }
      if (parsed.errorMessage) {
        return this.errorResult(parsed.errorMessage, latencyMs, parsed);
      }
      if (exitCode !== 0) {
        const detail = stderr.trim().slice(-2000) || `exit code ${exitCode}`;
        return this.errorResult(`opencode run failed: ${detail}`, latencyMs, parsed);
      }

      return {
        provider: this.name,
        model: this.model,
        output: parsed.text,
        latencyMs,
        inputTokens: parsed.inputTokens,
        outputTokens: parsed.outputTokens,
        costUsd: parsed.costUsd,
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

  private errorResult(message: string, latencyMs: number, parsed: ParsedRun): ProviderResult {
    return {
      provider: this.name,
      model: this.model,
      output: "",
      latencyMs,
      inputTokens: parsed.inputTokens,
      outputTokens: parsed.outputTokens,
      costUsd: parsed.costUsd,
      error: message,
    };
  }

  private buildArgs(): string[] {
    const args = ["run", "--model", this.model, "--format", "json", "--dir", this.dir];
    if (this.agent) args.push("--agent", this.agent);
    if (this.auto) args.push("--auto");
    args.push(...this.extraArgs);
    return args;
  }

  private runSubprocess(
    stdinInput: string
  ): Promise<{ stdout: string; stderr: string; exitCode: number | null; timedOut: boolean }> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.command, this.buildArgs(), {
        cwd: this.dir,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let settled = false;

      const killTimer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS).unref();
      }, this.timeoutMs);
      killTimer.unref();

      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.stdin.on("error", () => {
        // Ignore EPIPE if the process exits before we finish writing.
      });

      child.on("error", (err) => {
        clearTimeout(killTimer);
        if (!settled) {
          settled = true;
          reject(err);
        }
      });
      child.on("close", (code) => {
        clearTimeout(killTimer);
        if (!settled) {
          settled = true;
          resolve({ stdout, stderr, exitCode: code, timedOut });
        }
      });

      child.stdin.write(stdinInput);
      child.stdin.end();
    });
  }
}

/**
 * Defensive line-by-line NDJSON parse of a full opencode `run --format json`
 * stdout buffer, parsed after the process exits (the `Provider` contract is
 * a single resolved Promise, not a stream).
 *
 * `text` parts are keyed by `part.id` (last write wins per id, joined in
 * first-seen order). `step_finish` token/cost fields are summed across every
 * occurrence — an agent run can take multiple internal steps (e.g. one to
 * call a tool, one to produce the final text). `reasoning` tokens are folded
 * into `outputTokens`; `cache` read/write are dropped (see README caveat on
 * non-comparable token counts). `error` events short-circuit to
 * `errorMessage`; unknown event types and malformed lines are ignored.
 */
function parseOpencodeNdjson(stdout: string): ParsedRun {
  const textById = new Map<string, string>();
  let inputTokens = 0;
  let outputTokens = 0;
  let costUsd = 0;
  let errorMessage: string | undefined;

  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    switch (event?.type) {
      case "text": {
        const part = event.part;
        if (part?.id && typeof part.text === "string") textById.set(part.id, part.text);
        break;
      }
      case "step_finish": {
        const tokens = event.part?.tokens;
        if (tokens) {
          inputTokens += tokens.input ?? 0;
          outputTokens += (tokens.output ?? 0) + (tokens.reasoning ?? 0);
        }
        if (typeof event.part?.cost === "number") costUsd += event.part.cost;
        break;
      }
      case "error": {
        errorMessage = event.error?.data?.message ?? event.error?.name ?? "opencode run reported an error";
        break;
      }
      default:
        break;
    }
  }

  return { text: Array.from(textById.values()).join(""), inputTokens, outputTokens, costUsd, errorMessage };
}
