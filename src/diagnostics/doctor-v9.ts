import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { AdapterRegistry } from "../adapters/registry.js";
import type { ReviewAdapter } from "../adapters/types.js";
import type { AdapterFailure } from "../adapters/errors.js";
import type { ResolvedConfig, ResolvedReviewer } from "../config/schemas.js";
import type { ResolvedContext } from "../context/resolve.js";
import { getAppPaths } from "../config/paths.js";
import { createRunArtifact } from "./run-artifact.js";
import { indexRunArtifact, observePublicStream } from "./run-index.js";
import { createV9EventWriter } from "../protocol/v9-event-writer.js";
import { runV9Review } from "../orchestrator/run-v9.js";

export async function runDoctorV9(
  adapter: ReviewAdapter,
  reviewer: ResolvedReviewer,
  signal: AbortSignal,
  config: ResolvedConfig,
  runsDirectory = getAppPaths().runsDirectory,
) {
  const directory = await mkdtemp(join(tmpdir(), "review-mesh-doctor-v9-"));
  const workspace = join(directory, "workspace");
  await mkdir(workspace);
  const path = "review-mesh-doctor.txt";
  await writeFile(
    join(workspace, path),
    "Review Mesh doctor. Read this file with the provided tool before returning a pass.\n",
  );
  const runId = `doctor-${randomUUID()}`;
  const paths = { runsDirectory };
  const context: ResolvedContext = {
    consistency_mode: "live_worktree",
    workspace,
    project_name: "review-mesh-doctor",
    instructions:
      "Read review-mesh-doctor.txt with the provided read tool, then produce the required result pages.",
    request: { schema_version: "3" },
    review_scope: { mode: "changes", source: "request" },
    git: {
      is_repository: true,
      root: workspace,
      branch: "synthetic",
      head: "synthetic",
      merge_base: null,
      status_entries: [],
      changed_files: [path],
      changed_paths: [{ path, kind: "untracked" }],
      diff: "",
      diff_stat: "",
      raw_diff: {
        byte_count: 0,
        sha256: createHash("sha256").update("").digest("hex"),
      },
      shallow: false,
      truncated: {
        changed_files: false,
        diff: false,
        diff_stat: false,
        status_entries: false,
      },
    },
  };
  const proof =
    reviewer.policy?.changeCoverage?.proof ??
    (reviewer.adapter.type === "command" || reviewer.adapter.type === "codex"
      ? "attested"
      : "observed");
  const syntheticReviewer: ResolvedReviewer = {
    ...reviewer,
    id: "doctor",
    agentId: "doctor",
    modelIndex: 0,
    modelCount: 1,
    policy: {
      applicability: { mode: "always" },
      kind: "generic",
      requiredInput: [],
      passQuorum: 1,
      minimumProviderGroups: 1,
      adjudication: "off",
      gateMinimumSeverity: "medium",
      gateMinimumConfidence: "medium",
      changeCoverage: {
        relevantPaths: ["**"],
        minimumInspection: "full_file",
        proof,
      },
    },
  };
  const syntheticConfig: ResolvedConfig = {
    ...config,
    reviewers: [syntheticReviewer],
    execution: {
      ...config.execution,
      max_concurrency: 1,
      heartbeat_interval_ms: Math.max(
        1000,
        config.execution.heartbeat_interval_ms,
      ),
      deadline_mode: "fixed",
      run_deadline_ms: Math.max(60000, Math.min(600000, reviewer.timeoutMs)),
      no_progress_timeout_ms: config.execution.no_progress_timeout_ms ?? 300000,
    },
  };
  let lastFailure: AdapterFailure | undefined;
  let capabilities: Awaited<ReturnType<ReviewAdapter["probe"]>> | undefined;
  const registry = new AdapterRegistry();
  registry.register(reviewer.adapter.type, () => ({
    id: adapter.id,
    async probe(candidate, signal) {
      capabilities = await adapter.probe(candidate, signal);
      return capabilities;
    },
    async *run(input) {
      for await (const event of adapter.run(input)) {
        if (event.type === "failure") lastFailure = event.failure;
        yield event;
      }
    },
    ...(adapter.forceCleanup
      ? { forceCleanup: () => adapter.forceCleanup!() }
      : {}),
  }));
  const output = new PassThrough();
  output.resume();
  const artifact = await createRunArtifact({
    path: join(paths.runsDirectory, `${runId}.jsonl`),
    runId,
    toolVersion: "9.0.0",
  });
  const writer = createV9EventWriter({
    output,
    runId,
    shutdownGraceMs: config.execution.shutdown_grace_period_ms,
    recordEvent: (event) => artifact.record(event),
    finalize: async (summary) => {
      const ref = await artifact.finalize(summary);
      await indexRunArtifact({
        runsDirectory: paths.runsDirectory,
        runId,
        artifact: ref,
      });
      return ref;
    },
    observe: (outcome) =>
      observePublicStream({
        runsDirectory: paths.runsDirectory,
        runId,
        outcome,
      }),
  });
  try {
    const completion = await runV9Review({
      runId,
      config: syntheticConfig,
      context,
      registry,
      signal,
      writer,
      record: (record) => artifact.record(record),
      recordResult: (id, result) => artifact.result(id, result),
      outputMode: "concise-jsonl",
    });
    const job = completion.jobs[0];
    const covered =
      job?.result?.schema_version === "4" &&
      job.result.change_coverage.status === "complete";
    const failureStage = lastFailure?.diagnostics?.failure_stage;
    const checks: Array<{
      name: string;
      passed: boolean;
      required?: boolean;
      message?: string;
      failure?: AdapterFailure;
    }> = [
      { name: "authentication", passed: capabilities?.authenticated === true },
      { name: "model", passed: capabilities?.model_available === true },
      {
        name: "progress_observability",
        passed: job?.progressObservable === true,
        required: false,
      },
      {
        name: "streaming_negotiation",
        passed: !failureStage?.includes("stream") && job?.result !== undefined,
      },
      { name: "changed_file_access", passed: covered },
      { name: "result_page_assembly", passed: job?.result !== undefined },
      { name: "coverage_reconciliation", passed: covered },
      { name: "schema_validation", passed: job?.result !== undefined },
    ];
    if (lastFailure) {
      const stage =
        lastFailure.reason === "read_failure" ||
        failureStage?.includes("tool") ||
        failureStage?.includes("read")
          ? "changed_file_access"
          : failureStage?.includes("stream")
            ? "streaming_negotiation"
            : lastFailure.reason === "invalid_result"
              ? "schema_validation"
              : "result_page_assembly";
      const check = checks.find((check) => check.name === stage)!;
      check.passed = false;
      check.message = lastFailure.message;
      check.failure = lastFailure;
    }
    return {
      ready: completion.exitCode === 0,
      checks,
      run_id: runId,
      artifact: join(paths.runsDirectory, `${runId}.jsonl`),
      ...(job?.reason ? { failure: { reason: job.reason } } : {}),
    };
  } finally {
    await writer.close();
    await artifact.close();
    await rm(directory, { recursive: true, force: true });
  }
}
