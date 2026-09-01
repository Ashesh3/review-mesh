import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { runReviewApplication } from "../../src/app.js";
import {
  publicEventSchema,
  type PublicEvent,
} from "../../src/protocol/schemas.js";
import { installAbortHandlers, runCli as runCliEntry } from "../../src/cli.js";

const projectRoot = resolve(import.meta.dirname, "../..");
const cliEntry = join(projectRoot, "src", "cli.ts");
const compiledCliEntry = join(projectRoot, "dist", "cli.js");
const commandFixtureUrl = pathToFileURL(
  join(projectRoot, "tests", "fixtures", "command-adapter.mjs"),
).href;
const maximumRequestBytes = 8 * 1024 * 1024;
const temporaryRoots: string[] = [];

interface ProcessResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

interface CliFixture {
  root: string;
  workspace: string;
  configFile: string;
  env: NodeJS.ProcessEnv;
  request: string;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function fixtureScript(mode: string): string {
  return `process.env.REVIEW_MESH_FIXTURE_MODE=${JSON.stringify(mode)}; await import(${JSON.stringify(commandFixtureUrl)});`;
}

function isolatedEnvironment(root: string): NodeJS.ProcessEnv {
  if (process.platform === "win32") {
    return { ...process.env, APPDATA: root, LOCALAPPDATA: root };
  }
  if (process.platform === "darwin") {
    return { ...process.env, HOME: root };
  }
  return {
    ...process.env,
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_DATA_HOME: join(root, "data"),
    XDG_STATE_HOME: join(root, "state"),
  };
}

function isolatedConfigFile(root: string): string {
  if (process.platform === "win32") {
    return join(root, "review-mesh", "Config", "config.toml");
  }
  if (process.platform === "darwin") {
    return join(root, "Library", "Preferences", "review-mesh", "config.toml");
  }
  return join(root, "config", "review-mesh", "config.toml");
}

function trustedConfig(modes: readonly string[]): string {
  const adapters = modes
    .map(
      (mode, index) => `
[adapters.fixture_${index}]
type = "command"
command = ${tomlString(process.execPath)}
args = ["--input-type=module", "-e", ${tomlString(fixtureScript(mode))}]
env_allowlist = ["REVIEW_MESH_FIXTURE_CAPTURE"]
protocol = "review-mesh-command-v1"

[reviewer_profiles.fixture_${index}]
adapter = "fixture_${index}"
model = "fixture-model-${index}"
purpose = "Exercise fixture reviewer ${index}"
instructions = "Inspect the controlled fixture."
isolation = "prefer_enforced"
timeout_ms = 5000

[[reviewers]]
id = "fixture-${index}"
profile = "fixture_${index}"
`,
    )
    .join("\n");

  return `schema_version = "1"

[execution]
max_concurrency = 2
heartbeat_interval_ms = 100
shutdown_grace_period_ms = 100

[diagnostics]
persist_runs = false
max_runs = 1
${adapters}`;
}

async function createFixture(
  modes: readonly string[] = ["pass", "pass"],
  config = trustedConfig(modes),
): Promise<CliFixture> {
  const root = await mkdtemp(join(tmpdir(), "review-mesh-cli-"));
  temporaryRoots.push(root);
  const workspace = join(root, "workspace");
  const configFile = isolatedConfigFile(root);
  await mkdir(workspace, { recursive: true });
  await mkdir(dirname(configFile), { recursive: true });
  await writeFile(configFile, config);
  return {
    root,
    workspace,
    configFile,
    env: isolatedEnvironment(root),
    request: JSON.stringify({
      schema_version: "1",
      request_id: "cli-test-request",
      workspace,
      instructions: "Review the controlled workspace.",
    }),
  };
}

function startCli(
  fixture: CliFixture,
  args: readonly string[] = ["review"],
  input = fixture.request,
): ChildProcessWithoutNullStreams {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", cliEntry, ...args],
    {
      cwd: projectRoot,
      env: fixture.env,
      stdio: "pipe",
      windowsHide: true,
    },
  );
  child.stdin.on("error", () => undefined);
  child.stdin.end(input);
  return child;
}

function startCompiledCli(
  fixture: CliFixture,
  args: readonly string[] = ["review"],
  input = fixture.request,
): ChildProcessWithoutNullStreams {
  const child = spawn(process.execPath, [compiledCliEntry, ...args], {
    cwd: projectRoot,
    env: fixture.env,
    stdio: "pipe",
    windowsHide: true,
  });
  child.stdin.on("error", () => undefined);
  child.stdin.end(input);
  return child;
}

function startOpenCli(
  fixture: CliFixture,
  imports: readonly string[] = [],
): ChildProcessWithoutNullStreams {
  return spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      ...imports.flatMap((url) => ["--import", url]),
      cliEntry,
      "review",
    ],
    {
      cwd: projectRoot,
      env: fixture.env,
      stdio: "pipe",
      windowsHide: true,
    },
  );
}

async function collectProcess(
  child: ChildProcessWithoutNullStreams,
): Promise<ProcessResult> {
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  const outcome = await new Promise<{
    exitCode: number | null;
    signal: NodeJS.Signals | null;
  }>((resolveOutcome, reject) => {
    child.once("error", reject);
    child.once("close", (exitCode, signal) =>
      resolveOutcome({ exitCode, signal }),
    );
  });
  return {
    ...outcome,
    stdout: Buffer.concat(stdout).toString("utf8"),
    stderr: Buffer.concat(stderr).toString("utf8"),
  };
}

async function collectProcessWithin(
  child: ChildProcessWithoutNullStreams,
  timeoutMs = 5000,
): Promise<ProcessResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      collectProcess(child),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          child.kill();
          reject(new Error("CLI did not terminate after detaching from stdin"));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function runCli(
  fixture: CliFixture,
  args: readonly string[] = ["review"],
  input = fixture.request,
): Promise<ProcessResult> {
  return collectProcess(startCli(fixture, args, input));
}

function parseEvents(stdout: string): PublicEvent[] {
  const lines = stdout.split(/\r?\n/).filter((line) => line.length > 0);
  return lines.map((line) => publicEventSchema.parse(JSON.parse(line)));
}

function parseSingleDiagnostic(stderr: string): Record<string, unknown> {
  const lines = stderr.split(/\r?\n/).filter((line) => line.length > 0);
  expect(lines).toHaveLength(1);
  return JSON.parse(lines[0]!) as Record<string, unknown>;
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      await access(path);
      return;
    } catch {
      await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    }
  }
  throw new Error(`timed out waiting for ${path}`);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("review-mesh review", () => {
  it("dispatches config path without consuming redirected stdin", async () => {
    const fixture = await createFixture();
    const input = new PassThrough();
    const output = new PassThrough();
    const error = new PassThrough();
    let stdout = "";
    let stderr = "";
    output.on("data", (chunk) => (stdout += chunk.toString()));
    error.on("data", (chunk) => (stderr += chunk.toString()));
    input.write("unconsumed review request");

    await runCliEntry(new EventEmitter(), {
      argv: ["config", "path"],
      input,
      output,
      error,
      configFile: fixture.configFile,
    });

    expect(process.exitCode).toBe(0);
    expect(stdout).toBe(`${fixture.configFile}\n`);
    expect(stderr).toBe("");
    expect(input.read()?.toString()).toBe("unconsumed review request");
    process.exitCode = undefined;
  });

  it("runs the compiled CLI with valid JSONL and a passed terminal", async () => {
    const build = await new Promise<ProcessResult>((resolveBuild, reject) => {
      const child = spawn(
        process.execPath,
        ["node_modules/typescript/bin/tsc", "-p", "tsconfig.json"],
        {
          cwd: projectRoot,
          env: process.env,
          stdio: "pipe",
          windowsHide: true,
        },
      );
      void collectProcess(child).then(resolveBuild, reject);
    });
    expect(build).toMatchObject({ exitCode: 0, signal: null });
    const fixture = await createFixture(["pass"]);

    const result = await collectProcess(startCompiledCli(fixture));
    const events = parseEvents(result.stdout);
    const completed = events.at(-1);

    expect(result).toMatchObject({ exitCode: 0, signal: null, stderr: "" });
    expect(completed?.event).toBe("run.completed");
    if (completed?.event !== "run.completed")
      throw new Error("missing completion");
    expect(completed.data).toMatchObject({ status: "passed", exit_code: 0 });
  }, 20_000);

  it("persists only to the injected application-data runs directory when enabled", async () => {
    const fixture = await createFixture(
      ["pass"],
      trustedConfig(["pass"]).replace(
        "persist_runs = false",
        "persist_runs = true",
      ),
    );
    const runsDirectory = join(fixture.root, "injected-app-data", "runs");
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let publicOutput = "";
    stdout.setEncoding("utf8");
    stdout.on("data", (chunk: string) => {
      publicOutput += chunk;
    });

    const exitCode = await runReviewApplication({
      requestText: fixture.request,
      configFile: fixture.configFile,
      stdout,
      stderr,
      signal: new AbortController().signal,
      runIdFactory: () => "persisted-run",
      appPaths: {
        configFile: join(fixture.root, "unused-config.toml"),
        reviewersDirectory: join(fixture.root, "unused-reviewers"),
        runsDirectory,
      },
    });

    expect(exitCode).toBe(0);
    expect(parseEvents(publicOutput)).not.toHaveLength(0);
    await expect(
      readFile(join(runsDirectory, "persisted-run.jsonl"), "utf8"),
    ).resolves.toContain('"event":"run.completed"');
    await expect(access(join(fixture.root, "runs"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("does not create the injected runs directory when persistence is disabled", async () => {
    const fixture = await createFixture(["pass"]);
    const runsDirectory = join(fixture.root, "injected-app-data", "runs");

    const exitCode = await runReviewApplication({
      requestText: fixture.request,
      configFile: fixture.configFile,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      signal: new AbortController().signal,
      appPaths: {
        configFile: join(fixture.root, "unused-config.toml"),
        reviewersDirectory: join(fixture.root, "unused-reviewers"),
        runsDirectory,
      },
    });

    expect(exitCode).toBe(0);
    await expect(access(runsDirectory)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("returns runtime failure when the final public event cannot be written", async () => {
    const fixture = await createFixture(["pass"]);
    const publicLines: string[] = [];
    const stdout = Object.assign(new EventEmitter(), {
      write(
        chunk: string | Uint8Array,
        callback?: (error?: Error | null) => void,
      ) {
        const line = chunk.toString();
        if (line.includes('"event":"run.completed"')) {
          setTimeout(
            () =>
              callback?.(
                new Error("Authorization: Bearer delayed-stdout-secret"),
              ),
            20,
          );
          return true;
        }
        publicLines.push(line);
        queueMicrotask(() => callback?.(null));
        return true;
      },
    }) as unknown as NodeJS.WritableStream;
    const stderr = new PassThrough();
    let diagnostic = "";
    stderr.setEncoding("utf8");
    stderr.on("data", (chunk: string) => {
      diagnostic += chunk;
    });

    const exitCode = await runReviewApplication({
      requestText: fixture.request,
      configFile: fixture.configFile,
      stdout,
      stderr,
      signal: new AbortController().signal,
    });

    expect(exitCode).toBe(3);
    expect(publicLines.join("")).not.toContain('"event":"run.completed"');
    expect(parseSingleDiagnostic(diagnostic)).toMatchObject({
      error: "review_failed",
    });
    expect(diagnostic).not.toContain("delayed-stdout-secret");
    expect(diagnostic).not.toMatch(/\n\s+at\s/);
  });

  it("exits 3 with one sanitized diagnostic when the stdout consumer closes", async () => {
    const fixture = await createFixture(["pass"]);
    const child = startOpenCli(fixture);
    child.stdout.destroy();
    child.stdin.end(fixture.request);

    const result = await collectProcessWithin(child, 5000);

    expect(result.exitCode).toBe(3);
    expect(result.signal).toBeNull();
    expect(parseSingleDiagnostic(result.stderr)).toMatchObject({
      error: "review_failed",
    });
    expect(result.stderr).not.toMatch(/\n\s+at\s/);
  });

  it("exits 0 and emits only reconstructable public JSONL for two clean reviewers", async () => {
    const fixture = await createFixture();

    const result = await runCli(fixture);
    const events = parseEvents(result.stdout);
    const completed = events.at(-1);

    expect(result).toMatchObject({ exitCode: 0, signal: null, stderr: "" });
    expect(events.length).toBeGreaterThan(0);
    expect(events.map((event) => event.seq)).toEqual(
      events.map((_, index) => index + 1),
    );
    expect(
      events.every((event) => /^run_[0-9a-f-]{36}$/.test(event.run_id)),
    ).toBe(true);
    expect(new Set(events.map((event) => event.run_id)).size).toBe(1);
    expect(completed?.event).toBe("run.completed");
    if (completed?.event !== "run.completed")
      throw new Error("missing completion");
    expect(completed.data).toMatchObject({
      status: "passed",
      exit_code: 0,
      suite: { total: 2, completed: 2, incomplete: 0 },
    });
    expect(
      completed.data.reviewers.map((reviewer) => reviewer.reviewer_id),
    ).toEqual(["fixture-0", "fixture-1"]);
    expect(
      completed.data.reviewers.every(
        (reviewer) => reviewer.status === "completed",
      ),
    ).toBe(true);
    expect(result.stdout).not.toMatch(/stack|usage|review mesh/i);
  });

  it("exits 1 while retaining both reviewer results when one reports findings", async () => {
    const fixture = await createFixture(["pass", "fail"]);

    const result = await runCli(fixture);
    const completed = parseEvents(result.stdout).at(-1);

    expect(result.exitCode).toBe(1);
    expect(completed?.event).toBe("run.completed");
    if (completed?.event !== "run.completed")
      throw new Error("missing completion");
    expect(completed.data.status).toBe("findings");
    expect(completed.data.exit_code).toBe(1);
    expect(completed.data.reviewers).toHaveLength(2);
    expect(
      completed.data.reviewers.some(
        (reviewer) =>
          reviewer.status === "completed" &&
          reviewer.result.actionable_findings.length === 1,
      ),
    ).toBe(true);
  });

  it("exits 3 with a sanitized incomplete record when one reviewer crashes", async () => {
    const fixture = await createFixture(["pass", "crash"]);

    const result = await runCli(fixture);
    const events = parseEvents(result.stdout);
    const completed = events.at(-1);

    expect(result.exitCode).toBe(3);
    expect(completed?.event).toBe("run.completed");
    if (completed?.event !== "run.completed")
      throw new Error("missing completion");
    expect(completed.data.status).toBe("incomplete");
    expect(completed.data.reviewers).toHaveLength(2);
    expect(
      completed.data.reviewers.some(
        (reviewer) =>
          reviewer.status === "incomplete" &&
          reviewer.reason === "process_crashed",
      ),
    ).toBe(true);
    expect(result.stdout).not.toContain("fixture-secret");
    expect(result.stdout).not.toContain("Authorization: Bearer");
    expect(result.stdout).not.toMatch(/\n\s+at\s/);
  });

  it("reports unregistered live adapter types as unavailable instead of crashing", async () => {
    const config = trustedConfig(["pass"]).replace(
      /\[adapters\.fixture_0\][\s\S]*?protocol = "review-mesh-command-v1"/,
      '[adapters.fixture_0]\ntype = "codex"',
    );
    const fixture = await createFixture(["pass"], config);

    const result = await runCli(fixture);
    const completed = parseEvents(result.stdout).at(-1);

    expect(result.exitCode).toBe(3);
    expect(completed?.event).toBe("run.completed");
    if (completed?.event !== "run.completed")
      throw new Error("missing completion");
    expect(completed.data.reviewers).toMatchObject([
      { status: "incomplete", reason: "adapter_unavailable" },
    ]);
  });

  it.each([
    ["malformed JSON", ["review"], "{", undefined, "invalid_request"],
    ["empty stdin", ["review"], "", undefined, "invalid_request"],
    ["unsupported command", ["inspect"], undefined, undefined, "invalid_usage"],
    ["a flag", ["--help"], undefined, undefined, "invalid_usage"],
    [
      "additional arguments",
      ["review", "extra"],
      undefined,
      undefined,
      "invalid_usage",
    ],
    [
      "invalid configuration",
      ["review"],
      undefined,
      'schema_version = "1"\n',
      "invalid_configuration",
    ],
  ])(
    "exits 2 with one stderr JSON object and no run for %s",
    async (_name, args, input, config, expectedError) => {
      const fixture = await createFixture(
        ["pass", "pass"],
        config ?? trustedConfig(["pass", "pass"]),
      );

      const result = await runCli(fixture, args, input ?? fixture.request);

      expect(result).toMatchObject({ exitCode: 2, signal: null, stdout: "" });
      expect(parseSingleDiagnostic(result.stderr)).toMatchObject({
        error: expectedError,
      });
      expect(result.stderr).not.toMatch(/\n\s+at\s/);
    },
  );

  it("rejects stdin beyond 8 MiB instead of truncating or beginning a run", async () => {
    const fixture = await createFixture();
    const oversized = " ".repeat(maximumRequestBytes + 1);

    const result = await runCli(fixture, ["review"], oversized);

    expect(result).toMatchObject({ exitCode: 2, signal: null, stdout: "" });
    expect(parseSingleDiagnostic(result.stderr)).toMatchObject({
      error: "request_too_large",
    });
  });

  it("rejects the first byte beyond 8 MiB without waiting for producer EOF", async () => {
    const fixture = await createFixture();
    const child = startOpenCli(fixture);
    child.stdin.on("error", () => undefined);
    child.stdin.write(Buffer.alloc(maximumRequestBytes + 1, 0x20));

    const result = await collectProcessWithin(child);

    expect(result).toMatchObject({ exitCode: 2, signal: null, stdout: "" });
    expect(parseSingleDiagnostic(result.stderr)).toMatchObject({
      error: "request_too_large",
    });
  });

  it("stops a never-ending stdin read when interrupted before a valid run", async () => {
    const fixture = await createFixture();
    const preload = `
      const timer = setInterval(() => {
        if (process.listenerCount("SIGTERM") === 0) return;
        clearInterval(timer);
        process.emit("SIGTERM");
      }, 10);
    `;
    const preloadUrl = `data:text/javascript,${encodeURIComponent(preload)}`;
    const child = startOpenCli(fixture, [preloadUrl]);

    const result = await collectProcessWithin(child);

    expect(result).toMatchObject({ exitCode: 2, signal: null, stdout: "" });
    expect(parseSingleDiagnostic(result.stderr)).toMatchObject({
      error: "interrupted",
    });
  });

  it("accepts an exactly 8 MiB request before configuration validation", async () => {
    const fixture = await createFixture(["pass"], 'schema_version = "1"\n');
    const request = {
      schema_version: "1",
      workspace: fixture.workspace,
      instructions: "Review the controlled workspace.",
      context: { padding: "" },
    };
    const base = JSON.stringify(request);
    request.context.padding = "x".repeat(
      maximumRequestBytes - Buffer.byteLength(base),
    );
    const input = JSON.stringify(request);
    expect(Buffer.byteLength(input)).toBe(maximumRequestBytes);

    const result = await runCli(fixture, ["review"], input);

    expect(result).toMatchObject({ exitCode: 2, signal: null, stdout: "" });
    expect(parseSingleDiagnostic(result.stderr)).toMatchObject({
      error: "invalid_configuration",
    });
  });

  it.each(["SIGINT", "SIGTERM"] as const)(
    "installs a %s handler that aborts one controller exactly once",
    (signal) => {
      const source = new EventEmitter();
      const controller = new AbortController();
      let aborts = 0;
      controller.signal.addEventListener("abort", () => {
        aborts += 1;
      });

      const remove = installAbortHandlers(controller, source);
      source.emit(signal);
      source.emit(signal);
      source.emit(signal === "SIGINT" ? "SIGTERM" : "SIGINT");
      remove();

      expect(controller.signal).toMatchObject({
        aborted: true,
        reason: signal,
      });
      expect(aborts).toBe(1);
      expect(source.listenerCount("SIGINT")).toBe(0);
      expect(source.listenerCount("SIGTERM")).toBe(0);
    },
  );

  it.skipIf(process.platform === "win32")(
    "turns SIGINT into one cancelled terminal run and cleans up the managed child",
    async () => {
      const fixture = await createFixture(["silent"]);
      const capturePath = join(fixture.root, "capture.json");
      fixture.env.REVIEW_MESH_FIXTURE_CAPTURE = capturePath;
      const child = startCli(fixture);
      let stdout = "";
      let resolveStarted!: () => void;
      const started = new Promise<void>((resolveStart) => {
        resolveStarted = resolveStart;
      });
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
        if (stdout.includes('"event":"reviewer.started"')) resolveStarted();
      });

      const resultPromise = collectProcess(child);
      await started;
      await waitForFile(capturePath);
      child.kill("SIGINT");
      const result = await resultPromise;
      const capture = JSON.parse(await readFile(capturePath, "utf8")) as {
        pid: number;
        child_pid: number;
      };
      const events = parseEvents(result.stdout);
      const completed = events.at(-1);

      expect(result).toMatchObject({ exitCode: 4, signal: null, stderr: "" });
      expect(result.signal).toBeNull();
      expect(completed?.event).toBe("run.completed");
      if (completed?.event !== "run.completed")
        throw new Error("missing completion");
      expect(completed.data).toMatchObject({
        status: "incomplete",
        exit_code: 4,
        reviewers: [{ status: "incomplete", reason: "cancelled" }],
      });
      expect(isProcessAlive(capture.pid)).toBe(false);
      expect(isProcessAlive(capture.child_pid)).toBe(false);
    },
    15_000,
  );
});
