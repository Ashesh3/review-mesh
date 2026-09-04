import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const projectRoot = resolve(import.meta.dirname, "../..");
const windowsExecutable = join(
  projectRoot,
  "dist",
  "release",
  "review-mesh-windows-x64.exe",
);
const linuxExecutable = join(
  projectRoot,
  "dist",
  "release",
  "review-mesh-linux-x64",
);
const verifyStandalone = process.env.REVIEW_MESH_VERIFY_STANDALONE === "1";
const roots: string[] = [];

interface PlatformRunner {
  name: "Windows" | "Linux";
  createFixture(): Promise<Fixture>;
  run(
    fixture: Fixture,
    args: readonly string[],
    stdin?: string,
  ): Promise<ProcessResult>;
}

interface Fixture {
  root: string;
  workspace: string;
  home: string;
}

interface ProcessResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function collect(
  child: ReturnType<typeof spawn>,
  stdin = "",
): Promise<ProcessResult> {
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
  child.stdin?.end(stdin);
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

function quoteToml(value: string): string {
  return JSON.stringify(value.replaceAll("\\", "/"));
}

function config(command: string, args: readonly string[]): string {
  return `schema_version = "1"
[execution]
max_concurrency = 1
heartbeat_interval_ms = 100
shutdown_grace_period_ms = 100
[diagnostics]
persist_runs = true
max_runs = 1
[adapters.release]
type = "command"
command = ${quoteToml(command)}
args = [${args.map(quoteToml).join(", ")}]
protocol = "review-mesh-command-v1"
[reviewer_profiles.release_0]
adapter = "release"
model = "fixture-0"
purpose = "Standalone release acceptance 0"
instructions = "Review read-only."
isolation = "prefer_enforced"
timeout_ms = 10000
[reviewer_profiles.release_1]
adapter = "release"
model = "fixture-1"
purpose = "Standalone release acceptance 1"
instructions = "Review read-only."
isolation = "prefer_enforced"
timeout_ms = 10000
[[reviewers]]
id = "release-0"
profile = "release_0"
[[reviewers]]
id = "release-1"
profile = "release_1"
`;
}

const expectedReview = `# Standalone review\n\nThe release executable returned this complete cross-platform review.\n\n${"Complete standalone evidence. ".repeat(4_096)}`;
const expectedResult = {
  schema_version: "3",
  verdict: "fail",
  review_markdown: expectedReview,
  summary: "one standalone finding",
  actionable_findings: [
    {
      id: "standalone-medium",
      severity: "medium",
      title: "Standalone finding",
      description: "The release fixture found a controlled defect.",
      evidence: [{ path: "source.txt", detail: "Controlled evidence." }],
      suggested_direction: "Correct the controlled defect.",
      confidence: "high",
      classification: "confirmed_defect",
      external_assumptions: [],
      root_issue_id: "standalone-shared-root",
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
      id: "standalone-medium-second",
      evidence: [{ path: "source.txt", detail: "Controlled evidence B." }],
    },
  ],
};

function request(workspace: string): string {
  return JSON.stringify({
    schema_version: "2",
    request_id: "standalone-release-acceptance",
    project_name: "workspace",
    workspace,
    instructions: "Review the standalone release fixture.",
    review_scope: { mode: "full" },
  });
}

function parsedEvents(stdout: string): Array<Record<string, unknown>> {
  return stdout
    .trim()
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function windowsRunner(): Promise<PlatformRunner | undefined> {
  if (process.platform !== "win32" || !(await exists(windowsExecutable))) {
    return undefined;
  }
  return {
    name: "Windows",
    async createFixture() {
      const root = await mkdtemp(
        join(tmpdir(), "review-mesh-standalone-windows-"),
      );
      roots.push(root);
      const workspace = join(root, "workspace");
      const home = join(root, "home");
      const configFile = join(home, "review-mesh", "Config", "config.toml");
      const reviewer = join(root, "reviewer.ps1");
      await mkdir(workspace, { recursive: true });
      await mkdir(dirname(configFile), { recursive: true });
      await writeFile(join(workspace, "source.txt"), "controlled\n");
      await writeFile(
        reviewer,
        `$null = [Console]::In.ReadToEnd()\n$results = @('${Buffer.from(JSON.stringify(expectedResult), "utf8").toString("base64")}', '${Buffer.from(JSON.stringify(secondResult), "utf8").toString("base64")}')\n$index = if ($env:REVIEW_MESH_MODEL.EndsWith('-1')) { 1 } else { 0 }\n$json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($results[$index]))\n[Console]::Out.WriteLine('{"type":"result","result":' + $json + '}')\n`,
      );
      await writeFile(
        configFile,
        config("powershell.exe", [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          reviewer,
        ]),
      );
      return { root, workspace, home };
    },
    run(fixture, args, stdin) {
      return collect(
        spawn(windowsExecutable, [...args], {
          cwd: fixture.root,
          env: {
            ...process.env,
            APPDATA: fixture.home,
            LOCALAPPDATA: fixture.home,
          },
          stdio: "pipe",
          windowsHide: true,
        }),
        stdin,
      );
    },
  };
}

async function wslPath(path: string): Promise<string> {
  const result = await collect(
    spawn(
      "wsl.exe",
      ["--distribution", "Ubuntu", "--exec", "wslpath", "-a", path],
      { stdio: "pipe", windowsHide: true },
    ),
  );
  if (result.exitCode !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

async function linuxRunner(): Promise<PlatformRunner | undefined> {
  if (process.platform !== "win32" || !(await exists(linuxExecutable))) {
    return undefined;
  }
  const executable = await wslPath(linuxExecutable);
  const pythonProbe = await collect(
    spawn(
      "wsl.exe",
      ["--distribution", "Ubuntu", "--exec", "python3", "--version"],
      { stdio: "pipe", windowsHide: true },
    ),
  ).catch(() => undefined);
  if (pythonProbe?.exitCode !== 0) return undefined;
  return {
    name: "Linux",
    async createFixture() {
      const root = await mkdtemp(
        join(tmpdir(), "review-mesh-standalone-linux-"),
      );
      roots.push(root);
      const workspace = join(root, "workspace");
      const home = join(root, "home");
      const reviewer = join(root, "reviewer.py");
      await mkdir(workspace, { recursive: true });
      await mkdir(home, { recursive: true });
      await writeFile(join(workspace, "source.txt"), "controlled\n");
      await writeFile(
        reviewer,
        `import json,os,sys\nsys.stdin.buffer.read()\nresults=${JSON.stringify([expectedResult, secondResult])}\nindex=1 if os.environ.get("REVIEW_MESH_MODEL", "").endswith("-1") else 0\nprint(json.dumps({"type":"result","result":results[index]}))\n`,
      );
      const [linuxRoot, linuxWorkspace, linuxHome, linuxReviewer] =
        await Promise.all([
          wslPath(root),
          wslPath(workspace),
          wslPath(home),
          wslPath(reviewer),
        ]);
      const configFile = join(home, "review-mesh", "config.toml");
      await mkdir(dirname(configFile), { recursive: true });
      await writeFile(configFile, config("/usr/bin/python3", [linuxReviewer]));
      return { root: linuxRoot, workspace: linuxWorkspace, home: linuxHome };
    },
    run(fixture, args, stdin) {
      return collect(
        spawn(
          "wsl.exe",
          [
            "--distribution",
            "Ubuntu",
            "--exec",
            "env",
            `XDG_CONFIG_HOME=${fixture.home}`,
            `XDG_DATA_HOME=${fixture.home}/data`,
            `XDG_STATE_HOME=${fixture.home}/state`,
            executable,
            ...args,
          ],
          { cwd: projectRoot, stdio: "pipe", windowsHide: true },
        ),
        stdin,
      );
    },
  };
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe.skipIf(!verifyStandalone)("standalone release executables", () => {
  it("executes the exact Windows and Linux v8 binaries with the full artifact contract", async () => {
    const runners = await Promise.all([windowsRunner(), linuxRunner()]);
    expect(runners.every((runner) => runner !== undefined)).toBe(true);

    for (const runner of runners as PlatformRunner[]) {
      const fixture = await runner.createFixture();
      expect(
        Buffer.byteLength(expectedReview, "utf8"),
        runner.name,
      ).toBeGreaterThan(100 * 1_024);
      const version = await runner.run(fixture, ["--version"]);
      expect(version, runner.name).toEqual({
        exitCode: 0,
        stdout: "review-mesh 8.0.0\n",
        stderr: "",
      });

      const review = await runner.run(
        fixture,
        ["review"],
        request(fixture.workspace),
      );
      expect(review.exitCode, runner.name).toBe(1);
      expect(review.stderr, runner.name).toBe("");
      const events = parsedEvents(review.stdout);
      const fullResults = events.filter(
        (event): event is { run_id: string; data: Record<string, unknown> } =>
          event.event === "reviewer.result",
      );
      const full = fullResults[0];
      const completed = events.at(-1) as {
        run_id: string;
        data: Record<string, unknown>;
      };
      const expectedDigest = digest(expectedResult);
      const expectedBytes = Buffer.byteLength(
        JSON.stringify(expectedResult),
        "utf8",
      );
      expect(fullResults, runner.name).toHaveLength(2);
      expect(expectedDigest).toMatch(/^[a-f0-9]{64}$/u);
      expect(full, runner.name).toMatchObject({
        run_id: completed.run_id,
        data: {
          digest: expectedDigest,
          byte_count: expectedBytes,
          result: expectedResult,
        },
      });
      expect(fullResults[1], runner.name).toMatchObject({
        run_id: completed.run_id,
        data: { result: secondResult },
      });
      expect(completed, runner.name).toMatchObject({
        event: "run.completed",
        data: {
          report_path: expect.any(String),
          raw_findings: 2,
          unique_findings: 1,
          gate_findings: 1,
          advisory_findings: 0,
          results_complete: true,
        },
      });
      expect(completed.data.result_manifest, runner.name).toHaveLength(2);
      for (const [index, event] of fullResults.entries()) {
        expect(event.data.artifact_path, runner.name).toBe(
          completed.data.report_path,
        );
        expect(
          (completed.data.result_manifest as Array<Record<string, unknown>>)[
            index
          ],
          runner.name,
        ).toMatchObject({
          digest: event.data.digest,
          byte_count: event.data.byte_count,
          artifact_path: completed.data.report_path,
        });
      }

      const status = await runner.run(fixture, [
        "status",
        completed.run_id,
        "--json",
      ]);
      const report = await runner.run(fixture, [
        "report",
        completed.run_id,
        "--format",
        "json",
      ]);
      const findings = await runner.run(fixture, [
        "findings",
        completed.run_id,
        "--deduplicate",
        "--json",
      ]);
      for (const output of [status, report, findings]) {
        expect(output.exitCode, runner.name).toBe(0);
        expect(output.stderr, runner.name).toBe("");
      }
      expect(JSON.parse(status.stdout), runner.name).toMatchObject({
        run_id: completed.run_id,
        reviewers: [
          { complete_result: expectedResult, result_digest: expectedDigest },
          { complete_result: secondResult },
        ],
      });
      expect(JSON.parse(report.stdout), runner.name).toMatchObject({
        run_id: completed.run_id,
        reviewers: [{ result: expectedResult }, { result: secondResult }],
        finding_counts: { raw: 2, unique: 1, gate: 1, advisory: 0 },
      });
      expect(JSON.parse(findings.stdout), runner.name).toMatchObject({
        run_id: completed.run_id,
        findings: [expect.objectContaining({ id: "standalone-medium" })],
      });
    }
  }, 120_000);
});
