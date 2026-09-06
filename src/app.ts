import type { AppPaths } from "./config/paths.js";
import type { RunRecorderFileSystem } from "./diagnostics/run-recorder.js";
import type { ReviewOutputMode } from "./protocol/schemas.js";
import { AdapterRegistry } from "./adapters/registry.js";
import { createCommandAdapter } from "./adapters/command.js";
export interface ReviewApplicationOptions {
  requestText: string;
  configFile?: string;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  signal: AbortSignal;
  adapterRegistry?: AdapterRegistry;
  runIdFactory?: () => string;
  appPaths?: AppPaths;
  parentRunId?: string;
  onlyLensIds?: readonly string[];
  detailsFile?: string;
  outputMode?: ReviewOutputMode;
  runRecorderFileSystem?: RunRecorderFileSystem;
}
export class ReviewRunError extends Error {
  readonly validRunBegan = true;

  constructor(cause: unknown) {
    super("The review run failed unexpectedly.", { cause });
    this.name = "ReviewRunError";
  }
}
export function createDefaultRegistry(): AdapterRegistry {
  const registry = new AdapterRegistry();
  registry.register("command", (registration) =>
    createCommandAdapter(registration),
  );
  return registry;
}
export async function runReviewApplication(
  options: ReviewApplicationOptions,
): Promise<number> {
  const { runV9Application } = await import("./app-v9.js");
  return runV9Application(options);
}
