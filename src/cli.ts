#!/usr/bin/env node

import { resolve } from "node:path";
import type { Readable, Writable } from "node:stream";
import { pathToFileURL } from "node:url";
import {
  ReviewRunError,
  runReviewApplication,
  type ReviewApplicationOptions,
} from "./app.js";
import type { AdapterRegistry } from "./adapters/registry.js";
import { runConfigCommand } from "./config/command.js";
import { resolveProjectName } from "./config/project-names.js";
import { getAppPaths, type AppPaths } from "./config/paths.js";
import { readRunStatus, RunStatusError } from "./diagnostics/run-status.js";
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
    if (
      argv[0] !== "review" ||
      argv.length > 2 ||
      (argv.length === 2 && argv[1]?.startsWith("-"))
    ) {
      await writeUsageDiagnostic(
        "Unknown command. Expected one of: review, status, describe, schema, config, help, or version.",
        "review-mesh --help",
        errorOutput,
        ["Run review-mesh --help for the complete command manual."],
      );
      process.exitCode = 2;
      return;
    }

    const positionalWorkspace = argv[1];
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
