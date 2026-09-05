import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  v9AcceptanceNarrative,
  v9CommandConfig,
  v9ReviewerResult,
} from "../helpers/v9-command-fixture.js";

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
  const base = v9CommandConfig({
    scriptPath: args.at(-1)!,
    entries: [
      { id: "release_0", mode: "large-fail", result: expectedResult },
      { id: "release_1", mode: "large-fail", result: secondResult },
    ],
    persistRuns: true,
  });
  return base.replace(
    /command = .*\nargs = \[[^\n]*\]/gu,
    `command = ${quoteToml(command)}\nargs = [${args.map(quoteToml).join(", ")}]`,
  );
}

const expectedReview = v9AcceptanceNarrative("# Standalone review");
const expectedResult = v9ReviewerResult({
  verdict: "fail",
  reviewMarkdown: expectedReview,
  summary: "one standalone finding",
  findingId: "standalone-medium",
  rootIssueId: "standalone-shared-root",
  evidencePath: "source.txt",
});
const secondResult = v9ReviewerResult({
  verdict: "fail",
  reviewMarkdown: expectedReview,
  summary: "one standalone finding",
  findingId: "standalone-medium-second",
  rootIssueId: "standalone-shared-root",
  evidencePath: "source.txt",
  evidenceDetail: "Controlled evidence B.",
});

function request(workspace: string): string {
  return JSON.stringify({
    schema_version: "3",
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
        `$results = @('${Buffer.from(JSON.stringify(expectedResult), "utf8").toString("base64")}', '${Buffer.from(JSON.stringify(secondResult), "utf8").toString("base64")}')
$index = if ($env:REVIEW_MESH_MODEL.EndsWith('-1')) { 1 } else { 0 }
$result = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($results[$index])) | ConvertFrom-Json
$null = [Console]::In.ReadLine()
[Console]::Out.WriteLine('{"type":"activity","message":"fixture page delivery","identity":"fixture-activity"}')
$chunks = @()
$text = [string]$result.review_markdown
for ($offset = 0; $offset -lt $text.Length; $offset += 24576) { $chunks += $text.Substring($offset, [Math]::Min(24576, $text.Length - $offset)) }
$findings = @($result.actionable_findings)
$pageCount = 1 + $chunks.Count + [Math]::Ceiling($findings.Count / 2)
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $assignment = $line | ConvertFrom-Json
  if ($assignment.type -ne 'request_page') { continue }
  $pageIndex = [int]$assignment.request.page_index
  if ($pageIndex -eq 0) {
    $pageKind = 'header'
    $payload = [ordered]@{ verdict=$result.verdict; summary=$result.summary; informational_notes=@($result.informational_notes); narrative_byte_count=[Text.Encoding]::UTF8.GetByteCount($text); narrative_fragment_count=$chunks.Count; actionable_finding_count=$findings.Count; coverage_attestation=$null }
  } elseif ($pageIndex -le $chunks.Count) {
    $pageKind = 'narrative'; $payload = [ordered]@{ text_fragment=$chunks[$pageIndex - 1] }
  } else {
    $pageKind = 'findings'; $findingIndex = ($pageIndex - $chunks.Count - 1) * 2; $payload = [ordered]@{ actionable_findings=@($findings[$findingIndex..([Math]::Min($findingIndex + 1, $findings.Count - 1))]) }
  }
  $page = [ordered]@{ schema_version='1'; kind='review-mesh.result-page'; result_id=$assignment.request.result_id; result_kind='reviewer'; result_schema_version='4'; page_index=$pageIndex; page_count=[int]$pageCount; page_kind=$pageKind; previous_page_digest=$assignment.request.previous_page_digest; payload=$payload } | ConvertTo-Json -Compress -Depth 20
  [Console]::Out.WriteLine((@{type='result_page';page=$page} | ConvertTo-Json -Compress))
  if ($pageIndex + 1 -eq $pageCount) { break }
}
`,
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
        `import json,os,sys
results=${JSON.stringify([expectedResult, secondResult])}
index=1 if os.environ.get("REVIEW_MESH_MODEL", "").endswith("-1") else 0
result=results[index]
sys.stdin.readline()
print(json.dumps({"type":"activity","message":"fixture page delivery","identity":"fixture-activity"}),flush=True)
text=result["review_markdown"]
chunks=[text[i:i+24576] for i in range(0,len(text),24576)]
findings=result["actionable_findings"]
page_count=1+len(chunks)+(len(findings)+1)//2
for line in sys.stdin:
    assignment=json.loads(line)
    if assignment.get("type")!="request_page": continue
    request=assignment["request"]; page_index=request["page_index"]
    if page_index==0:
        page_kind="header"; payload={"verdict":result["verdict"],"summary":result["summary"],"informational_notes":result["informational_notes"],"narrative_byte_count":len(text.encode()),"narrative_fragment_count":len(chunks),"actionable_finding_count":len(findings),"coverage_attestation":None}
    elif page_index<=len(chunks):
        page_kind="narrative"; payload={"text_fragment":chunks[page_index-1]}
    else:
        page_kind="findings"; offset=(page_index-len(chunks)-1)*2; payload={"actionable_findings":findings[offset:offset+2]}
    page={"schema_version":"1","kind":"review-mesh.result-page","result_id":request["result_id"],"result_kind":"reviewer","result_schema_version":"4","page_index":page_index,"page_count":page_count,"page_kind":page_kind,"previous_page_digest":request["previous_page_digest"],"payload":payload}
    print(json.dumps({"type":"result_page","page":json.dumps(page,separators=(",",":"))}),flush=True)
    if page_index+1==page_count: break
`,
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
  it("executes the exact Windows and Linux v9 binaries with the full artifact contract", async () => {
    const runners = await Promise.all([windowsRunner(), linuxRunner()]);
    expect(runners.every((runner) => runner !== undefined)).toBe(true);

    for (const runner of runners as PlatformRunner[]) {
      const fixture = await runner.createFixture();
      expect(Buffer.byteLength(expectedReview, "utf8"), runner.name).toBe(
        256 * 1_024,
      );
      const version = await runner.run(fixture, ["--version"]);
      expect(version, runner.name).toEqual({
        exitCode: 0,
        stdout: "review-mesh 9.1.0\n",
        stderr: "",
      });

      const review = await runner.run(
        fixture,
        ["review", "--output-mode", "full-jsonl"],
        request(fixture.workspace),
      );
      expect(review.exitCode, runner.name).toBe(0);
      expect(review.stderr, runner.name).toBe("");
      const events = parsedEvents(review.stdout);
      const fullResults = events
        .filter(
          (event): event is { run_id: string; data: Record<string, unknown> } =>
            event.event === "reviewer.result",
        )
        .sort((left, right) =>
          String((left as Record<string, unknown>).reviewer_id).localeCompare(
            String((right as Record<string, unknown>).reviewer_id),
          ),
        );
      const full = fullResults[0];
      if (full === undefined) throw new Error(`${runner.name} omitted results`);
      const completed = events.at(-1) as {
        run_id: string;
        data: Record<string, unknown>;
      };
      const acceptedResult = full.data.result as Record<string, unknown>;
      const expectedDigest = digest(acceptedResult);
      const expectedBytes = Buffer.byteLength(
        JSON.stringify(acceptedResult),
        "utf8",
      );
      expect(fullResults, runner.name).toHaveLength(2);
      expect(expectedDigest).toMatch(/^[a-f0-9]{64}$/u);
      expect(full, runner.name).toMatchObject({
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
      expect(fullResults[1], runner.name).toMatchObject({
        run_id: completed.run_id,
        data: {
          result: {
            ...secondResult,
            change_coverage: { status: "not_applicable" },
          },
        },
      });
      expect(completed, runner.name).toMatchObject({
        event: "run.completed",
        data: {
          run_outcome: "clear",
          gate_outcome: "no_gate_findings",
          coverage_outcome: "complete",
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
      expect(completed.data.artifact, runner.name).toMatchObject({
        completed_results: 2,
      });
      for (const event of fullResults)
        expect(event.data, runner.name).not.toHaveProperty("artifact_path");

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
          {
            complete_result: {
              ...expectedResult,
              change_coverage: { status: "not_applicable" },
            },
            result_digest: expectedDigest,
          },
          {
            complete_result: {
              ...secondResult,
              change_coverage: { status: "not_applicable" },
            },
          },
        ],
      });
      expect(JSON.parse(report.stdout), runner.name).toMatchObject({
        run_id: completed.run_id,
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
      });
      expect(JSON.parse(findings.stdout), runner.name).toMatchObject({
        run_id: completed.run_id,
        findings: [
          expect.objectContaining({
            id: "standalone-shared-root",
            subfindings: expect.any(Array),
          }),
        ],
      });
    }
  }, 120_000);
});
