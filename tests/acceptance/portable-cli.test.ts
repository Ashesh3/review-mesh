import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const projectRoot = resolve(import.meta.dirname, "../..");
const sourceArtifact = join(projectRoot, "dist", "review-mesh.mjs");
let root: string;
let artifact: string;

function isolatedEnvironment(rootDirectory: string): NodeJS.ProcessEnv {
  if (process.platform === "win32") {
    return {
      ...process.env,
      APPDATA: rootDirectory,
      LOCALAPPDATA: rootDirectory,
    };
  }
  if (process.platform === "darwin") {
    return { ...process.env, HOME: rootDirectory };
  }
  return {
    ...process.env,
    XDG_CONFIG_HOME: join(rootDirectory, "config"),
    XDG_DATA_HOME: join(rootDirectory, "data"),
    XDG_STATE_HOME: join(rootDirectory, "state"),
  };
}

function configPath(rootDirectory: string): string {
  if (process.platform === "win32") {
    return join(rootDirectory, "review-mesh", "Config", "config.toml");
  }
  if (process.platform === "darwin") {
    return join(
      rootDirectory,
      "Library",
      "Preferences",
      "review-mesh",
      "config.toml",
    );
  }
  return join(rootDirectory, "config", "review-mesh", "config.toml");
}

async function run(
  file: string,
  request: object,
  options: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [file, "review"], {
    ...options,
    stdio: "pipe",
    windowsHide: true,
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  child.stdin.end(JSON.stringify(request));
  const exitCode = await new Promise<number | null>((resolveExit, reject) => {
    child.once("error", reject);
    child.once("close", resolveExit);
  });
  return {
    exitCode,
    stdout: Buffer.concat(stdout).toString("utf8"),
    stderr: Buffer.concat(stderr).toString("utf8"),
  };
}

async function runArguments(
  file: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [file, ...args], {
    ...options,
    stdio: "pipe",
    windowsHide: true,
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  child.stdin.end();
  const exitCode = await new Promise<number | null>((resolveExit, reject) => {
    child.once("error", reject);
    child.once("close", resolveExit);
  });
  return {
    exitCode,
    stdout: Buffer.concat(stdout).toString("utf8"),
    stderr: Buffer.concat(stderr).toString("utf8"),
  };
}

function completion(stdout: string): Record<string, unknown> {
  return stdout
    .trim()
    .split(/\r?\n/u)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .at(-1)!;
}

async function buildPortable(): Promise<void> {
  const child = spawn(process.execPath, ["scripts/build-portable.mjs"], {
    cwd: projectRoot,
    stdio: "pipe",
    windowsHide: true,
  });
  const stderr: Buffer[] = [];
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  const exitCode = await new Promise<number | null>((resolveExit, reject) => {
    child.once("error", reject);
    child.once("close", resolveExit);
  });
  expect(Buffer.concat(stderr).toString("utf8")).toBe("");
  expect(exitCode).toBe(0);
}

beforeAll(async () => {
  await buildPortable();
  root = await mkdtemp(join(tmpdir(), "review-mesh-portable-"));
  artifact = join(root, "bin", "review-mesh.mjs");
  await mkdir(dirname(artifact), { recursive: true });
  await writeFile(artifact, await readFile(sourceArtifact));
}, 30_000);

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("portable CLI", () => {
  it("is one self-contained JavaScript file with a shebang", async () => {
    const contents = await readFile(artifact, "utf8");
    expect(contents.startsWith("#!/usr/bin/env node\n")).toBe(true);
    expect(contents).not.toContain('from "env-paths"');
    expect(contents).not.toContain('from "execa"');
    expect(contents).not.toContain('from "smol-toml"');
    expect(contents).not.toContain('from "zod"');
  });

  it("keeps help, version, and Zod-derived schemas in the copied artifact", async () => {
    const options = {
      cwd: root,
      env: isolatedEnvironment(join(root, "help-home")),
    };
    const help = await runArguments(artifact, ["--help"], options);
    expect(help).toMatchObject({ exitCode: 0, stderr: "" });
    expect(help.stdout).toContain("AGENT QUICK START");

    const version = await runArguments(artifact, ["--version"], options);
    expect(version).toMatchObject({ exitCode: 0, stderr: "" });
    expect(version.stdout).toMatch(/^review-mesh \d+\.\d+\.\d+\n$/);

    const schema = await runArguments(
      artifact,
      ["schema", "request", "--json"],
      options,
    );
    expect(schema).toMatchObject({ exitCode: 0, stderr: "" });
    expect(JSON.parse(schema.stdout)).toMatchObject({
      name: "request",
      schema: { $schema: "http://json-schema.org/draft-07/schema#" },
    });
  });

  it("runs the command adapter after being copied outside the project", async () => {
    const workspace = join(root, "command-workspace");
    const reviewer = join(root, "command-reviewer.mjs");
    const config = configPath(join(root, "command-home"));
    await mkdir(workspace, { recursive: true });
    await mkdir(dirname(config), { recursive: true });
    await writeFile(join(workspace, "source.ts"), "export const value = 1;\n");
    await writeFile(
      reviewer,
      `for await (const _ of process.stdin) {}\nprocess.stdout.write(JSON.stringify({type:"result",result:{schema_version:"1",verdict:"pass",summary:"portable command",actionable_findings:[],informational_notes:[]}})+"\\n");\n`,
    );
    await writeFile(
      config,
      `schema_version = "1"
[execution]
max_concurrency = 1
heartbeat_interval_ms = 100
shutdown_grace_period_ms = 100
[diagnostics]
persist_runs = false
max_runs = 1
[adapters.portable]
type = "command"
command = ${JSON.stringify(process.execPath)}
args = [${JSON.stringify(reviewer)}]
protocol = "review-mesh-command-v1"
[reviewer_profiles.portable]
adapter = "portable"
model = "fixture"
purpose = "Portable command acceptance"
instructions = "Review read-only."
isolation = "prefer_enforced"
timeout_ms = 5000
[[reviewers]]
id = "portable"
profile = "portable"
`,
    );

    const result = await run(
      artifact,
      {
        schema_version: "2",
        project_name: "command-workspace",
        workspace,
        instructions: "Review the portable command fixture.",
        review_scope: { mode: "full" },
      },
      { cwd: root, env: isolatedEnvironment(join(root, "command-home")) },
    );

    expect(result).toMatchObject({ exitCode: 0, stderr: "" });
    expect(completion(result.stdout)).toMatchObject({
      event: "run.completed",
      data: { status: "passed", exit_code: 0 },
    });
  });

  it("runs the embedded OpenAI-compatible adapter without node_modules", async () => {
    const workspace = join(root, "openai-workspace");
    const home = join(root, "openai-home");
    const config = configPath(home);
    await mkdir(workspace, { recursive: true });
    await mkdir(dirname(config), { recursive: true });
    await writeFile(join(workspace, "source.ts"), "export const value = 1;\n");

    const server = createServer(
      (request: IncomingMessage, response: ServerResponse) => {
        response.setHeader("content-type", "application/json");
        if (request.url === "/v1/models") {
          response.end(JSON.stringify({ data: [{ id: "portable-model" }] }));
          return;
        }
        if (request.url === "/v1/chat/completions") {
          response.end(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      schema_version: "1",
                      verdict: "pass",
                      summary: "portable OpenAI compatible",
                      actionable_findings: [],
                      informational_notes: [],
                    }),
                  },
                },
              ],
            }),
          );
          return;
        }
        response.statusCode = 404;
        response.end("{}");
      },
    );
    await new Promise<void>((resolveListen) =>
      server.listen(0, "127.0.0.1", resolveListen),
    );
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("test server did not expose a TCP address");
    }
    await writeFile(
      config,
      `schema_version = "1"
[execution]
max_concurrency = 1
heartbeat_interval_ms = 100
shutdown_grace_period_ms = 100
[diagnostics]
persist_runs = false
max_runs = 1
[adapters.portable]
type = "openai_compatible"
base_url_env = "PORTABLE_BASE_URL"
api_key_env = "PORTABLE_API_KEY"
[reviewer_profiles.portable]
adapter = "portable"
model = "portable-model"
purpose = "Portable OpenAI acceptance"
instructions = "Review read-only."
isolation = "prefer_enforced"
timeout_ms = 5000
[[reviewers]]
id = "portable"
profile = "portable"
`,
    );
    try {
      const result = await run(
        artifact,
        {
          schema_version: "2",
          project_name: "openai-workspace",
          workspace,
          instructions: "Review the portable OpenAI-compatible fixture.",
          review_scope: { mode: "full" },
        },
        {
          cwd: root,
          env: {
            ...isolatedEnvironment(home),
            PORTABLE_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
            PORTABLE_API_KEY: "portable-secret",
          },
        },
      );
      expect(result).toMatchObject({ exitCode: 0, stderr: "" });
      expect(completion(result.stdout)).toMatchObject({
        event: "run.completed",
        data: { status: "passed", exit_code: 0 },
      });
    } finally {
      await new Promise<void>((resolveClose, reject) =>
        server.close((error) => (error ? reject(error) : resolveClose())),
      );
    }
  });
});
