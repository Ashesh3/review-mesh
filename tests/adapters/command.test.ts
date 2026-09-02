import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { execa } from "execa";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createCommandAdapter,
  type CommandLauncher,
  type CommandProcess,
} from "../../src/adapters/command.js";
import type {
  AdapterEvent,
  AdapterReviewInput,
} from "../../src/adapters/types.js";
import { buildAllowlistedEnvironment } from "../../src/adapters/types.js";
import { reviewerResultJsonSchema } from "../../src/protocol/json-schema.js";
import { buildReviewerPrompt } from "../../src/protocol/prompt.js";
import { runReviewRound } from "../../src/orchestrator/run-review.js";
import {
  resolvedContext,
  resolvedReviewer,
  roundInput,
} from "../helpers/fixtures.js";

const fixture = resolve("tests/fixtures/command-adapter.mjs");
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryWorkspace(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "review-mesh-command-"));
  temporaryDirectories.push(directory);
  return directory;
}

function sourceEnvironment(mode: string, capture?: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    REVIEW_MESH_FIXTURE_MODE: mode,
    REVIEW_MESH_ALLOWED_TOKEN: "trusted-value",
    REVIEW_MESH_LEAKED_SECRET: "must-not-cross-boundary",
  };
  for (const name of [
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
  ]) {
    if (process.env[name] !== undefined) environment[name] = process.env[name];
  }
  if (capture !== undefined) environment.REVIEW_MESH_FIXTURE_CAPTURE = capture;
  return environment;
}

async function setup(
  mode: string,
  options: {
    capture?: string;
    requireEnforced?: boolean;
    captureLaunchEnvironment?: boolean;
  } = {},
) {
  const workspace = await temporaryWorkspace();
  const reviewer = resolvedReviewer({
    id: "command-reviewer",
    isolationPolicy: options.requireEnforced
      ? "require_enforced"
      : "prefer_enforced",
  });
  const context = resolvedContext({
    workspace,
    instructions: "Inspect the controlled workspace.",
    caller_context: { ticket: "RM-8" },
  });
  const prompt = buildReviewerPrompt({
    reviewer,
    context,
    resultJsonSchema: reviewerResultJsonSchema,
  });
  const controller = new AbortController();
  const envAllowlist = [
    "REVIEW_MESH_FIXTURE_MODE",
    "REVIEW_MESH_ALLOWED_TOKEN",
    ...(options.capture === undefined ? [] : ["REVIEW_MESH_FIXTURE_CAPTURE"]),
  ];
  const registration = {
    type: "command" as const,
    command: process.execPath,
    args: [fixture],
    env_allowlist: envAllowlist,
    protocol: "review-mesh-command-v1" as const,
  };
  let launchedEnvironment: NodeJS.ProcessEnv | undefined;
  let launchInvocation:
    | {
        command: string;
        args: readonly string[];
        options: Parameters<CommandLauncher>[2];
      }
    | undefined;
  const launchInvocations: Array<{
    command: string;
    args: readonly string[];
    options: Parameters<CommandLauncher>[2];
  }> = [];
  const launch: CommandLauncher = (command, args, launchOptions) => {
    launchInvocation = { command, args, options: launchOptions };
    launchInvocations.push(launchInvocation);
    launchedEnvironment = launchOptions.env as NodeJS.ProcessEnv | undefined;
    return execa(command, args, launchOptions);
  };
  const adapter = createCommandAdapter(registration, {
    environment: sourceEnvironment(mode, options.capture),
    ...(options.captureLaunchEnvironment === true ? { launch } : {}),
  });
  const input: AdapterReviewInput = {
    runId: "run-command-8",
    reviewer,
    context,
    prompt,
    resultJsonSchema: reviewerResultJsonSchema,
    isolationPolicy: reviewer.isolationPolicy,
    signal: controller.signal,
  };
  return {
    adapter,
    controller,
    input,
    workspace,
    launchedEnvironment: () => launchedEnvironment,
    launchInvocation: () => launchInvocation,
    launchInvocations,
  };
}

async function collect(iterable: AsyncIterable<AdapterEvent>) {
  const events: AdapterEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

function terminalFailure(events: readonly AdapterEvent[]) {
  const event = events.at(-1);
  expect(event?.type).toBe("failure");
  if (event?.type !== "failure") throw new Error("expected terminal failure");
  return event;
}

async function waitForFile(path: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await access(path);
      return;
    } catch {
      await delay(10);
    }
  }
  throw new Error(`timed out waiting for ${path}`);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function controlledProcess(pid: number) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let settle!: (result: { exitCode: number; isCanceled?: boolean }) => void;
  const completion = new Promise<{
    exitCode: number;
    isCanceled?: boolean;
  }>((resolve) => {
    settle = resolve;
  });
  const process: CommandProcess & { pid: number } = {
    pid,
    stdin,
    stdout,
    stderr,
    kill: vi.fn(() => true),
    then: completion.then.bind(completion),
  };
  return {
    process,
    stdout,
    finish(
      result: { exitCode: number; isCanceled?: boolean } = { exitCode: 0 },
    ) {
      stdout.end();
      stderr.end();
      settle(result);
    },
  };
}

describe("generic command adapter", () => {
  it("translates progress and a passing result using prompt-only isolation by default", async () => {
    const { adapter, input } = await setup("pass");

    await expect(collect(adapter.run(input))).resolves.toEqual([
      { type: "progress", phase: "reviewing", message: "fixture active" },
      {
        type: "result",
        result: {
          schema_version: "1",
          verdict: "pass",
          summary: "clean",
          actionable_findings: [],
          informational_notes: [],
        },
        isolation: "prompt_only",
      },
    ]);
  });

  it("preserves a valid failing reviewer result", async () => {
    const { adapter, input } = await setup("fail");

    const events = await collect(adapter.run(input));

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "result",
      isolation: "prompt_only",
      result: {
        verdict: "fail",
        actionable_findings: [{ id: "fixture-medium", severity: "medium" }],
      },
    });
  });

  it("sanitizes credential-shaped progress and activity before yielding public messages", async () => {
    const { adapter, input } = await setup("secret-messages");

    const events = await collect(adapter.run(input));

    expect(events.slice(0, 2)).toEqual([
      { type: "progress", phase: "reviewing", message: "[redacted] reviewing" },
      { type: "activity", message: "[redacted] reviewing" },
    ]);
    expect(JSON.stringify(events)).not.toContain("progress-secret");
    expect(JSON.stringify(events)).not.toContain("activity-secret");
  });

  it("writes exactly one complete request and only the allowlisted environment", async () => {
    const capture = join(await temporaryWorkspace(), "capture.json");
    const { adapter, input, workspace, launchedEnvironment, launchInvocation } =
      await setup("pass", { capture, captureLaunchEnvironment: true });
    input.reviewer.effort = "high";

    await collect(adapter.run(input));
    const captured = JSON.parse(await readFile(capture, "utf8")) as {
      request: unknown;
      env: Record<string, string>;
    };

    expect(captured.request).toEqual({
      protocol: "review-mesh-command-v1",
      run_id: "run-command-8",
      reviewer_id: "command-reviewer",
      prompt: input.prompt,
      context: input.context,
      result_schema: reviewerResultJsonSchema,
      isolation_policy: "prefer_enforced",
    });
    expect(captured.env).toMatchObject({
      REVIEW_MESH_FIXTURE_MODE: "pass",
      REVIEW_MESH_FIXTURE_CAPTURE: capture,
      REVIEW_MESH_ALLOWED_TOKEN: "trusted-value",
      REVIEW_MESH_PROTOCOL_VERSION: "review-mesh-command-v1",
      REVIEW_MESH_RUN_ID: "run-command-8",
      REVIEW_MESH_REVIEWER_ID: "command-reviewer",
      REVIEW_MESH_WORKSPACE: workspace,
      REVIEW_MESH_ISOLATION_POLICY: "prefer_enforced",
      REVIEW_MESH_MODEL: input.reviewer.model,
      REVIEW_MESH_REASONING_EFFORT: "high",
    });
    expect(captured.env).not.toHaveProperty("REVIEW_MESH_LEAKED_SECRET");
    expect(launchInvocation()).toMatchObject({
      command: process.execPath,
      args: [fixture],
      options: {
        cwd: workspace,
        shell: false,
        extendEnv: false,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        reject: false,
        killDescendants: false,
        detached: false,
      },
    });
    const expectedNames = new Set([
      "REVIEW_MESH_FIXTURE_MODE",
      "REVIEW_MESH_FIXTURE_CAPTURE",
      "REVIEW_MESH_ALLOWED_TOKEN",
      "REVIEW_MESH_PROTOCOL_VERSION",
      "REVIEW_MESH_RUN_ID",
      "REVIEW_MESH_REVIEWER_ID",
      "REVIEW_MESH_WORKSPACE",
      "REVIEW_MESH_ISOLATION_POLICY",
      "REVIEW_MESH_MODEL",
      "REVIEW_MESH_REASONING_EFFORT",
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
    ]);
    expect(Object.keys(launchedEnvironment() ?? {}).sort()).toEqual(
      [...expectedNames]
        .filter(
          (name) =>
            name.startsWith("REVIEW_MESH_") ||
            sourceEnvironment("pass", capture)[name] !== undefined,
        )
        .sort(),
    );
  });

  it("does not copy inherited properties from an environment object", () => {
    const inherited = Object.create({
      toString: "inherited-secret",
    }) as NodeJS.ProcessEnv;
    inherited.PATH = "safe-path";
    expect(buildAllowlistedEnvironment(["toString"], inherited)).toEqual({
      PATH: "safe-path",
    });
  });

  it.each([
    ["malformed", "malformed json"],
    ["no-terminal", "without a terminal"],
    ["double-terminal", "terminal"],
    ["extra-after-terminal", "terminal"],
    ["capabilities-late", "capabilities"],
    ["oversized-line", "line"],
    ["oversized-total", "total"],
  ])("maps %s stdout to a protocol violation", async (mode, message) => {
    const { adapter, input } = await setup(mode);

    const failure = terminalFailure(await collect(adapter.run(input)));

    expect(failure.failure.reason).toBe("protocol_violation");
    expect(failure.failure.message.toLowerCase()).toContain(message);
  });

  it("maps a nonzero exit without terminal failure to a sanitized process crash", async () => {
    const { adapter, input } = await setup("crash");

    const failure = terminalFailure(await collect(adapter.run(input)));

    expect(failure.failure).toMatchObject({
      reason: "process_crashed",
      retryable: false,
    });
    expect(failure.failure.message).toContain("7");
    expect(failure.failure.message).toContain("[redacted]");
    expect(failure.failure.message).not.toContain("fixture-secret");
  });

  it("caps stderr before publishing a process crash diagnostic", async () => {
    const { adapter, input } = await setup("crash-large");

    const failure = terminalFailure(await collect(adapter.run(input)));

    expect(failure.failure.reason).toBe("process_crashed");
    expect(
      Buffer.byteLength(failure.failure.message, "utf8"),
    ).toBeLessThanOrEqual(1_000);
    expect(failure.failure.message).toContain("9");
  });

  it("rejects a result before acceptance when enforced isolation is required", async () => {
    const { adapter, input } = await setup("pass", { requireEnforced: true });

    const failure = terminalFailure(await collect(adapter.run(input)));

    expect(failure).toMatchObject({
      isolation: "prompt_only",
      failure: { reason: "adapter_unavailable" },
    });
  });

  it("accepts a first capabilities event that reports enforced read-only isolation", async () => {
    const { adapter, input } = await setup("capabilities-enforced", {
      requireEnforced: true,
    });

    const events = await collect(adapter.run(input));

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "result",
      isolation: "enforced_read_only",
      result: { verdict: "pass" },
    });
  });

  it("retains a silent process after abort until force cleanup kills its exact tree", async () => {
    const capture = join(await temporaryWorkspace(), "silent.json");
    const { adapter, controller, input } = await setup("silent", { capture });
    const running = collect(adapter.run(input));
    await waitForFile(capture);
    const { pid, child_pid: childPid } = JSON.parse(
      await readFile(capture, "utf8"),
    ) as { pid: number; child_pid: number };

    controller.abort(new Error("deadline"));
    await delay(50);
    expect(isAlive(pid)).toBe(true);
    expect(isAlive(childPid)).toBe(true);
    await adapter.forceCleanup?.();
    const failure = terminalFailure(await running);

    expect(failure.failure).toMatchObject({ reason: "cancelled" });
    await expect.poll(() => isAlive(pid), { timeout: 2_000 }).toBe(false);
    await expect.poll(() => isAlive(childPid), { timeout: 2_000 }).toBe(false);
  });

  it("uses literal Windows taskkill arguments only for the still-owned spawned PID", async () => {
    const { process: command, finish } = controlledProcess(process.pid);
    const cleanup = controlledProcess(0);
    cleanup.finish();
    const invocations: Array<{
      command: string;
      args: readonly string[];
      options: Parameters<CommandLauncher>[2];
    }> = [];
    const launch: CommandLauncher = (file, args, options) => {
      invocations.push({ command: file, args, options });
      if (file === "taskkill.exe") finish({ exitCode: 1, isCanceled: true });
      return invocations.length === 1 ? command : cleanup.process;
    };
    const prepared = await setup("pass");
    const adapter = createCommandAdapter(
      {
        type: "command",
        command: "reviewer.exe",
        protocol: "review-mesh-command-v1",
      },
      { launch, platform: "win32", environment: sourceEnvironment("pass") },
    );
    const running = collect(adapter.run(prepared.input));
    await vi.waitFor(() => expect(invocations).toHaveLength(1));

    await adapter.forceCleanup?.();

    expect(command.kill).not.toHaveBeenCalled();
    expect(invocations[1]).toMatchObject({
      command: "taskkill.exe",
      args: ["/PID", String(process.pid), "/T", "/F"],
      options: { shell: false, extendEnv: false, reject: false },
    });
    finish();
    await running;
  });

  it("shares one in-flight Windows taskkill across concurrent force cleanup calls", async () => {
    const { process: command, finish } = controlledProcess(process.pid);
    const cleanup = controlledProcess(0);
    const invocations: string[] = [];
    const launch: CommandLauncher = (file) => {
      invocations.push(file);
      return file === "taskkill.exe" ? cleanup.process : command;
    };
    const prepared = await setup("pass");
    const adapter = createCommandAdapter(
      {
        type: "command",
        command: "reviewer.exe",
        protocol: "review-mesh-command-v1",
      },
      { launch, platform: "win32", environment: sourceEnvironment("pass") },
    );
    const running = collect(adapter.run(prepared.input));
    await vi.waitFor(() => expect(invocations).toEqual(["reviewer.exe"]));

    const cleanupCalls = Promise.all([
      adapter.forceCleanup?.(),
      adapter.forceCleanup?.(),
    ]);
    await vi.waitFor(() =>
      expect(
        invocations.filter((file) => file === "taskkill.exe"),
      ).toHaveLength(1),
    );
    cleanup.finish();
    finish({ exitCode: 1, isCanceled: true });
    await cleanupCalls;
    await running;

    expect(invocations).toEqual(["reviewer.exe", "taskkill.exe"]);
  });

  it("joins an in-flight Windows cleanup after the owned PID stops being alive", async () => {
    const pid = 42_424;
    const { process: command, finish } = controlledProcess(pid);
    const cleanup = controlledProcess(0);
    const invocations: string[] = [];
    const launch: CommandLauncher = (file) => {
      invocations.push(file);
      return file === "taskkill.exe" ? cleanup.process : command;
    };
    let livenessChecks = 0;
    const liveness = vi
      .spyOn(process, "kill")
      .mockImplementation((checkedPid, signal) => {
        if (checkedPid === pid && signal === 0) {
          livenessChecks += 1;
          if (livenessChecks === 1) return true;
          throw Object.assign(new Error("process not found"), {
            code: "ESRCH",
          });
        }
        return true;
      });
    try {
      const prepared = await setup("pass");
      const adapter = createCommandAdapter(
        {
          type: "command",
          command: "reviewer.exe",
          protocol: "review-mesh-command-v1",
        },
        { launch, platform: "win32", environment: sourceEnvironment("pass") },
      );
      const running = collect(adapter.run(prepared.input));
      await vi.waitFor(() => expect(invocations).toEqual(["reviewer.exe"]));

      let firstSettled = false;
      const firstCleanup = adapter.forceCleanup?.().then(() => {
        firstSettled = true;
      });
      await vi.waitFor(() =>
        expect(invocations).toEqual(["reviewer.exe", "taskkill.exe"]),
      );
      let secondSettled = false;
      const secondCleanup = adapter.forceCleanup?.().then(() => {
        secondSettled = true;
      });
      await Promise.resolve();

      expect(firstSettled).toBe(false);
      expect(secondSettled).toBe(false);
      expect(livenessChecks).toBe(1);
      expect(invocations).toEqual(["reviewer.exe", "taskkill.exe"]);
      cleanup.finish();
      await Promise.resolve();
      expect(firstSettled).toBe(false);
      expect(secondSettled).toBe(false);

      finish({ exitCode: 1, isCanceled: true });
      await Promise.all([firstCleanup, secondCleanup, running]);

      expect(firstSettled).toBe(true);
      expect(secondSettled).toBe(true);
      expect(invocations).toEqual(["reviewer.exe", "taskkill.exe"]);
    } finally {
      liveness.mockRestore();
    }
  });

  it("does not tree-kill a captured PID after the active child identity changes", async () => {
    const { process: command, stdout, finish } = controlledProcess(process.pid);
    const invocations: string[] = [];
    const launch: CommandLauncher = (file) => {
      invocations.push(file);
      return command;
    };
    const prepared = await setup("pass");
    const adapter = createCommandAdapter(
      {
        type: "command",
        command: "reviewer.exe",
        protocol: "review-mesh-command-v1",
      },
      { launch, platform: "win32", environment: sourceEnvironment("pass") },
    );
    const running = collect(adapter.run(prepared.input));
    await vi.waitFor(() => expect(invocations).toHaveLength(1));
    command.pid += 1;

    await adapter.forceCleanup?.();

    expect(command.kill).not.toHaveBeenCalled();
    expect(invocations).toEqual(["reviewer.exe"]);
    stdout.end(
      `${JSON.stringify({
        type: "result",
        result: {
          schema_version: "1",
          verdict: "pass",
          summary: "clean",
          actionable_findings: [],
          informational_notes: [],
        },
      })}\n`,
    );
    finish();
    await running;
  });

  it("does not give Execa the review signal and leaves tree cleanup to forceCleanup", async () => {
    const capture = join(await temporaryWorkspace(), "boundary.json");
    const { adapter, controller, input, launchInvocation } = await setup(
      "silent",
      { capture, captureLaunchEnvironment: true },
    );
    const running = collect(adapter.run(input));
    await waitForFile(capture);
    const { pid, child_pid: childPid } = JSON.parse(
      await readFile(capture, "utf8"),
    ) as { pid: number; child_pid: number };

    expect(launchInvocation()?.options).toMatchObject({
      killDescendants: false,
      detached: false,
      forceKillAfterDelay: false,
    });
    expect(launchInvocation()?.options.cancelSignal).toBeUndefined();
    controller.abort(new Error("deadline"));
    await delay(50);
    expect(isAlive(pid)).toBe(true);
    expect(isAlive(childPid)).toBe(true);

    await adapter.forceCleanup?.();
    const failure = terminalFailure(await running);
    expect(failure.failure.reason).toBe("cancelled");
    await expect.poll(() => isAlive(pid), { timeout: 2_000 }).toBe(false);
    await expect.poll(() => isAlive(childPid), { timeout: 2_000 }).toBe(false);
  });

  it("times out a real command tree only after deadline grace and leaves no orphan", async () => {
    const capture = join(await temporaryWorkspace(), "deadline.json");
    const prepared = await setup("silent", {
      capture,
      captureLaunchEnvironment: true,
    });
    const startedAt = Date.now();
    const completionPromise = runReviewRound(
      roundInput({
        adapters: { command: prepared.adapter },
        context: { workspace: prepared.workspace },
        config: {
          execution: {
            heartbeat_interval_ms: 1_000,
            shutdown_grace_period_ms: 75,
          },
          reviewers: [{ timeoutMs: 75 }],
        },
      }),
    );
    await waitForFile(capture);
    const { pid, child_pid: childPid } = JSON.parse(
      await readFile(capture, "utf8"),
    ) as { pid: number; child_pid: number };
    expect(isAlive(pid)).toBe(true);
    expect(isAlive(childPid)).toBe(true);

    const completion = await completionPromise;

    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(140);
    expect(completion.reviewers[0]).toMatchObject({
      status: "incomplete",
      reason: "timeout",
    });
    expect(prepared.launchInvocations.at(-1)).toMatchObject({
      command: "taskkill.exe",
      args: ["/PID", String(pid), "/T", "/F"],
    });
    await expect.poll(() => isAlive(pid), { timeout: 2_000 }).toBe(false);
    await expect.poll(() => isAlive(childPid), { timeout: 2_000 }).toBe(false);
  });

  it("interrupts through scheduler grace before exact-PID force cleanup and exit 4", async () => {
    const { process: command, finish } = controlledProcess(process.pid);
    const cleanup = controlledProcess(0);
    cleanup.finish();
    const invocations: Array<{
      command: string;
      args: readonly string[];
      options: Parameters<CommandLauncher>[2];
      at: number;
    }> = [];
    const launch: CommandLauncher = (file, args, options) => {
      invocations.push({ command: file, args, options, at: Date.now() });
      if (file === "taskkill.exe") {
        finish({ exitCode: 1, isCanceled: true });
        return cleanup.process;
      }
      return command;
    };
    const adapter = createCommandAdapter(
      {
        type: "command",
        command: "reviewer.exe",
        protocol: "review-mesh-command-v1",
      },
      { launch, platform: "win32", environment: sourceEnvironment("pass") },
    );
    const controller = new AbortController();
    const completionPromise = runReviewRound(
      roundInput({
        adapters: { command: adapter },
        signal: controller.signal,
        config: {
          execution: {
            heartbeat_interval_ms: 1_000,
            shutdown_grace_period_ms: 75,
          },
        },
      }),
    );
    await vi.waitFor(() => expect(invocations).toHaveLength(1));
    expect(invocations[0]?.options.cancelSignal).toBeUndefined();
    const abortedAt = Date.now();
    controller.abort(new Error("caller interrupted"));
    await delay(40);
    expect(invocations).toHaveLength(1);

    const completion = await completionPromise;

    expect(invocations[1]).toMatchObject({
      command: "taskkill.exe",
      args: ["/PID", String(process.pid), "/T", "/F"],
    });
    expect(invocations[1]!.at - abortedAt).toBeGreaterThanOrEqual(70);
    expect(completion.exitCode).toBe(4);
    expect(completion.reviewers[0]).toMatchObject({ reason: "cancelled" });
  });
});
