import { createInterface } from "node:readline/promises";
import { resolve } from "node:path";
import type { Readable, Writable } from "node:stream";
import {
  supportedEffortsForAdapter,
  type AdapterRegistration,
  type ReasoningEffort,
} from "./schemas.js";
import type { CopilotAccountService } from "../copilot/account.js";
import type { JsonValue } from "../protocol/schemas.js";
import {
  canonicalProjectPath,
  listConfig,
  requireEnvironmentName,
  requireSafeIdentifier,
  saveManagedConfig,
  type ConfigSnapshot,
  type ManagedAgent,
  type ManagedConfig,
} from "./manage.js";

export interface ConfigPrompter {
  ask(question: string, signal?: AbortSignal): Promise<string>;
  close(): void;
}

export interface ConfigMenuOptions {
  configFile: string;
  config: ManagedConfig;
  snapshot: ConfigSnapshot;
  prompt: ConfigPrompter;
  output: NodeJS.WritableStream;
  cwd?: string;
  signal?: AbortSignal;
  copilotAccount?: CopilotAccountService;
}

class SignalPrompter implements ConfigPrompter {
  constructor(
    private readonly inner: ConfigPrompter,
    private readonly signal: AbortSignal | undefined,
  ) {}

  ask(question: string, signal = this.signal): Promise<string> {
    return this.inner.ask(question, signal);
  }

  close(): void {
    this.inner.close();
  }
}

async function write(
  output: NodeJS.WritableStream,
  text: string,
): Promise<void> {
  if (output.write(text)) return;
  await new Promise<void>((resolve, reject) => {
    output.once("drain", resolve);
    output.once("error", reject);
  });
}

function yes(value: string): boolean {
  return /^(?:y|yes)$/i.test(value.trim());
}

function positiveInteger(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

function timerMilliseconds(value: string, label: string): number {
  const parsed = positiveInteger(value, label);
  if (parsed > 2_147_483_647) {
    throw new Error(`${label} must not exceed 2147483647`);
  }
  return parsed;
}

function isolationPolicy(value: string): ManagedAgent["isolation"] {
  if (value !== "prefer_enforced" && value !== "require_enforced") {
    throw new Error("isolation must be prefer_enforced or require_enforced");
  }
  return value;
}

const EFFORTS: ReadonlySet<string> = new Set([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
  "persistent",
]);

function reasoningEffort(value: string): ReasoningEffort | undefined {
  if (value === "" || value === "default") return undefined;
  if (!EFFORTS.has(value)) {
    throw new Error(
      "effort must be default, none, minimal, low, medium, high, xhigh, max, ultra, or persistent",
    );
  }
  return value as ReasoningEffort;
}

function optionalJson(value: string): JsonValue {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error("context must be valid JSON");
  }
}

async function answer(
  prompt: ConfigPrompter,
  question: string,
  fallback?: string,
  signal?: AbortSignal,
): Promise<string> {
  if (signal?.aborted) {
    throw signal.reason ?? new Error("configuration interrupted");
  }
  const asking = prompt.ask(question, signal);
  void asking.catch(() => undefined);
  let abort: (() => void) | undefined;
  const interrupted = new Promise<never>((_resolve, reject) => {
    if (signal === undefined) return;
    abort = () =>
      reject(signal.reason ?? new Error("configuration interrupted"));
    signal.addEventListener("abort", abort, { once: true });
  });
  let response: string;
  try {
    response =
      signal === undefined
        ? await asking
        : await Promise.race([asking, interrupted]);
  } finally {
    if (abort !== undefined) signal?.removeEventListener("abort", abort);
  }
  const value = response.trim();
  return value === "" && fallback !== undefined ? fallback : value;
}

function chooseAgents(value: string, config: ManagedConfig): string[] {
  const ids = value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (ids.length === 0) throw new Error("choose at least one agent");
  for (const id of ids) {
    if (config.agents[id] === undefined)
      throw new Error(`unknown agent: ${id}`);
  }
  return [...new Set(ids)];
}

function lexicalProjectPath(candidate: string, cwd = process.cwd()): string {
  const normalized = resolve(cwd, candidate).replaceAll("\\", "/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

async function storedProjectPath(
  candidate: string,
  config: ManagedConfig,
  cwd?: string,
): Promise<string> {
  const projects = config.projects ?? {};
  try {
    const canonical = await canonicalProjectPath(candidate, cwd);
    if (projects[canonical] !== undefined) return canonical;
  } catch {
    // A deleted or unavailable project remains removable by its stored path.
  }
  const requested = lexicalProjectPath(candidate, cwd);
  const match = Object.keys(projects).find(
    (path) => lexicalProjectPath(path, cwd) === requested,
  );
  if (match === undefined) throw new Error(`unknown project: ${requested}`);
  return match;
}

async function createAdapter(
  config: ManagedConfig,
  prompt: ConfigPrompter,
): Promise<string> {
  const id = requireSafeIdentifier(
    await answer(prompt, "Adapter id: "),
    "adapter id",
  );
  if (config.adapters[id] !== undefined)
    throw new Error(`adapter already exists: ${id}`);
  const type = await answer(
    prompt,
    "Adapter type (openai_compatible, command, copilot, claude, codex): ",
  );
  let adapter: AdapterRegistration;
  if (type === "openai_compatible") {
    adapter = {
      type,
      base_url_env: requireEnvironmentName(
        await answer(prompt, "Base URL environment variable: "),
      ),
      api_key_env: requireEnvironmentName(
        await answer(prompt, "API key environment variable: "),
      ),
    };
  } else if (type === "command") {
    const encodedArgs = await answer(
      prompt,
      "Arguments as JSON array [default []]: ",
      "[]",
    );
    const parsedArgs: unknown = JSON.parse(encodedArgs);
    if (
      !Array.isArray(parsedArgs) ||
      parsedArgs.some((item) => typeof item !== "string")
    ) {
      throw new Error("command arguments must be a JSON array of strings");
    }
    adapter = {
      type,
      command: await answer(prompt, "Command or executable path: "),
      args: parsedArgs,
      protocol: "review-mesh-command-v1",
    };
  } else if (type === "copilot") {
    adapter = { type, use_logged_in_user: true };
  } else if (type === "claude" || type === "codex") {
    const executable = await answer(
      prompt,
      "Executable override [leave blank for runtime default]: ",
    );
    adapter = { type, ...(executable === "" ? {} : { executable }) };
  } else {
    throw new Error(`unsupported adapter type: ${type}`);
  }
  config.adapters[id] = adapter;
  return id;
}

async function copilotModelAndEffort(
  options: ConfigMenuOptions,
  adapterId: string,
  current?: Pick<ManagedAgent, "model" | "effort">,
): Promise<{ model: string; effort?: ReasoningEffort }> {
  const adapter = options.config.adapters[adapterId];
  if (adapter?.type !== "copilot" || options.copilotAccount === undefined) {
    const model = await answer(
      options.prompt,
      current === undefined ? "Model id: " : `Model id [${current.model}]: `,
      current?.model,
    );
    const supported = supportedEffortsForAdapter(adapter?.type ?? "command");
    const effort = reasoningEffort(
      await answer(
        options.prompt,
        current === undefined
          ? `Reasoning effort${supported === undefined ? "" : ` (${supported.join(",")})`} [default]: `
          : `Reasoning effort${supported === undefined ? "" : ` (${supported.join(",")})`} [${current.effort ?? "default"}]: `,
        current?.effort ?? "default",
      ),
    );
    if (
      effort !== undefined &&
      supported !== undefined &&
      !supported.includes(effort)
    ) {
      throw new Error(`${adapter?.type} does not support effort ${effort}`);
    }
    return { model, ...(effort === undefined ? {} : { effort }) };
  }

  let snapshot = await options.copilotAccount.models(options.signal);
  if (!snapshot.status.isAuthenticated) {
    const login = yes(
      await answer(
        options.prompt,
        "GitHub Copilot is not authenticated. Sign in now? [Y/n]: ",
        "y",
      ),
    );
    if (!login) throw new Error("GitHub Copilot authentication is required");
    await options.copilotAccount.login({
      output: options.output,
      error: options.output,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    snapshot = await options.copilotAccount.models(options.signal);
  }
  if (!snapshot.status.isAuthenticated) {
    throw new Error("GitHub Copilot authentication is unavailable");
  }

  const selectable = snapshot.models.filter(
    (model) => model.policy === undefined || model.policy.state === "enabled",
  );
  if (selectable.length === 0) {
    throw new Error("the GitHub Copilot account has no available models");
  }
  await write(options.output, "GitHub Copilot models:\n");
  for (const model of selectable) {
    const efforts = model.supportedReasoningEfforts?.join(",") ?? "default";
    await write(
      options.output,
      `  ${model.id}: ${model.name} (effort: ${efforts})\n`,
    );
  }
  const modelId = await answer(
    options.prompt,
    current === undefined ? "Model id: " : `Model id [${current.model}]: `,
    current?.model,
  );
  const model = selectable.find((candidate) => candidate.id === modelId);
  if (model === undefined) {
    throw new Error(
      `Copilot model is not available to this account: ${modelId}`,
    );
  }
  const supportedEfforts = model.supportedReasoningEfforts ?? [];
  const fallbackEffort =
    current?.model === modelId && current.effort !== undefined
      ? current.effort
      : (model.defaultReasoningEffort ?? "default");
  const effort = reasoningEffort(
    await answer(
      options.prompt,
      `Reasoning effort (${supportedEfforts.join(",") || "default only"}) [${fallbackEffort}]: `,
      fallbackEffort,
    ),
  );
  if (effort !== undefined && !supportedEfforts.includes(effort)) {
    throw new Error(
      `Copilot model ${modelId} does not support effort ${effort}`,
    );
  }
  return { model: modelId, ...(effort === undefined ? {} : { effort }) };
}

async function addAgent(options: ConfigMenuOptions): Promise<void> {
  const { config, prompt } = options;
  const firstAgent = Object.keys(config.agents).length === 0;
  const id = requireSafeIdentifier(
    await answer(prompt, "Agent id: "),
    "agent id",
  );
  if (config.agents[id] !== undefined)
    throw new Error(`agent already exists: ${id}`);
  const available = Object.keys(config.adapters).sort();
  await write(
    options.output,
    `Adapters: ${available.length === 0 ? "(none)" : available.join(", ")}\n`,
  );
  let adapter = await answer(prompt, "Adapter id (or 'new'): ", "new");
  if (adapter === "new") adapter = await createAdapter(config, prompt);
  if (config.adapters[adapter] === undefined)
    throw new Error(`unknown adapter: ${adapter}`);
  const selection = await copilotModelAndEffort(options, adapter);
  const purpose = await answer(prompt, "Purpose: ");
  const instructions = await answer(prompt, "Review instructions: ");
  const timeoutText = await answer(
    prompt,
    "Timeout milliseconds [900000]: ",
    "900000",
  );
  const timeout = timerMilliseconds(timeoutText, "timeout");
  const agent: ManagedAgent = {
    adapter,
    ...selection,
    purpose,
    instructions,
    isolation: yes(
      await answer(prompt, "Require enforced isolation? [y/N]: ", "n"),
    )
      ? "require_enforced"
      : "prefer_enforced",
    timeout_ms: timeout,
  };
  config.agents[id] = agent;
  if (
    firstAgent ||
    yes(await answer(prompt, "Enable by default? [Y/n]: ", "y"))
  ) {
    config.defaults ??= { agents: [] };
    config.defaults.agents.push(id);
  }
}

async function editAgent(options: ConfigMenuOptions): Promise<void> {
  const { config, prompt } = options;
  const id = await answer(prompt, "Agent id to edit: ");
  const current = config.agents[id];
  if (current === undefined) throw new Error(`unknown agent: ${id}`);
  await write(
    options.output,
    `Adapters: ${Object.keys(config.adapters).sort().join(", ")}\n`,
  );
  let adapter = await answer(
    prompt,
    `Adapter id (or 'new') [${current.adapter}]: `,
    current.adapter,
  );
  if (adapter === "new") adapter = await createAdapter(config, prompt);
  if (config.adapters[adapter] === undefined) {
    throw new Error(`unknown adapter: ${adapter}`);
  }
  const selection = await copilotModelAndEffort(options, adapter, current);
  const purpose = await answer(
    prompt,
    `Purpose [${current.purpose}]: `,
    current.purpose,
  );
  const instructions = await answer(
    prompt,
    "Review instructions [leave blank to keep current]: ",
  );
  const isolation = isolationPolicy(
    await answer(
      prompt,
      `Isolation [${current.isolation}]: `,
      current.isolation,
    ),
  );
  const timeout = timerMilliseconds(
    await answer(
      prompt,
      `Timeout milliseconds [${current.timeout_ms}]: `,
      String(current.timeout_ms),
    ),
    "timeout",
  );
  const edited: ManagedAgent = {
    ...current,
    adapter,
    ...selection,
    purpose,
    isolation,
    timeout_ms: timeout,
  };
  if (instructions !== "") {
    edited.instructions = instructions;
    delete edited.instructions_file;
  }
  config.agents[id] = edited;
  const isDefault = config.defaults?.agents.includes(id) === true;
  const makeDefault = yes(
    await answer(
      prompt,
      `Enable by default? [${isDefault ? "Y/n" : "y/N"}]: `,
      isDefault ? "y" : "n",
    ),
  );
  if (makeDefault) {
    config.defaults ??= { agents: [] };
    if (!config.defaults.agents.includes(id)) config.defaults.agents.push(id);
  } else if (config.defaults !== undefined) {
    config.defaults.agents = config.defaults.agents.filter(
      (candidate) => candidate !== id,
    );
    if (config.defaults.agents.length === 0) delete config.defaults;
  }
}

async function removeAgent(options: ConfigMenuOptions): Promise<void> {
  const id = await answer(options.prompt, "Agent id to remove: ");
  if (options.config.agents[id] === undefined)
    throw new Error(`unknown agent: ${id}`);
  if (Object.keys(options.config.agents).length === 1) {
    throw new Error("cannot remove the last configured agent");
  }
  if (
    !yes(
      await answer(
        options.prompt,
        `Remove ${id} and all assignments? [y/N]: `,
        "n",
      ),
    )
  ) {
    return;
  }
  delete options.config.agents[id];
  if (options.config.defaults !== undefined) {
    options.config.defaults.agents = options.config.defaults.agents.filter(
      (candidate) => candidate !== id,
    );
    if (options.config.defaults.agents.length === 0) {
      delete options.config.defaults;
    }
  }
  for (const [path, project] of Object.entries(options.config.projects ?? {})) {
    if (project.agents !== undefined) {
      project.agents = project.agents.filter((candidate) => candidate !== id);
      if (project.agents.length === 0) {
        if ((options.config.defaults?.agents.length ?? 0) > 0) {
          delete project.agents;
        } else {
          throw new Error(
            `cannot remove ${id}: project ${path} would have no enabled agents`,
          );
        }
      }
    }
  }
}

async function addProject(options: ConfigMenuOptions): Promise<void> {
  const projectPath = await canonicalProjectPath(
    await answer(options.prompt, "Project directory: "),
    options.cwd,
  );
  if (options.config.projects?.[projectPath] !== undefined) {
    throw new Error(`project already exists: ${projectPath}`);
  }
  await write(
    options.output,
    `Agents: ${Object.keys(options.config.agents).sort().join(", ")}\n`,
  );
  const agents = chooseAgents(
    await answer(options.prompt, "Enabled agents (comma-separated): "),
    options.config,
  );
  const instructions = await answer(
    options.prompt,
    "Additional project instructions [optional]: ",
  );
  const contextText = await answer(
    options.prompt,
    "Project context as JSON [optional]: ",
  );
  options.config.projects ??= {};
  options.config.projects[projectPath] = {
    agents,
    ...(instructions === "" ? {} : { instructions }),
    ...(contextText === "" ? {} : { context: optionalJson(contextText) }),
  };
}

async function editProject(options: ConfigMenuOptions): Promise<void> {
  const projectPath = await storedProjectPath(
    await answer(options.prompt, "Project directory to edit: "),
    options.config,
    options.cwd,
  );
  const project = options.config.projects?.[projectPath];
  if (project === undefined) throw new Error(`unknown project: ${projectPath}`);
  await write(
    options.output,
    `Agents: ${Object.keys(options.config.agents).sort().join(", ")}\n`,
  );
  const currentAgents = project.agents ?? options.config.defaults?.agents ?? [];
  project.agents = chooseAgents(
    await answer(
      options.prompt,
      `Enabled agents (comma-separated) [${currentAgents.join(",")}]: `,
      currentAgents.join(","),
    ),
    options.config,
  );
  const instructions = await answer(
    options.prompt,
    "Additional project instructions [blank keeps, '-' removes]: ",
  );
  if (instructions === "-") {
    delete project.instructions;
    delete project.instructions_file;
  } else if (instructions !== "") {
    project.instructions = instructions;
    delete project.instructions_file;
  }
  const contextText = await answer(
    options.prompt,
    "Project context JSON [blank keeps, '-' removes]: ",
  );
  if (contextText === "-") delete project.context;
  else if (contextText !== "") project.context = optionalJson(contextText);
}

async function editSettings(options: ConfigMenuOptions): Promise<void> {
  const { execution, diagnostics } = options.config;
  execution.max_concurrency = positiveInteger(
    await answer(
      options.prompt,
      `Maximum concurrency [${execution.max_concurrency}]: `,
      String(execution.max_concurrency),
    ),
    "maximum concurrency",
  );
  execution.heartbeat_interval_ms = timerMilliseconds(
    await answer(
      options.prompt,
      `Heartbeat interval milliseconds [${execution.heartbeat_interval_ms}]: `,
      String(execution.heartbeat_interval_ms),
    ),
    "heartbeat interval",
  );
  execution.shutdown_grace_period_ms = timerMilliseconds(
    await answer(
      options.prompt,
      `Shutdown grace period milliseconds [${execution.shutdown_grace_period_ms}]: `,
      String(execution.shutdown_grace_period_ms),
    ),
    "shutdown grace period",
  );
  diagnostics.persist_runs = yes(
    await answer(
      options.prompt,
      `Persist run records? [${diagnostics.persist_runs ? "Y/n" : "y/N"}]: `,
      diagnostics.persist_runs ? "y" : "n",
    ),
  );
  diagnostics.max_runs = positiveInteger(
    await answer(
      options.prompt,
      `Maximum retained runs [${diagnostics.max_runs}]: `,
      String(diagnostics.max_runs),
    ),
    "maximum retained runs",
  );
}

async function setDefaultAgents(options: ConfigMenuOptions): Promise<void> {
  await write(
    options.output,
    `Agents: ${Object.keys(options.config.agents).sort().join(", ")}\n`,
  );
  const current = options.config.defaults?.agents ?? [];
  const selected = chooseAgents(
    await answer(
      options.prompt,
      `Default agents in execution order${
        current.length === 0 ? "" : ` [${current.join(",")}]`
      }: `,
      current.length === 0 ? undefined : current.join(","),
    ),
    options.config,
  );
  options.config.defaults = { agents: selected };
}

async function removeProject(options: ConfigMenuOptions): Promise<void> {
  const projectPath = await storedProjectPath(
    await answer(options.prompt, "Project directory to remove: "),
    options.config,
    options.cwd,
  );
  if (options.config.projects?.[projectPath] === undefined) {
    throw new Error(`unknown project: ${projectPath}`);
  }
  if (!yes(await answer(options.prompt, `Remove ${projectPath}? [y/N]: `, "n")))
    return;
  delete options.config.projects[projectPath];
}

async function showList(options: ConfigMenuOptions): Promise<void> {
  const listed = listConfig(options.config);
  await write(options.output, "\nAdapters:\n");
  const adapters = Object.entries(options.config.adapters).sort(
    ([left], [right]) => left.localeCompare(right),
  );
  if (adapters.length === 0) await write(options.output, "  (none)\n");
  for (const [id, adapter] of adapters) {
    await write(options.output, `  ${id}: ${adapter.type}\n`);
  }
  await write(options.output, "\nAgents:\n");
  if (listed.agents.length === 0) await write(options.output, "  (none)\n");
  for (const agent of listed.agents) {
    await write(
      options.output,
      `  ${agent.id}${agent.default ? " [default]" : ""}: ${agent.model}${agent.effort === undefined ? "" : ` @ ${agent.effort}`} via ${agent.adapter}\n`,
    );
  }
  await write(options.output, "Projects:\n");
  if (listed.projects.length === 0) await write(options.output, "  (none)\n");
  for (const project of listed.projects) {
    await write(
      options.output,
      `  ${project.path}: ${project.agents.join(", ")}\n`,
    );
  }
}

export async function runConfigMenu(options: ConfigMenuOptions): Promise<void> {
  const prompt = new SignalPrompter(options.prompt, options.signal);
  options = { ...options, prompt };
  let snapshot = options.snapshot;
  const abort = () => options.prompt.close();
  options.signal?.addEventListener("abort", abort, { once: true });
  try {
    for (;;) {
      await write(
        options.output,
        [
          "\nReview Mesh configuration",
          `Config file: ${options.configFile}`,
          "l) List agents and projects",
          "a) Add agent",
          "e) Edit agent",
          "r) Remove agent",
          "p) Add project assignment",
          "o) Edit project assignment",
          "d) Remove project assignment",
          "g) Set default agents and order",
          "s) Global settings",
          "v) Validate and save",
          "q) Quit",
          "",
        ].join("\n"),
      );
      const choice = (
        await answer(options.prompt, "Choice: ", undefined, options.signal)
      ).toLowerCase();
      if (choice === "q") return;
      const before = structuredClone(options.config);
      try {
        let changed = false;
        if (choice === "l") await showList(options);
        else if (choice === "a") {
          await addAgent(options);
          changed = true;
        } else if (choice === "e") {
          await editAgent(options);
          changed = true;
        } else if (choice === "r") {
          await removeAgent(options);
          changed = true;
        } else if (choice === "p") {
          await addProject(options);
          changed = true;
        } else if (choice === "o") {
          await editProject(options);
          changed = true;
        } else if (choice === "d") {
          await removeProject(options);
          changed = true;
        } else if (choice === "g") {
          await setDefaultAgents(options);
          changed = true;
        } else if (choice === "s") {
          await editSettings(options);
          changed = true;
        } else if (choice === "v") changed = true;
        else throw new Error("unknown menu choice");

        if (changed) {
          snapshot = await saveManagedConfig(
            options.configFile,
            options.config,
            snapshot,
          );
          await write(options.output, "Configuration saved.\n");
        }
      } catch (error) {
        for (const key of Object.keys(options.config) as Array<
          keyof ManagedConfig
        >) {
          delete options.config[key];
        }
        Object.assign(options.config, before);
        await write(
          options.output,
          `Error: ${error instanceof Error ? error.message : "operation failed"}\n`,
        );
      }
    }
  } finally {
    options.signal?.removeEventListener("abort", abort);
    options.prompt.close();
  }
}

export function createReadlinePrompter(
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
): ConfigPrompter {
  const readline = createInterface({
    input: input as Readable,
    output: output as Writable,
    terminal: true,
  });
  return {
    ask: async (question, signal) => {
      if (signal?.aborted) {
        throw signal.reason ?? new Error("configuration interrupted");
      }
      return await readline.question(question, { signal });
    },
    close: () => readline.close(),
  };
}
