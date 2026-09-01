import { getAppPaths } from "./paths.js";
import {
  listConfig,
  loadManagedConfig,
  serializeManagedConfig,
} from "./manage.js";
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
): Promise<void> {
  await write(stream, `${JSON.stringify({ error, message })}\n`);
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
    if (command === "copilot") {
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
          await write(
            options.output,
            `${agent.id}\t${agent.model}\t${agent.effort ?? "default"}\t${agent.adapter}${agent.default ? "\tdefault" : ""}\n`,
          );
        }
        for (const project of listed.projects) {
          await write(
            options.output,
            `${project.path}\t${project.agents.join(",")}\n`,
          );
        }
      }
      return 0;
    }
    if (command !== undefined || rest.length > 0) {
      await diagnostic(
        options.error,
        "invalid_usage",
        "Expected: review-mesh config [path|show|validate|list [--json]|copilot ...]",
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
        "Loaded legacy v1 configuration; the first successful change will save it as v2.\n",
      );
    }
    await runConfigMenu({
      configFile,
      config: loaded.config,
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
    );
    return 2;
  }
}
