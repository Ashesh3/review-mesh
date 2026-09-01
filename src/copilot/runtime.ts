import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { delimiter, dirname, join } from "node:path";

interface CopilotSdkModule {
  CopilotClient: new (...args: any[]) => any;
}

let embeddedSdkModule: CopilotSdkModule | undefined;

export function registerEmbeddedCopilotSdkModule(
  module: CopilotSdkModule,
): void {
  embeddedSdkModule = module;
}

function platformPackageNames(): string[] {
  const variants =
    process.platform === "linux" ? ["linux", "linuxmusl"] : [process.platform];
  return variants.map(
    (variant) => `@github/copilot-${variant}-${process.arch}`,
  );
}

function moduleResolvers(): NodeJS.Require[] {
  const resolvers: NodeJS.Require[] = [];
  for (const base of [
    import.meta.url,
    join(process.cwd(), "package.json"),
    join(dirname(process.execPath), "package.json"),
  ]) {
    try {
      resolvers.push(createRequire(base));
    } catch {
      // Continue to the remaining resolution bases.
    }
  }
  return resolvers;
}

function pathRuntime(environment: NodeJS.ProcessEnv): string | undefined {
  const executable = process.platform === "win32" ? "copilot.exe" : "copilot";
  for (const directory of (environment.PATH ?? environment.Path ?? "").split(
    delimiter,
  )) {
    if (directory.trim().length === 0) continue;
    const candidate = join(directory, executable);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/** Resolves the native Copilot CLI entrypoint without launching a shell. */
export function resolveCopilotRuntimePath(
  environment: NodeJS.ProcessEnv,
  resolvers: readonly NodeJS.Require[] = moduleResolvers(),
): string | undefined {
  const override = environment.COPILOT_CLI_PATH?.trim();
  if (override) return override;

  for (const require of resolvers) {
    for (const packageName of platformPackageNames()) {
      try {
        return require.resolve(packageName);
      } catch {
        // Try the next package and resolution base.
      }
    }
  }
  return pathRuntime(environment);
}

export function loadCopilotSdkModule(): unknown {
  if (embeddedSdkModule !== undefined) return embeddedSdkModule;
  for (const require of moduleResolvers()) {
    try {
      return require("@github/copilot-sdk");
    } catch {
      // Try the next resolution base.
    }
  }
  throw new Error(
    "Could not load @github/copilot-sdk. Install it beside Review Mesh or in the current project.",
  );
}
