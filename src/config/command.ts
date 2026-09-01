import { getAppPaths } from "./paths.js";
import {
  listConfig,
  loadManagedConfig,
  serializeManagedConfig,
} from "./manage.js";
import { createReadlinePrompter, runConfigMenu } from "./tui.js";

export interface ConfigCommandOptions {
  args: readonly string[];
  input: NodeJS.ReadableStream & { isTTY?: boolean };
  output: NodeJS.WritableStream & { isTTY?: boolean };
  error: NodeJS.WritableStream;
  configFile?: string;
  cwd?: string;
  interactive?: boolean;
  signal?: AbortSignal;
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

export async function runConfigCommand(
  options: ConfigCommandOptions,
): Promise<number> {
  const configFile = options.configFile ?? getAppPaths().configFile;
  const [command, ...rest] = options.args;
  try {
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
            `${agent.id}\t${agent.model}\t${agent.adapter}${agent.default ? "\tdefault" : ""}\n`,
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
        "Expected: review-mesh config [path|show|validate|list [--json]]",
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
