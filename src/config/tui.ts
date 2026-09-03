import { createInterface } from "node:readline/promises";
import type { Readable, Writable } from "node:stream";
import {
  supportedEffortsForAdapter,
  type AdapterRegistration,
  type ReasoningEffort,
} from "./schemas.js";
import type { CopilotAccountService } from "../copilot/account.js";
import type { JsonValue } from "../protocol/schemas.js";
import {
  listConfig,
  requireEnvironmentName,
  requireSafeIdentifier,
  saveManagedConfig,
  type ConfigSnapshot,
  type ManagedAgent,
  type ManagedConfig,
} from "./manage.js";
import { requireProjectName } from "./project-names.js";

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

interface ScalarModelSelection {
  model: string;
  effort?: ReasoningEffort | undefined;
}

interface ModelRunSelection extends ScalarModelSelection {
  id: string;
  adapter?: string | undefined;
  provider_group?: string | undefined;
  timeout_ms?: number | undefined;
}

type AgentModelSelection =
  | (ScalarModelSelection & { model_runs?: never })
  | { model_runs: ModelRunSelection[]; model?: never; effort?: never };

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

function storedProjectName(candidate: string, config: ManagedConfig): string {
  const projects = config.projects ?? {};
  const requested = requireProjectName(candidate);
  const match = Object.keys(projects).find(
    (name) =>
      name.toLocaleLowerCase("en-US") === requested.toLocaleLowerCase("en-US"),
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

async function modelAndEffort(
  options: ConfigMenuOptions,
  adapterId: string,
  current?: ScalarModelSelection,
): Promise<ScalarModelSelection> {
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

function scalarSelection(
  agent: ManagedAgent,
): ScalarModelSelection | undefined {
  return agent.model_runs === undefined
    ? {
        model: agent.model,
        ...(agent.effort === undefined ? {} : { effort: agent.effort }),
      }
    : undefined;
}

async function modelRuns(
  options: ConfigMenuOptions,
  parentAdapter: string,
  current: readonly ModelRunSelection[] = [],
  previousParentAdapter = parentAdapter,
): Promise<ModelRunSelection[]> {
  await write(
    options.output,
    `Adapters: ${Object.keys(options.config.adapters).sort().join(", ")}\n`,
  );
  const count = positiveInteger(
    await answer(
      options.prompt,
      `Number of model runs [${Math.max(current.length, 2)}]: `,
      String(Math.max(current.length, 2)),
    ),
    "model run count",
  );
  if (count < 2) {
    throw new Error("a multi-model agent requires at least two model runs");
  }

  const selected: ModelRunSelection[] = [];
  const ids = new Set<string>();
  for (let index = 0; index < count; index += 1) {
    const existing = current[index];
    const id = requireSafeIdentifier(
      await answer(
        options.prompt,
        existing === undefined
          ? `Model run ${index + 1} id: `
          : `Model run ${index + 1} id [${existing.id}]: `,
        existing?.id,
      ),
      "model run id",
    );
    if (ids.has(id)) throw new Error(`duplicate model run id: ${id}`);
    ids.add(id);

    let override: string;
    const overrideMode = (
      await answer(
        options.prompt,
        `Adapter selection for ${id} (inherit, existing, or create) [${existing?.adapter === undefined ? "inherit" : "existing"}]: `,
        existing?.adapter === undefined ? "inherit" : "existing",
      )
    ).toLowerCase();
    if (!new Set(["inherit", "existing", "create"]).has(overrideMode)) {
      throw new Error("adapter selection must be inherit, existing, or create");
    }
    if (overrideMode === "existing") {
      override = await answer(
        options.prompt,
        `Adapter id for ${id}${existing?.adapter === undefined ? "" : ` [${existing.adapter}]`}: `,
        existing?.adapter,
      );
    } else if (overrideMode === "create") {
      override = await createAdapter(options.config, options.prompt);
    } else {
      override = parentAdapter;
    }
    const effectiveAdapter = override;
    if (options.config.adapters[effectiveAdapter] === undefined) {
      throw new Error(`unknown adapter: ${effectiveAdapter}`);
    }
    const previousEffectiveAdapter =
      existing === undefined
        ? undefined
        : (existing.adapter ?? previousParentAdapter);
    const selection = await modelAndEffort(
      options,
      effectiveAdapter,
      previousEffectiveAdapter === effectiveAdapter ? existing : undefined,
    );
    selected.push({
      id,
      ...(overrideMode === "inherit" ? {} : { adapter: override }),
      ...selection,
      ...(existing?.provider_group === undefined
        ? {}
        : { provider_group: existing.provider_group }),
      ...(existing?.timeout_ms === undefined
        ? {}
        : { timeout_ms: existing.timeout_ms }),
    });
  }
  return selected;
}

async function agentModelSelection(
  options: ConfigMenuOptions,
  parentAdapter: string,
  current?: ManagedAgent,
): Promise<AgentModelSelection> {
  const currentScalar =
    current === undefined ? undefined : scalarSelection(current);
  const currentMode = current?.model_runs === undefined ? "single" : "multi";
  const mode = (
    await answer(
      options.prompt,
      `Model configuration (single or multi) [${currentMode}]: `,
      currentMode,
    )
  ).toLowerCase();
  if (mode !== "single" && mode !== "multi") {
    throw new Error("model configuration must be single or multi");
  }
  if (mode === "single") {
    return await modelAndEffort(options, parentAdapter, currentScalar);
  }

  const existingRuns =
    current?.model_runs ??
    (currentScalar === undefined
      ? []
      : [{ id: "primary", ...currentScalar } satisfies ModelRunSelection]);
  return {
    model_runs: await modelRuns(
      options,
      parentAdapter,
      existingRuns,
      current?.adapter ?? parentAdapter,
    ),
  };
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
  const selection = await agentModelSelection(options, adapter);
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
  const selection = await agentModelSelection(options, adapter, current);
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
  const instructionSelection =
    instructions !== ""
      ? { instructions }
      : current.instructions !== undefined
        ? { instructions: current.instructions }
        : { instructions_file: current.instructions_file! };
  const edited: ManagedAgent = {
    adapter,
    ...selection,
    purpose,
    ...instructionSelection,
    isolation,
    timeout_ms: timeout,
    ...(current.runtime === undefined ? {} : { runtime: current.runtime }),
    ...(current.applicability === undefined
      ? {}
      : { applicability: current.applicability }),
    ...(current.required_context === undefined
      ? {}
      : { required_context: current.required_context }),
    ...(current.pass_quorum === undefined
      ? {}
      : { pass_quorum: current.pass_quorum }),
    ...(current.minimum_provider_groups === undefined
      ? {}
      : { minimum_provider_groups: current.minimum_provider_groups }),
    ...(current.adjudication === undefined
      ? {}
      : { adjudication: current.adjudication }),
    ...(current.gate_minimum_severity === undefined
      ? {}
      : { gate_minimum_severity: current.gate_minimum_severity }),
    ...(current.gate_minimum_confidence === undefined
      ? {}
      : { gate_minimum_confidence: current.gate_minimum_confidence }),
  };
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
  for (const [name, project] of Object.entries(options.config.projects ?? {})) {
    if (project.agents !== undefined) {
      project.agents = project.agents.filter((candidate) => candidate !== id);
      if (project.agents.length === 0) {
        if ((options.config.defaults?.agents.length ?? 0) > 0) {
          delete project.agents;
        } else {
          throw new Error(
            `cannot remove ${id}: project ${name} would have no enabled agents`,
          );
        }
      }
    }
  }
}

async function addProject(options: ConfigMenuOptions): Promise<void> {
  const projectName = requireProjectName(
    await answer(options.prompt, "Project name: "),
  );
  if (
    Object.keys(options.config.projects ?? {}).some(
      (name) =>
        name.toLocaleLowerCase("en-US") ===
        projectName.toLocaleLowerCase("en-US"),
    )
  ) {
    throw new Error(`project already exists: ${projectName}`);
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
  options.config.projects[projectName] = {
    agents,
    ...(instructions === "" ? {} : { instructions }),
    ...(contextText === "" ? {} : { context: optionalJson(contextText) }),
  };
}

async function editProject(options: ConfigMenuOptions): Promise<void> {
  const projectName = storedProjectName(
    await answer(options.prompt, "Project name to edit: "),
    options.config,
  );
  const project = options.config.projects?.[projectName];
  if (project === undefined) throw new Error(`unknown project: ${projectName}`);
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
  const projectName = storedProjectName(
    await answer(options.prompt, "Project name to remove: "),
    options.config,
  );
  if (options.config.projects?.[projectName] === undefined) {
    throw new Error(`unknown project: ${projectName}`);
  }
  if (!yes(await answer(options.prompt, `Remove ${projectName}? [y/N]: `, "n")))
    return;
  delete options.config.projects[projectName];
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
    if ("model_runs" in agent) {
      await write(
        options.output,
        `  ${agent.id}${agent.default ? " [default]" : ""}: ${agent.model_runs.length} model runs\n`,
      );
      for (const run of agent.model_runs) {
        await write(
          options.output,
          `    ${agent.id}::${run.id}: ${run.model}${run.effort === undefined ? "" : ` @ ${run.effort}`} via ${run.adapter ?? agent.adapter}\n`,
        );
      }
    } else {
      await write(
        options.output,
        `  ${agent.id}${agent.default ? " [default]" : ""}: ${agent.model}${agent.effort === undefined ? "" : ` @ ${agent.effort}`} via ${agent.adapter}\n`,
      );
    }
  }
  await write(options.output, "Projects:\n");
  if (listed.projects.length === 0) await write(options.output, "  (none)\n");
  for (const project of listed.projects) {
    await write(
      options.output,
      `  ${project.name}: ${project.agents.join(", ")}\n`,
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
