#!/usr/bin/env node

import { resolve } from "node:path";
import type { Readable, Writable } from "node:stream";
import { pathToFileURL } from "node:url";
import {
  ReviewRunError,
  createDefaultRegistry,
  runReviewApplication,
  type ReviewApplicationOptions,
} from "./app.js";
import type { AdapterRegistry } from "./adapters/registry.js";
import { runConfigCommand } from "./config/command.js";
import { resolveProjectName } from "./config/project-names.js";
import { getAppPaths, type AppPaths } from "./config/paths.js";
import { loadConfigFiles } from "./config/load.js";
import { resolveConfig } from "./config/resolve.js";
import { readRunStatus, RunStatusError } from "./diagnostics/run-status.js";
import {
  readRunFindings,
  readRunReport,
  readRetryRunPlan,
  renderRunReportJson,
  renderRunReportMarkdown,
  RunReportError,
} from "./diagnostics/run-report.js";
import {
  normalizeHelpTopic,
  renderHelp,
  reviewMeshVersion,
} from "./discovery/help.js";
import { describeWorkspace, renderDescription } from "./discovery/describe.js";
import { isSchemaName, renderSchema, schemaNames } from "./discovery/schema.js";

declare const REVIEW_MESH_STANDALONE: boolean | undefined;

const maximumRequestBytes = 8 * 1024 * 1024;

async function writeDiagnostic(
  error: string,
  message: string,
  output: NodeJS.WritableStream = process.stderr,
): Promise<void> {
  const line = `${JSON.stringify({
    schema_version: "1",
    kind: "review-mesh.diagnostic",
    error,
    message,
    retryable: false,
  })}\n`;
  if (output.write(line)) return;
  await new Promise<void>((resolve, reject) => {
    output.once("drain", resolve);
    output.once("error", reject);
  });
}

async function writeUsageDiagnostic(
  message: string,
  helpCommand: string,
  output: NodeJS.WritableStream,
  nextActions: readonly string[] = [
    `Run ${helpCommand}.`,
    "Run review-mesh --help for the complete command manual.",
  ],
): Promise<void> {
  const line = `${JSON.stringify({
    schema_version: "1",
    kind: "review-mesh.diagnostic",
    error: "invalid_usage",
    message,
    retryable: false,
    help_command: helpCommand,
    next_actions: nextActions,
  })}\n`;
  await writeText(output, line);
}

async function writeText(
  output: NodeJS.WritableStream,
  value: string,
): Promise<void> {
  if (output.write(value)) return;
  await new Promise<void>((resolve, reject) => {
    output.once("drain", resolve);
    output.once("error", reject);
  });
}

async function defaultRequest(
  cwd: string,
  signal: AbortSignal,
): Promise<string> {
  const project = await resolveProjectName(cwd, { signal });
  return JSON.stringify({
    schema_version: "2",
    project_name: project.name,
    workspace: cwd,
    instructions:
      "Review the current change set for actionable correctness, security, reliability, compatibility, and test-coverage defects. Report only evidence-backed findings with precise file and line references when available.",
    review_scope: { mode: "changes" },
  });
}

async function explicitReviewRequest(
  cwd: string,
  workspace: string,
  signal: AbortSignal,
): Promise<string> {
  return defaultRequest(resolve(cwd, workspace), signal);
}

class RequestReadError extends Error {
  constructor(
    readonly code: "interrupted" | "invalid_request" | "request_too_large",
  ) {
    super(code);
    this.name = "RequestReadError";
  }
}

async function readRequest(
  input: Readable = process.stdin,
  signal: AbortSignal,
): Promise<string> {
  return new Promise((resolveRequest, rejectRequest) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let settled = false;

    const cleanup = () => {
      input.removeListener("data", onData);
      input.removeListener("end", onEnd);
      input.removeListener("error", onError);
      signal.removeEventListener("abort", onAbort);
    };
    const reject = (error: RequestReadError, destroy: boolean) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (destroy) input.destroy();
      rejectRequest(error);
    };
    const onData = (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buffer.byteLength;
      if (totalBytes > maximumRequestBytes) {
        reject(new RequestReadError("request_too_large"), true);
        return;
      }
      chunks.push(buffer);
    };
    const onEnd = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolveRequest(Buffer.concat(chunks, totalBytes).toString("utf8"));
    };
    const onError = () => {
      reject(new RequestReadError("invalid_request"), false);
    };
    const onAbort = () => {
      reject(new RequestReadError("interrupted"), true);
    };

    input.on("data", onData);
    input.once("end", onEnd);
    input.once("error", onError);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    else input.resume();
  });
}

export interface SignalSource {
  once(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  removeListener(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
}

export interface CliRuntime {
  argv?: readonly string[];
  input?: Readable & { isTTY?: boolean };
  output?: Writable & { isTTY?: boolean };
  error?: Writable;
  configFile?: string;
  cwd?: string;
  adapterRegistry?: AdapterRegistry;
  appPaths?: AppPaths;
  runReview?: (options: ReviewApplicationOptions) => Promise<number>;
}

export function installAbortHandlers(
  controller: AbortController,
  source: SignalSource = process,
): () => void {
  const abort = (signal: NodeJS.Signals) => {
    if (!controller.signal.aborted) controller.abort(signal);
  };
  const onSigint = () => abort("SIGINT");
  const onSigterm = () => abort("SIGTERM");
  source.once("SIGINT", onSigint);
  source.once("SIGTERM", onSigterm);
  return () => {
    source.removeListener("SIGINT", onSigint);
    source.removeListener("SIGTERM", onSigterm);
  };
}

export async function runCli(
  signalSource: SignalSource = process,
  runtime: CliRuntime = {},
): Promise<void> {
  const controller = new AbortController();
  const removeAbortHandlers = installAbortHandlers(controller, signalSource);
  const argv = runtime.argv ?? process.argv.slice(2);
  const input = runtime.input ?? process.stdin;
  const output = runtime.output ?? process.stdout;
  const errorOutput = runtime.error ?? process.stderr;

  try {
    if (
      argv.length === 0 ||
      (argv.length === 1 &&
        (argv[0] === "--help" || argv[0] === "-h" || argv[0] === "help"))
    ) {
      await writeText(output, renderHelp());
      process.exitCode = 0;
      return;
    }
    if (
      argv.length === 1 &&
      (argv[0] === "--version" || argv[0] === "version")
    ) {
      await writeText(output, `review-mesh ${reviewMeshVersion}\n`);
      process.exitCode = 0;
      return;
    }
    if (argv[0] === "help") {
      const topic = argv.length === 2 ? normalizeHelpTopic(argv[1]) : undefined;
      if (topic === undefined) {
        await writeDiagnostic(
          "unknown_help_topic",
          `Unknown help topic: ${argv[1] ?? ""}. Available topics: review, status, config, config-file, adapters, command-adapter, describe, schema, events, exit-codes.`,
          errorOutput,
        );
        process.exitCode = 2;
        return;
      }
      await writeText(output, renderHelp(topic));
      process.exitCode = 0;
      return;
    }
    if (argv.length === 2 && (argv[1] === "--help" || argv[1] === "-h")) {
      const topic = normalizeHelpTopic(argv[0]);
      if (topic !== undefined && topic !== "overview") {
        await writeText(output, renderHelp(topic));
        process.exitCode = 0;
        return;
      }
    }
    if (argv[0] === "schema") {
      if (argv.length === 2 && argv[1] === "list") {
        await writeText(
          output,
          `${JSON.stringify({ schemas: schemaNames.map((name) => ({ name, command: `review-mesh schema ${name} --json` })) })}\n`,
        );
        process.exitCode = 0;
        return;
      }
      const argumentsWithoutJson = argv
        .slice(1)
        .filter((arg) => arg !== "--json");
      const json = argv.slice(1).includes("--json");
      const name = argumentsWithoutJson[0] ?? "request";
      if (
        argumentsWithoutJson.length > 1 ||
        argv.slice(1).some((arg) => arg.startsWith("--") && arg !== "--json") ||
        !isSchemaName(name)
      ) {
        await writeUsageDiagnostic(
          `Expected: review-mesh schema [${schemaNames.join("|")}] [--json], or review-mesh schema list`,
          "review-mesh help schema",
          errorOutput,
        );
        process.exitCode = 2;
        return;
      }
      await writeText(output, renderSchema(name, json));
      process.exitCode = 0;
      return;
    }
    if (argv[0] === "describe") {
      const argumentsWithoutJson = argv
        .slice(1)
        .filter((arg) => arg !== "--json");
      const json = argv.slice(1).includes("--json");
      if (
        argumentsWithoutJson.length > 1 ||
        argv.slice(1).some((arg) => arg.startsWith("--") && arg !== "--json")
      ) {
        await writeUsageDiagnostic(
          "Expected: review-mesh describe [WORKSPACE] [--json]",
          "review-mesh help describe",
          errorOutput,
        );
        process.exitCode = 2;
        return;
      }
      const description = await describeWorkspace({
        ...(argumentsWithoutJson[0] === undefined
          ? {}
          : { workspace: argumentsWithoutJson[0] }),
        ...(runtime.cwd === undefined ? {} : { cwd: runtime.cwd }),
        ...(runtime.configFile === undefined
          ? {}
          : { configFile: runtime.configFile }),
        signal: controller.signal,
      });
      await writeText(output, renderDescription(description, json));
      process.exitCode = 0;
      return;
    }
    if (argv[0] === "doctor") {
      const doctorUsage =
        "Expected: review-mesh doctor [WORKSPACE] [--adapter ID] [--model MODEL] [--structured-output]";
      let workspaceArgument: string | undefined;
      let adapterFilter: string | undefined;
      let modelFilter: string | undefined;
      let structuredOutput = false;
      let invalidDoctorUsage = false;
      for (let index = 1; index < argv.length; index += 1) {
        const argument = argv[index]!;
        if (argument === "--structured-output") {
          if (structuredOutput) invalidDoctorUsage = true;
          structuredOutput = true;
          continue;
        }
        if (argument === "--adapter" || argument === "--model") {
          const value = argv[index + 1];
          if (
            value === undefined ||
            value.startsWith("--") ||
            (argument === "--adapter" && adapterFilter !== undefined) ||
            (argument === "--model" && modelFilter !== undefined)
          ) {
            invalidDoctorUsage = true;
            continue;
          }
          if (argument === "--adapter") adapterFilter = value;
          else modelFilter = value;
          index += 1;
          continue;
        }
        if (argument.startsWith("--") || workspaceArgument !== undefined) {
          invalidDoctorUsage = true;
          continue;
        }
        workspaceArgument = argument;
      }
      if (invalidDoctorUsage) {
        await writeUsageDiagnostic(
          doctorUsage,
          "review-mesh help doctor",
          errorOutput,
        );
        process.exitCode = 2;
        return;
      }
      const workspace = resolve(
        runtime.cwd ?? process.cwd(),
        workspaceArgument ?? ".",
      );
      try {
        const loaded = await loadConfigFiles({
          ...(runtime.configFile === undefined
            ? {}
            : { configFile: runtime.configFile }),
          workspace,
          signal: controller.signal,
        });
        const config = resolveConfig({
          trusted: loaded.trusted,
          workspace: loaded.workspace,
          projectName: loaded.projectName,
          projectNameSource: loaded.projectNameSource,
        });
        const reviewers = config.reviewers.filter(
          (reviewer) =>
            (adapterFilter === undefined ||
              reviewer.adapterId === adapterFilter) &&
            (modelFilter === undefined || reviewer.model === modelFilter),
        );
        if (reviewers.length === 0) {
          await writeDiagnostic(
            "doctor_selection_empty",
            "No resolved reviewer matches the requested doctor adapter/model selection.",
            errorOutput,
          );
          process.exitCode = 2;
          return;
        }
        const registry = runtime.adapterRegistry ?? createDefaultRegistry();
        const results = [];
        for (const reviewer of reviewers) {
          const adapter = registry.create(reviewer.adapterId, reviewer.adapter);
          const result =
            structuredOutput && adapter.doctor !== undefined
              ? await adapter.doctor(reviewer, controller.signal)
              : (() => undefined)();
          const capabilities =
            result === undefined
              ? await adapter.probe(reviewer, controller.signal)
              : undefined;
          results.push({
            reviewer_id: reviewer.id,
            adapter: reviewer.adapterId,
            model: reviewer.model,
            provider_group: reviewer.providerGroup ?? reviewer.adapterId,
            ...(result === undefined
              ? {
                  ready: capabilities!.available,
                  checks: [
                    {
                      name: "readiness",
                      passed: capabilities!.available,
                      ...(capabilities!.message === undefined
                        ? {}
                        : { message: capabilities!.message }),
                    },
                  ],
                }
              : result),
          });
        }
        await writeText(
          output,
          `${JSON.stringify({
            schema_version: "1",
            kind: "review-mesh.doctor",
            workspace: loaded.workspace,
            ready: results.every((result) => result.ready),
            reviewers: results,
          })}\n`,
        );
        process.exitCode = results.every((result) => result.ready) ? 0 : 3;
      } catch {
        await writeDiagnostic(
          "doctor_failed",
          "Review Mesh could not complete adapter preflight.",
          errorOutput,
        );
        process.exitCode = 2;
      }
      return;
    }
    if (argv[0] === "config") {
      process.exitCode = await runConfigCommand({
        args: argv.slice(1),
        input,
        output,
        error: errorOutput,
        signal: controller.signal,
        ...(runtime.configFile === undefined
          ? {}
          : { configFile: runtime.configFile }),
        ...(runtime.cwd === undefined ? {} : { cwd: runtime.cwd }),
      });
      return;
    }
    if (argv[0] === "status") {
      const argumentsWithoutJson = argv
        .slice(1)
        .filter((argument) => argument !== "--json");
      if (
        argumentsWithoutJson.length < 1 ||
        argumentsWithoutJson.length > 2 ||
        argv
          .slice(1)
          .some(
            (argument) => argument.startsWith("--") && argument !== "--json",
          )
      ) {
        await writeUsageDiagnostic(
          "Expected: review-mesh status RUN_ID [REVIEWER_ID] [--json]",
          "review-mesh help status",
          errorOutput,
        );
        process.exitCode = 2;
        return;
      }
      try {
        const status = await readRunStatus({
          runsDirectory: (runtime.appPaths ?? getAppPaths()).runsDirectory,
          runId: argumentsWithoutJson[0]!,
          ...(argumentsWithoutJson[1] === undefined
            ? {}
            : { reviewerId: argumentsWithoutJson[1] }),
        });
        await writeText(output, `${JSON.stringify(status)}\n`);
        process.exitCode = 0;
      } catch (error) {
        await writeDiagnostic(
          error instanceof RunStatusError ? error.code : "status_failed",
          error instanceof RunStatusError
            ? error.message
            : "The persisted Review Mesh run status could not be read.",
          errorOutput,
        );
        process.exitCode = 2;
      }
      return;
    }
    if (argv[0] === "report") {
      const runId = argv[1];
      const formatIndex = argv.indexOf("--format");
      const format = formatIndex >= 0 ? argv[formatIndex + 1] : "markdown";
      if (
        runId === undefined ||
        (format !== "markdown" && format !== "json") ||
        argv.some(
          (argument, index) =>
            index > 1 && argument.startsWith("--") && argument !== "--format",
        )
      ) {
        await writeUsageDiagnostic(
          "Expected: review-mesh report RUN_ID [--format markdown|json]",
          "review-mesh help report",
          errorOutput,
        );
        process.exitCode = 2;
        return;
      }
      try {
        const report = await readRunReport({
          runsDirectory: (runtime.appPaths ?? getAppPaths()).runsDirectory,
          runId,
        });
        await writeText(
          output,
          format === "json"
            ? renderRunReportJson(report)
            : renderRunReportMarkdown(report),
        );
        process.exitCode = 0;
      } catch (error) {
        await writeDiagnostic(
          error instanceof RunReportError ? error.code : "report_failed",
          error instanceof RunReportError
            ? error.message
            : "The persisted Review Mesh report could not be read.",
          errorOutput,
        );
        process.exitCode = 2;
      }
      return;
    }
    if (argv[0] === "findings") {
      const runId = argv[1];
      const allowed = new Set(["--json", "--deduplicate"]);
      if (
        runId === undefined ||
        argv.slice(2).some((argument) => !allowed.has(argument))
      ) {
        await writeUsageDiagnostic(
          "Expected: review-mesh findings RUN_ID [--deduplicate] [--json]",
          "review-mesh help findings",
          errorOutput,
        );
        process.exitCode = 2;
        return;
      }
      try {
        const findings = await readRunFindings({
          runsDirectory: (runtime.appPaths ?? getAppPaths()).runsDirectory,
          runId,
        });
        const payload = argv.includes("--deduplicate")
          ? { run_id: findings.run_id, findings: findings.deduplicated }
          : { run_id: findings.run_id, findings: findings.raw };
        await writeText(output, `${JSON.stringify(payload)}\n`);
        process.exitCode = 0;
      } catch (error) {
        await writeDiagnostic(
          error instanceof RunReportError ? error.code : "report_failed",
          error instanceof RunReportError
            ? error.message
            : "The persisted Review Mesh findings could not be read.",
          errorOutput,
        );
        process.exitCode = 2;
      }
      return;
    }
    if (argv[0] === "retry") {
      const runId = argv[1];
      if (
        runId === undefined ||
        argv.length !== 3 ||
        argv[2] !== "--only-incomplete"
      ) {
        await writeUsageDiagnostic(
          "Expected: review-mesh retry RUN_ID --only-incomplete",
          "review-mesh help retry",
          errorOutput,
        );
        process.exitCode = 2;
        return;
      }
      try {
        const plan = await readRetryRunPlan({
          runsDirectory: (runtime.appPaths ?? getAppPaths()).runsDirectory,
          runId,
        });
        if (plan.incomplete_lenses.length === 0) {
          await writeDiagnostic(
            "nothing_to_retry",
            "The persisted run has no incomplete logical lenses.",
            errorOutput,
          );
          process.exitCode = 2;
          return;
        }
        const request = plan.request;
        const lifecycle = setInterval(() => undefined, 60_000);
        try {
          process.exitCode = await (runtime.runReview ?? runReviewApplication)({
            requestText: JSON.stringify(request),
            stdout: output,
            stderr: errorOutput,
            signal: controller.signal,
            parentRunId: plan.parent_run_id,
            onlyLensIds: plan.incomplete_lenses,
            ...(runtime.adapterRegistry === undefined
              ? {}
              : { adapterRegistry: runtime.adapterRegistry }),
            ...(runtime.appPaths === undefined
              ? {}
              : { appPaths: runtime.appPaths }),
          });
        } finally {
          clearInterval(lifecycle);
        }
      } catch (error) {
        await writeDiagnostic(
          error instanceof RunReportError ? error.code : "retry_failed",
          error instanceof RunReportError
            ? error.message
            : "The incomplete review lenses could not be retried.",
          errorOutput,
        );
        process.exitCode = 2;
      }
      return;
    }
    if (argv[0] === "review") {
      const knownStandaloneFlags = new Set([
        "--no-ansi",
        "--output-mode",
        "--heartbeat",
        "--details-file",
      ]);
      for (const argument of argv.slice(1)) {
        if (argument.startsWith("--") && !knownStandaloneFlags.has(argument)) {
          await writeUsageDiagnostic(
            "Expected: review-mesh review [WORKSPACE] [--output-mode compact-jsonl] [--no-ansi] [--heartbeat aggregate] [--details-file PATH]",
            "review-mesh help review",
            errorOutput,
          );
          process.exitCode = 2;
          return;
        }
      }
    }
    if (argv[0] !== "review") {
      await writeUsageDiagnostic(
        "Unknown command. Expected one of: review, status, report, findings, retry, doctor, describe, schema, config, help, or version.",
        "review-mesh --help",
        errorOutput,
        ["Run review-mesh --help for the complete command manual."],
      );
      process.exitCode = 2;
      return;
    }

    let outputMode: string | undefined;
    let heartbeatMode: string | undefined;
    let detailsFile: string | undefined;
    let invalidReviewArguments = false;
    const positional: string[] = [];
    for (let index = 1; index < argv.length; index += 1) {
      const argument = argv[index]!;
      if (argument === "--no-ansi") continue;
      if (
        argument === "--output-mode" ||
        argument === "--heartbeat" ||
        argument === "--details-file"
      ) {
        const value = argv[index + 1];
        if (value === undefined || value.startsWith("--")) {
          invalidReviewArguments = true;
          break;
        }
        if (argument === "--output-mode") {
          if (outputMode !== undefined) invalidReviewArguments = true;
          outputMode = value;
        } else if (argument === "--heartbeat") {
          if (heartbeatMode !== undefined) invalidReviewArguments = true;
          heartbeatMode = value;
        } else {
          if (detailsFile !== undefined) invalidReviewArguments = true;
          detailsFile = value;
        }
        index += 1;
        continue;
      }
      if (!argument.startsWith("--")) positional.push(argument);
    }
    if (
      invalidReviewArguments ||
      positional.length > 1 ||
      (outputMode !== undefined && outputMode !== "compact-jsonl") ||
      (heartbeatMode !== undefined && heartbeatMode !== "aggregate")
    ) {
      await writeUsageDiagnostic(
        "Expected: review-mesh review [WORKSPACE] [--output-mode compact-jsonl] [--no-ansi] [--heartbeat aggregate] [--details-file PATH]",
        "review-mesh help review",
        errorOutput,
      );
      process.exitCode = 2;
      return;
    }
    const positionalWorkspace = positional[0];
    const cwd = resolve(runtime.cwd ?? process.cwd());
    let requestText: string;
    try {
      requestText =
        input.isTTY === true
          ? positionalWorkspace === undefined
            ? await defaultRequest(cwd, controller.signal)
            : await explicitReviewRequest(
                cwd,
                positionalWorkspace,
                controller.signal,
              )
          : await readRequest(input, controller.signal);
    } catch (error) {
      if (
        error instanceof RequestReadError &&
        error.code === "request_too_large"
      ) {
        await writeDiagnostic(
          "request_too_large",
          "The request exceeds the 8 MiB stdin limit.",
          errorOutput,
        );
      } else if (
        error instanceof RequestReadError &&
        error.code === "interrupted"
      ) {
        await writeDiagnostic(
          "interrupted",
          "The request read was interrupted before a valid run began.",
          errorOutput,
        );
      } else {
        await writeDiagnostic(
          "invalid_request",
          "The Review Mesh request could not be read from stdin.",
          errorOutput,
        );
      }
      process.exitCode = 2;
      return;
    }
    if (requestText.trim().length === 0) {
      requestText =
        positionalWorkspace === undefined
          ? await defaultRequest(cwd, controller.signal)
          : await explicitReviewRequest(
              cwd,
              positionalWorkspace,
              controller.signal,
            );
    } else if (positionalWorkspace !== undefined && input.isTTY !== true) {
      await writeUsageDiagnostic(
        "A positional review workspace cannot be combined with a JSON request on stdin.",
        "review-mesh help review",
        errorOutput,
        [
          "Run review-mesh review WORKSPACE with empty stdin.",
          "Or omit WORKSPACE and send the complete request object on stdin.",
        ],
      );
      process.exitCode = 2;
      return;
    }

    const lifecycle = setInterval(() => undefined, 60_000);
    try {
      try {
        process.exitCode = await (runtime.runReview ?? runReviewApplication)({
          requestText,
          stdout: output,
          stderr: errorOutput,
          signal: controller.signal,
          ...(runtime.adapterRegistry === undefined
            ? {}
            : { adapterRegistry: runtime.adapterRegistry }),
          ...(runtime.appPaths === undefined
            ? {}
            : { appPaths: runtime.appPaths }),
          ...(detailsFile === undefined
            ? {}
            : { detailsFile: resolve(cwd, detailsFile) }),
        });
      } catch (error) {
        await writeDiagnostic(
          error instanceof ReviewRunError ? "review_failed" : "startup_failed",
          error instanceof ReviewRunError
            ? "The valid review run failed unexpectedly."
            : "Review Mesh could not start the review.",
          errorOutput,
        );
        process.exitCode = error instanceof ReviewRunError ? 3 : 2;
      }
    } finally {
      clearInterval(lifecycle);
    }
  } finally {
    removeAbortHandlers();
  }
}

const invokedDirectly =
  (typeof REVIEW_MESH_STANDALONE === "undefined" || !REVIEW_MESH_STANDALONE) &&
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (invokedDirectly) {
  await runCli().catch(async () => {
    try {
      await writeDiagnostic(
        "startup_failed",
        "Review Mesh could not complete process cleanup.",
      );
    } finally {
      process.exitCode = 2;
    }
  });
}
