import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { AdapterRegistry } from "../adapters/registry.js";
import type { ReviewAdapter } from "../adapters/types.js";
import type { AdapterFailure } from "../adapters/errors.js";
import type { ResolvedConfig, ResolvedReviewer } from "../config/schemas.js";
import { resolveContext } from "../context/resolve.js";
import { createGitRunner } from "../context/git.js";
import { getAppPaths } from "../config/paths.js";
import { createRunArtifact, readRunArtifact } from "./run-artifact.js";
import { indexRunArtifact, observePublicStream } from "./run-index.js";
import { createV9EventWriter } from "../protocol/v9-event-writer.js";
import { runV9Review } from "../orchestrator/run-v9.js";
import { reviewMeshVersion } from "../discovery/help.js";
import { prepareV9Retry } from "./retry-v9.js";

export async function runDoctorV9(
  adapter: ReviewAdapter,
  reviewer: ResolvedReviewer,
  signal: AbortSignal,
  config: ResolvedConfig,
  runsDirectory = getAppPaths().runsDirectory,
) {
  const directory = await mkdtemp(join(tmpdir(), "review-mesh-doctor-v9-"));
  let artifact: Awaited<ReturnType<typeof createRunArtifact>> | undefined;
  let writer: ReturnType<typeof createV9EventWriter> | undefined;
  try {
    const workspace = join(directory, "workspace");
    await mkdir(workspace);
    const path = "review-mesh-doctor.txt";
    const git = createGitRunner();
    const gitCommand = async (args: string[]) => {
      const result = await git.run(args, { cwd: workspace, signal });
      if (result.exitCode !== 0)
        throw new Error("Doctor could not prepare its changed Git fixture.");
    };
    await gitCommand(["init", "--initial-branch=main"]);
    await writeFile(join(workspace, path), "Review Mesh doctor baseline.\n");
    await gitCommand(["add", "--", path]);
    await gitCommand([
      "-c",
      "user.name=Review Mesh Doctor",
      "-c",
      "user.email=doctor@localhost",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-m",
      "Doctor baseline",
    ]);
    await writeFile(
      join(workspace, path),
      "Review Mesh doctor. Read this changed file with the provided tool before returning a pass.\n",
    );
    const runId = `doctor-${randomUUID()}`;
    const paths = { runsDirectory };
    const context = await resolveContext({
      request: {
        schema_version: "3",
        workspace,
        project_name: "review-mesh-doctor",
        instructions:
          "Read review-mesh-doctor.txt with the provided read tool, inspect the supplied Git diff, then produce the required result pages.",
        review_scope: { mode: "changes", base: "HEAD" },
      },
      git,
      signal,
    });
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
        no_progress_timeout_ms:
          config.execution.no_progress_timeout_ms ?? 300000,
      },
    };
    let lastFailure: AdapterFailure | undefined;
    let responseObserved = false;
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
          else if (event.type === "result") lastFailure = undefined;
          if (
            event.type === "progress" &&
            (event.phase === "response" || (event.byteCount ?? 0) > 0)
          )
            responseObserved = true;
          yield event;
        }
      },
      ...(adapter.forceCleanup
        ? { forceCleanup: () => adapter.forceCleanup!() }
        : {}),
    }));
    const output = new PassThrough();
    output.resume();
    const openedArtifact = await createRunArtifact({
      path: join(paths.runsDirectory, `${runId}.jsonl`),
      runId,
      toolVersion: reviewMeshVersion,
    });
    artifact = openedArtifact;
    writer = createV9EventWriter({
      output,
      runId,
      shutdownGraceMs: config.execution.shutdown_grace_period_ms,
      recordEvent: (event) => openedArtifact.record(event),
      finalize: async (summary) => {
        const ref = await openedArtifact.finalize(summary);
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
    const completion = await runV9Review({
      runId,
      config: syntheticConfig,
      context,
      registry,
      signal,
      writer,
      record: (record) => openedArtifact.record(record),
      recordResult: (id, result) => openedArtifact.result(id, result),
      outputMode: "concise-jsonl",
    });
    const job = completion.jobs[0];
    const failureStage = lastFailure?.diagnostics?.failure_stage;
    // Reading validates the durable page chain, digest, and assembled result
    // against the recorded reviewer output; a whole-result adapter bypass is
    // insufficient evidence that its paged output path works.
    const persisted = await readRunArtifact(openedArtifact.path);
    const coverageEntries = persisted.records
      .flatMap((record) => {
        if (
          record.record !== "reviewer.coverage" ||
          record.reviewer_id !== "doctor"
        )
          return [];
        const entries = (record.data as { entries?: unknown[] }).entries;
        return (entries ?? []).filter(
          (entry): entry is Record<string, unknown> =>
            typeof entry === "object" &&
            entry !== null &&
            !Array.isArray(entry),
        );
      })
      .filter((entry) => entry.relevant === true);
    const changedAccess =
      coverageEntries.length > 0 &&
      coverageEntries.every((entry) => entry.snapshot_read === "satisfied");
    const diffDelivered =
      coverageEntries.length > 0 &&
      coverageEntries.every((entry) => entry.diff_delivery === "satisfied") &&
      context.git.is_repository &&
      (context.git.raw_diff?.byte_count ?? 0) > 0;
    const covered =
      coverageEntries.length > 0 &&
      coverageEntries.every((entry) => entry.disposition === "satisfied");
    const streamingNegotiated =
      !failureStage?.includes("stream") &&
      (responseObserved ||
        job?.result !== undefined ||
        (capabilities?.streaming === true && changedAccess));
    const pagesVerified =
      job?.result !== undefined &&
      persisted.records.some(
        (record) =>
          record.record === "reviewer.result_page" &&
          record.reviewer_id === "doctor",
      );
    let retryVerified = false;
    if (completion.exitCode === 0) {
      const retry = await prepareV9Retry({
        runsDirectory,
        parentRunId: runId,
        selectedLensIds: ["doctor"],
        config: syntheticConfig,
        context,
      });
      retryVerified =
        retry.inheritance === "exact" && retry.inherited.length === 1;
    }
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
        passed: streamingNegotiated,
      },
      { name: "changed_file_access", passed: changedAccess },
      { name: "result_page_assembly", passed: pagesVerified },
      { name: "coverage_reconciliation", passed: covered },
      { name: "schema_validation", passed: job?.result !== undefined },
      {
        name: "git_diff_delivery",
        passed: diffDelivered,
      },
      { name: "retry", passed: retryVerified },
      {
        name: "observed_coverage",
        passed: covered && proof === "observed",
        required: false,
      },
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
      ready:
        completion.exitCode === 0 &&
        checks.every((check) => check.required === false || check.passed),
      readiness_scope:
        proof === "observed" ? "end_to_end_observed" : "end_to_end_attested",
      proof_kind: proof,
      checks,
      run_id: runId,
      artifact: join(paths.runsDirectory, `${runId}.jsonl`),
      ...(job?.reason ? { failure: { reason: job.reason } } : {}),
    };
  } finally {
    await writer?.close().catch(() => undefined);
    await artifact?.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
}
