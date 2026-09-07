import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, expect, it } from "vitest";
import { runReviewApplication } from "../../src/app.js";
import { AdapterRegistry } from "../../src/adapters/registry.js";
import { readRunReport } from "../../src/diagnostics/run-report.js";
import { loadV9Run } from "../../src/diagnostics/v9-views.js";
import type { AdapterReviewInput } from "../../src/adapters/types.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

async function review(fail = false) {
  const root = await mkdtemp(join(tmpdir(), "mesh-native-"));
  roots.push(root);
  const workspace = join(root, "project");
  await mkdir(workspace);
  await writeFile(join(workspace, "source.ts"), "export const answer = 42;\n");
  const configFile = join(root, "config.toml");
  await writeFile(
    configFile,
    `schema_version = "7"
[execution]
max_concurrency = 1
heartbeat_interval_ms = 1000
shutdown_grace_period_ms = 1000
deadline_mode = "adaptive"
no_progress_timeout_ms = 10000
retry_attempts = 3
[diagnostics]
persist_runs = true
max_runs = 10
[adapters.native]
type = "sdk"
[agents.review]
adapter = "native"
model = "gpt-5.6"
purpose = "Review"
instructions = "Review"
isolation = "prefer_enforced"
timeout_ms = 10000
kind = "generic"
required_input = []
adjudication = "off"
[agents.review.applicability]
mode = "always"
[agents.review.change_coverage]
relevant_paths = ["**"]
minimum_inspection = "full_file"
proof = "native_attested"
[defaults]
agents = ["review"]
`,
  );
  const received: AdapterReviewInput[] = [];
  const registry = new AdapterRegistry();
  registry.register("codex", () => ({
    id: "codex",
    async probe() {
      return {
        available: true,
        authenticated: true,
        model_available: true,
        streaming: true,
        cancellation: true,
        maximumIsolation: "runtime_read_only" as const,
        sdk_version: "0.3.251",
        runtime_version: "2.1.251",
        observed_file_access: false,
        progress_observable: false,
      };
    },
    async *run(input) {
      received.push(input);
      if (fail) {
        yield {
          type: "failure" as const,
          failure: {
            reason: "provider_timeout" as const,
            message: "Temporary provider outage",
            retryable: true,
          },
        };
        return;
      }
      yield {
        type: "result" as const,
        isolation: "runtime_read_only" as const,
        result: {
          schema_version: "4" as const,
          verdict: "pass" as const,
          review_markdown: "Complete native review",
          summary: "No defects",
          actionable_findings: [],
          informational_notes: [],
          native_scope_attestation: {
            complete: true,
            reviewed_paths: ["source.ts"],
            limitations: [],
          },
        },
      };
    },
  }));
  const stdout = new PassThrough(),
    stderr = new PassThrough();
  let output = "",
    errors = "";
  stdout.on("data", (c) => {
    output += c;
  });
  stderr.on("data", (c) => {
    errors += c;
  });
  const runsDirectory = join(root, "runs");
  const code = await runReviewApplication({
    requestText: JSON.stringify({
      schema_version: "3",
      project_name: "project",
      workspace,
      instructions: "Review",
      review_scope: { mode: "full" },
    }),
    configFile,
    appPaths: {
      configFile,
      reviewersDirectory: join(root, "reviewers"),
      runsDirectory,
    },
    stdout,
    stderr,
    signal: new AbortController().signal,
    adapterRegistry: registry,
    runIdFactory: () => "run-native",
  });
  return {
    code,
    received,
    errors,
    events: output
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l)),
    runsDirectory,
  };
}

it("executes the routed SDK through the public application without snapshot/page conversations and preserves the report", async () => {
  const r = await review();
  expect(r.errors).toBe("");
  expect(r.code).toBe(0);
  expect(r.received).toHaveLength(1);
  expect(r.received[0]!.coverage).toBeUndefined();
  expect(r.received[0]!.resultPages).toBeUndefined();
  expect(r.received[0]!.reviewer.adapter.type).toBe("codex");
  expect(
    r.events.find((event) => event.event === "reviewer.started")?.data.proof,
  ).toBe("unknown");
  expect(r.events.at(-1)).toMatchObject({
    event: "run.completed",
    data: { run_outcome: "clear" },
  });
  const report = await readRunReport({
    runsDirectory: r.runsDirectory,
    runId: "run-native",
  });
  expect(JSON.stringify(report)).toContain("Complete native review");
  const normalized = await loadV9Run(r.runsDirectory, "run-native");
  expect(
    normalized?.records.find(
      (record) => record.record === "reviewer.native_execution",
    )?.data,
  ).toMatchObject({ sdk_version: "0.3.251", runtime_version: "2.1.251" });
});

it("does not retry a terminal SDK provider failure in Review Mesh", async () => {
  const r = await review(true);
  expect(r.errors).toBe("");
  expect(r.code).toBe(3);
  expect(r.received).toHaveLength(1);
  expect(r.events.at(-1)).toMatchObject({
    event: "run.completed",
    data: { run_outcome: "inconclusive" },
  });
});
