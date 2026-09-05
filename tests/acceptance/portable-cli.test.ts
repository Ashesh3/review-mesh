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
import {
  v9AcceptanceNarrative,
  v9CommandConfig,
  v9ReviewerResult,
  writeV9CommandFixture,
} from "../helpers/v9-command-fixture.js";

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
  options: { cwd: string; env: NodeJS.ProcessEnv; args?: readonly string[] },
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  const child = spawn(
    process.execPath,
    [file, "review", ...(options.args ?? [])],
    {
      ...options,
      stdio: "pipe",
      windowsHide: true,
    },
  );
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
    expect(version.stdout).toBe("review-mesh 9.1.0\n");

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
    const largeReview = v9AcceptanceNarrative("# Portable review");
    expect(Buffer.byteLength(largeReview, "utf8")).toBe(256 * 1024);
    const expectedResult = v9ReviewerResult({
      verdict: "fail",
      reviewMarkdown: largeReview,
      summary: "portable command finding",
      findingId: "portable-root-a",
      rootIssueId: "portable-shared-root",
      evidenceDetail: "Controlled evidence A.",
    });
    const secondResult = v9ReviewerResult({
      verdict: "fail",
      reviewMarkdown: largeReview,
      summary: "portable command finding",
      findingId: "portable-root-b",
      rootIssueId: "portable-shared-root",
      evidenceDetail: "Controlled evidence B.",
    });
    await writeV9CommandFixture(reviewer, [
      { id: "portable_0", mode: "large-fail", result: expectedResult },
      { id: "portable_1", mode: "large-fail", result: secondResult },
    ]);
    await writeFile(
      config,
      v9CommandConfig({
        scriptPath: reviewer,
        entries: [
          { id: "portable_0", mode: "large-fail", result: expectedResult },
          { id: "portable_1", mode: "large-fail", result: secondResult },
        ],
        persistRuns: true,
      }),
    );

    const result = await run(
      artifact,
      {
        schema_version: "3",
        project_name: "command-workspace",
        workspace,
        instructions: "Review the portable command fixture.",
        review_scope: { mode: "full" },
      },
      {
        cwd: root,
        env: isolatedEnvironment(join(root, "command-home")),
        args: ["--output-mode", "full-jsonl"],
      },
    );

    expect(result).toMatchObject({ exitCode: 0, stderr: "" });
    const parsed = events(result.stdout);
    const fullResults = parsed.filter(
      (
        event,
      ): event is {
        run_id: string;
        reviewer_id: string;
        data: Record<string, unknown>;
      } => event.event === "reviewer.result",
    );
    const full = fullResults.find(
      (event) => event.reviewer_id === "portable_0",
    );
    const completed = completion(result.stdout) as {
      run_id: string;
      data: Record<string, unknown>;
    };
    const acceptedResult = full?.data.result as Record<string, unknown>;
    const expectedDigest = digest(acceptedResult);
    const expectedBytes = Buffer.byteLength(
      JSON.stringify(acceptedResult),
      "utf8",
    );
    expect(fullResults).toHaveLength(2);
    expect(digest(secondResult)).toMatch(/^[a-f0-9]{64}$/u);
    expect(full).toMatchObject({
      run_id: completed.run_id,
      data: {
        digest: expectedDigest,
        byte_count: expectedBytes,
        result: {
          ...expectedResult,
          change_coverage: { status: "not_applicable" },
        },
      },
    });
    expect(
      fullResults.find((event) => event.reviewer_id === "portable_1"),
    ).toMatchObject({
      run_id: completed.run_id,
      data: {
        result: {
          ...secondResult,
          change_coverage: { status: "not_applicable" },
        },
      },
    });
    expect(completed).toMatchObject({
      event: "run.completed",
      data: {
        run_outcome: "clear",
        gate_outcome: "no_gate_findings",
        coverage_outcome: "complete",
        exit_code: 0,
        raw_source_findings: 2,
        atomic_subfindings: 1,
        canonical_roots: 1,
        gate_eligible_subfindings: 0,
        result_delivery: {
          completed_results: 2,
          artifact: "complete",
          planned_public_stream: "complete",
        },
      },
    });
    const artifactReference = completed.data.artifact as Record<
      string,
      unknown
    >;
    expect(artifactReference).toMatchObject({ completed_results: 2 });
    for (const event of fullResults)
      expect(event.data).not.toHaveProperty("artifact_path");

    const artifactRecords = (
      await readFile(String(artifactReference.path), "utf8")
    )
      .trim()
      .split(/\r?\n/u)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const artifactResult = artifactRecords.find(
      (record) =>
        record.record === "reviewer.result" &&
        record.reviewer_id === "portable_0",
    );
    expect(artifactResult).toMatchObject({
      record: "reviewer.result",
      run_id: completed.run_id,
      reviewer_id: "portable_0",
    });
    expect(
      artifactRecords.some(
        (record) =>
          record.record === "reviewer.result" &&
          record.reviewer_id === "portable_1",
      ),
    ).toBe(true);

    for (const [args, assertion] of [
      [
        ["status", completed.run_id, "--json"],
        {
          reviewers: [
            {
              complete_result: {
                ...expectedResult,
                change_coverage: { status: "not_applicable" },
              },
            },
            {
              complete_result: {
                ...secondResult,
                change_coverage: { status: "not_applicable" },
              },
            },
          ],
        },
      ],
      [
        ["report", completed.run_id, "--format", "json"],
        {
          reviewers: [
            {
              result: {
                ...expectedResult,
                change_coverage: { status: "not_applicable" },
              },
            },
            {
              result: {
                ...secondResult,
                change_coverage: { status: "not_applicable" },
              },
            },
          ],
          finding_counts: {
            raw_source_findings: 2,
            atomic_subfindings: 1,
            canonical_roots: 1,
            gate_eligible_subfindings: 0,
          },
        },
      ],
      [
        ["findings", completed.run_id, "--deduplicate", "--json"],
        {
          findings: [
            expect.objectContaining({
              id: "portable-shared-root",
              subfindings: [expect.objectContaining({ id: "portable-root-a" })],
            }),
          ],
        },
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

    const observedBodies: Array<Record<string, unknown>> = [];
    let scriptedResponseIndex = 0;
    let firstPage = "";
    const scriptedResponses = [
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "read-source",
            type: "function",
            function: {
              name: "read_file",
              arguments: JSON.stringify({ path: "source.ts" }),
            },
          },
        ],
      },
      { role: "assistant", content: "Inspection complete." },
    ];
    const server = createServer(
      (request: IncomingMessage, response: ServerResponse) => {
        response.setHeader("content-type", "application/json");
        if (request.url === "/v1/models") {
          response.end(JSON.stringify({ data: [{ id: "portable-model" }] }));
          return;
        }
        if (request.url === "/v1/chat/completions") {
          const chunks: Buffer[] = [];
          request.on("data", (chunk: Buffer) => chunks.push(chunk));
          request.on("end", () => {
            observedBodies.push(
              JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<
                string,
                unknown
              >,
            );
            const body = observedBodies.at(-1)!;
            const messages = body.messages as Array<{
              role?: string;
              content?: string;
            }>;
            const lastContent = messages.at(-1)?.content;
            let message: Record<string, unknown> | undefined;
            if (scriptedResponseIndex < scriptedResponses.length) {
              message = scriptedResponses[scriptedResponseIndex++];
            } else if (body.response_format !== undefined) {
              const assignment = JSON.parse(lastContent ?? "{}") as {
                result_id: string;
                page_index: number;
                previous_page_digest: string | null;
              };
              const page = JSON.stringify({
                schema_version: "1",
                kind: "review-mesh.result-page",
                result_id: assignment.result_id,
                result_kind: "reviewer",
                result_schema_version: "4",
                page_index: assignment.page_index,
                page_count: 2,
                page_kind: assignment.page_index === 0 ? "header" : "narrative",
                previous_page_digest: assignment.previous_page_digest,
                payload:
                  assignment.page_index === 0
                    ? {
                        verdict: "pass",
                        summary: "portable OpenAI compatible",
                        informational_notes: [],
                        narrative_byte_count: Buffer.byteLength(
                          "Portable observed review.",
                          "utf8",
                        ),
                        narrative_fragment_count: 1,
                        actionable_finding_count: 0,
                        coverage_attestation: null,
                      }
                    : { text_fragment: "Portable observed review." },
              });
              if (assignment.page_index === 0) firstPage = page;
              else {
                expect(assignment.previous_page_digest).toBe(
                  createHash("sha256").update(firstPage, "utf8").digest("hex"),
                );
              }
              message = { role: "assistant", content: page };
            }
            if (message === undefined) {
              response.statusCode = 500;
              response.end("{}");
              return;
            }
            response.end(
              JSON.stringify({ choices: [{ message, finish_reason: "stop" }] }),
            );
          });
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
      `schema_version = "7"
[execution]
max_concurrency = 1
heartbeat_interval_ms = 1000
shutdown_grace_period_ms = 1000
deadline_mode = "adaptive"
no_progress_timeout_ms = 1000
[diagnostics]
persist_runs = true
max_runs = 10
[adapters.portable]
type = "openai_compatible"
base_url_env = "PORTABLE_BASE_URL"
api_key_env = "PORTABLE_API_KEY"
[agents.portable]
adapter = "portable"
model = "portable-model"
purpose = "Portable OpenAI acceptance"
instructions = "Review read-only."
isolation = "prefer_enforced"
timeout_ms = 20000
kind = "generic"
required_input = []
adjudication = "off"
[agents.portable.applicability]
mode = "always"
[agents.portable.change_coverage]
relevant_paths = ["**"]
minimum_inspection = "full_file"
proof = "observed"
[defaults]
agents = ["portable"]
`,
    );
    try {
      const result = await run(
        artifact,
        {
          schema_version: "3",
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
      if (result.exitCode !== 0) {
        throw new Error(
          `portable OpenAI fixture failed ${JSON.stringify({ result, observedBodies })}`,
        );
      }
      expect(result).toMatchObject({ exitCode: 0, stderr: "" });
      expect(completion(result.stdout)).toMatchObject({
        event: "run.completed",
        data: {
          run_outcome: "clear",
          gate_outcome: "no_gate_findings",
          coverage_outcome: "complete",
          exit_code: 0,
        },
      });
      expect(scriptedResponseIndex).toBe(scriptedResponses.length);
      expect(
        observedBodies.some((body) =>
          JSON.stringify(body).includes('"name":"read_file"'),
        ),
      ).toBe(true);
      expect(
        observedBodies.filter((body) => body.response_format !== undefined),
      ).toHaveLength(2);
    } finally {
      await new Promise<void>((resolveClose, reject) =>
        server.close((error) => (error ? reject(error) : resolveClose())),
      );
    }
  });
});
