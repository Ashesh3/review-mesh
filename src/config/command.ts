import { resolve as resolvePath } from "node:path";
import { TomlError } from "smol-toml";
import { getAppPaths } from "./paths.js";
import {
  ConfigConflictError,
  MAX_CONFIG_BYTES,
  configRevision,
  listConfig,
  loadManagedConfig,
  migrateLegacyConfig,
  saveManagedConfig,
  serializeManagedConfig,
} from "./manage.js";
import { describeEffectiveConfig } from "./effective.js";
import { configApplyEnvelopeSchema, trustedConfigSchema } from "./schemas.js";
import { createReadlinePrompter, runConfigMenu } from "./tui.js";
import {
  createCopilotAccountService,
  type CopilotAccountService,
  type CopilotAccountStatus,
  type CopilotModelInfo,
} from "../copilot/account.js";

export interface ConfigCommandOptions {
  args: readonly string[];
  input: NodeJS.ReadableStream & { isTTY?: boolean };
  output: NodeJS.WritableStream & { isTTY?: boolean };
  error: NodeJS.WritableStream;
  configFile?: string;
  cwd?: string;
  interactive?: boolean;
  signal?: AbortSignal;
  copilotAccount?: CopilotAccountService;
}

const CONFIG_HELP = `Review Mesh configuration

USAGE
  review-mesh config
      Open the interactive configuration manager in a terminal.

  review-mesh config help
  review-mesh config --help
  review-mesh config -h
      Show this help page.

READ-ONLY COMMANDS
  review-mesh config path
      Print the global configuration file path.

  review-mesh config show
      Print the validated configuration as canonical TOML.

  review-mesh config validate
      Validate the global configuration and all project assignments.

  review-mesh config list [--json]
      List declared agents, their scalar model or ordered model runs, and
      project-name assignments. Multi-model agents expand during review according to
      the global max_concurrency setting.

  review-mesh config export --json
      Export the complete validated configuration, its path, and a revision.
      This intentionally includes trusted instruction text and runtime fields,
      but never expands referenced environment variables.

  review-mesh config effective [WORKSPACE] --json
  review-mesh config resolve [WORKSPACE] --json
      Resolve the exact ordered reviewer suite for WORKSPACE (default: current
      directory). Output is safe to share with an agent: instruction bodies,
      project context, runtime fields, commands, URLs, and secret values are
      omitted. Referenced environment variables are reported by name and
      presence only.

MACHINE UPDATE
  review-mesh config apply --json
      Read one strict JSON request from stdin (maximum 5 MiB):
      {"schema_version":"1","expected_revision":"<sha256-or-missing>","config":{...}}

      Start from "config export --json", edit its "config" value, and send that
      value with the exported "revision". A stale revision fails closed with
      "config_conflict"; Review Mesh never merges concurrent edits. Review Mesh
      writers serialize through a config lock and publish by atomic replacement.
      External editors must not modify the file concurrently with config apply.

COPILOT ACCOUNT
  review-mesh config copilot login [--device-code|--web-flow] [--host URL]
  review-mesh config copilot status [--json]
  review-mesh config copilot models [--json]

PROJECT SELECTION
  Project keys are repository/project names, not paths. Review Mesh prefers the
  origin remote repository name, then another remote, then the Git common/root
  directory name; non-Git workspaces use the workspace directory name. Matching
  is case-insensitive, so clones and linked worktrees use the same assignment.
  A project's "agents" list overrides defaults. If it omits "agents", default
  agents remain active while project instructions and context are layered on.

EXIT CODES
  0  Command succeeded.
  2  Invalid usage, request, configuration, workspace, or stale revision.
  4  Interrupted.
`;

class MachineRequestError extends Error {
  constructor(readonly code: "invalid_request" | "request_too_large") {
    super(code);
    this.name = "MachineRequestError";
  }
}

const MAX_APPLY_REQUEST_BYTES = MAX_CONFIG_BYTES + 1024 * 1024;

async function readMachineRequest(
  source: NodeJS.ReadableStream,
  signal: AbortSignal | undefined,
): Promise<string> {
  return new Promise((resolveRequest, rejectRequest) => {
    const input = source as NodeJS.ReadableStream & { destroy?(): void };
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const cleanup = () => {
      input.removeListener("data", onData);
      input.removeListener("end", onEnd);
      input.removeListener("error", onError);
      signal?.removeEventListener("abort", onAbort);
    };
    const reject = (error: Error, destroy = false) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (destroy) input.destroy?.();
      rejectRequest(error);
    };
    const onData = (chunk: string | Buffer) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += bytes.byteLength;
      if (total > MAX_APPLY_REQUEST_BYTES) {
        reject(new MachineRequestError("request_too_large"), true);
        return;
      }
      chunks.push(bytes);
    };
    const onEnd = () => {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        resolveRequest(
          new TextDecoder("utf-8", { fatal: true }).decode(
            Buffer.concat(chunks, total),
          ),
        );
      } catch {
        rejectRequest(new MachineRequestError("invalid_request"));
      }
    };
    const onError = () => reject(new MachineRequestError("invalid_request"));
    const onAbort = () =>
      reject(
        signal?.reason instanceof Error
          ? signal.reason
          : new DOMException("The operation was aborted.", "AbortError"),
        true,
      );
    input.on("data", onData);
    input.once("end", onEnd);
    input.once("error", onError);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    else input.resume();
  });
}

function effectiveArguments(
  args: readonly string[],
  cwd: string,
): string | undefined {
  if (args.includes("--help") || args.includes("-h")) return undefined;
  if (!args.includes("--json")) {
    throw new Error("effective configuration output requires --json");
  }
  if (args.filter((argument) => argument === "--json").length !== 1) {
    throw new Error("effective configuration accepts --json exactly once");
  }
  const positional = args.filter((argument) => argument !== "--json");
  if (
    positional.length > 1 ||
    args.some((argument) => argument.startsWith("--") && argument !== "--json")
  ) {
    throw new Error("invalid effective configuration arguments");
  }
  return resolvePath(cwd, positional[0] ?? ".");
}

async function write(
  stream: NodeJS.WritableStream,
  value: string,
): Promise<void> {
  if (stream.write(value)) return;
  await new Promise<void>((resolve, reject) => {
    stream.once("drain", resolve);
    stream.once("error", reject);
  });
}

async function diagnostic(
  stream: NodeJS.WritableStream,
  error: string,
  message: string,
  details: Record<string, unknown> = {},
): Promise<void> {
  await write(
    stream,
    `${JSON.stringify({
      schema_version: "1",
      kind: "review-mesh.diagnostic",
      error,
      message,
      retryable: false,
      ...details,
    })}\n`,
  );
}

function safeIssues(error: unknown): Array<{
  path: string;
  code: string;
  message: string;
}> {
  if (
    typeof error !== "object" ||
    error === null ||
    !("issues" in error) ||
    !Array.isArray(error.issues)
  ) {
    return [];
  }
  return error.issues.slice(0, 50).map((issue: unknown) => {
    const record =
      typeof issue === "object" && issue !== null
        ? (issue as Record<string, unknown>)
        : {};
    const path = Array.isArray(record.path)
      ? record.path.map(String).join(".")
      : "";
    return {
      path,
      code: typeof record.code === "string" ? record.code : "invalid_value",
      message:
        typeof record.message === "string"
          ? record.message.slice(0, 500)
          : "Invalid configuration value.",
    };
  });
}

function safeErrorDetails(error: unknown): Record<string, unknown> {
  const issues = safeIssues(error);
  if (issues.length > 0) return { issues };
  if (!(error instanceof TomlError)) return {};
  const record = error;
  return {
    ...(typeof record.line === "number" ? { line: record.line } : {}),
    ...(typeof record.column === "number" ? { column: record.column } : {}),
  };
}

function publicCopilotStatus(status: CopilotAccountStatus) {
  return {
    authenticated: status.isAuthenticated,
    ...(status.authType === undefined ? {} : { auth_type: status.authType }),
    ...(status.host === undefined ? {} : { host: status.host }),
    ...(status.login === undefined ? {} : { login: status.login }),
    runtime_version: status.runtimeVersion,
  };
}

function publicCopilotModel(model: CopilotModelInfo) {
  return {
    id: model.id,
    name: model.name,
    available: model.policy === undefined || model.policy.state === "enabled",
    ...(model.policy === undefined ? {} : { policy_state: model.policy.state }),
    reasoning_efforts: model.supportedReasoningEfforts ?? [],
    ...(model.defaultReasoningEffort === undefined
      ? {}
      : { default_effort: model.defaultReasoningEffort }),
  };
}

function copilotLoginArguments(args: readonly string[]): {
  flow?: "device-code" | "web-flow";
  host?: string;
} {
  let flow: "device-code" | "web-flow" | undefined;
  let host: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--device-code" || argument === "--web-flow") {
      const selected = argument.slice(2) as "device-code" | "web-flow";
      if (flow !== undefined)
        throw new Error("choose only one Copilot login flow");
      flow = selected;
      continue;
    }
    if (argument === "--host") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error("--host requires a GitHub host URL");
      }
      host = value;
      index += 1;
      continue;
    }
    throw new Error(`unknown Copilot login option: ${argument}`);
  }
  return {
    ...(flow === undefined ? {} : { flow }),
    ...(host === undefined ? {} : { host }),
  };
}

export async function runConfigCommand(
  options: ConfigCommandOptions,
): Promise<number> {
  const configFile = options.configFile ?? getAppPaths().configFile;
  const [command, ...rest] = options.args;
  try {
    if (command === "help" || command === "--help" || command === "-h") {
      if (rest.length !== 0) throw new Error("help does not accept arguments");
      await write(options.output, CONFIG_HELP);
      return 0;
    }
    if (
      (command === "export" || command === "apply") &&
      rest.length === 1 &&
      (rest[0] === "--help" || rest[0] === "-h")
    ) {
      await write(options.output, CONFIG_HELP);
      return 0;
    }
    if (
      (command === "effective" || command === "resolve") &&
      rest.some((argument) => argument === "--help" || argument === "-h")
    ) {
      await write(options.output, CONFIG_HELP);
      return 0;
    }
    if (command === "copilot") {
      if (
        rest.length === 1 &&
        (rest[0] === "help" || rest[0] === "--help" || rest[0] === "-h")
      ) {
        await write(options.output, CONFIG_HELP);
        return 0;
      }
      const account = options.copilotAccount ?? createCopilotAccountService();
      const [operation, ...operationArgs] = rest;
      if (
        (operation === "status" || operation === "models") &&
        (operationArgs.length === 0 ||
          (operationArgs.length === 1 && operationArgs[0] === "--json"))
      ) {
        const snapshot =
          operation === "models"
            ? await account.models(options.signal)
            : { status: await account.status(options.signal), models: [] };
        const json = operationArgs[0] === "--json";
        if (json) {
          await write(
            options.output,
            `${JSON.stringify({
              ...publicCopilotStatus(snapshot.status),
              ...(operation === "models"
                ? { models: snapshot.models.map(publicCopilotModel) }
                : {}),
            })}\n`,
          );
        } else if (operation === "status") {
          const identity = snapshot.status.login ?? "unknown user";
          const source = snapshot.status.authType ?? "unknown authentication";
          await write(
            options.output,
            snapshot.status.isAuthenticated
              ? `GitHub Copilot authenticated as ${identity} via ${source}.\n`
              : "GitHub Copilot is not authenticated. Run review-mesh config copilot login.\n",
          );
        } else {
          if (!snapshot.status.isAuthenticated) {
            await diagnostic(
              options.error,
              "copilot_authentication_required",
              "Sign in with review-mesh config copilot login before listing models.",
            );
            return 2;
          }
          for (const model of snapshot.models.map(publicCopilotModel)) {
            await write(
              options.output,
              `${model.id}\t${model.name}\t${model.available ? "available" : model.policy_state}\t${model.reasoning_efforts.join(",") || "default"}\n`,
            );
          }
        }
        return 0;
      }
      if (operation === "login") {
        const login = copilotLoginArguments(operationArgs);
        await account.login({
          ...login,
          input: options.input,
          output: options.output,
          error: options.error,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
        const status = await account.status(options.signal);
        if (!status.isAuthenticated) {
          throw new Error(
            "Copilot login completed without an authenticated account",
          );
        }
        await write(
          options.output,
          `GitHub Copilot login ready${status.login === undefined ? "" : ` for ${status.login}`}.\n`,
        );
        return 0;
      }
      await diagnostic(
        options.error,
        "invalid_usage",
        "Expected: review-mesh config copilot [login [--device-code|--web-flow] [--host URL]|status [--json]|models [--json]]",
      );
      return 2;
    }
    if (command === "path" && rest.length === 0) {
      await write(options.output, `${configFile}\n`);
      return 0;
    }
    if (command === "export" && rest.length === 1 && rest[0] === "--json") {
      const loaded = await loadManagedConfig(configFile, true);
      await write(
        options.output,
        `${JSON.stringify({
          schema_version: "1",
          config_schema_version: loaded.config.schema_version,
          path: configFile,
          revision: configRevision(loaded.snapshot),
          exists: loaded.snapshot.exists,
          migrated: loaded.migrated,
          warnings: loaded.warnings,
          config: loaded.config,
        })}\n`,
      );
      return 0;
    }
    if (command === "apply" && rest.length === 1 && rest[0] === "--json") {
      let text: string;
      try {
        text = await readMachineRequest(options.input, options.signal);
      } catch (error) {
        if (options.signal?.aborted) throw error;
        const tooLarge =
          error instanceof MachineRequestError &&
          error.code === "request_too_large";
        await diagnostic(
          options.error,
          tooLarge ? "request_too_large" : "invalid_request",
          tooLarge
            ? "The configuration apply request exceeds the 5 MiB stdin limit."
            : "Stdin must contain one valid Review Mesh configuration apply request.",
        );
        return 2;
      }
      let request: ReturnType<typeof configApplyEnvelopeSchema.parse>;
      try {
        request = configApplyEnvelopeSchema.parse(JSON.parse(text));
      } catch {
        await diagnostic(
          options.error,
          "invalid_request",
          "Stdin must contain one strict Review Mesh configuration apply request.",
        );
        return 2;
      }
      const loaded = await loadManagedConfig(configFile, true);
      const previousRevision = configRevision(loaded.snapshot);
      if (request.expected_revision !== previousRevision) {
        await write(
          options.error,
          `${JSON.stringify({
            schema_version: "1",
            kind: "review-mesh.diagnostic",
            error: "config_conflict",
            message:
              "The global Review Mesh configuration changed; export it again before applying changes.",
            retryable: true,
            current_revision: previousRevision,
          })}\n`,
        );
        return 2;
      }
      let strictConfig;
      try {
        strictConfig = trustedConfigSchema.parse(request.config);
      } catch {
        await diagnostic(
          options.error,
          "invalid_request",
          "Stdin must contain one strict Review Mesh configuration apply request.",
        );
        return 2;
      }
      const desired =
        strictConfig.schema_version === "7"
          ? strictConfig
          : await migrateLegacyConfig(strictConfig);
      const attestedLensIds = Object.entries(desired.agents)
        .filter(([, agent]) => agent.change_coverage?.proof === "attested")
        .map(([id]) => id);
      if (
        strictConfig.schema_version !== "7" &&
        attestedLensIds.length > 0 &&
        request.confirm_attested_coverage !== true
      ) {
        await diagnostic(
          options.error,
          "attested_coverage_confirmation_required",
          "Applying this migration requires confirmation of derived attested coverage.",
          { lens_ids: attestedLensIds },
        );
        return 2;
      }
      const desiredText = serializeManagedConfig(desired);
      if (
        loaded.snapshot.exists &&
        !loaded.migrated &&
        serializeManagedConfig(loaded.config) === desiredText
      ) {
        await write(
          options.output,
          `${JSON.stringify({
            schema_version: "1",
            status: "unchanged",
            path: configFile,
            previous_revision: previousRevision,
            revision: previousRevision,
          })}\n`,
        );
        return 0;
      }
      try {
        const saved = await saveManagedConfig(
          configFile,
          desired,
          loaded.snapshot,
        );
        await write(
          options.output,
          `${JSON.stringify({
            schema_version: "1",
            status: "applied",
            path: configFile,
            previous_revision: previousRevision,
            revision: configRevision(saved),
          })}\n`,
        );
        return 0;
      } catch (error) {
        if (!(error instanceof ConfigConflictError)) throw error;
        const current = await loadManagedConfig(configFile, true);
        await write(
          options.error,
          `${JSON.stringify({
            schema_version: "1",
            kind: "review-mesh.diagnostic",
            error: "config_conflict",
            message:
              "The global Review Mesh configuration changed; export it again before applying changes.",
            retryable: true,
            current_revision: configRevision(current.snapshot),
          })}\n`,
        );
        return 2;
      }
    }
    if (command === "effective" || command === "resolve") {
      let workspace: string | undefined;
      try {
        workspace = effectiveArguments(rest, options.cwd ?? process.cwd());
      } catch {
        await diagnostic(
          options.error,
          "invalid_usage",
          "Expected: review-mesh config effective [workspace] --json",
        );
        return 2;
      }
      if (workspace === undefined) {
        await write(options.output, CONFIG_HELP);
        return 0;
      }
      const result = await describeEffectiveConfig({
        configFile,
        workspace,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      await write(options.output, `${JSON.stringify(result)}\n`);
      return result.valid ? 0 : 2;
    }
    if (command === "show" && rest.length === 0) {
      const text = serializeManagedConfig(
        (await loadManagedConfig(configFile)).config,
      );
      await write(options.output, text.endsWith("\n") ? text : `${text}\n`);
      return 0;
    }
    if (command === "validate" && rest.length === 0) {
      await loadManagedConfig(configFile);
      await write(options.output, `Configuration is valid: ${configFile}\n`);
      return 0;
    }
    if (
      command === "list" &&
      (rest.length === 0 || (rest.length === 1 && rest[0] === "--json"))
    ) {
      const loaded = await loadManagedConfig(configFile);
      const listed = listConfig(loaded.config);
      if (rest[0] === "--json") {
        await write(options.output, `${JSON.stringify(listed)}\n`);
      } else {
        for (const agent of listed.agents) {
          if ("model_runs" in agent) {
            for (const run of agent.model_runs) {
              await write(
                options.output,
                `${agent.id}::${run.id}\t${run.model}\t${run.effort ?? "default"}\t${run.adapter ?? agent.adapter}${agent.default ? "\tdefault" : ""}\n`,
              );
            }
          } else {
            await write(
              options.output,
              `${agent.id}\t${agent.model}\t${agent.effort ?? "default"}\t${agent.adapter}${agent.default ? "\tdefault" : ""}\n`,
            );
          }
        }
        for (const project of listed.projects) {
          await write(
            options.output,
            `${project.name}\t${project.agents.join(",")}\n`,
          );
        }
      }
      return 0;
    }
    if (command !== undefined || rest.length > 0) {
      await diagnostic(
        options.error,
        "invalid_usage",
        "Expected: review-mesh config [help|path|show|validate|list [--json]|export --json|apply --json|effective [workspace] --json|resolve [workspace] --json|copilot ...]",
      );
      return 2;
    }
    const interactive =
      options.interactive ??
      (options.input.isTTY === true && options.output.isTTY === true);
    if (!interactive) {
      await diagnostic(
        options.error,
        "interactive_terminal_required",
        "review-mesh config requires an interactive terminal; use a config subcommand for automation.",
      );
      return 2;
    }
    const loaded = await loadManagedConfig(configFile, true);
    if (loaded.migrated) {
      await write(
        options.output,
        "Loaded legacy configuration; the first successful change will save it as v7.\n",
      );
    }
    await runConfigMenu({
      configFile,
      config: loaded.config,
      pendingMigrationConfirmation: loaded.migrated,
      snapshot: loaded.snapshot,
      prompt: createReadlinePrompter(options.input, options.output),
      output: options.output,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      copilotAccount: options.copilotAccount ?? createCopilotAccountService(),
    });
    return 0;
  } catch (error) {
    if (options.signal?.aborted) {
      await diagnostic(
        options.error,
        "interrupted",
        "Review Mesh configuration was interrupted.",
      );
      return 4;
    }
    await diagnostic(
      options.error,
      "configuration_error",
      "The global Review Mesh configuration operation failed.",
      {
        ...safeErrorDetails(error),
        config_file: configFile,
        help_command: "review-mesh help config-file",
        next_actions: [
          "Run review-mesh config validate after repairing the reported fields.",
          "Run review-mesh schema config --json for the structural schema.",
        ],
      },
    );
    return 2;
  }
}
