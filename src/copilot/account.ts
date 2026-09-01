import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { execa } from "execa";
import { buildAllowlistedEnvironment } from "../adapters/types.js";
import {
  createCopilotClientFacade,
  type CopilotAuthStatus,
  type CopilotClientFacade,
  type CopilotClientFactory,
  type CopilotModelInfo,
} from "../adapters/copilot.js";
import { getAppPaths } from "../config/paths.js";

export interface CopilotAccountStatus extends CopilotAuthStatus {
  runtimeVersion: string;
}

export interface CopilotAccountSnapshot {
  status: CopilotAccountStatus;
  models: CopilotModelInfo[];
}

export type { CopilotModelInfo } from "../adapters/copilot.js";

export interface CopilotLoginOptions {
  flow?: "device-code" | "web-flow";
  host?: string;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  error?: NodeJS.WritableStream;
  signal?: AbortSignal;
}

export interface CopilotAccountService {
  status(signal?: AbortSignal): Promise<CopilotAccountStatus>;
  models(signal?: AbortSignal): Promise<CopilotAccountSnapshot>;
  login(options?: CopilotLoginOptions): Promise<void>;
}

export interface CopilotAccountDependencies {
  applicationDataDirectory?: string;
  environment?: NodeJS.ProcessEnv;
  createClient?: CopilotClientFactory;
  launchLogin?: CopilotLoginLauncher;
  resolveLoginCommand?: () => CopilotLoginCommand;
}

export interface CopilotLoginCommand {
  command: string;
  args: string[];
}

export type CopilotLoginLauncher = (
  command: CopilotLoginCommand,
  args: readonly string[],
  options: {
    env: NodeJS.ProcessEnv;
    input?: NodeJS.ReadableStream;
    output?: NodeJS.WritableStream;
    error?: NodeJS.WritableStream;
    signal?: AbortSignal;
  },
) => Promise<number>;

const COPILOT_ACCOUNT_ENVIRONMENT = [
  "TEMP",
  "TMP",
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMDATA",
  "COPILOT_CLI_PATH",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "GH_CONFIG_DIR",
  "COPILOT_GITHUB_TOKEN",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_HOST",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "https_proxy",
  "http_proxy",
  "all_proxy",
  "no_proxy",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "BROWSER",
  "TERM",
  "COLORTERM",
  "SSH_CONNECTION",
  "SSH_TTY",
  "CODESPACES",
  "CODESPACE_NAME",
  "REMOTE_CONTAINERS",
  "DEVCONTAINER",
  "CI",
  "WSL_DISTRO_NAME",
  "WSL_INTEROP",
  "DISPLAY",
  "WAYLAND_DISPLAY",
] as const;

function definedEnvironment(
  environment: NodeJS.ProcessEnv,
): Record<string, string | undefined> {
  return Object.fromEntries(
    Object.entries(environment).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}

function accountEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return buildAllowlistedEnvironment(COPILOT_ACCOUNT_ENVIRONMENT, source);
}

function platformPackageNames(): string[] {
  const variants =
    process.platform === "linux" ? ["linux", "linuxmusl"] : [process.platform];
  return variants.map(
    (variant) => `@github/copilot-${variant}-${process.arch}`,
  );
}

function executableCommand(path: string): CopilotLoginCommand {
  return [".js", ".mjs", ".cjs"].includes(extname(path).toLowerCase())
    ? { command: process.execPath, args: [path] }
    : { command: path, args: [] };
}

export function resolveCopilotLoginCommand(): CopilotLoginCommand {
  const override = process.env.COPILOT_CLI_PATH?.trim();
  if (override) return executableCommand(override);

  const require = createRequire(import.meta.url);
  for (const packageName of platformPackageNames()) {
    try {
      return executableCommand(require.resolve(packageName));
    } catch {
      // Try the next platform package name before falling back to PATH.
    }
  }
  try {
    const packageFile = require.resolve("@github/copilot/package.json");
    return {
      command: process.execPath,
      args: [join(dirname(packageFile), "npm-loader.js")],
    };
  } catch {
    return { command: "copilot", args: [] };
  }
}

const defaultLoginLauncher: CopilotLoginLauncher = async (
  command,
  args,
  options,
) => {
  const result = await execa(command.command, [...command.args, ...args], {
    env: options.env,
    extendEnv: false,
    reject: false,
    ...(options.signal === undefined
      ? {}
      : { cancelSignal: options.signal, gracefulCancel: true }),
    stdin: (options.input as Readable | undefined) ?? "inherit",
    stdout: (options.output as Writable | undefined) ?? "inherit",
    stderr: (options.error as Writable | undefined) ?? "inherit",
  });
  return result.exitCode ?? 1;
};

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new DOMException("The operation was aborted.", "AbortError");
}

export function createCopilotAccountService(
  dependencies: CopilotAccountDependencies = {},
): CopilotAccountService {
  const applicationDataDirectory =
    dependencies.applicationDataDirectory ??
    dirname(getAppPaths().runsDirectory);
  const baseDirectory = join(applicationDataDirectory, "runtime", "copilot");
  const environment = dependencies.environment ?? process.env;
  const runtimeEnvironment = accountEnvironment(environment);
  const createClient = dependencies.createClient ?? createCopilotClientFacade;
  const launchLogin = dependencies.launchLogin ?? defaultLoginLauncher;
  const resolveLoginCommand =
    dependencies.resolveLoginCommand ?? resolveCopilotLoginCommand;

  const withClient = async <T>(
    signal: AbortSignal | undefined,
    action: (client: CopilotClientFacade) => Promise<T>,
  ): Promise<T> => {
    throwIfAborted(signal);
    await mkdir(baseDirectory, { recursive: true });
    const client = createClient({
      mode: "empty",
      baseDirectory,
      logLevel: "error",
      env: definedEnvironment(runtimeEnvironment),
      useLoggedInUser: true,
    });
    const abort = () => void client.forceStop().catch(() => undefined);
    signal?.addEventListener("abort", abort, { once: true });
    try {
      await client.start();
      throwIfAborted(signal);
      return await action(client);
    } finally {
      signal?.removeEventListener("abort", abort);
      try {
        await client.stop();
      } catch {
        await client.forceStop().catch(() => undefined);
      }
    }
  };

  return {
    status: async (signal) =>
      withClient(signal, async (client) => {
        const [runtime, auth] = await Promise.all([
          client.getStatus(),
          client.getAuthStatus(),
        ]);
        return { ...auth, runtimeVersion: runtime.version };
      }),
    models: async (signal) =>
      withClient(signal, async (client) => {
        const [runtime, auth] = await Promise.all([
          client.getStatus(),
          client.getAuthStatus(),
        ]);
        const status = { ...auth, runtimeVersion: runtime.version };
        return {
          status,
          models: auth.isAuthenticated ? await client.listModels() : [],
        };
      }),
    login: async (options = {}) => {
      throwIfAborted(options.signal);
      await mkdir(baseDirectory, { recursive: true });
      const args = [
        "login",
        ...(options.flow === undefined ? [] : [`--${options.flow}`]),
        ...(options.host === undefined ? [] : ["--host", options.host]),
      ];
      const exitCode = await launchLogin(resolveLoginCommand(), args, {
        env: { ...runtimeEnvironment, COPILOT_HOME: baseDirectory },
        ...(options.input === undefined ? {} : { input: options.input }),
        ...(options.output === undefined ? {} : { output: options.output }),
        ...(options.error === undefined ? {} : { error: options.error }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      throwIfAborted(options.signal);
      if (exitCode !== 0) {
        throw new Error(`GitHub Copilot login exited with code ${exitCode}.`);
      }
    },
  };
}
