import { createHash } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  publicEventV6Schema,
  type PublicEventV6,
  type ReviewerResultV4,
} from "../../src/protocol/schemas.js";
import { reviewerResultDigest } from "../../src/results/digest.js";
import {
  defaultV9FixtureResult,
  v9CommandConfig,
  v9LargeNarrative,
  v9ReviewerResult,
  writeV9CommandFixture,
} from "../helpers/v9-command-fixture.js";

const projectRoot = resolve(import.meta.dirname, "../..");
const require = createRequire(import.meta.url);
const tscCli = require.resolve("typescript/bin/tsc");
const compiledCli = join(projectRoot, "dist", "cli.js");
const temporaryRoots: string[] = [];

interface ProcessResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

interface Fixture {
  root: string;
  workspace: string;
  env: NodeJS.ProcessEnv;
  request: string;
}

function isolatedEnvironment(root: string): NodeJS.ProcessEnv {
  if (process.platform === "win32") {
    return { ...process.env, APPDATA: root, LOCALAPPDATA: root };
  }
  if (process.platform === "darwin") return { ...process.env, HOME: root };
  return {
    ...process.env,
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_DATA_HOME: join(root, "data"),
    XDG_STATE_HOME: join(root, "state"),
  };
}

function configPath(root: string): string {
  if (process.platform === "win32") {
    return join(root, "review-mesh", "Config", "config.toml");
  }
  if (process.platform === "darwin") {
    return join(root, "Library", "Preferences", "review-mesh", "config.toml");
  }
  return join(root, "config", "review-mesh", "config.toml");
}

function trustedConfig(
  modes: readonly string[],
  scriptPath: string,
  options: { persistRuns?: boolean; timeoutMs?: number } = {},
): string {
  return v9CommandConfig({
    scriptPath,
    entries: modes.map((mode) => ({
      mode: mode as Parameters<typeof defaultV9FixtureResult>[0],
    })),
    persistRuns: options.persistRuns !== false,
    timeoutMs: options.timeoutMs ?? 20_000,
  });
}

async function createFixture(
  modes: readonly string[],
  options: {
    persistRuns?: boolean;
    timeoutMs?: number;
    results?: readonly NonNullable<ReturnType<typeof defaultV9FixtureResult>>[];
  } = {},
): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "review-mesh-acceptance-"));
  temporaryRoots.push(root);
  const workspace = join(root, "workspace");
  const reviewer = join(root, "v9-command-reviewer.mjs");
  const configFile = configPath(root);
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, "source.ts"), "export const value = 1;\n");
  await writeFile(join(workspace, "sentinel.txt"), "immutable-sentinel\n");
  await writeV9CommandFixture(
    reviewer,
    modes.map((mode, index) => ({
      mode: mode as Parameters<typeof defaultV9FixtureResult>[0],
      ...(options.results?.[index] === undefined
        ? {}
        : { result: options.results[index] }),
    })),
  );
  await mkdir(dirname(configFile), { recursive: true });
  await writeFile(configFile, trustedConfig(modes, reviewer, options));
  return {
    root,
    workspace,
    env: isolatedEnvironment(root),
    request: JSON.stringify({
      schema_version: "3",
      request_id: "acceptance-request",
      project_name: "workspace",
      workspace,
      instructions: "Review the controlled fixture.",
      review_scope: { mode: "full" },
    }),
  };
}

function start(
  fixture: Fixture,
  args: readonly string[] = [],
): ChildProcessWithoutNullStreams {
  const child = spawn(process.execPath, [compiledCli, "review", ...args], {
    cwd: projectRoot,
    env: fixture.env,
    stdio: "pipe",
    windowsHide: true,
  });
  child.stdin.on("error", () => undefined);
  child.stdin.end(fixture.request);
  return child;
}

function startArguments(
  fixture: Fixture,
  args: readonly string[],
): ChildProcessWithoutNullStreams {
  const child = spawn(process.execPath, [compiledCli, ...args], {
    cwd: projectRoot,
    env: fixture.env,
    stdio: "pipe",
    windowsHide: true,
  });
  child.stdin.end();
  return child;
}

async function collect(
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

function events(stdout: string): PublicEventV6[] {
  const parsed = stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => publicEventV6Schema.parse(JSON.parse(line)));
  expect(parsed.map((event) => event.seq)).toEqual(
    parsed.map((_, index) => index + 1),
  );
  expect(parsed.at(-1)?.event).toBe("run.completed");
  return parsed;
}

async function workspaceDigest(root: string): Promise<string> {
  const paths: string[] = [];
  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory)) {
      const path = join(directory, entry);
      const metadata = await stat(path);
      if (metadata.isDirectory()) await walk(path);
      else paths.push(path);
    }
  }
  await walk(root);
  const digest = createHash("sha256");
  for (const path of paths.sort()) {
    digest.update(path.slice(root.length));
    digest.update(await readFile(path));
  }
  return digest.digest("hex");
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 10_000;
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

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

beforeAll(async () => {
  const build = spawn(process.execPath, [tscCli, "-p", "tsconfig.json"], {
    cwd: projectRoot,
    stdio: "pipe",
    windowsHide: true,
  });
  expect(await collect(build)).toMatchObject({ exitCode: 0, signal: null });
}, 20_000);

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("compiled CLI acceptance", () => {
  it("reports the exact release version", async () => {
    const home = await mkdtemp(join(tmpdir(), "review-mesh-version-"));
    temporaryRoots.push(home);
    const result = await collect(
      spawn(process.execPath, [compiledCli, "--version"], {
        cwd: projectRoot,
        env: isolatedEnvironment(home),
        stdio: "pipe",
        windowsHide: true,
      }),
    );

    expect(result).toMatchObject({
      exitCode: 0,
      signal: null,
      stdout: "review-mesh 8.0.0\n",
      stderr: "",
    });
  });

  it("explicitly delivers a complete 13 MiB full result and strictly round-trips its artifact", async () => {
    const exactNarrative = v9LargeNarrative("# Complete acceptance finding");
    const exactResult = v9ReviewerResult({
      verdict: "fail",
      reviewMarkdown: exactNarrative,
    });
    const fixture = await createFixture(["large-fail"], {
      persistRuns: true,
      timeoutMs: 120_000,
      results: [exactResult],
    });
    const result = await collect(
      start(fixture, ["--output-mode", "full-jsonl"]),
    );
    const parsed = events(result.stdout);
    const full = parsed.find((event) => event.event === "reviewer.result");
    const completed = parsed.at(-1);
    if (
      full?.event !== "reviewer.result" ||
      completed?.event !== "run.completed"
    ) {
      throw new Error(
        `missing full result contract ${JSON.stringify({ result, parsed })}`,
      );
    }
    const fullResults = parsed.filter(
      (event): event is Extract<PublicEventV6, { event: "reviewer.result" }> =>
        event.event === "reviewer.result",
    );
    const accepted = full.data.result as ReviewerResultV4;
    const expectedReview = exactNarrative;
    expect(Buffer.byteLength(expectedReview, "utf8")).toBe(13 * 1024 * 1024);

    expect(result).toMatchObject({ exitCode: 0, signal: null, stderr: "" });
    expect(fullResults).toHaveLength(1);
    for (const event of fullResults) {
      const resultDigest = reviewerResultDigest(
        event.data.result as ReviewerResultV4,
      );
      const resultBytes = Buffer.byteLength(
        JSON.stringify(event.data.result),
        "utf8",
      );
      expect(event.data).toMatchObject({
        digest: resultDigest,
        byte_count: resultBytes,
        result: {
          schema_version: "4",
          review_markdown: expectedReview,
        },
      });
    }
    expect(completed.data).toMatchObject({
      run_outcome: "clear",
      gate_outcome: "no_gate_findings",
      coverage_outcome: "complete",
      raw_source_findings: 1,
      atomic_subfindings: 1,
      canonical_roots: 1,
      gate_eligible_subfindings: 0,
      result_delivery: {
        completed_results: 1,
        artifact: "complete",
        planned_public_stream: "complete",
      },
      artifact: { completed_results: 1 },
    });
    expect(completed.data.artifact.path).toEqual(expect.any(String));
    for (const event of fullResults) {
      expect(event.data).not.toHaveProperty("artifact_path");
    }

    const [statusOutput, reportOutput, findingsOutput] = await Promise.all([
      collect(startArguments(fixture, ["status", completed.run_id, "--json"])),
      collect(
        startArguments(fixture, [
          "report",
          completed.run_id,
          "--format",
          "json",
        ]),
      ),
      collect(
        startArguments(fixture, [
          "findings",
          completed.run_id,
          "--deduplicate",
          "--json",
        ]),
      ),
    ]);
    for (const output of [statusOutput, reportOutput, findingsOutput]) {
      expect(output).toMatchObject({ exitCode: 0, signal: null, stderr: "" });
    }
    const status = JSON.parse(statusOutput.stdout) as Record<string, unknown>;
    const report = JSON.parse(reportOutput.stdout) as Record<string, unknown>;
    const findings = JSON.parse(findingsOutput.stdout) as Record<
      string,
      unknown
    >;
    expect(status).toMatchObject({
      run_id: completed.run_id,
      reviewers: [
        {
          reviewer_id: "fixture_0",
          complete_result: accepted,
          result_digest: fullResults[0]?.data.digest,
          result_byte_count: fullResults[0]?.data.byte_count,
        },
      ],
    });
    expect(report).toMatchObject({
      run_id: completed.run_id,
      reviewers: [{ reviewer_id: "fixture_0", result: accepted }],
      finding_counts: {
        raw_source_findings: 1,
        atomic_subfindings: 1,
        canonical_roots: 1,
        gate_eligible_subfindings: 0,
      },
    });
    expect(findings).toMatchObject({
      run_id: completed.run_id,
      findings: [
        expect.objectContaining({
          id: "fixture-shared-root",
          subfindings: [expect.objectContaining({ id: "fixture-medium" })],
        }),
      ],
    });
    expect((findings.findings as unknown[]).length).toBeGreaterThan(0);
  }, 180_000);

  it.each([
    [["pass", "pass"], 0, "clear", "no_gate_findings", "complete"],
    [["pass", "fail"], 0, "clear", "no_gate_findings", "complete"],
    [["fail", "crash"], 3, "inconclusive", "no_gate_findings", "partial"],
  ] as const)(
    "returns the expected exit and status for %j",
    async (
      modes,
      expectedExit,
      expectedOutcome,
      expectedGateOutcome,
      expectedCoverageOutcome,
    ) => {
      const fixture = await createFixture(modes);
      const before = await workspaceDigest(fixture.workspace);

      const result = await collect(start(fixture));
      const parsed = events(result.stdout);
      const completed = parsed.at(-1);

      expect(result.exitCode).toBe(expectedExit);
      expect(result.signal).toBeNull();
      expect(result.stderr).toBe("");
      expect(completed?.event).toBe("run.completed");
      if (completed?.event !== "run.completed")
        throw new Error("missing completion");
      expect(completed.data.run_outcome).toBe(expectedOutcome);
      expect(completed.data.gate_outcome).toBe(expectedGateOutcome);
      expect(completed.data.coverage_outcome).toBe(expectedCoverageOutcome);
      expect(completed.data.model_runs?.total).toBe(modes.length);
      expect(await workspaceDigest(fixture.workspace)).toBe(before);
    },
    20_000,
  );

  it("turns a deterministic interrupt into exit 4 and removes the silent process tree", async () => {
    const fixture = await createFixture(["silent"]);
    const capture = join(fixture.root, "capture.json");
    fixture.env.REVIEW_MESH_FIXTURE_CAPTURE = capture;
    const wrapper = join(fixture.root, "interrupt-wrapper.mjs");
    await writeFile(
      wrapper,
      `import { EventEmitter } from "node:events"; import { access } from "node:fs/promises"; import { runCli } from ${JSON.stringify(pathToFileURL(compiledCli).href)}; const source=new EventEmitter(); const timer=setInterval(async()=>{try{await access(${JSON.stringify(capture)})}catch{return}clearInterval(timer);source.emit("SIGINT");},20); await runCli(source);`,
    );
    const child = spawn(process.execPath, [wrapper, "review"], {
      cwd: projectRoot,
      env: fixture.env,
      stdio: "pipe",
      windowsHide: true,
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(fixture.request);

    const result = await collect(child);
    const parsed = result.stdout
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => publicEventV6Schema.parse(JSON.parse(line)));
    if (parsed.at(-1)?.event !== "run.completed") {
      throw new Error(
        `interrupted result ${JSON.stringify({ result, events: parsed })}`,
      );
    }
    const completed = parsed.at(-1);
    const captured = JSON.parse(await readFile(capture, "utf8")) as {
      pid: number;
      child_pid: number;
    };

    expect(result).toMatchObject({ exitCode: 4, signal: null, stderr: "" });
    expect(completed?.event).toBe("run.completed");
    if (completed?.event !== "run.completed")
      throw new Error("missing completion");
    expect(completed.data).toMatchObject({
      run_outcome: "cancelled",
      exit_code: 4,
      coverage_outcome: "partial",
      model_runs: { incomplete: 1 },
    });
    expect(processAlive(captured.pid)).toBe(false);
    expect(processAlive(captured.child_pid)).toBe(false);
  }, 20_000);
});
