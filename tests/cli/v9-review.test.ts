import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { runReviewApplication } from "../../src/app.js";
import { AdapterRegistry } from "../../src/adapters/registry.js";
import { readNormalizedRun } from "../../src/diagnostics/normalize-run.js";
import { resolveRunArtifact } from "../../src/diagnostics/run-index.js";
import {
  readRunReport,
  readRunFindings,
} from "../../src/diagnostics/run-report.js";
import { readRunStatus } from "../../src/diagnostics/run-status.js";
import { readDashboardRun } from "../../src/server/dashboard-data.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
describe("current v9 application", () => {
  it("emits concise v6 output and strictly retrieves the indexed exact result", async () => {
    const root = await mkdtemp(join(tmpdir(), "review-mesh-v9-app-"));
    roots.push(root);
    const workspace = join(root, "project");
    await mkdir(workspace);
    await writeFile(join(workspace, "source.txt"), "source\n");
    const configFile = join(root, "config.toml");
    await writeFile(
      configFile,
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
[adapters.test]
type = "command"
command = "fixture"
protocol = "review-mesh-command-v2"
[agents.test]
adapter = "test"
model = "fixture"
purpose = "Review"
instructions = "Review"
isolation = "prefer_enforced"
timeout_ms = 10000
kind = "generic"
required_input = []
adjudication = "off"
[agents.test.applicability]
mode = "always"
[agents.test.change_coverage]
relevant_paths = ["**"]
minimum_inspection = "full_file"
proof = "attested"
[defaults]
agents = ["test"]
`,
    );
    const registry = new AdapterRegistry();
    registry.register("command", () => ({
      id: "test",
      async probe() {
        return {
          available: true,
          authenticated: true,
          model_available: true,
          streaming: false,
          cancellation: true,
          maximumIsolation: "runtime_read_only",
          observed_file_access: false,
          progress_observable: false,
        };
      },
      async *run() {
        yield {
          type: "result" as const,
          isolation: "runtime_read_only" as const,
          result: {
            schema_version: "4" as const,
            verdict: "pass" as const,
            review_markdown: "Exact full review",
            summary: "Complete",
            actionable_findings: [],
            informational_notes: [],
          },
        };
      },
    }));
    const stdout = new PassThrough(),
      stderr = new PassThrough();
    let text = "",
      error = "";
    stdout.on("data", (chunk) => {
      text += chunk.toString();
    });
    stderr.on("data", (chunk) => {
      error += chunk.toString();
    });
    const paths = {
      configFile,
      reviewersDirectory: join(root, "reviewers"),
      runsDirectory: join(root, "runs"),
    };
    const code = await runReviewApplication({
      requestText: JSON.stringify({
        schema_version: "3",
        project_name: basename(workspace),
        workspace,
        instructions: "Review",
        review_scope: { mode: "full" },
      }),
      configFile,
      appPaths: paths,
      stdout,
      stderr,
      signal: new AbortController().signal,
      adapterRegistry: registry,
      runIdFactory: () => "run-test",
    });
    expect(error).toBe("");
    expect(code).toBe(0);
    const events = text
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(events.at(-1)).toMatchObject({
      schema_version: "6",
      event: "run.completed",
      data: { run_outcome: "clear", gate_outcome: "no_gate_findings" },
    });
    expect(events.some((event) => event.event === "reviewer.result")).toBe(
      false,
    );
    const artifact = await resolveRunArtifact("run-test", {
      runsDirectory: paths.runsDirectory,
    });
    const normalized = await readNormalizedRun(artifact.artifact.path, {
      expectedSha256: artifact.artifact.sha256,
      expectedIdentity: artifact.expected_identity,
    });
    expect(normalized.reviewers[0]?.result?.review_markdown).toBe(
      "Exact full review",
    );
    const report = await readRunReport({
      runsDirectory: paths.runsDirectory,
      runId: "run-test",
    });
    const status = await readRunStatus({
      runsDirectory: paths.runsDirectory,
      runId: "run-test",
    });
    const dashboard = await readDashboardRun({
      appPaths: paths,
      runId: "run-test",
    });
    const findings = await readRunFindings({
      runsDirectory: paths.runsDirectory,
      runId: "run-test",
    });
    expect(report.schema_version).toBe("2");
    expect(status.schema_version).toBe("3");
    expect(dashboard.schema_version).toBe("2");
    expect(report.finding_counts).toEqual(
      (status.canonical as typeof normalized.canonical).counts,
    );
    expect((dashboard.canonical as typeof normalized.canonical).counts).toEqual(
      normalized.canonical.counts,
    );
    expect(findings.raw).toEqual([]);
  });
});
