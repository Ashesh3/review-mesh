import { execa, type Options } from "execa";
import type { Readable } from "node:stream";
import { z } from "zod";
import type { AdapterRegistration } from "../config/schemas.js";
import {
  incompleteReasonSchema,
  isolationLevelSchema,
  reviewerResultV2Schema,
  type IsolationLevel,
} from "../protocol/schemas.js";
import { adapterFailure, sanitizeAdapterFailure } from "./errors.js";
import {
  buildAllowlistedEnvironment,
  type AdapterCapabilities,
  type AdapterEvent,
  type AdapterReviewInput,
  type ReviewAdapter,
} from "./types.js";

const MAX_STDOUT_BYTES = 8 * 1024 * 1024;
const MAX_STDOUT_LINE_BYTES = 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const PROTOCOL = "review-mesh-command-v1";
const LAUNCH_ENVIRONMENT_NAMES = [
  "PATH",
  "Path",
  "PATHEXT",
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "TEMP",
  "TMP",
  "HOME",
  "USERPROFILE",
] as const;

type CommandRegistration = Extract<AdapterRegistration, { type: "command" }>;
export interface CommandAdapterDependencies {
  environment?: NodeJS.ProcessEnv;
  launch?: CommandLauncher;
  platform?: NodeJS.Platform;
}

export type CommandLauncher = (
  command: string,
  args: readonly string[],
  options: Options,
) => CommandProcess;

export interface CommandProcess extends PromiseLike<{
  exitCode?: number;
  isCanceled?: boolean;
}> {
  readonly pid?: number;
  readonly stdin: NodeJS.WritableStream | null;
  readonly stdout: Readable | null;
  readonly stderr: Readable | null;
  readonly nodeChildProcess?: {
    kill(signal?: NodeJS.Signals | number): boolean;
  };
  kill(signal?: NodeJS.Signals | number): boolean;
}

const capabilitiesEventSchema = z.strictObject({
  type: z.literal("capabilities"),
  isolation: isolationLevelSchema,
});
const progressEventSchema = z.strictObject({
  type: z.literal("progress"),
  phase: z.string().min(1),
  message: z.string().min(1).optional(),
});
const activityEventSchema = z.strictObject({
  type: z.literal("activity"),
  message: z.string().min(1),
});
const resultEventSchema = z.strictObject({
  type: z.literal("result"),
  result: reviewerResultV2Schema,
});
const failureEventSchema = z.strictObject({
  type: z.literal("failure"),
  failure: z.strictObject({
    reason: incompleteReasonSchema,
    message: z.string().min(1),
    retryable: z.boolean(),
  }),
});

type ProtocolTerminal =
  z.infer<typeof resultEventSchema> | z.infer<typeof failureEventSchema>;

interface ActiveChild {
  child: CommandProcess;
  pid: number;
  completion: Promise<void>;
}

type ChildOutcome =
  | {
      type: "result";
      result: { exitCode?: number; isCanceled?: boolean };
    }
  | { type: "error"; error: unknown };

function asBuffer(chunk: unknown): Buffer {
  if (typeof chunk === "string") return Buffer.from(chunk, "utf8");
  if (chunk instanceof Uint8Array) return Buffer.from(chunk);
  throw new TypeError("subprocess stream emitted a non-byte chunk");
}

function boundedUtf8(value: Buffer, maximumBytes: number): string {
  const bounded = value.subarray(0, maximumBytes);
  return bounded.toString("utf8").replace(/\uFFFD$/u, "");
}

async function collectStderr(stream: Readable | null): Promise<string> {
  if (stream === null) return "";
  const chunks: Buffer[] = [];
  let retained = 0;
  let truncated = false;
  for await (const rawChunk of stream) {
    const chunk = asBuffer(rawChunk);
    if (retained < MAX_STDERR_BYTES) {
      const remaining = MAX_STDERR_BYTES - retained;
      const kept = chunk.subarray(0, remaining);
      chunks.push(kept);
      retained += kept.byteLength;
    }
    if (retained >= MAX_STDERR_BYTES && chunk.byteLength > 0) truncated = true;
  }
  const message = boundedUtf8(Buffer.concat(chunks), MAX_STDERR_BYTES).trim();
  return truncated && message.length > 0 ? `${message} [truncated]` : message;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sanitizedPublicMessage(message: string): string {
  return sanitizeAdapterFailure("unknown", message).message;
}

function signalPromise(signal: AbortSignal): {
  promise: Promise<void>;
  dispose(): void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((completed) => {
    resolve = completed;
  });
  const onAbort = () => resolve();
  if (signal.aborted) resolve();
  else signal.addEventListener("abort", onAbort, { once: true });
  return {
    promise,
    dispose: () => signal.removeEventListener("abort", onAbort),
  };
}

class CommandAdapter implements ReviewAdapter {
  readonly id: string;
  private active?: ActiveChild;
  private cleanup?: { active: ActiveChild; promise: Promise<void> };
  private readonly environment: NodeJS.ProcessEnv;
  private readonly launch: CommandLauncher;
  private readonly platform: NodeJS.Platform;

  constructor(
    private readonly registration: CommandRegistration,
    dependencies: CommandAdapterDependencies,
  ) {
    this.id = registration.command;
    this.environment = dependencies.environment ?? process.env;
    this.launch =
      dependencies.launch ??
      ((command, args, options) =>
        execa(command, args, options) as unknown as CommandProcess);
    this.platform = dependencies.platform ?? process.platform;
  }

  async probe(): Promise<AdapterCapabilities> {
    return {
      available: true,
      authenticated: "unknown",
      model_available: "unknown",
      streaming: true,
      cancellation: true,
      maximumIsolation: "unknown",
    };
  }

  async *run(input: AdapterReviewInput): AsyncIterable<AdapterEvent> {
    if (this.active !== undefined) {
      yield {
        type: "failure",
        failure: adapterFailure.unavailable(
          "The command adapter already owns an active subprocess.",
        ),
      };
      return;
    }

    const env = buildAllowlistedEnvironment(
      [...LAUNCH_ENVIRONMENT_NAMES, ...(this.registration.env_allowlist ?? [])],
      this.environment,
    );
    for (const name of Object.keys(env)) {
      if (
        !LAUNCH_ENVIRONMENT_NAMES.includes(
          name as (typeof LAUNCH_ENVIRONMENT_NAMES)[number],
        ) &&
        !this.registration.env_allowlist?.includes(name)
      ) {
        delete env[name];
      }
    }
    Object.assign(env, {
      REVIEW_MESH_PROTOCOL_VERSION: PROTOCOL,
      REVIEW_MESH_RUN_ID: input.runId,
      REVIEW_MESH_REVIEWER_ID: input.reviewer.id,
      REVIEW_MESH_WORKSPACE: input.context.workspace,
      ...(input.context.project_name === undefined
        ? {}
        : { REVIEW_MESH_PROJECT_NAME: input.context.project_name }),
      REVIEW_MESH_REVIEW_SCOPE: input.context.review_scope.mode,
      REVIEW_MESH_ISOLATION_POLICY: input.isolationPolicy,
      REVIEW_MESH_MODEL: input.reviewer.model,
      ...(input.reviewer.effort === undefined
        ? {}
        : { REVIEW_MESH_REASONING_EFFORT: input.reviewer.effort }),
    });

    const child = this.launch(
      this.registration.command,
      this.registration.args ?? [],
      {
        cwd: input.context.workspace,
        env,
        extendEnv: false,
        shell: false,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        buffer: false,
        reject: false,
        forceKillAfterDelay: false,
        killDescendants: false,
        detached: this.platform !== "win32",
      },
    );
    const pid = child.pid;
    let active: ActiveChild | undefined;
    const childOutcome: Promise<ChildOutcome> = Promise.resolve(child).then(
      (result) => ({ type: "result" as const, result }),
      (error: unknown) => ({ type: "error" as const, error }),
    );
    const completion = childOutcome.then(() => {
      if (active !== undefined && this.active === active) delete this.active;
    });
    if (pid !== undefined) {
      active = { child, pid, completion };
      this.active = active;
    }
    const stderrPromise = collectStderr(child.stderr).catch(() => "");
    const abort = signalPromise(input.signal);

    const request = {
      protocol: PROTOCOL,
      run_id: input.runId,
      reviewer_id: input.reviewer.id,
      prompt: input.prompt,
      context: input.context,
      result_schema: input.resultJsonSchema,
      isolation_policy: input.isolationPolicy,
    };
    if (child.stdin === null) {
      child.kill();
      yield {
        type: "failure",
        failure: adapterFailure.processCrashed(
          "The command process did not expose stdin.",
        ),
      };
      return;
    }
    child.stdin.end(JSON.stringify(request));

    let actualIsolation: IsolationLevel = "prompt_only";
    let terminal: ProtocolTerminal | undefined;
    let protocolViolation: string | undefined;
    let eventCount = 0;
    let totalBytes = 0;
    let buffered = Buffer.alloc(0);

    const acceptLine = (lineBuffer: Buffer): AdapterEvent | undefined => {
      eventCount += 1;
      const normalized =
        lineBuffer.at(-1) === 0x0d
          ? lineBuffer.subarray(0, lineBuffer.byteLength - 1)
          : lineBuffer;
      let value: unknown;
      try {
        value = JSON.parse(normalized.toString("utf8"));
      } catch {
        protocolViolation = "The command emitted malformed JSON on stdout.";
        return undefined;
      }

      if (terminal !== undefined) {
        protocolViolation =
          "The command emitted stdout data after its terminal event.";
        return undefined;
      }
      const capabilities = capabilitiesEventSchema.safeParse(value);
      if (capabilities.success) {
        if (eventCount !== 1) {
          protocolViolation =
            "The command emitted capabilities after its first event.";
        } else {
          actualIsolation = capabilities.data.isolation;
        }
        return undefined;
      }
      const progress = progressEventSchema.safeParse(value);
      if (progress.success) {
        return {
          type: "progress",
          phase: progress.data.phase,
          ...(progress.data.message === undefined
            ? {}
            : { message: sanitizedPublicMessage(progress.data.message) }),
        };
      }
      const activity = activityEventSchema.safeParse(value);
      if (activity.success) {
        return {
          type: "activity",
          message: sanitizedPublicMessage(activity.data.message),
        };
      }
      const result = resultEventSchema.safeParse(value);
      if (result.success) {
        terminal = result.data;
        return undefined;
      }
      const failure = failureEventSchema.safeParse(value);
      if (failure.success) {
        terminal = failure.data;
        return undefined;
      }
      protocolViolation =
        "The command emitted an unsupported or invalid protocol event.";
      return undefined;
    };

    try {
      if (child.stdout === null) {
        protocolViolation = "The command process did not expose stdout.";
      } else {
        const stdout = child.stdout[Symbol.asyncIterator]();
        for (;;) {
          const next = Promise.resolve(stdout.next()).then(
            (result) => ({ type: "next" as const, result }),
            (error: unknown) => ({ type: "error" as const, error }),
          );
          const outcome = await Promise.race([
            next,
            abort.promise.then(() => ({ type: "abort" as const })),
          ]);
          if (outcome.type === "abort") {
            await completion;
            yield { type: "failure", failure: adapterFailure.cancelled() };
            return;
          }
          if (outcome.type === "error") throw outcome.error;
          if (outcome.result.done) break;
          const rawChunk = outcome.result.value;
          const chunk = asBuffer(rawChunk);
          totalBytes += chunk.byteLength;
          if (totalBytes > MAX_STDOUT_BYTES) {
            protocolViolation =
              "The command exceeded the total stdout byte limit.";
            child.kill();
            child.stdout.destroy();
            break;
          }
          buffered = Buffer.concat([buffered, chunk]);
          for (;;) {
            const newline = buffered.indexOf(0x0a);
            if (newline < 0) break;
            if (newline > MAX_STDOUT_LINE_BYTES) {
              protocolViolation =
                "The command exceeded the stdout line byte limit.";
              child.kill();
              child.stdout.destroy();
              break;
            }
            const line = buffered.subarray(0, newline);
            buffered = buffered.subarray(newline + 1);
            const event = acceptLine(line);
            if (event !== undefined) yield event;
            if (protocolViolation !== undefined) {
              child.kill();
              child.stdout.destroy();
              break;
            }
          }
          if (protocolViolation !== undefined) break;
          if (buffered.byteLength > MAX_STDOUT_LINE_BYTES) {
            protocolViolation =
              "The command exceeded the stdout line byte limit.";
            child.kill();
            child.stdout.destroy();
            break;
          }
        }
      }
      if (protocolViolation === undefined && buffered.byteLength > 0) {
        if (buffered.byteLength > MAX_STDOUT_LINE_BYTES) {
          protocolViolation =
            "The command exceeded the stdout line byte limit.";
        } else {
          const event = acceptLine(buffered);
          if (event !== undefined) yield event;
        }
      }

      const settled = await Promise.race([
        childOutcome,
        abort.promise.then(() => ({ type: "abort" as const })),
      ]);
      if (settled.type === "abort") {
        await completion;
        yield { type: "failure", failure: adapterFailure.cancelled() };
        return;
      }
      if (settled.type === "error") throw settled.error;
      const result = settled.result;
      const stderr = await stderrPromise;
      if (input.signal.aborted || result.isCanceled) {
        yield { type: "failure", failure: adapterFailure.cancelled() };
      } else if (protocolViolation !== undefined) {
        yield {
          type: "failure",
          failure: adapterFailure.protocolViolation(protocolViolation),
          isolation: actualIsolation,
        };
      } else if (result.exitCode !== 0 && terminal?.type !== "failure") {
        yield {
          type: "failure",
          failure: adapterFailure.processCrashed(
            `The command exited with code ${String(result.exitCode)}.${
              stderr.length === 0 ? "" : ` ${stderr}`
            }`,
          ),
          isolation: actualIsolation,
        };
      } else if (terminal === undefined) {
        yield {
          type: "failure",
          failure: adapterFailure.protocolViolation(
            "The command exited without a terminal event.",
          ),
          isolation: actualIsolation,
        };
      } else if (
        terminal.type === "result" &&
        input.isolationPolicy === "require_enforced" &&
        (actualIsolation as IsolationLevel) !== "enforced_read_only"
      ) {
        yield {
          type: "failure",
          failure: adapterFailure.unavailable(
            "The command did not achieve the required enforced read-only isolation.",
          ),
          isolation: actualIsolation,
        };
      } else if (terminal.type === "failure") {
        yield {
          type: "failure",
          failure: sanitizeAdapterFailure(
            terminal.failure.reason,
            terminal.failure.message,
            terminal.failure.retryable,
          ),
          isolation: actualIsolation,
        };
      } else {
        yield {
          type: "result",
          result: terminal.result,
          isolation: actualIsolation,
        };
      }
    } catch (error) {
      const stderr = await stderrPromise;
      const cancelled =
        input.signal.aborted ||
        (typeof error === "object" &&
          error !== null &&
          "isCanceled" in error &&
          error.isCanceled === true);
      if (cancelled) {
        yield { type: "failure", failure: adapterFailure.cancelled() };
      } else {
        yield {
          type: "failure",
          failure: adapterFailure.processCrashed(
            `${error instanceof Error ? error.message : String(error)}${
              stderr.length === 0 ? "" : ` ${stderr}`
            }`,
          ),
          isolation: actualIsolation,
        };
      }
    } finally {
      abort.dispose();
    }
  }

  async forceCleanup(): Promise<void> {
    const active = this.active;
    if (
      active === undefined ||
      this.active !== active ||
      active.child.pid !== active.pid
    )
      return;
    if (this.cleanup?.active === active) return this.cleanup.promise;
    if (!isPidAlive(active.pid)) return;
    const promise = (async () => {
      if (this.platform === "win32") {
        await this.launch(
          "taskkill.exe",
          ["/PID", String(active.pid), "/T", "/F"],
          {
            env: buildAllowlistedEnvironment(
              LAUNCH_ENVIRONMENT_NAMES,
              this.environment,
            ),
            extendEnv: false,
            shell: false,
            reject: false,
          },
        );
      } else if (this.active === active && isPidAlive(active.pid)) {
        try {
          process.kill(-active.pid, "SIGKILL");
        } catch {
          active.child.nodeChildProcess?.kill("SIGKILL") ??
            active.child.kill("SIGKILL");
        }
      }
      await active.completion;
    })();
    this.cleanup = { active, promise };
    try {
      await promise;
    } finally {
      if (this.cleanup?.promise === promise) delete this.cleanup;
    }
  }
}

export function createCommandAdapter(
  registration: AdapterRegistration,
  dependencies: CommandAdapterDependencies = {},
): ReviewAdapter {
  if (registration.type !== "command") {
    throw new Error("createCommandAdapter requires a command registration");
  }
  return new CommandAdapter(registration, dependencies);
}
