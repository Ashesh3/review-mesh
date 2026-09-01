#!/usr/bin/env node

import { resolve } from "node:path";
import type { Readable, Writable } from "node:stream";
import { pathToFileURL } from "node:url";
import { ReviewRunError, runReviewApplication } from "./app.js";
import { runConfigCommand } from "./config/command.js";

declare const REVIEW_MESH_STANDALONE: boolean | undefined;

const maximumRequestBytes = 8 * 1024 * 1024;

async function writeDiagnostic(
  error: string,
  message: string,
  output: NodeJS.WritableStream = process.stderr,
): Promise<void> {
  const line = `${JSON.stringify({ error, message })}\n`;
  if (output.write(line)) return;
  await new Promise<void>((resolve, reject) => {
    output.once("drain", resolve);
    output.once("error", reject);
  });
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
    if (argv.length !== 1 || argv[0] !== "review") {
      await writeDiagnostic(
        "invalid_usage",
        "Expected: review-mesh review or review-mesh config",
        errorOutput,
      );
      process.exitCode = 2;
      return;
    }

    let requestText: string;
    try {
      requestText = await readRequest(input, controller.signal);
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

    const lifecycle = setInterval(() => undefined, 60_000);
    try {
      try {
        process.exitCode = await runReviewApplication({
          requestText,
          stdout: output,
          stderr: errorOutput,
          signal: controller.signal,
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
