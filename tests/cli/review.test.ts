import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { PassThrough, Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { execa } from "execa";
import { runReviewApplication } from "../../src/app.js";
import {
  publicEventSchema,
  type PublicEvent,
} from "../../src/protocol/schemas.js";
import { reviewerResultDigest } from "../../src/results/digest.js";
import { readRunReport } from "../../src/diagnostics/run-report.js";
import { readRunStatus } from "../../src/diagnostics/run-status.js";
import { installAbortHandlers, runCli as runCliEntry } from "../../src/cli.js";

const projectRoot = resolve(import.meta.dirname, "../..");
const require = createRequire(import.meta.url);
const tscCli = require.resolve("typescript/bin/tsc");
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

function multiModelConfig(): string {
  return `schema_version = "4"

[execution]
max_concurrency = 2
heartbeat_interval_ms = 100
shutdown_grace_period_ms = 100

[diagnostics]
persist_runs = false
max_runs = 1

[adapters.opus]
type = "command"
command = ${tomlString(process.execPath)}
args = ["--input-type=module", "-e", ${tomlString(fixtureScript("pass"))}]
protocol = "review-mesh-command-v1"

[adapters.grok]
type = "command"
command = ${tomlString(process.execPath)}
args = ["--input-type=module", "-e", ${tomlString(fixtureScript("pass"))}]
protocol = "review-mesh-command-v1"

[agents.architecture]
adapter = "opus"
model_runs = [
  { id = "opus", model = "claude-opus-test", effort = "high" },
  { id = "grok", adapter = "grok", model = "grok-test", effort = "medium" },
]
purpose = "Review architecture twice"
instructions = "Inspect the controlled fixture architecture."
isolation = "prefer_enforced"
timeout_ms = 5000

[defaults]
agents = ["architecture"]
`;
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
  await execa("git", ["init", "--initial-branch=main"], { cwd: workspace });
  await execa("git", ["config", "user.name", "Review Mesh Test"], {
    cwd: workspace,
  });
  await execa("git", ["config", "user.email", "review-mesh@example.test"], {
    cwd: workspace,
  });
  await writeFile(join(workspace, "README.md"), "fixture\n");
  await execa("git", ["add", "README.md"], { cwd: workspace });
  await execa("git", ["commit", "-m", "Initial fixture"], { cwd: workspace });
  await mkdir(dirname(configFile), { recursive: true });
  await writeFile(configFile, config);
  return {
    root,
    workspace,
    configFile,
    env: isolatedEnvironment(root),
    request: JSON.stringify({
      schema_version: "2",
      request_id: "cli-test-request",
      project_name: "workspace",
      workspace,
      instructions: "Review the controlled workspace.",
      review_scope: { mode: "changes" },
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
  it("runs one agent's models in ordered quorum progression", async () => {
    const fixture = await createFixture([], multiModelConfig());

    const result = await runCli(fixture);
    expect(result).toMatchObject({ exitCode: 0, stderr: "" });
    const events = parseEvents(result.stdout);
    const suite = events.find((event) => event.event === "suite.resolved");
    expect(suite).toMatchObject({
      data: {
        logical_lenses: 1,
        model_runs: 2,
        lenses: [
          {
            id: "architecture",
            model_runs: 2,
          },
        ],
      },
    });
    expect(suite === undefined ? undefined : "reviewers" in suite.data).toBe(
      false,
    );
    expect(JSON.stringify(suite)).not.toMatch(
      /claude-opus-test|grok-test|architecture::opus|architecture::grok/u,
    );
    expect(
      events
        .filter((event) => event.event === "reviewer.completed")
        .map((event) => event.reviewer_id)
        .sort(),
    ).toEqual(["architecture::grok", "architecture::opus"]);
  });

  it.each([
    ["no arguments", []],
    ["help", ["help"]],
    ["long flag", ["--help"]],
    ["short flag", ["-h"]],
  ] as const)(
    "prints agent-first overview help for %j without consuming stdin",
    async (_case, argv) => {
      process.exitCode = undefined;
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
        argv: [...argv],
        input,
        output,
        error,
        configFile: fixture.configFile,
      });

      expect(process.exitCode).toBe(0);
      expect(stdout).toContain("AGENT QUICK START");
      expect(stdout).toContain("review-mesh describe . --json");
      expect(stderr).toBe("");
      expect(input.read()?.toString()).toBe("unconsumed review request");
      process.exitCode = undefined;
    },
  );

  it("prints focused topic help and the application version", async () => {
    const fixture = await createFixture();
    const topic = await runCli(fixture, ["help", "events"], "");
    expect(topic).toMatchObject({ exitCode: 0, stderr: "" });
    expect(topic.stdout).toContain("REVIEW-MESH EVENTS");
    expect(topic.stdout).toContain(
      "reviewer.result      Complete sanitized result/digest in full-jsonl mode.",
    );
    expect(topic.stdout).toContain(
      "run.completed        Outcomes, canonical counts, result manifest, and artifact.",
    );
    expect(topic.stdout).toContain("run.completed");

    const commandHelp = await runCli(fixture, ["review", "--help"], "");
    expect(commandHelp).toMatchObject({ exitCode: 0, stderr: "" });
    expect(commandHelp.stdout).toContain("REVIEW-MESH REVIEW");
    expect(commandHelp.stdout).toContain(
      "Full JSONL, no ANSI, and aggregate heartbeats are the defaults.",
    );

    const version = await runCli(fixture, ["--version"], "");
    expect(version).toMatchObject({ exitCode: 0, stderr: "" });
    expect(version.stdout).toMatch(/^review-mesh \d+\.\d+\.\d+\n$/);
  });

  it("queries one persisted reviewer status without starting a review", async () => {
    const fixture = await createFixture();
    const runsDirectory = join(fixture.root, "injected-app-data", "runs");
    await mkdir(runsDirectory, { recursive: true });
    await writeFile(
      join(runsDirectory, "run-query.jsonl.active.12.1.owner"),
      `${JSON.stringify({
        schema_version: "5",
        event: "reviewer.progress",
        run_id: "run-query",
        seq: 1,
        timestamp: "2026-09-03T00:00:00.000Z",
        reviewer_id: "fixture-0",
        data: { phase: "reviewing", message: "Inspecting files." },
      })}\n`,
    );
    const input = new PassThrough();
    const output = new PassThrough();
    const error = new PassThrough();
    let stdout = "";
    let stderr = "";
    output.on("data", (chunk) => (stdout += chunk.toString()));
    error.on("data", (chunk) => (stderr += chunk.toString()));
    input.end();

    await runCliEntry(new EventEmitter(), {
      argv: ["status", "run-query", "fixture-0", "--json"],
      input,
      output,
      error,
      configFile: fixture.configFile,
      appPaths: {
        configFile: fixture.configFile,
        reviewersDirectory: join(fixture.root, "reviewers"),
        runsDirectory,
      },
      runReview: async () => {
        throw new Error("status must not start a review");
      },
    });

    expect(process.exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(JSON.parse(stdout)).toMatchObject({
      kind: "review-mesh.run-status",
      run_id: "run-query",
      reviewers: [{ reviewer_id: "fixture-0", state: "reviewing" }],
    });
    process.exitCode = undefined;
  });

  it("prints authoritative Zod-derived schemas", async () => {
    const fixture = await createFixture();
    for (const name of [
      "request",
      "events",
      "run-status",
      "result",
      "config",
      "config-apply",
      "diagnostic",
      "command-adapter-event",
    ]) {
      const result = await runCli(fixture, ["schema", name, "--json"], "");
      expect(result).toMatchObject({ exitCode: 0, stderr: "" });
      const document = JSON.parse(result.stdout) as {
        name: string;
        schema: Record<string, unknown>;
      };
      expect(document.name).toBe(name);
      expect(document.schema.$schema).toBe(
        "http://json-schema.org/draft-07/schema#",
      );
    }
    const listed = await runCli(fixture, ["schema", "list"], "");
    const schemaList = JSON.parse(listed.stdout) as {
      schemas: Array<{ name: string; command: string }>;
    };
    expect(schemaList.schemas.map(({ name }) => name)).toEqual(
      expect.arrayContaining(["request", "command-adapter-event"]),
    );
  });

  it("describes the exact configured suite for a workspace", async () => {
    const fixture = await createFixture();
    const canonicalWorkspace = await realpath(fixture.workspace);
    const result = await runCli(
      fixture,
      ["describe", fixture.workspace, "--json"],
      "",
    );
    expect(result).toMatchObject({ exitCode: 0, stderr: "" });
    const description = JSON.parse(result.stdout);
    expect(description).toMatchObject({
      schema_version: "2",
      kind: "review-mesh.description",
      tool: { name: "review-mesh", agent_first: true },
      invocation: {
        workspace: canonicalWorkspace,
      },
      configuration: {
        valid: true,
        config_path: fixture.configFile,
        selection: {
          project_name: expect.any(String),
          project_name_source: expect.any(String),
        },
        execution: { max_concurrency: 2 },
        reviewers: [
          { id: "fixture-0", model: "fixture-model-0" },
          { id: "fixture-1", model: "fixture-model-1" },
        ],
      },
      streams: {
        review: {
          stdin: "empty-or-review-request-json-v2",
          stdout: "public-events-jsonl-v5",
          final_event: "run.completed",
        },
      },
      protocol: {
        version: "5",
        request_version: "2",
        review_scope: {
          default_mode: "changes",
          full_review_requires_explicit_mode: true,
        },
        progress: {
          adapter_activity_streamed: false,
          status_query_available: true,
          retryable_adapter_failures: { maximum_attempts: 2 },
        },
      },
      request_examples: {
        changes: {
          schema_version: "2",
          project_name: "workspace",
          review_scope: { mode: "changes" },
        },
        full: { review_scope: { mode: "full" } },
      },
    });
    expect(description.invocation.default_review).toContain(canonicalWorkspace);
  });

  it("describes missing configuration as actionable discovery, not a CLI failure", async () => {
    const fixture = await createFixture();
    const missing = join(fixture.root, "missing", "config.toml");
    const output = new PassThrough();
    const error = new PassThrough();
    let stdout = "";
    let stderr = "";
    output.on("data", (chunk) => (stdout += chunk.toString()));
    error.on("data", (chunk) => (stderr += chunk.toString()));
    await runCliEntry(new EventEmitter(), {
      argv: ["describe", fixture.workspace, "--json"],
      input: Readable.from([""]),
      output,
      error,
      configFile: missing,
    });
    expect(process.exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(JSON.parse(stdout)).toMatchObject({
      kind: "review-mesh.description",
      configuration: {
        valid: false,
        config_path: missing,
        error: { code: "configuration_missing" },
      },
    });
    process.exitCode = undefined;
  });

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
      const child = spawn(process.execPath, [tscCli, "-p", "tsconfig.json"], {
        cwd: projectRoot,
        env: process.env,
        stdio: "pipe",
        windowsHide: true,
      });
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

  it("round-trips a result above 1 MiB through stdout and one authoritative artifact payload", async () => {
    const fixture = await createFixture(
      ["large-result"],
      trustedConfig(["large-result"]).replace(
        "persist_runs = false",
        "persist_runs = true",
      ),
    );
    const runsDirectory = join(fixture.root, "large-app-data", "runs");
    const stdout = new PassThrough();
    let publicOutput = "";
    stdout.setEncoding("utf8");
    stdout.on("data", (chunk: string) => (publicOutput += chunk));

    const exitCode = await runReviewApplication({
      requestText: fixture.request,
      configFile: fixture.configFile,
      stdout,
      stderr: new PassThrough(),
      signal: new AbortController().signal,
      runIdFactory: () => "large-persisted-run",
      appPaths: {
        configFile: join(fixture.root, "unused-config.toml"),
        reviewersDirectory: join(fixture.root, "unused-reviewers"),
        runsDirectory,
      },
    });

    expect(exitCode).toBe(0);
    const publicResult = parseEvents(publicOutput).find(
      (event) => event.event === "reviewer.result",
    );
    expect(publicResult?.event).toBe("reviewer.result");
    if (publicResult?.event !== "reviewer.result")
      throw new Error("missing result");
    const reviewMarkdown = publicResult.data.result.review_markdown;
    const digest = publicResult.data.digest;
    const byteCount = publicResult.data.byte_count;
    expect(Buffer.byteLength(reviewMarkdown, "utf8")).toBeGreaterThan(
      1024 * 1024,
    );
    const artifact = await readFile(
      join(runsDirectory, "large-persisted-run.jsonl"),
      "utf8",
    );
    expect(artifact.match(/"review_markdown"/gu)).toHaveLength(1);
    expect(artifact).toContain(
      `"event":"reviewer.result","run_id":"large-persisted-run"`,
    );
    expect(artifact).toContain(`"digest":"${digest}"`);
    expect(artifact).toContain(`"byte_count":${byteCount}`);
    const status = await readRunStatus({
      runsDirectory,
      runId: "large-persisted-run",
    });
    expect(status).toMatchObject({
      reviewers: [{ complete_result: { review_markdown: reviewMarkdown } }],
    });
    const statusReviewers = status.reviewers as Array<Record<string, unknown>>;
    expect(statusReviewers[0]).toMatchObject({
      result_digest: digest,
      result_byte_count: byteCount,
    });
    const report = await readRunReport({
      runsDirectory,
      runId: "large-persisted-run",
    });
    expect(report).toMatchObject({
      reviewers: [{ result: { review_markdown: reviewMarkdown } }],
    });
  }, 20_000);

  it("publishes a sanitized details file and removes the temporary internal record", async () => {
    const fixture = await createFixture(["secret-messages"]);
    const runsDirectory = join(fixture.root, "injected-app-data", "runs");
    const detailsFile = join(fixture.root, "review-details.jsonl");
    const stdout = new PassThrough();
    let publicOutput = "";
    stdout.setEncoding("utf8");
    stdout.on("data", (chunk: string) => {
      publicOutput += chunk;
    });

    const exitCode = await runReviewApplication({
      requestText: fixture.request,
      configFile: fixture.configFile,
      stdout,
      stderr: new PassThrough(),
      signal: new AbortController().signal,
      runIdFactory: () => "details-success",
      detailsFile,
      appPaths: {
        configFile: join(fixture.root, "unused-config.toml"),
        reviewersDirectory: join(fixture.root, "unused-reviewers"),
        runsDirectory,
      },
    });

    expect(exitCode).toBe(0);
    const completed = parseEvents(publicOutput).at(-1);
    expect(completed).toMatchObject({
      event: "run.completed",
      data: { report_path: join(runsDirectory, "details-success.jsonl") },
    });
    const details = await readFile(detailsFile, "utf8");
    expect(details).toContain('"event":"run.completed"');
    expect(details).toContain("[redacted]");
    expect(details).not.toMatch(/progress-secret|activity-secret/u);
    await expect(
      access(join(runsDirectory, "details-success.jsonl")),
    ).resolves.toBeUndefined();
  });

  it("references a complete immutable artifact before writing terminal stdout with --details-file", async () => {
    const fixture = await createFixture(["pass"]);
    const runsDirectory = join(fixture.root, "details-order", "runs");
    const detailsFile = join(fixture.root, "details-order.jsonl");
    let terminalInspection:
      | Promise<{
          path: string;
          contents: string;
        }>
      | undefined;
    const stdout = Object.assign(new EventEmitter(), {
      write(
        chunk: string | Uint8Array,
        callback?: (error?: Error | null) => void,
      ) {
        const line = chunk.toString();
        if (line.includes('"event":"run.completed"')) {
          const event = JSON.parse(line) as {
            data: { report_path: string };
          };
          terminalInspection = readFile(event.data.report_path, "utf8").then(
            (contents) => ({ path: event.data.report_path, contents }),
          );
          void terminalInspection.then(
            () => callback?.(null),
            (error: unknown) =>
              callback?.(
                error instanceof Error ? error : new Error(String(error)),
              ),
          );
          return true;
        }
        queueMicrotask(() => callback?.(null));
        return true;
      },
    }) as unknown as NodeJS.WritableStream;

    const exitCode = await runReviewApplication({
      requestText: fixture.request,
      configFile: fixture.configFile,
      stdout,
      stderr: new PassThrough(),
      signal: new AbortController().signal,
      runIdFactory: () => "details-order",
      detailsFile,
      appPaths: {
        configFile: join(fixture.root, "unused-config.toml"),
        reviewersDirectory: join(fixture.root, "unused-reviewers"),
        runsDirectory,
      },
    });

    expect(exitCode).toBe(0);
    await expect(terminalInspection).resolves.toMatchObject({
      path: join(runsDirectory, "details-order.jsonl"),
      contents: expect.stringContaining('"record":"reviewer.result"'),
    });
    await expect(readFile(detailsFile, "utf8")).resolves.toContain(
      '"record":"reviewer.result"',
    );
  });

  it("redacts a reviewer summary in both stdout and the exported artifact", async () => {
    const fixture = await createFixture(["pass"]);
    const runsDirectory = join(fixture.root, "injected-app-data", "runs");
    const detailsFile = join(fixture.root, "summary-details.jsonl");
    const stdout = new PassThrough();
    let publicOutput = "";
    stdout.setEncoding("utf8");
    stdout.on("data", (chunk: string) => {
      publicOutput += chunk;
    });
    const adapterScript = `
      const chunks=[]; for await (const chunk of process.stdin) chunks.push(chunk);
      process.stdout.write(JSON.stringify({type:"result",result:{schema_version:"3",verdict:"pass",review_markdown:"# Review\\n\\nAuthorization: Bearer summary-secret",summary:"Authorization: Bearer summary-secret",actionable_findings:[],informational_notes:[]}})+"\\n");
    `;
    await writeFile(
      fixture.configFile,
      trustedConfig(["pass"]).replace(
        `args = ["--input-type=module", "-e", ${tomlString(fixtureScript("pass"))}]`,
        `args = ["--input-type=module", "-e", ${tomlString(adapterScript)}]`,
      ),
    );

    const exitCode = await runReviewApplication({
      requestText: fixture.request,
      configFile: fixture.configFile,
      stdout,
      stderr: new PassThrough(),
      signal: new AbortController().signal,
      runIdFactory: () => "details-summary",
      detailsFile,
      appPaths: {
        configFile: join(fixture.root, "unused-config.toml"),
        reviewersDirectory: join(fixture.root, "unused-reviewers"),
        runsDirectory,
      },
    });

    expect(exitCode).toBe(0);
    const completed = parseEvents(publicOutput).find(
      (event) => event.event === "reviewer.completed",
    );
    expect(completed).toMatchObject({ data: { summary: "[redacted]" } });
    expect(publicOutput).not.toContain("summary-secret");
    const details = await readFile(detailsFile, "utf8");
    expect(details).toContain("[redacted]");
    expect(details).not.toContain("summary-secret");
  });

  it("defaults review output to full-jsonl", async () => {
    const fixture = await createFixture(["pass"]);
    const stdout = new PassThrough();
    let publicOutput = "";
    stdout.setEncoding("utf8");
    stdout.on("data", (chunk: string) => {
      publicOutput += chunk;
    });
    const adapterScript = `
      const chunks=[]; for await (const chunk of process.stdin) chunks.push(chunk);
      process.stdout.write(JSON.stringify({type:"result",result:{schema_version:"3",verdict:"pass",review_markdown:"# Complete review",summary:"No actionable findings.",actionable_findings:[],informational_notes:[]}})+"\\n");
    `;
    await writeFile(
      fixture.configFile,
      trustedConfig(["pass"]).replace(
        `args = ["--input-type=module", "-e", ${tomlString(fixtureScript("pass"))}]`,
        `args = ["--input-type=module", "-e", ${tomlString(adapterScript)}]`,
      ),
    );

    const exitCode = await runReviewApplication({
      requestText: fixture.request,
      configFile: fixture.configFile,
      stdout,
      stderr: new PassThrough(),
      signal: new AbortController().signal,
      runIdFactory: () => "default-full-output",
      appPaths: {
        configFile: join(fixture.root, "unused-config.toml"),
        reviewersDirectory: join(fixture.root, "unused-reviewers"),
        runsDirectory: join(fixture.root, "runs"),
      },
    });

    expect(exitCode).toBe(0);
    expect(parseEvents(publicOutput)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "reviewer.result",
          data: expect.objectContaining({
            result: expect.objectContaining({
              review_markdown: "# Complete review",
            }),
          }),
        }),
      ]),
    );
  });

  it("automatically publishes an immutable artifact for compact-jsonl", async () => {
    const fixture = await createFixture(["pass"]);
    const runsDirectory = join(fixture.root, "compact-app-data", "runs");
    const stdout = new PassThrough();
    let publicOutput = "";
    stdout.setEncoding("utf8");
    stdout.on("data", (chunk: string) => {
      publicOutput += chunk;
    });

    const exitCode = await runReviewApplication({
      requestText: fixture.request,
      configFile: fixture.configFile,
      stdout,
      stderr: new PassThrough(),
      signal: new AbortController().signal,
      runIdFactory: () => "compact-persisted",
      outputMode: "compact-jsonl",
      appPaths: {
        configFile: join(fixture.root, "unused-config.toml"),
        reviewersDirectory: join(fixture.root, "unused-reviewers"),
        runsDirectory,
      },
    });

    expect(exitCode).toBe(0);
    const events = parseEvents(publicOutput);
    expect(events.some((event) => event.event === "reviewer.result")).toBe(
      false,
    );
    expect(events.at(-1)).toMatchObject({
      event: "run.completed",
      data: {
        report_path: join(runsDirectory, "compact-persisted.jsonl"),
        results_complete: true,
        result_manifest: [
          expect.objectContaining({
            artifact_path: join(runsDirectory, "compact-persisted.jsonl"),
          }),
        ],
      },
    });
    await expect(
      readRunReport({ runsDirectory, runId: "compact-persisted" }),
    ).resolves.toMatchObject({
      active: false,
      reviewers: [
        expect.objectContaining({
          result: expect.objectContaining({ schema_version: "3" }),
        }),
      ],
    });
  });

  it("does not emit results_complete when immutable artifact publication fails", async () => {
    const fixture = await createFixture(["pass"]);
    const runsDirectory = join(fixture.root, "publication-failure", "runs");
    const stdout = new PassThrough();
    let publicOutput = "";
    stdout.setEncoding("utf8");
    stdout.on("data", (chunk: string) => {
      publicOutput += chunk;
    });
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
      runIdFactory: () => "publication-failed",
      outputMode: "compact-jsonl",
      appPaths: {
        configFile: join(fixture.root, "unused-config.toml"),
        reviewersDirectory: join(fixture.root, "unused-reviewers"),
        runsDirectory,
      },
      runRecorderFileSystem: {
        mkdir,
        readdir,
        stat,
        rm: async (path) => rm(path),
        link: async () => {
          throw new Error("link failed");
        },
      },
    });

    expect(exitCode).toBe(3);
    expect(publicOutput).not.toContain('"results_complete":true');
    expect(parseSingleDiagnostic(diagnostic)).toMatchObject({
      error: "persistence_failed",
    });
    await expect(
      access(join(runsDirectory, "publication-failed.jsonl")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects an existing details target without changing it", async () => {
    const fixture = await createFixture(["pass"]);
    const runsDirectory = join(fixture.root, "injected-app-data", "runs");
    const detailsFile = join(fixture.root, "existing-details.jsonl");
    await writeFile(detailsFile, "keep-me");
    const stderr = new PassThrough();
    let diagnostic = "";
    stderr.setEncoding("utf8");
    stderr.on("data", (chunk: string) => {
      diagnostic += chunk;
    });

    const exitCode = await runReviewApplication({
      requestText: fixture.request,
      configFile: fixture.configFile,
      stdout: new PassThrough(),
      stderr,
      signal: new AbortController().signal,
      runIdFactory: () => "details-existing",
      detailsFile,
      appPaths: {
        configFile: join(fixture.root, "unused-config.toml"),
        reviewersDirectory: join(fixture.root, "unused-reviewers"),
        runsDirectory,
      },
    });

    expect(exitCode).toBe(2);
    expect(parseSingleDiagnostic(diagnostic)).toMatchObject({
      error: "details_file_unavailable",
    });
    expect(await readFile(detailsFile, "utf8")).toBe("keep-me");
    await expect(access(runsDirectory)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("publishes a nonempty cancellation artifact after an interrupted run", async () => {
    const fixture = await createFixture(["pass"]);
    const runsDirectory = join(fixture.root, "injected-app-data", "runs");
    const detailsFile = join(fixture.root, "interrupted-details.jsonl");
    const controller = new AbortController();
    const stdout = new PassThrough();
    let publicOutput = "";
    stdout.setEncoding("utf8");
    stdout.on("data", (chunk: string) => {
      publicOutput += chunk;
      if (chunk.includes('"event":"run.started"')) controller.abort("SIGINT");
    });

    const exitCode = await runReviewApplication({
      requestText: fixture.request,
      configFile: fixture.configFile,
      stdout,
      stderr: new PassThrough(),
      signal: controller.signal,
      runIdFactory: () => "details-interrupted",
      detailsFile,
      appPaths: {
        configFile: join(fixture.root, "unused-config.toml"),
        reviewersDirectory: join(fixture.root, "unused-reviewers"),
        runsDirectory,
      },
    });

    expect(exitCode).toBe(4);
    expect(publicOutput).toContain('"event":"run.completed"');
    const details = await readFile(detailsFile, "utf8");
    expect(details).toContain('"event":"run.completed"');
    expect(details).toContain('"reason":"cancelled"');
    expect(Buffer.byteLength(details)).toBeGreaterThan(0);
    await expect(
      access(join(runsDirectory, "details-interrupted.jsonl")),
    ).resolves.toBeUndefined();
  });

  it("does not persist arbitrary reviewer runtime values in the run header", async () => {
    const config = trustedConfig(["pass"])
      .replace("persist_runs = false", "persist_runs = true")
      .replace(
        "timeout_ms = 5000",
        'timeout_ms = 5000\nruntime = { ordinary = "sensitive-runtime-value" }',
      );
    const fixture = await createFixture(["pass"], config);
    const runsDirectory = join(fixture.root, "injected-app-data", "runs");
    const stdout = new PassThrough();
    stdout.resume();

    expect(
      await runReviewApplication({
        requestText: fixture.request,
        configFile: fixture.configFile,
        stdout,
        stderr: new PassThrough(),
        signal: new AbortController().signal,
        runIdFactory: () => "runtime-redaction-run",
        appPaths: {
          configFile: join(fixture.root, "unused-config.toml"),
          reviewersDirectory: join(fixture.root, "unused-reviewers"),
          runsDirectory,
        },
      }),
    ).toBe(0);
    expect(
      await readFile(
        join(runsDirectory, "runtime-redaction-run.jsonl"),
        "utf8",
      ),
    ).not.toContain("sensitive-runtime-value");
  });

  it("removes the transient active record when persistence is disabled", async () => {
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
    await expect(readdir(runsDirectory)).resolves.toEqual([]);
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
    expect(completed.data.model_runs).toMatchObject({ completed: 2 });
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
    expect(completed.data.gate_outcome).toBe("findings");
    expect(completed.data.unique_findings).toBeGreaterThan(0);
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
    expect(completed.data.coverage_outcome).toBe("partial");
    expect(completed.data.model_runs?.incomplete).toBe(1);
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
    expect(completed.data.coverage_outcome).toBe("partial");
    expect(completed.data.model_runs?.incomplete).toBe(1);
  });

  it.each([
    ["malformed JSON", ["review"], "{", undefined, "invalid_request"],
    ["unsupported command", ["inspect"], undefined, undefined, "invalid_usage"],
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

  it("reviews the current directory with a synthesized request on empty stdin", async () => {
    const fixture = await createFixture();
    const child = spawn(
      process.execPath,
      ["--import", "tsx", cliEntry, "review", fixture.workspace],
      {
        cwd: projectRoot,
        env: fixture.env,
        stdio: "pipe",
        windowsHide: true,
      },
    );
    child.stdin.end();
    const result = await collectProcess(child);
    expect(result).toMatchObject({ exitCode: 0, stderr: "" });
    expect(parseEvents(result.stdout).at(-1)).toMatchObject({
      event: "run.completed",
      data: { status: "passed" },
    });
  });

  it("rejects a v2 project name that does not match the workspace", async () => {
    const fixture = await createFixture();
    const stderr = new PassThrough();
    let diagnostic = "";
    stderr.setEncoding("utf8");
    stderr.on("data", (chunk: string) => (diagnostic += chunk));
    const exitCode = await runReviewApplication({
      requestText: JSON.stringify({
        schema_version: "2",
        project_name: "wrong-project",
        workspace: fixture.workspace,
        instructions: "Review changes.",
        review_scope: { mode: "changes" },
      }),
      configFile: fixture.configFile,
      stdout: new PassThrough(),
      stderr,
      signal: new AbortController().signal,
    });
    expect(exitCode).toBe(2);
    expect(JSON.parse(diagnostic)).toMatchObject({
      error: "invalid_request",
      message: expect.stringContaining("workspace identity workspace"),
    });
  });

  it("synthesizes immediately for TTY stdin without consuming it", async () => {
    const fixture = await createFixture();
    const input = new PassThrough() as PassThrough & { isTTY?: boolean };
    input.isTTY = true;
    input.write("must remain unread");
    const output = new PassThrough();
    const error = new PassThrough();
    let requestText: string | undefined;
    input.resume = (() => {
      throw new Error("TTY stdin must not be resumed");
    }) as typeof input.resume;
    output.resume();
    error.resume();
    await runCliEntry(new EventEmitter(), {
      argv: ["review", fixture.workspace],
      input,
      output,
      error,
      configFile: fixture.configFile,
      cwd: fixture.workspace,
      runReview: async (options) => {
        requestText = options.requestText;
        return 0;
      },
    });
    expect(requestText).toBeDefined();
    expect(JSON.parse(requestText!)).toMatchObject({
      schema_version: "2",
      project_name: "workspace",
      workspace: resolve(fixture.workspace),
      review_scope: { mode: "changes" },
    });
  });

  it("rejects a positional workspace combined with piped JSON", async () => {
    const fixture = await createFixture();
    const result = await runCli(
      fixture,
      ["review", fixture.workspace],
      fixture.request,
    );
    expect(result).toMatchObject({ exitCode: 2, stdout: "" });
    expect(parseSingleDiagnostic(result.stderr)).toMatchObject({
      error: "invalid_usage",
      help_command: "review-mesh help review",
    });
  });

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
      schema_version: "2",
      project_name: "workspace",
      workspace: fixture.workspace,
      instructions: "Review the controlled workspace.",
      review_scope: { mode: "changes" },
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
