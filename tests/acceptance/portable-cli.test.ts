import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
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

function events(stdout: string): Array<Record<string, unknown>> {
  return stdout
    .trim()
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function digest(value: unknown): string {
  return createHash("sha256")
    .update(canonicalJson(value), "utf8")
    .digest("hex");
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
    expect(version.stdout).toBe("review-mesh 8.0.0\n");

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

  it("serves the embedded dashboard from the copied artifact", async () => {
    const home = join(root, "serve-home");
    const child = spawn(
      process.execPath,
      [artifact, "serve", "--host", "127.0.0.1", "--port", "0", "--no-open"],
      {
        cwd: root,
        env: isolatedEnvironment(home),
        stdio: "pipe",
        windowsHide: true,
      },
    );
    try {
      const url = await new Promise<string>((resolveUrl, reject) => {
        let stdout = "";
        const timer = setTimeout(
          () => reject(new Error("dashboard URL was not printed")),
          10_000,
        );
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
          stdout += chunk;
          const match = /Review Mesh dashboard: (http:\/\/[^\s]+)/u.exec(
            stdout,
          );
          if (match === null) return;
          clearTimeout(timer);
          resolveUrl(match[1]!);
        });
        child.once("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
      });
      const page = await fetch(url);
      expect(page.status).toBe(200);
      const html = await page.text();
      expect(html).toContain("Review Mesh");
      expect(html).not.toMatch(/https?:\/\/.*(?:\.js|\.css)/u);
      const snapshot = await fetch(new URL("api/snapshot", url));
      expect(await snapshot.json()).toMatchObject({
        server: { read_only: true },
      });
    } finally {
      child.kill("SIGTERM");
      await new Promise((resolveClose) => child.once("close", resolveClose));
    }
  });

  it("runs the command adapter after being copied outside the project", async () => {
    const workspace = join(root, "command-workspace");
    const reviewer = join(root, "command-reviewer.mjs");
    const config = configPath(join(root, "command-home"));
    await mkdir(workspace, { recursive: true });
    await mkdir(dirname(config), { recursive: true });
    await writeFile(join(workspace, "source.ts"), "export const value = 1;\n");
    const expectedReview = `# Portable review\n\nThe copied artifact preserved this complete review.\n\n${"Complete portable evidence. ".repeat(4_096)}`;
    expect(Buffer.byteLength(expectedReview, "utf8")).toBeGreaterThan(
      100 * 1_024,
    );
    const expectedResult = {
      schema_version: "3",
      verdict: "fail",
      review_markdown: expectedReview,
      summary: "portable command finding",
      actionable_findings: [
        {
          id: "portable-root-a",
          severity: "medium",
          title: "Portable shared finding",
          description: "The portable fixture found a controlled defect.",
          evidence: [{ path: "source.ts", detail: "Controlled evidence A." }],
          suggested_direction: "Correct the controlled defect.",
          confidence: "high",
          classification: "confirmed_defect",
          external_assumptions: [],
          root_issue_id: "portable-shared-root",
          category: "correctness",
          verification: "The copied fixture emitted deterministic evidence.",
        },
      ],
      informational_notes: [],
    };
    const secondResult = {
      ...expectedResult,
      actionable_findings: [
        {
          ...expectedResult.actionable_findings[0],
          id: "portable-root-b",
          evidence: [{ path: "source.ts", detail: "Controlled evidence B." }],
        },
      ],
    };
    await writeFile(
      reviewer,
      `for await (const _ of process.stdin) {}\nconst index=process.env.REVIEW_MESH_MODEL.endsWith("-1")?1:0;const results=${JSON.stringify([expectedResult, secondResult])};process.stdout.write(JSON.stringify({type:"result",result:results[index]})+"\\n");\n`,
    );
    await writeFile(
      config,
      `schema_version = "1"
[execution]
max_concurrency = 1
heartbeat_interval_ms = 100
shutdown_grace_period_ms = 100
[diagnostics]
persist_runs = true
max_runs = 1
[adapters.portable]
type = "command"
command = ${JSON.stringify(process.execPath)}
args = [${JSON.stringify(reviewer)}]
protocol = "review-mesh-command-v1"
[reviewer_profiles.portable_0]
adapter = "portable"
model = "fixture-0"
purpose = "Portable command acceptance 0"
instructions = "Review read-only."
isolation = "prefer_enforced"
timeout_ms = 5000
[reviewer_profiles.portable_1]
adapter = "portable"
model = "fixture-1"
purpose = "Portable command acceptance 1"
instructions = "Review read-only."
isolation = "prefer_enforced"
timeout_ms = 5000
[[reviewers]]
id = "portable-0"
profile = "portable_0"
[[reviewers]]
id = "portable-1"
profile = "portable_1"
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

    expect(result).toMatchObject({ exitCode: 1, stderr: "" });
    const parsed = events(result.stdout);
    const fullResults = parsed.filter(
      (event): event is { run_id: string; data: Record<string, unknown> } =>
        event.event === "reviewer.result",
    );
    const full = fullResults[0];
    const completed = completion(result.stdout) as {
      run_id: string;
      data: Record<string, unknown>;
    };
    const expectedDigest = digest(expectedResult);
    const expectedBytes = Buffer.byteLength(
      JSON.stringify(expectedResult),
      "utf8",
    );
    expect(fullResults).toHaveLength(2);
    expect(digest(secondResult)).toMatch(/^[a-f0-9]{64}$/u);
    expect(full).toMatchObject({
      run_id: completed.run_id,
      data: {
        digest: expectedDigest,
        byte_count: expectedBytes,
        result: expectedResult,
      },
    });
    expect(fullResults[1]).toMatchObject({
      run_id: completed.run_id,
      data: { result: secondResult },
    });
    expect(completed).toMatchObject({
      event: "run.completed",
      data: {
        status: "findings",
        exit_code: 1,
        raw_findings: 2,
        unique_findings: 1,
        gate_findings: 1,
        advisory_findings: 0,
        results_complete: true,
      },
    });
    expect(completed.data.result_manifest).toHaveLength(2);
    const manifest = completed.data.result_manifest as Array<
      Record<string, unknown>
    >;
    for (const [index, event] of fullResults.entries()) {
      expect(event.data.artifact_path).toBe(completed.data.report_path);
      expect(manifest[index]).toMatchObject({
        digest: event.data.digest,
        byte_count: event.data.byte_count,
        artifact_path: completed.data.report_path,
      });
    }
    expect(full?.data.artifact_path).toBe(completed.data.report_path);

    const artifactRecords = (
      await readFile(String(completed.data.report_path), "utf8")
    )
      .trim()
      .split(/\r?\n/u)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(artifactRecords).toContainEqual(
      expect.objectContaining({
        record: "reviewer.result",
        run_id: completed.run_id,
        reviewer_id: "portable-0",
        digest: expectedDigest,
        byte_count: expectedBytes,
        result: expectedResult,
      }),
    );
    expect(artifactRecords).toContainEqual(
      expect.objectContaining({
        event: "reviewer.result",
        run_id: completed.run_id,
        data: expect.not.objectContaining({ result: expect.anything() }),
      }),
    );

    for (const [args, assertion] of [
      [
        ["status", completed.run_id, "--json"],
        {
          reviewers: [
            { complete_result: expectedResult },
            { complete_result: secondResult },
          ],
        },
      ],
      [
        ["report", completed.run_id, "--format", "json"],
        {
          reviewers: [{ result: expectedResult }, { result: secondResult }],
          finding_counts: { raw: 2, unique: 1, gate: 1, advisory: 0 },
        },
      ],
      [
        ["findings", completed.run_id, "--deduplicate", "--json"],
        { findings: [expect.objectContaining({ id: "portable-root-a" })] },
      ],
    ] as const) {
      const readback = await runArguments(artifact, args, {
        cwd: root,
        env: isolatedEnvironment(join(root, "command-home")),
      });
      expect(readback).toMatchObject({ exitCode: 0, stderr: "" });
      expect(JSON.parse(readback.stdout)).toMatchObject({
        run_id: completed.run_id,
        ...assertion,
      });
    }
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
                      schema_version: "3",
                      verdict: "pass",
                      review_markdown:
                        "# Portable OpenAI review\n\nThe embedded adapter returned a complete result.",
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
