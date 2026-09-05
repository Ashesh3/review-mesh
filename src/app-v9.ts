import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, unlink, type FileHandle } from "node:fs/promises";
import { join, resolve } from "node:path";
import { loadConfigFiles } from "./config/load.js";
import { resolveConfig } from "./config/resolve.js";
import { getAppPaths } from "./config/paths.js";
import { resolveContext, ReviewScopeError } from "./context/resolve.js";
import { createGitRunner } from "./context/git.js";
import { reviewRequestV2Schema } from "./protocol/schemas.js";
import { reviewRequestV3Schema } from "./protocol/v9.js";
import { createV9EventWriter } from "./protocol/v9-event-writer.js";
import {
  createManagedRunArtifact,
  copyVerifiedArtifact,
} from "./diagnostics/run-artifact.js";
import {
  indexRunArtifact,
  observePublicStream,
  createSafeArtifactParent,
  safeArtifactParent,
  verifyArtifactFile,
  RunArtifactError,
  type ArtifactReference,
} from "./diagnostics/run-index.js";
import { runV9Review } from "./orchestrator/run-v9.js";
import { createDefaultRegistry, type ReviewApplicationOptions } from "./app.js";
import { sanitizePublicText } from "./adapters/errors.js";
import { prepareV9Retry, V9RetryError } from "./diagnostics/retry-v9.js";
import { reviewMeshVersion } from "./discovery/help.js";
import { createRunControl } from "./diagnostics/run-control.js";

export async function runV9Application(
  options: ReviewApplicationOptions,
): Promise<number> {
  const diagnostic = (error: string, message: string, details = {}) => {
    options.stderr.write(
      JSON.stringify({
        schema_version: "1",
        kind: "review-mesh.diagnostic",
        error,
        message: sanitizePublicText(message) ?? "Review failed.",
        retryable: false,
        ...details,
      }) + "\n",
    );
  };
  let request;
  try {
    request = reviewRequestV3Schema
      .or(reviewRequestV2Schema)
      .parse(JSON.parse(options.requestText));
  } catch {
    diagnostic(
      "invalid_request",
      "Stdin must contain a valid Review Mesh request.",
    );
    return 2;
  }
  if (
    request.request_id &&
    Buffer.byteLength(request.request_id, "utf8") > 128
  ) {
    diagnostic(
      "invalid_request",
      "Request ID exceeds the 128-byte public protocol limit.",
    );
    return 2;
  }
  const preflight = new AbortController();
  const onAbort = () => preflight.abort(options.signal.reason);
  if (options.signal.aborted) preflight.abort(options.signal.reason);
  else options.signal.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(
    () => preflight.abort(new Error("Preflight deadline exceeded")),
    60_000,
  );
  let config, context;
  try {
    const loaded = await loadConfigFiles({
      workspace: request.workspace,
      ...(options.configFile === undefined
        ? {}
        : { configFile: options.configFile }),
      signal: preflight.signal,
    });
    if (
      request.project_name.toLocaleLowerCase("en-US") !==
      loaded.projectName.toLocaleLowerCase("en-US")
    )
      throw new Error("Requested project name does not match the workspace.");
    config = resolveConfig({
      trusted: loaded.trusted,
      workspace: loaded.workspace,
      projectName: loaded.projectName,
      projectNameSource: loaded.projectNameSource,
      sourceSchemaVersion: loaded.sourceSchemaVersion,
      migrated: loaded.migrated,
      migrationWarnings: loaded.migrationWarnings,
    });
    context = await resolveContext({
      request: { ...request, workspace: loaded.workspace },
      git: createGitRunner(),
      signal: preflight.signal,
    });
  } catch (error) {
    diagnostic(
      error instanceof ReviewScopeError ? error.code : "invalid_request",
      error instanceof Error
        ? error.message
        : "Configuration or workspace preflight failed.",
      error instanceof ReviewScopeError
        ? { subtype: error.subtype, details: error.diagnostics }
        : {},
    );
    return options.signal.aborted ? 4 : 2;
  } finally {
    clearTimeout(timer);
    options.signal.removeEventListener("abort", onAbort);
  }
  if (options.signal.aborted) return 4;
  const outputMode = options.outputMode ?? "concise-jsonl";
  if (!config.diagnostics.persist_runs && !options.detailsFile) {
    diagnostic(
      "details_file_required",
      "A details file is required when managed run persistence is disabled.",
    );
    return 3;
  }
  const paths = options.appPaths ?? getAppPaths();
  let retry: Awaited<ReturnType<typeof prepareV9Retry>> | undefined;
  if (options.parentRunId !== undefined) {
    try {
      retry = await prepareV9Retry({
        runsDirectory: paths.runsDirectory,
        parentRunId: options.parentRunId,
        selectedLensIds: options.onlyLensIds ?? [],
        config,
        context,
      });
    } catch (error) {
      diagnostic(
        error instanceof V9RetryError ? error.code : "invalid_request",
        error instanceof Error ? error.message : "Retry preflight failed.",
      );
      return 2;
    }
  }
  const runId = (options.runIdFactory ?? (() => `run_${randomUUID()}`))();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(runId)) {
    diagnostic("invalid_request", "Run ID is invalid.");
    return 2;
  }
  await createSafeArtifactParent(join(paths.runsDirectory, ".index-marker"));
  let detailsHandle: FileHandle | undefined;
  let detailsIdentity: { dev: bigint; ino: bigint } | undefined;
  if (options.detailsFile) {
    try {
      await safeArtifactParent(resolve(options.detailsFile));
      detailsHandle = await open(
        options.detailsFile,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          (constants.O_NOFOLLOW ?? 0),
        0o600,
      );
      detailsIdentity = await detailsHandle.stat({ bigint: true });
    } catch {
      diagnostic(
        "details_file_unavailable",
        "Details file must be a new writable regular file.",
      );
      return 2;
    }
  }
  let artifact: Awaited<ReturnType<typeof createManagedRunArtifact>>;
  let externalPublished = false;
  try {
    artifact = await createManagedRunArtifact({
      runsDirectory: paths.runsDirectory,
      runId,
      toolVersion: reviewMeshVersion,
      publishManaged: config.diagnostics.persist_runs,
    });
  } catch {
    await detailsHandle?.close();
    diagnostic(
      "persistence_failed",
      "The immutable artifact could not be initialized.",
    );
    return 3;
  }
  const writer = createV9EventWriter({
    output: options.stdout,
    runId,
    ...(request.request_id === undefined
      ? {}
      : { requestId: request.request_id }),
    shutdownGraceMs: config.execution.shutdown_grace_period_ms,
    recordEvent: (event) => artifact.record(event),
    finalize: async (summary) => {
      let stage = "artifact_finalization";
      try {
        const stagingReference = await artifact.finalize(summary);
        let reference = stagingReference;
        const alternatives: ArtifactReference[] =
          config.diagnostics.persist_runs && artifact.recoveryReference
            ? [artifact.recoveryReference]
            : [];
        if (detailsHandle) {
          stage = "artifact_details_publication";
          const target = await lstat(options.detailsFile!, { bigint: true });
          if (
            !target.isFile() ||
            target.isSymbolicLink() ||
            target.dev !== detailsIdentity?.dev ||
            target.ino !== detailsIdentity.ino
          )
            throw new Error("Details file identity changed.");
          await copyVerifiedArtifact(
            artifact.recoveryReference ?? stagingReference,
            detailsHandle,
          );
          await detailsHandle.close();
          detailsHandle = undefined;
          const copy = await verifyArtifactFile(
            resolve(options.detailsFile!),
            detailsIdentity === undefined
              ? undefined
              : {
                  dev: String(detailsIdentity.dev),
                  ino: String(detailsIdentity.ino),
                },
          );
          if (
            copy.byte_count !== stagingReference.byte_count ||
            copy.sha256 !== stagingReference.sha256
          )
            throw new Error("Details file verification failed.");
          if (!config.diagnostics.persist_runs) {
            reference = {
              ...stagingReference,
              path: resolve(options.detailsFile!),
            };
            externalPublished = true;
          } else
            alternatives.push({
              ...stagingReference,
              path: resolve(options.detailsFile!),
            });
        }
        stage = "artifact_index_publication";
        await indexRunArtifact({
          runsDirectory: paths.runsDirectory,
          runId,
          artifact: reference,
          alternatives,
          ownership: config.diagnostics.persist_runs ? "managed" : "caller",
        });
        await artifact.persisted();
        return reference;
      } catch (error) {
        throw new RunArtifactError(
          error instanceof RunArtifactError
            ? error.code
            : "artifact_unavailable",
          error instanceof Error
            ? error.message
            : "Artifact publication failed.",
          {
            cause: error,
            diagnosticDetails: {
              ...(error instanceof RunArtifactError
                ? error.diagnosticDetails
                : {}),
              stage:
                stage === "artifact_finalization" &&
                error instanceof RunArtifactError &&
                error.diagnosticDetails.stage
                  ? error.diagnosticDetails.stage
                  : stage,
              run_id: runId,
              ...(artifact.recoveryReference
                ? {
                    recovery_artifact: artifact.recoveryReference,
                    recovery_command: `review-mesh recover ${runId} --artifact ${JSON.stringify(artifact.recoveryReference.path)}`,
                  }
                : {}),
            },
          },
        );
      }
    },
    observe: (outcome) =>
      observePublicStream({
        runsDirectory: paths.runsDirectory,
        runId,
        outcome,
      }),
  });
  const controlAbort = new AbortController();
  const abortRun = () => controlAbort.abort(options.signal.reason);
  options.signal.addEventListener("abort", abortRun, { once: true });
  if (options.signal.aborted) abortRun();
  let control: Awaited<ReturnType<typeof createRunControl>> | undefined;
  try {
    control = await createRunControl(paths.runsDirectory, runId, controlAbort);
    const result = await runV9Review({
      runId,
      config,
      context,
      registry: options.adapterRegistry ?? createDefaultRegistry(),
      signal: controlAbort.signal,
      writer,
      record: (record) => artifact.record(record),
      recordResult: (id, result) => artifact.result(id, result),
      outputMode,
      ...(retry === undefined ? {} : { retry }),
    });
    return result.exitCode;
  } catch (error) {
    diagnostic(
      "review_failed",
      error instanceof Error ? error.message : "The review failed.",
      error instanceof RunArtifactError
        ? { details: error.diagnosticDetails }
        : {},
    );
    return options.signal.aborted ? 4 : 3;
  } finally {
    options.signal.removeEventListener("abort", abortRun);
    await control?.close();
    await writer.close().catch(() => undefined);
    await artifact.close().catch(() => undefined);
    await detailsHandle?.close();
    if (
      !config.diagnostics.persist_runs &&
      !externalPublished &&
      detailsIdentity !== undefined &&
      options.detailsFile
    ) {
      const target = await lstat(options.detailsFile, { bigint: true }).catch(
        () => undefined,
      );
      if (
        target?.isFile() &&
        !target.isSymbolicLink() &&
        target.dev === detailsIdentity.dev &&
        target.ino === detailsIdentity.ino &&
        target.size === 0n
      )
        await unlink(options.detailsFile).catch(() => undefined);
    }
  }
}
