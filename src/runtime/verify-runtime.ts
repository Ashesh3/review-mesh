import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { createInterface } from "node:readline";
import { startup } from "@anthropic-ai/claude-agent-sdk";
import { resolveSdkRuntime, type SdkRuntimeName } from "./sdk-runtime.js";
import { loadCopilotSdkModule } from "../copilot/runtime.js";

async function bounded<T>(
  operation: Promise<T>,
  milliseconds: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("SDK runtime verification timed out.")),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function isolatedEnvironment(home: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of [
    "SystemRoot",
    "WINDIR",
    "COMSPEC",
    "PATHEXT",
    "TMP",
    "TEMP",
    "LANG",
  ]) {
    if (process.env[key] !== undefined) environment[key] = process.env[key];
  }
  return {
    ...environment,
    PATH: "",
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, "AppData", "Roaming"),
    LOCALAPPDATA: join(home, "AppData", "Local"),
    XDG_CONFIG_HOME: join(home, "config"),
    CODEX_HOME: join(home, "codex"),
    CLAUDE_CONFIG_DIR: join(home, "claude"),
    COPILOT_HOME: join(home, "copilot"),
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
    DO_NOT_TRACK: "1",
  };
}

async function codexHandshake(
  executable: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const child = spawn(executable, ["app-server", "--stdio"], {
    cwd,
    env,
    windowsHide: true,
    stdio: "pipe",
  });
  const closed = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", () => resolve());
  });
  child.stderr.resume();
  const lines = createInterface({ input: child.stdout });
  try {
    const response = new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", () =>
        reject(new Error("Codex exited before initialization.")),
      );
      lines.on("line", (line) => {
        try {
          const value = JSON.parse(line);
          if (value.id === 1 && value.result) resolve();
          if (value.id === 1 && value.error)
            reject(new Error("Codex initialization failed."));
        } catch {
          // Non-protocol startup output cannot satisfy the handshake.
        }
      });
    });
    child.stdin.write(
      `${JSON.stringify({ id: 1, method: "initialize", params: { clientInfo: { name: "review_mesh_packaging_check", version: "1.0.0" }, capabilities: { experimentalApi: true } } })}\n`,
    );
    await bounded(response, 15000);
    child.stdin.end(`${JSON.stringify({ method: "initialized" })}\n`);
    await bounded(closed, 5000);
  } finally {
    lines.close();
    if (child.exitCode === null) child.kill();
    await closed;
  }
}

/** Local startup checks only; never submits a user prompt or creates a model turn. */
export async function verifySdkRuntime(
  sdk: SdkRuntimeName,
): Promise<Record<string, unknown>> {
  const runtime = resolveSdkRuntime(sdk);
  const home = await mkdtemp(join(tmpdir(), "review-mesh-runtime-probe-"));
  const env = isolatedEnvironment(home);
  env.PATH = runtime.pathEntries.join(delimiter);
  for (const directory of [
    "codex",
    "claude",
    "copilot",
    "config",
    "AppData/Roaming",
    "AppData/Local",
  ])
    await mkdir(join(home, directory), { recursive: true });
  try {
    const version = spawnSync(runtime.executablePath, ["--version"], {
      cwd: home,
      env,
      windowsHide: true,
      encoding: "utf8",
      timeout: 15000,
    });
    if (
      version.error ||
      version.status !== 0 ||
      !version.stdout.includes(runtime.runtimeVersion)
    ) {
      throw new Error(`${sdk} packaged executable version check failed.`);
    }
    if (sdk === "claude") {
      let stopped: Promise<void> | undefined;
      let child: ReturnType<typeof spawn> | undefined;
      let warm: Awaited<ReturnType<typeof startup>> | undefined;
      try {
        warm = await startup({
          options: {
            pathToClaudeCodeExecutable: runtime.executablePath,
            cwd: home,
            env,
            tools: [],
            settingSources: [],
            mcpServers: {},
            persistSession: false,
            // The vendor WarmQuery disposal resolves before the process exits
            // unless sessionStore is used. Observe the supported spawn seam so
            // the acceptance check waits for actual OS cleanup.
            spawnClaudeCodeProcess: (options) => {
              const launched = spawn(options.command, options.args, {
                cwd: home,
                env,
                signal: options.signal,
                windowsHide: true,
                stdio: "pipe",
              });
              child = launched;
              stopped = new Promise<void>((resolve, reject) => {
                launched.once("close", () => resolve());
                launched.once("error", (error) => {
                  if (error.name !== "AbortError") reject(error);
                });
              });
              return launched;
            },
          },
          initializeTimeoutMs: 15000,
        });
        await warm[Symbol.asyncDispose]();
        if (stopped) await bounded(stopped, 5000);
      } finally {
        warm?.close();
        if (child && child.exitCode === null) child.kill();
        if (stopped) await stopped;
      }
    } else if (sdk === "codex") {
      await codexHandshake(runtime.executablePath, home, env);
    } else {
      const module = loadCopilotSdkModule() as {
        CopilotClient: new (options: Record<string, unknown>) => {
          start(): Promise<void>;
          ping(message: string): Promise<{ message: string }>;
          stop(): Promise<Error[]>;
          forceStop(): Promise<void>;
        };
        RuntimeConnection: { forStdio(options: { path: string }): unknown };
      };
      const client = new module.CopilotClient({
        connection: module.RuntimeConnection.forStdio({
          path: runtime.executablePath,
        }),
        env,
        mode: "empty",
        workingDirectory: home,
        baseDirectory: join(home, "copilot"),
        useLoggedInUser: false,
        logLevel: "none",
      });
      try {
        await bounded(client.start(), 15000);
        const result = await bounded(
          client.ping("review-mesh-runtime-check"),
          5000,
        );
        if (result.message !== "pong: review-mesh-runtime-check")
          throw new Error("Copilot handshake response did not match.");
      } finally {
        try {
          if ((await bounded(client.stop(), 5000)).length > 0)
            throw new Error("Copilot runtime shutdown failed.");
        } catch (error) {
          await client.forceStop();
          throw error;
        }
      }
    }
    return {
      sdk,
      sdkVersion: runtime.sdkVersion,
      runtimeVersion: runtime.runtimeVersion,
      mode: runtime.mode,
      platform: `${process.platform}-${process.arch}`,
      versionCheck: "passed",
      handshake: "passed",
      handshakeTransport:
        sdk === "codex" ? "native_app_server_stdio" : "sdk_managed_stdio",
      shutdown: "passed",
      inference: "not_run",
      vendorCliOnPath: false,
      processBehavior: "managed_child_process",
      windowsHidden:
        process.platform !== "win32"
          ? "not_applicable"
          : sdk === "codex"
            ? "sdk_launcher_not_verified"
            : sdk === "claude"
              ? "supported_spawn_seam_windowsHide_true"
              : "vendor_launcher_windowsHide_true",
    };
  } finally {
    await rm(home, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  }
}

export async function runSdkRuntimeVerification(args: string[]): Promise<void> {
  const sdk = args[args.indexOf("--sdk") + 1];
  const mode = args[args.indexOf("--mode") + 1];
  if (
    !["claude", "codex", "copilot"].includes(sdk ?? "") ||
    mode !== "managed_process"
  ) {
    throw new Error(
      "Runtime verification requires --sdk claude|codex|copilot --mode managed_process. In-process operation is unsupported.",
    );
  }
  process.stdout.write(
    `${JSON.stringify(await verifySdkRuntime(sdk as SdkRuntimeName))}\n`,
  );
}
