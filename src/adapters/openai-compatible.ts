import { lstat, opendir, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { z } from "zod";
import type { AdapterRegistration } from "../config/schemas.js";
import { reviewerResultSchema } from "../protocol/schemas.js";
import { adapterFailure, type AdapterFailure } from "./errors.js";
import type {
  AdapterCapabilities,
  AdapterEvent,
  AdapterReviewInput,
  ReviewAdapter,
} from "./types.js";

const DEFAULT_REQUEST_TIMEOUT_MS = 180_000;
const DEFAULT_MAX_TURNS = 80;
const MAX_FILE_BYTES = 512 * 1_024;
const MAX_LIST_ENTRIES = 2_000;
const MAX_SEARCH_RESULTS = 200;
const MAX_PROVIDER_RESPONSE_BYTES = 8 * 1_024 * 1_024;
const MAX_TOOL_CALLS_PER_TURN = 32;
const MAX_PATH_LENGTH = 4_096;
const MAX_QUERY_LENGTH = 500;
const MAX_READ_LINES = 500;
const MAX_RETURNED_LINE_LENGTH = 1_000;
const SKIPPED_DIRECTORIES = new Set([
  ".git",
  ".git-recovered",
  ".worktrees",
  "node_modules",
  "dist",
  "coverage",
  ".review-mesh-runs",
]);
const ENFORCED_ISOLATION_FAILURE =
  "The OpenAI-compatible adapter provides runtime read-only tools, not an independently enforced filesystem boundary.";

type OpenAICompatibleRegistration = Extract<
  AdapterRegistration,
  { type: "openai_compatible" }
>;

export interface OpenAICompatibleAdapterDependencies {
  environment?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  requestTimeoutMs?: number;
  maxTurns?: number;
}

interface ProviderConfiguration {
  baseUrl: string;
  apiKey: string;
}

interface FileEntry {
  absolute: string;
  relative: string;
  size: number;
}

type ChatMessage = Record<string, unknown>;

const toolCallSchema = z.object({
  id: z.string().min(1),
  type: z.literal("function").optional(),
  function: z.object({
    name: z.string().min(1),
    arguments: z.string(),
  }),
});

const assistantMessageSchema = z.object({
  role: z.string().optional(),
  content: z.string().nullable().optional(),
  tool_calls: z.array(toolCallSchema).optional(),
});

const chatResponseSchema = z.object({
  choices: z
    .array(
      z.object({
        message: assistantMessageSchema,
      }),
    )
    .min(1),
});

const modelsResponseSchema = z.object({
  data: z.array(z.object({ id: z.string().min(1) })),
});

const listFilesArgumentsSchema = z.strictObject({
  path: z.string().max(MAX_PATH_LENGTH).optional(),
});

const readFileArgumentsSchema = z
  .strictObject({
    path: z.string().min(1).max(MAX_PATH_LENGTH),
    start_line: z.number().int().positive().optional(),
    end_line: z.number().int().positive().optional(),
  })
  .refine(
    (value) =>
      value.start_line === undefined ||
      value.end_line === undefined ||
      value.end_line >= value.start_line,
    "end_line must be greater than or equal to start_line",
  );

const searchTextArgumentsSchema = z.strictObject({
  query: z.string().min(1).max(MAX_QUERY_LENGTH),
  path: z.string().max(MAX_PATH_LENGTH).optional(),
  case_sensitive: z.boolean().optional(),
});

const READ_ONLY_TOOLS = [
  {
    type: "function",
    function: {
      name: "list_files",
      description:
        "List regular files recursively beneath an optional relative directory. Excludes internal metadata, dependencies, and generated output.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: { path: { type: "string", maxLength: MAX_PATH_LENGTH } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description:
        "Read a bounded UTF-8 regular file and return numbered lines.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["path"],
        properties: {
          path: { type: "string", minLength: 1, maxLength: MAX_PATH_LENGTH },
          start_line: { type: "integer", minimum: 1 },
          end_line: { type: "integer", minimum: 1 },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_text",
      description: "Find a literal string in bounded UTF-8 regular files.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["query"],
        properties: {
          query: { type: "string", minLength: 1, maxLength: MAX_QUERY_LENGTH },
          path: { type: "string", maxLength: MAX_PATH_LENGTH },
          case_sensitive: { type: "boolean" },
        },
      },
    },
  },
] as const;

class ProviderRequestError extends Error {
  constructor(readonly failure: AdapterFailure) {
    super(failure.message);
  }
}

function normalizedRelative(path: string): string {
  return path.split(sep).join("/");
}

function excludedPath(path: string): boolean {
  return path
    .replaceAll("\\", "/")
    .split("/")
    .some((part) => SKIPPED_DIRECTORIES.has(part.toLowerCase()));
}

function pathIsInside(root: string, target: string): boolean {
  const path = relative(root, target);
  return (
    path === "" ||
    (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`))
  );
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted)
    throw new ProviderRequestError(adapterFailure.cancelled());
}

class ReadOnlyWorkspace {
  private canonicalWorkspace?: Promise<string>;

  constructor(private readonly workspace: string) {}

  private root(): Promise<string> {
    this.canonicalWorkspace ??= realpath(this.workspace);
    return this.canonicalWorkspace;
  }

  private async confinedPath(candidate = "."): Promise<string> {
    if (
      typeof candidate !== "string" ||
      candidate.length > MAX_PATH_LENGTH ||
      candidate.includes("\0") ||
      excludedPath(candidate)
    ) {
      throw new Error("The requested path is unavailable.");
    }

    const workspace = await this.root();
    const target = resolve(workspace, candidate);
    if (!pathIsInside(workspace, target)) {
      throw new Error("The requested path escapes the reviewed workspace.");
    }

    const canonical = await realpath(target);
    const canonicalRelative = relative(workspace, canonical);
    if (
      !pathIsInside(workspace, canonical) ||
      excludedPath(canonicalRelative)
    ) {
      throw new Error("The requested path is unavailable.");
    }
    return canonical;
  }

  private async collectFiles(
    relativeRoot: string,
    signal: AbortSignal,
  ): Promise<{ files: FileEntry[]; truncated: boolean }> {
    throwIfAborted(signal);
    const workspace = await this.root();
    const root = await this.confinedPath(relativeRoot);
    const files: FileEntry[] = [];
    let truncated = false;
    let visitedEntries = 0;

    const walk = async (directory: string): Promise<void> => {
      throwIfAborted(signal);
      const stream = await opendir(directory);
      for await (const entry of stream) {
        throwIfAborted(signal);
        visitedEntries += 1;
        if (visitedEntries > MAX_LIST_ENTRIES) {
          truncated = true;
          return;
        }
        if (SKIPPED_DIRECTORIES.has(entry.name.toLowerCase())) continue;
        const absolute = resolve(directory, entry.name);
        const metadata = await lstat(absolute);
        if (metadata.isSymbolicLink()) continue;
        if (metadata.isDirectory()) {
          await walk(absolute);
          if (truncated) return;
        } else if (metadata.isFile() && metadata.size <= MAX_FILE_BYTES) {
          files.push({
            absolute,
            relative: normalizedRelative(relative(workspace, absolute)),
            size: metadata.size,
          });
        }
      }
    };

    await walk(root);
    files.sort((left, right) => left.relative.localeCompare(right.relative));
    return { files, truncated };
  }

  async listFiles(path: string | undefined, signal: AbortSignal) {
    try {
      const result = await this.collectFiles(path ?? ".", signal);
      return {
        files: result.files.map((file) => ({
          path: file.relative,
          size: file.size,
        })),
        truncated: result.truncated,
      };
    } catch (error) {
      if (error instanceof ProviderRequestError) throw error;
      return { error: "The requested directory could not be listed." };
    }
  }

  async readText(
    path: string,
    startLine: number | undefined,
    endLine: number | undefined,
    signal: AbortSignal,
  ) {
    try {
      throwIfAborted(signal);
      const workspace = await this.root();
      const file = await this.confinedPath(path);
      const metadata = await lstat(file);
      if (!metadata.isFile() || metadata.size > MAX_FILE_BYTES) {
        return { error: "The requested file is unavailable." };
      }
      const text = await readFile(file, { encoding: "utf8", signal });
      if (text.includes("\0")) {
        return { error: "The requested file is not supported text." };
      }
      const lines = text.split(/\r?\n/);
      const start = Math.min(lines.length || 1, startLine ?? 1);
      const requestedEnd = endLine ?? start + MAX_READ_LINES - 1;
      const end = Math.min(
        lines.length,
        Math.max(start, Math.min(requestedEnd, start + MAX_READ_LINES - 1)),
      );
      return {
        path: normalizedRelative(relative(workspace, file)),
        start_line: start,
        end_line: end,
        content: lines
          .slice(start - 1, end)
          .map(
            (line, index) =>
              `${start + index}: ${line.slice(0, MAX_RETURNED_LINE_LENGTH)}`,
          )
          .join("\n"),
        truncated: end < lines.length,
      };
    } catch (error) {
      if (signal.aborted)
        throw new ProviderRequestError(adapterFailure.cancelled());
      return { error: "The requested file could not be read." };
    }
  }

  async searchText(
    query: string,
    path: string | undefined,
    caseSensitive: boolean,
    signal: AbortSignal,
  ) {
    try {
      const collected = await this.collectFiles(path ?? ".", signal);
      const needle = caseSensitive ? query : query.toLowerCase();
      const matches: Array<{ path: string; line: number; text: string }> = [];

      for (const file of collected.files) {
        throwIfAborted(signal);
        let text: string;
        try {
          text = await readFile(file.absolute, { encoding: "utf8", signal });
        } catch {
          if (signal.aborted) {
            throw new ProviderRequestError(adapterFailure.cancelled());
          }
          continue;
        }
        if (text.includes("\0")) continue;
        const lines = text.split(/\r?\n/);
        for (let index = 0; index < lines.length; index += 1) {
          const line = lines[index] ?? "";
          const haystack = caseSensitive ? line : line.toLowerCase();
          if (!haystack.includes(needle)) continue;
          matches.push({
            path: file.relative,
            line: index + 1,
            text: line.slice(0, MAX_RETURNED_LINE_LENGTH),
          });
          if (matches.length >= MAX_SEARCH_RESULTS) {
            return { matches, truncated: true };
          }
        }
      }
      return { matches, truncated: collected.truncated };
    } catch (error) {
      if (error instanceof ProviderRequestError) throw error;
      return { error: "The requested text search could not be completed." };
    }
  }
}

function providerFailureForStatus(
  status: number,
  operation: "probe" | "chat",
): AdapterFailure {
  if (status === 401 || status === 403) {
    return adapterFailure.authentication(
      "The OpenAI-compatible endpoint rejected authentication.",
    );
  }
  if (status === 404 && operation === "chat") {
    return adapterFailure.modelUnavailable(
      "The OpenAI-compatible endpoint could not serve the configured model.",
    );
  }
  if (status === 408 || status === 429 || status >= 500) {
    return adapterFailure.unknown(
      "The OpenAI-compatible endpoint is temporarily unavailable.",
      true,
    );
  }
  return adapterFailure.unavailable(
    operation === "probe"
      ? "The OpenAI-compatible models endpoint rejected the readiness check."
      : "The OpenAI-compatible endpoint rejected the review request.",
  );
}

function headerValue(
  headers: HeadersInit | undefined,
  name: string,
): string | undefined {
  if (headers === undefined) return undefined;
  const normalized = name.toLowerCase();
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  if (Array.isArray(headers)) {
    return headers.find(([key]) => key.toLowerCase() === normalized)?.[1];
  }
  const value = Object.entries(headers).find(
    ([key]) => key.toLowerCase() === normalized,
  )?.[1];
  return value === undefined ? undefined : String(value);
}

function safeBaseUrl(value: string): string | undefined {
  try {
    const parsed = new URL(value);
    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.search !== "" ||
      parsed.hash !== ""
    ) {
      return undefined;
    }
    return value.replace(/\/+$/, "");
  } catch {
    return undefined;
  }
}

function publicAssistantMessage(
  message: z.infer<typeof assistantMessageSchema>,
): ChatMessage {
  return {
    role: "assistant",
    ...(message.content === undefined ? {} : { content: message.content }),
    ...(message.tool_calls === undefined
      ? {}
      : { tool_calls: message.tool_calls }),
  };
}

class OpenAICompatibleAdapter implements ReviewAdapter {
  readonly id = "openai_compatible";
  private readonly environment: NodeJS.ProcessEnv;
  private readonly fetchFacade: typeof fetch;
  private readonly requestTimeoutMs: number;
  private readonly maxTurns: number;
  private readonly activeRequests = new Set<AbortController>();

  constructor(
    private readonly registration: OpenAICompatibleRegistration,
    dependencies: OpenAICompatibleAdapterDependencies,
  ) {
    this.environment = dependencies.environment ?? process.env;
    this.fetchFacade = dependencies.fetch ?? globalThis.fetch;
    this.requestTimeoutMs =
      dependencies.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.maxTurns = dependencies.maxTurns ?? DEFAULT_MAX_TURNS;
  }

  private configuration(): ProviderConfiguration | AdapterFailure {
    const apiKey = this.environment[this.registration.api_key_env];
    if (apiKey === undefined || apiKey.trim() === "") {
      return adapterFailure.authentication(
        "The configured OpenAI-compatible API key environment variable is unavailable.",
      );
    }
    const configuredBaseUrl = this.environment[this.registration.base_url_env];
    const baseUrl =
      configuredBaseUrl === undefined
        ? undefined
        : safeBaseUrl(configuredBaseUrl.trim());
    if (baseUrl === undefined || baseUrl === "") {
      return adapterFailure.unavailable(
        "The configured OpenAI-compatible base URL environment variable is unavailable or invalid.",
      );
    }
    return { baseUrl, apiKey };
  }

  private async requestJson(
    configuration: ProviderConfiguration,
    path: string,
    operation: "probe" | "chat",
    signal: AbortSignal,
    init: Omit<RequestInit, "signal">,
  ): Promise<unknown> {
    throwIfAborted(signal);
    const contentType = headerValue(init.headers, "content-type");
    if (
      typeof init.body === "string" &&
      contentType?.toLowerCase().includes("application/json") === true &&
      Buffer.byteLength(init.body, "utf8") > MAX_PROVIDER_RESPONSE_BYTES
    ) {
      throw new ProviderRequestError(
        adapterFailure.protocolViolation(
          "The OpenAI-compatible review request exceeded the size limit.",
        ),
      );
    }
    const controller = new AbortController();
    let timedOut = false;
    const abort = () => controller.abort(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error("Provider request deadline expired."));
    }, this.requestTimeoutMs);
    this.activeRequests.add(controller);

    try {
      const response = await this.fetchFacade(
        `${configuration.baseUrl}${path}`,
        {
          ...init,
          redirect: "error",
          signal: controller.signal,
          headers: {
            Authorization: `Bearer ${configuration.apiKey}`,
            ...init.headers,
          },
        },
      );
      if (!response.ok) {
        try {
          await response.body?.cancel();
        } catch {
          // The response body is untrusted and is never published.
        }
        throw new ProviderRequestError(
          providerFailureForStatus(response.status, operation),
        );
      }
      try {
        const contentLength = response.headers.get("content-length");
        if (
          contentLength !== null &&
          Number.parseInt(contentLength, 10) > MAX_PROVIDER_RESPONSE_BYTES
        ) {
          await response.body?.cancel();
          throw new ProviderRequestError(
            adapterFailure.protocolViolation(
              "The OpenAI-compatible endpoint returned an oversized response.",
            ),
          );
        }
        const reader = response.body?.getReader();
        if (reader === undefined) {
          throw new ProviderRequestError(
            adapterFailure.protocolViolation(
              "The OpenAI-compatible endpoint returned no response body.",
            ),
          );
        }
        const chunks: Uint8Array[] = [];
        let length = 0;
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          length += chunk.value.byteLength;
          if (length > MAX_PROVIDER_RESPONSE_BYTES) {
            await reader.cancel();
            throw new ProviderRequestError(
              adapterFailure.protocolViolation(
                "The OpenAI-compatible endpoint returned an oversized response.",
              ),
            );
          }
          chunks.push(chunk.value);
        }
        const bytes = new Uint8Array(length);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
        return JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        );
      } catch (error) {
        if (error instanceof ProviderRequestError) throw error;
        if (signal.aborted) {
          throw new ProviderRequestError(adapterFailure.cancelled());
        }
        if (timedOut) {
          throw new ProviderRequestError(
            adapterFailure.timeout(
              "The OpenAI-compatible endpoint exceeded the request deadline.",
            ),
          );
        }
        throw new ProviderRequestError(
          adapterFailure.protocolViolation(
            "The OpenAI-compatible endpoint returned invalid JSON.",
          ),
        );
      }
    } catch (error) {
      if (error instanceof ProviderRequestError) throw error;
      if (signal.aborted) {
        throw new ProviderRequestError(adapterFailure.cancelled());
      }
      if (timedOut) {
        throw new ProviderRequestError(
          adapterFailure.timeout(
            "The OpenAI-compatible endpoint exceeded the request deadline.",
          ),
        );
      }
      throw new ProviderRequestError(
        adapterFailure.unavailable(
          "The OpenAI-compatible endpoint could not be reached.",
          true,
        ),
      );
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
      this.activeRequests.delete(controller);
    }
  }

  private async chat(
    configuration: ProviderConfiguration,
    signal: AbortSignal,
    body: Record<string, unknown>,
  ) {
    const response = await this.requestJson(
      configuration,
      "/chat/completions",
      "chat",
      signal,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    const parsed = chatResponseSchema.safeParse(response);
    if (!parsed.success) {
      throw new ProviderRequestError(
        adapterFailure.protocolViolation(
          "The OpenAI-compatible endpoint returned an invalid chat response.",
        ),
      );
    }
    return parsed.data.choices[0]!.message;
  }

  async probe(
    reviewer: AdapterReviewInput["reviewer"],
    signal: AbortSignal,
  ): Promise<AdapterCapabilities> {
    const base: Omit<AdapterCapabilities, "available"> = {
      authenticated: "unknown",
      model_available: "unknown",
      streaming: false,
      cancellation: true,
      maximumIsolation: "runtime_read_only",
    };
    const configuration = this.configuration();
    if ("reason" in configuration) {
      return {
        ...base,
        available: false,
        authenticated:
          configuration.reason === "authentication_failed" ? false : "unknown",
        message: configuration.message,
      };
    }
    if (reviewer.isolationPolicy === "require_enforced") {
      return {
        ...base,
        available: false,
        authenticated: true,
        message: ENFORCED_ISOLATION_FAILURE,
      };
    }
    if (signal.aborted) {
      return {
        ...base,
        available: false,
        authenticated: true,
        message: "The OpenAI-compatible readiness check was cancelled.",
      };
    }

    try {
      const response = await this.requestJson(
        configuration,
        "/models",
        "probe",
        signal,
        { method: "GET" },
      );
      const parsed = modelsResponseSchema.safeParse(response);
      if (!parsed.success) {
        return {
          ...base,
          available: false,
          authenticated: true,
          message:
            "The OpenAI-compatible models endpoint returned an invalid readiness response.",
        };
      }
      const modelAvailable = parsed.data.data.some(
        (model) => model.id === reviewer.model,
      );
      return {
        ...base,
        available: modelAvailable,
        authenticated: true,
        model_available: modelAvailable,
        ...(!modelAvailable
          ? { message: "The configured reviewer model is unavailable." }
          : {}),
      };
    } catch (error) {
      const failure =
        error instanceof ProviderRequestError
          ? error.failure
          : adapterFailure.unavailable(
              "The OpenAI-compatible readiness check failed.",
              true,
            );
      return {
        ...base,
        available: false,
        authenticated:
          failure.reason === "authentication_failed" ? false : "unknown",
        message: failure.message,
      };
    }
  }

  private async runTool(
    workspace: ReadOnlyWorkspace,
    name: string,
    encodedArguments: string,
    signal: AbortSignal,
  ): Promise<unknown> {
    let argumentsValue: unknown;
    try {
      argumentsValue = JSON.parse(encodedArguments || "{}");
    } catch {
      return { error: "The inspection tool arguments are invalid." };
    }

    if (name === "list_files") {
      const parsed = listFilesArgumentsSchema.safeParse(argumentsValue);
      return parsed.success
        ? workspace.listFiles(parsed.data.path, signal)
        : { error: "The inspection tool arguments are invalid." };
    }
    if (name === "read_file") {
      const parsed = readFileArgumentsSchema.safeParse(argumentsValue);
      return parsed.success
        ? workspace.readText(
            parsed.data.path,
            parsed.data.start_line,
            parsed.data.end_line,
            signal,
          )
        : { error: "The inspection tool arguments are invalid." };
    }
    if (name === "search_text") {
      const parsed = searchTextArgumentsSchema.safeParse(argumentsValue);
      return parsed.success
        ? workspace.searchText(
            parsed.data.query,
            parsed.data.path,
            parsed.data.case_sensitive === true,
            signal,
          )
        : { error: "The inspection tool arguments are invalid." };
    }
    return { error: "The requested inspection tool is unsupported." };
  }

  async *run(input: AdapterReviewInput): AsyncIterable<AdapterEvent> {
    const isolation = "runtime_read_only" as const;
    if (input.isolationPolicy === "require_enforced") {
      yield {
        type: "failure",
        failure: adapterFailure.unavailable(ENFORCED_ISOLATION_FAILURE),
        isolation,
      };
      return;
    }
    if (input.signal.aborted) {
      yield {
        type: "failure",
        failure: adapterFailure.cancelled(),
        isolation,
      };
      return;
    }
    const configuration = this.configuration();
    if ("reason" in configuration) {
      yield { type: "failure", failure: configuration, isolation };
      return;
    }

    const workspace = new ReadOnlyWorkspace(input.context.workspace);
    const system = [
      input.prompt.system,
      "# TRUSTED TOOL POLICY",
      "Use only list_files, read_file, and search_text.",
      "Never execute shell commands, command-line tools, programs, scripts, builds, tests, Git commands, or code.",
      "Never write, edit, create, delete, rename, or change permissions on files.",
      "Never request any other capability.",
      "Inspect enough relevant source and tests to substantiate the verdict.",
    ].join("\n\n");
    const messages: ChatMessage[] = [
      { role: "system", content: system },
      { role: "user", content: input.prompt.user },
    ];

    yield {
      type: "progress",
      phase: "reviewing",
      message:
        "The OpenAI-compatible reviewer is inspecting repository files with bounded read-only tools.",
    };

    try {
      for (let turn = 0; turn < this.maxTurns; turn += 1) {
        const message = await this.chat(configuration, input.signal, {
          model: input.reviewer.model,
          messages,
          tools: READ_ONLY_TOOLS,
          tool_choice: turn === 0 ? "required" : "auto",
          max_tokens: 8_192,
        });
        messages.push(publicAssistantMessage(message));
        const toolCalls = message.tool_calls ?? [];
        if (toolCalls.length > MAX_TOOL_CALLS_PER_TURN) {
          throw new ProviderRequestError(
            adapterFailure.protocolViolation(
              "The OpenAI-compatible endpoint returned too many inspection tool calls.",
            ),
          );
        }
        if (toolCalls.length > 0) {
          for (const call of toolCalls) {
            const result = await this.runTool(
              workspace,
              call.function.name,
              call.function.arguments,
              input.signal,
            );
            messages.push({
              role: "tool",
              tool_call_id: call.id,
              content: JSON.stringify(result),
            });
          }
          yield {
            type: "activity",
            message:
              "The reviewer completed a bounded read-only inspection step.",
          };
          continue;
        }

        messages.push({
          role: "user",
          content:
            "Return the final reviewer result now. Do not call tools. Follow the supplied JSON Schema exactly.",
        });
        yield {
          type: "progress",
          phase: "validating",
          message: "The reviewer is producing its structured result.",
        };
        const finalMessage = await this.chat(configuration, input.signal, {
          model: input.reviewer.model,
          messages,
          response_format: {
            type: "json_schema",
            json_schema: {
              name: "reviewer_result",
              strict: true,
              schema: input.resultJsonSchema,
            },
          },
          max_tokens: 8_192,
        });
        if (
          typeof finalMessage.content !== "string" ||
          finalMessage.content.trim() === ""
        ) {
          throw new ProviderRequestError(
            adapterFailure.invalidResult(
              "The OpenAI-compatible endpoint returned no structured reviewer result.",
            ),
          );
        }
        let parsedJson: unknown;
        try {
          parsedJson = JSON.parse(finalMessage.content);
        } catch {
          throw new ProviderRequestError(
            adapterFailure.invalidResult(
              "The OpenAI-compatible endpoint returned invalid structured reviewer JSON.",
            ),
          );
        }
        const parsedResult = reviewerResultSchema.safeParse(parsedJson);
        if (!parsedResult.success) {
          throw new ProviderRequestError(
            adapterFailure.invalidResult(
              "The OpenAI-compatible endpoint returned a reviewer result that violates the required schema.",
            ),
          );
        }
        yield { type: "result", result: parsedResult.data, isolation };
        return;
      }

      yield {
        type: "failure",
        failure: adapterFailure.timeout(
          "The OpenAI-compatible reviewer exceeded its bounded inspection turn limit.",
        ),
        isolation,
      };
    } catch (error) {
      const failure = input.signal.aborted
        ? adapterFailure.cancelled()
        : error instanceof ProviderRequestError
          ? error.failure
          : adapterFailure.unknown(
              "The OpenAI-compatible reviewer failed without a safe diagnostic.",
            );
      yield { type: "failure", failure, isolation };
    }
  }

  async forceCleanup(): Promise<void> {
    for (const controller of this.activeRequests) {
      controller.abort(new Error("Review Mesh forced adapter cleanup."));
    }
  }
}

export function createOpenAICompatibleAdapter(
  registration: AdapterRegistration,
  dependencies: OpenAICompatibleAdapterDependencies = {},
): ReviewAdapter {
  if (registration.type !== "openai_compatible") {
    throw new Error("Expected an OpenAI-compatible adapter registration.");
  }
  return new OpenAICompatibleAdapter(registration, dependencies);
}
