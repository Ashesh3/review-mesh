import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, expect, it } from "vitest";
import { runReviewApplication } from "../../src/app.js";
import { AdapterRegistry } from "../../src/adapters/registry.js";
import { loadV9Run } from "../../src/diagnostics/v9-views.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
type Scenario = "bounded" | "queued_cancel" | "probe_timeout" | "mixed";
async function run(scenario: Scenario) {
  const root = await mkdtemp(join(tmpdir(), "mesh-native-admission-"));
  roots.push(root);
  const workspace = join(root, "project");
  await mkdir(workspace);
  await writeFile(join(workspace, "source.ts"), "fixture\n");
  const reviewers =
    scenario === "probe_timeout" ? ["one"] : ["one", "two", "three"];
  const configFile = join(root, "config.toml");
  await writeFile(
    configFile,
    `schema_version="7"
[execution]
max_concurrency=${scenario === "bounded" ? 2 : 1}
default_provider_concurrency=1
heartbeat_interval_ms=1000
shutdown_grace_period_ms=1000
deadline_mode="adaptive"
no_progress_timeout_ms=10000
allow_provider_concentration=true
[execution.provider_limits]
shared=1
[diagnostics]
persist_runs=true
max_runs=10
[adapters.native]
type="sdk"
[adapters.legacy]
type="command"
command="never-execute"
protocol="review-mesh-command-v2"
${reviewers
  .map(
    (id, index) => `[agents.${id}]
adapter="${scenario === "mixed" && index === 0 ? "legacy" : "native"}"
model="gpt-5.6"
provider_group="${index < 2 ? "shared" : "other"}"
purpose="Review"
instructions="Review"
isolation="prefer_enforced"
timeout_ms=${scenario === "probe_timeout" ? 60 : 2000}
kind="generic"
required_input=[]
adjudication="off"
[agents.${id}.applicability]
mode="always"
[agents.${id}.change_coverage]
relevant_paths=["**"]
minimum_inspection="full_file"
proof="${scenario === "mixed" && index === 0 ? "attested" : "native_attested"}"
`,
  )
  .join("\n")}
[defaults]
agents=${JSON.stringify(reviewers)}
`,
  );
  const controller = new AbortController(),
    registry = new AdapterRegistry();
  let live = 0,
    maxLive = 0,
    probeCalls = 0,
    runCalls = 0,
    cleanup = 0,
    probeAborted = false;
  const liveByGroup = new Map<string, number>(),
    maximumByGroup = new Map<string, number>();
  registry.register("codex", () => ({
    id: "codex",
    async probe(reviewer, signal) {
      probeCalls++;
      live++;
      maxLive = Math.max(maxLive, live);
      const group = reviewer.providerGroup!;
      liveByGroup.set(group, (liveByGroup.get(group) ?? 0) + 1);
      maximumByGroup.set(
        group,
        Math.max(maximumByGroup.get(group) ?? 0, liveByGroup.get(group)!),
      );
      try {
        await new Promise<void>((resolve) => {
          const finish = () => {
            signal.removeEventListener("abort", abort);
            if (timer) clearTimeout(timer);
            resolve();
          };
          const abort = () => {
            probeAborted = true;
            finish();
          };
          const timer =
            scenario === "bounded" ? setTimeout(finish, 35) : undefined;
          signal.addEventListener("abort", abort, { once: true });
          if (signal.aborted) abort();
          if (scenario === "queued_cancel")
            setImmediate(() => controller.abort());
        });
      } finally {
        live--;
        liveByGroup.set(group, liveByGroup.get(group)! - 1);
      }
      return {
        available: true,
        authenticated: true,
        model_available: true,
        streaming: true,
        cancellation: true,
        maximumIsolation: "runtime_read_only",
        runtime_version: "fixture",
      };
    },
    async *run() {
      runCalls++;
      yield {
        type: "result",
        isolation: "runtime_read_only",
        result: {
          schema_version: "4",
          verdict: "pass",
          review_markdown: "Complete",
          summary: "Clear",
          actionable_findings: [],
          informational_notes: [],
          native_scope_attestation: {
            reviewed_paths: ["source.ts"],
            complete: true,
            limitations: [],
          },
        },
      };
    },
    async forceCleanup() {
      cleanup++;
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
  const runsDirectory = join(root, "runs"),
    guard = setTimeout(
      () => controller.abort(new Error("fixture guard")),
      1500,
    );
  const started = Date.now();
  try {
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
      signal: controller.signal,
      adapterRegistry: registry,
      runIdFactory: () => "run-admission",
    });
    return {
      code,
      errors,
      probeCalls,
      runCalls,
      cleanup,
      maxLive,
      maximumByGroup,
      probeAborted,
      elapsed: Date.now() - started,
      events: output
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
      report: await loadV9Run(runsDirectory, "run-admission"),
    };
  } finally {
    clearTimeout(guard);
  }
}

it("bounds native runtime probes by both global and provider admission limits", async () => {
  const r = await run("bounded");
  expect(r.errors).toBe("");
  expect(r.code).toBe(0);
  expect(r.probeCalls).toBe(3);
  expect(r.runCalls).toBe(3);
  expect(r.maxLive).toBeLessThanOrEqual(2);
  expect(r.maximumByGroup.get("shared")).toBe(1);
  const starts = r.events.filter((e) => e.event === "reviewer.started");
  expect(starts).toHaveLength(3);
  expect(
    starts.every(
      (e) => e.data.probe_elapsed_ms >= 25 && e.data.queue_wait_ms >= 0,
    ),
  ).toBe(true);
  expect(starts.some((e) => e.data.queue_wait_ms >= 25)).toBe(true);
});
it("never starts probes for reviewers cancelled while waiting for admission", async () => {
  const r = await run("queued_cancel");
  expect(r.code).toBe(4);
  expect(r.probeCalls).toBe(1);
  expect(r.runCalls).toBe(0);
  expect(r.cleanup).toBe(1);
  expect(r.report?.active).toBe(false);
  expect(r.report?.reviewers).toHaveLength(3);
});
it("enforces the reviewer timeout during the native runtime probe", async () => {
  const r = await run("probe_timeout");
  expect(r.errors).toBe("");
  expect(r.code).toBe(3);
  expect(r.probeAborted).toBe(true);
  expect(r.runCalls).toBe(0);
  expect(r.events).toContainEqual(
    expect.objectContaining({
      event: "reviewer.incomplete",
      data: expect.objectContaining({
        reason: "probe_deadline_exceeded",
        failure_stage: "probing",
      }),
    }),
  );
});
it("rejects a mixed command and SDK roster before starting any reviewer", async () => {
  const r = await run("mixed");
  expect(r.code).toBe(2);
  expect(r.errors).toMatch(
    /Command and native SDK reviewers cannot share the same run/,
  );
  expect(r.probeCalls).toBe(0);
  expect(r.runCalls).toBe(0);
  expect(r.events).toEqual([]);
  expect(r.report).toBeUndefined();
});
