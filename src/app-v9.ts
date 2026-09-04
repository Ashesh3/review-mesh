import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readFile,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { loadConfigFiles } from "./config/load.js";
import { resolveConfig } from "./config/resolve.js";
import { getAppPaths } from "./config/paths.js";
import { resolveContext, ReviewScopeError } from "./context/resolve.js";
import { createGitRunner } from "./context/git.js";
import { reviewRequestV2Schema } from "./protocol/schemas.js";
import { reviewRequestV3Schema } from "./protocol/v9.js";
import { createV9EventWriter } from "./protocol/v9-event-writer.js";
import { createRunArtifact } from "./diagnostics/run-artifact.js";
import {
  indexRunArtifact,
  observePublicStream,
  createSafeArtifactParent,
  safeArtifactParent,
  verifyArtifactFile,
  type ArtifactReference,
} from "./diagnostics/run-index.js";
import { runV9Review } from "./orchestrator/run-v9.js";
import { createDefaultRegistry, type ReviewApplicationOptions } from "./app.js";
import { sanitizePublicText } from "./adapters/errors.js";

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
    if (options.onlyLensIds !== undefined)
      config.reviewers = config.reviewers.filter((reviewer) =>
        options.onlyLensIds!.includes(reviewer.agentId ?? reviewer.id),
      );
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
  const runId = (options.runIdFactory ?? (() => `run_${randomUUID()}`))();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(runId)) {
    diagnostic("invalid_request", "Run ID is invalid.");
    return 2;
  }
  await createSafeArtifactParent(join(paths.runsDirectory, ".index-marker"));
  const managedPath = join(paths.runsDirectory, `${runId}.jsonl`);
  const primaryPath = config.diagnostics.persist_runs
    ? managedPath
    : resolve(options.detailsFile!);
  let detailsHandle: FileHandle | undefined;
  let detailsIdentity: { dev: bigint; ino: bigint } | undefined;
  if (config.diagnostics.persist_runs && options.detailsFile) {
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
  let artifact: Awaited<ReturnType<typeof createRunArtifact>>;
  try {
    artifact = await createRunArtifact({
      path: primaryPath,
      runId,
      toolVersion: "9.0.0",
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
      const reference = await artifact.finalize(summary);
      if (detailsHandle) {
        const target = await lstat(options.detailsFile!, { bigint: true });
        if (
          !target.isFile() ||
          target.isSymbolicLink() ||
          target.dev !== detailsIdentity?.dev ||
          target.ino !== detailsIdentity.ino
        )
          throw new Error("Details file identity changed.");
        const bytes = await readFile(reference.path);
        await detailsHandle.writeFile(bytes);
        await detailsHandle.sync();
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
          copy.byte_count !== reference.byte_count ||
          copy.sha256 !== reference.sha256
        )
          throw new Error("Details file verification failed.");
      }
      await indexRunArtifact({
        runsDirectory: paths.runsDirectory,
        runId,
        artifact: reference,
      });
      return reference;
    },
    observe: (outcome) =>
      observePublicStream({
        runsDirectory: paths.runsDirectory,
        runId,
        outcome,
      }),
  });
  try {
    const result = await runV9Review({
      runId,
      config,
      context,
      registry: options.adapterRegistry ?? createDefaultRegistry(),
      signal: options.signal,
      writer,
      record: (record) => artifact.record(record),
      recordResult: (id, result) => artifact.result(id, result),
      outputMode,
    });
    return result.exitCode;
  } catch (error) {
    diagnostic(
      "review_failed",
      error instanceof Error ? error.message : "The review failed.",
    );
    return options.signal.aborted ? 4 : 3;
  } finally {
    await writer.close().catch(() => undefined);
    await artifact.close().catch(() => undefined);
    await detailsHandle?.close();
  }
}
