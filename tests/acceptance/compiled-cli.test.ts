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
  publicEventSchema,
  type PublicEvent,
} from "../../src/protocol/schemas.js";

const projectRoot = resolve(import.meta.dirname, "../..");
const require = createRequire(import.meta.url);
const tscCli = require.resolve("typescript/bin/tsc");
const compiledCli = join(projectRoot, "dist", "cli.js");
const fixtureUrl = pathToFileURL(
  join(projectRoot, "tests", "fixtures", "command-adapter.mjs"),
).href;
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

function script(mode: string): string {
  return `process.env.REVIEW_MESH_FIXTURE_MODE=${JSON.stringify(mode)}; await import(${JSON.stringify(fixtureUrl)});`;
}

function trustedConfig(modes: readonly string[]): string {
  const reviewers = modes
    .map(
      (mode, index) => `
[adapters.fixture_${index}]
type = "command"
command = ${JSON.stringify(process.execPath)}
args = ["--input-type=module", "-e", ${JSON.stringify(script(mode))}]
env_allowlist = ["REVIEW_MESH_FIXTURE_CAPTURE"]
protocol = "review-mesh-command-v1"

[reviewer_profiles.fixture_${index}]
adapter = "fixture_${index}"
model = "fixture-model-${index}"
purpose = "Acceptance reviewer ${index}"
instructions = "Review without modifying the workspace."
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
max_concurrency = 3
heartbeat_interval_ms = 100
shutdown_grace_period_ms = 100

[diagnostics]
persist_runs = false
max_runs = 1
${reviewers}`;
}

async function createFixture(modes: readonly string[]): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "review-mesh-acceptance-"));
  temporaryRoots.push(root);
  const workspace = join(root, "workspace");
  const configFile = configPath(root);
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, "source.ts"), "export const value = 1;\n");
  await writeFile(join(workspace, "sentinel.txt"), "immutable-sentinel\n");
  await mkdir(dirname(configFile), { recursive: true });
  await writeFile(configFile, trustedConfig(modes));
  return {
    root,
    workspace,
    env: isolatedEnvironment(root),
    request: JSON.stringify({
      schema_version: "2",
      request_id: "acceptance-request",
      project_name: "workspace",
      workspace,
      instructions: "Review the controlled fixture.",
      review_scope: { mode: "full" },
    }),
  };
}

function start(fixture: Fixture): ChildProcessWithoutNullStreams {
  const child = spawn(process.execPath, [compiledCli, "review"], {
    cwd: projectRoot,
    env: fixture.env,
    stdio: "pipe",
    windowsHide: true,
  });
  child.stdin.on("error", () => undefined);
  child.stdin.end(fixture.request);
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

function events(stdout: string): PublicEvent[] {
  const parsed = stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => publicEventSchema.parse(JSON.parse(line)));
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
  it.each([
    [["pass", "pass"], 0, "passed"],
    [["pass", "fail"], 1, "findings"],
    [["fail", "crash"], 3, "incomplete"],
  ] as const)(
    "returns the expected exit and status for %j",
    async (modes, expectedExit, expectedStatus) => {
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
      expect(completed.data.status).toBe(expectedStatus);
      expect(completed.data.consistency_mode).toBe("live_worktree");
      expect(completed.data.model_runs?.total).toBe(modes.length);
      if (expectedStatus === "incomplete") {
        expect(completed.data.gate_outcome).toBe("findings");
        expect(completed.data.coverage_outcome).toBe("partial");
      }
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
      .map((line) => publicEventSchema.parse(JSON.parse(line)));
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
      status: "incomplete",
      exit_code: 4,
      coverage_outcome: "partial",
      model_runs: { incomplete: 1 },
    });
    expect(processAlive(captured.pid)).toBe(false);
    expect(processAlive(captured.child_pid)).toBe(false);
  }, 20_000);
});
