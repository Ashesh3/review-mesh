import { randomUUID } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import {
  lstat,
  open,
  opendir,
  realpath,
  type FileHandle,
} from "node:fs/promises";
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
const MAX_SNAPSHOT_BYTES = 32 * 1_024 * 1_024;
const MAX_LIST_ENTRIES = 2_000;
const MAX_SEARCH_RESULTS = 200;
const MAX_PROVIDER_RESPONSE_BYTES = 8 * 1_024 * 1_024;
const MAX_TOOL_RESULT_BYTES = 128 * 1_024;
const MAX_CONVERSATION_BYTES = 6 * 1_024 * 1_024;
const FINALIZATION_RESERVE_BYTES = 256 * 1_024;
const MAX_ASSISTANT_MESSAGE_BYTES = 512 * 1_024;
const MAX_TOOL_ARGUMENT_BYTES = 16 * 1_024;
const MAX_TOOL_CALLS_PER_TURN = 32;
const MAX_PATH_LENGTH = 4_096;
const MAX_QUERY_LENGTH = 500;
const MAX_READ_LINES = 500;
const MAX_RETURNED_LINE_LENGTH = 1_000;
const MAX_CONTENT_PARTS = 1_024;
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
  sessionIdFactory?: () => string;
  requestTimeoutMs?: number;
  maxTurns?: number;
  workspaceHooks?: ReadOnlyWorkspaceHooks;
  fileSystemIdentity?: FileSystemIdentityFacade;
  maxSnapshotBytes?: number;
  maxToolResultBytes?: number;
  maxConversationBytes?: number;
}

export interface ReadOnlyWorkspaceHooks {
  beforeDirectoryOpen?(path: string): void | Promise<void>;
  afterDirectoryOpen?(path: string): void | Promise<void>;
  beforeFileOpen?(path: string): void | Promise<void>;
  afterFileOpen?(path: string): void | Promise<void>;
  afterFileValidation?(path: string): void | Promise<void>;
  betweenSnapshotReads?(path: string): void | Promise<void>;
  snapshotBuildPaused?(): void | Promise<void>;
}

export interface FileSystemIdentityFacade {
  lstat(path: string): Promise<BigIntStats>;
  realpath(path: string): Promise<string>;
}

interface ProviderConfiguration {
  baseUrl: string;
  apiKey: string;
}

interface OpenedFile {
  handle: FileHandle;
  relative: string;
  metadata: BigIntStats;
}

interface SnapshotFile {
  relative: string;
  size: number;
  text: string;
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

const assistantContentPartSchema = z
  .object({
    type: z.string().optional(),
    text: z.string(),
  })
  .superRefine((part, context) => {
    if (part.type !== undefined && part.type !== "text") {
      context.addIssue({
        code: "custom",
        message: "Only text assistant content parts are supported.",
      });
    }
  });

const assistantMessageSchema = z.object({
  role: z.string().optional(),
  content: z
    .union([
      z.string(),
      z.null(),
      z.array(assistantContentPartSchema).max(MAX_CONTENT_PARTS),
    ])
    .optional(),
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
  return process.platform === "win32" ? path.replaceAll("\\", "/") : path;
}

function excludedPath(path: string): boolean {
  const normalized =
    process.platform === "win32" ? path.replaceAll("\\", "/") : path;
  return normalized
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

const noFollowFlag =
  (constants as unknown as Record<string, number>).O_NOFOLLOW ?? 0;
const nonBlockFlag =
  (constants as unknown as Record<string, number>).O_NONBLOCK ?? 0;
const readOnlyNoFollowFlags = constants.O_RDONLY | noFollowFlag | nonBlockFlag;

function sameFile(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function hasStableIdentity(metadata: BigIntStats): boolean {
  return metadata.dev !== 0n && metadata.ino !== 0n;
}

function sameCaptureMetadata(left: BigIntStats, right: BigIntStats): boolean {
  return (
    hasStableIdentity(left) &&
    hasStableIdentity(right) &&
    sameFile(left, right) &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

async function readBoundedBytes(
  handle: FileHandle,
  signal: AbortSignal,
): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(MAX_FILE_BYTES + 1);
  let offset = 0;
  while (offset < buffer.length) {
    throwIfAborted(signal);
    const { bytesRead } = await handle.read(
      buffer,
      offset,
      buffer.length - offset,
      offset,
    );
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  if (offset > MAX_FILE_BYTES) {
    throw new Error("The requested file exceeds the read limit.");
  }
  return buffer.subarray(0, offset);
}

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

class ReadOnlyWorkspace {
  private canonicalWorkspace?: Promise<{ path: string; identity: BigIntStats }>;
  private snapshot?: Promise<{
    files: SnapshotFile[];
    truncated: boolean;
  }>;
  private readonly buildController = new AbortController();
  private disposed = false;

  constructor(
    private readonly workspace: string,
    private readonly hooks: ReadOnlyWorkspaceHooks = {},
    private readonly fileSystemIdentity: FileSystemIdentityFacade = {
      lstat: (path) => lstat(path, { bigint: true }),
      realpath,
    },
    private readonly maxSnapshotBytes = MAX_SNAPSHOT_BYTES,
  ) {}

  private root(): Promise<{ path: string; identity: BigIntStats }> {
    this.canonicalWorkspace ??= (async () => {
      const path = await this.fileSystemIdentity.realpath(this.workspace);
      const identity = await this.fileSystemIdentity.lstat(path);
      if (!identity.isDirectory() || !hasStableIdentity(identity)) {
        throw new ProviderRequestError(
          adapterFailure.read(
            "The reviewed workspace does not expose a stable filesystem identity.",
          ),
        );
      }
      return { path, identity };
    })();
    return this.canonicalWorkspace;
  }

  private async verifyRoot(): Promise<{ path: string; identity: BigIntStats }> {
    const root = await this.root();
    const canonical = await this.fileSystemIdentity.realpath(this.workspace);
    const current = await this.fileSystemIdentity.lstat(canonical);
    if (
      resolve(canonical).toLowerCase() !== resolve(root.path).toLowerCase() ||
      !current.isDirectory() ||
      !hasStableIdentity(current) ||
      !sameFile(root.identity, current)
    ) {
      throw new ProviderRequestError(
        adapterFailure.read(
          "The reviewed workspace changed identity while its snapshot was built.",
        ),
      );
    }
    return root;
  }

  private throwIfDisposed(signal: AbortSignal): void {
    throwIfAborted(signal);
    throwIfAborted(this.buildController.signal);
    if (this.disposed) {
      throw new ProviderRequestError(adapterFailure.cancelled());
    }
  }

  private async confinedCanonicalPath(target: string): Promise<string> {
    const workspace = (await this.verifyRoot()).path;
    const canonical = await this.fileSystemIdentity.realpath(target);
    const canonicalRelative = relative(workspace, canonical);
    if (
      !pathIsInside(workspace, canonical) ||
      excludedPath(canonicalRelative)
    ) {
      throw new Error("The requested path is unavailable.");
    }
    return canonical;
  }

  private async openedPathIsSafe(
    absolute: string,
    opened: BigIntStats,
  ): Promise<boolean> {
    const workspace = (await this.verifyRoot()).path;
    const before = await this.fileSystemIdentity.lstat(absolute);
    if (
      !hasStableIdentity(opened) ||
      !hasStableIdentity(before) ||
      before.isSymbolicLink() ||
      !before.isFile() ||
      !sameFile(opened, before)
    ) {
      return false;
    }
    const canonical = await this.confinedCanonicalPath(absolute);
    const after = await this.fileSystemIdentity.lstat(absolute);
    return (
      hasStableIdentity(after) &&
      pathIsInside(workspace, canonical) &&
      !excludedPath(relative(workspace, canonical)) &&
      !after.isSymbolicLink() &&
      after.isFile() &&
      sameFile(opened, after) &&
      sameFile(before, after)
    );
  }

  private async openRegularFile(
    absolute: string,
    signal: AbortSignal,
  ): Promise<OpenedFile> {
    this.throwIfDisposed(signal);
    const workspace = (await this.verifyRoot()).path;
    if (
      !pathIsInside(workspace, absolute) ||
      excludedPath(relative(workspace, absolute))
    ) {
      throw new Error("The requested file is unavailable.");
    }

    await this.hooks.beforeFileOpen?.(absolute);
    let handle: FileHandle | undefined;
    try {
      handle = await open(absolute, readOnlyNoFollowFlags);
      await this.hooks.afterFileOpen?.(absolute);
      this.throwIfDisposed(signal);
      const metadata = await handle.stat({ bigint: true });
      if (!hasStableIdentity(metadata)) {
        throw new ProviderRequestError(
          adapterFailure.read(
            "A workspace file does not expose a stable filesystem identity.",
          ),
        );
      }
      if (
        !metadata.isFile() ||
        metadata.size > BigInt(MAX_FILE_BYTES) ||
        !(await this.openedPathIsSafe(absolute, metadata))
      ) {
        throw new Error("The requested file is unavailable.");
      }
      await this.hooks.afterFileValidation?.(absolute);
      return {
        handle,
        relative: normalizedRelative(relative(workspace, absolute)),
        metadata,
      };
    } catch (error) {
      await handle?.close().catch(() => undefined);
      throw error;
    }
  }

  private async openConfinedDirectory(absolute: string, signal: AbortSignal) {
    this.throwIfDisposed(signal);
    const before = await this.fileSystemIdentity.lstat(absolute);
    if (!hasStableIdentity(before)) {
      throw new ProviderRequestError(
        adapterFailure.read(
          "A workspace directory does not expose a stable filesystem identity.",
        ),
      );
    }
    if (before.isSymbolicLink() || !before.isDirectory()) {
      throw new Error("The requested directory is unavailable.");
    }
    await this.confinedCanonicalPath(absolute);
    await this.hooks.beforeDirectoryOpen?.(absolute);
    const stream = await opendir(absolute);
    try {
      await this.hooks.afterDirectoryOpen?.(absolute);
      const after = await this.fileSystemIdentity.lstat(absolute);
      if (!hasStableIdentity(after)) {
        throw new ProviderRequestError(
          adapterFailure.read(
            "A workspace directory does not expose a stable filesystem identity.",
          ),
        );
      }
      await this.confinedCanonicalPath(absolute);
      if (
        after.isSymbolicLink() ||
        !after.isDirectory() ||
        !sameFile(before, after)
      ) {
        throw new Error("The requested directory changed while opening.");
      }
      return stream;
    } catch (error) {
      await stream.close().catch(() => undefined);
      throw error;
    }
  }

  private createSnapshot(signal: AbortSignal): Promise<{
    files: SnapshotFile[];
    truncated: boolean;
  }> {
    this.throwIfDisposed(signal);
    this.snapshot ??= this.buildSnapshot(signal);
    return this.snapshot;
  }

  private async buildSnapshot(signal: AbortSignal): Promise<{
    files: SnapshotFile[];
    truncated: boolean;
  }> {
    this.throwIfDisposed(signal);
    const root = (await this.verifyRoot()).path;
    await this.hooks.snapshotBuildPaused?.();
    this.throwIfDisposed(signal);
    const files: SnapshotFile[] = [];
    let truncated = false;
    let visitedEntries = 0;
    let totalBytes = 0;

    const walk = async (directory: string): Promise<void> => {
      this.throwIfDisposed(signal);
      await this.verifyRoot();
      const stream = await this.openConfinedDirectory(directory, signal);
      for await (const entry of stream) {
        this.throwIfDisposed(signal);
        visitedEntries += 1;
        if (visitedEntries > MAX_LIST_ENTRIES) {
          truncated = true;
          return;
        }
        if (SKIPPED_DIRECTORIES.has(entry.name.toLowerCase())) continue;
        const absolute = resolve(directory, entry.name);
        try {
          const metadata = await this.fileSystemIdentity.lstat(absolute);
          if (!hasStableIdentity(metadata)) {
            throw new ProviderRequestError(
              adapterFailure.read(
                "A workspace entry does not expose a stable filesystem identity.",
              ),
            );
          }
          if (metadata.isSymbolicLink()) continue;
          if (metadata.isDirectory()) {
            await walk(absolute);
            if (truncated) return;
          } else if (metadata.isFile()) {
            const opened = await this.openRegularFile(absolute, signal);
            try {
              const firstBytes = await readBoundedBytes(opened.handle, signal);
              const afterFirstRead = await opened.handle.stat({ bigint: true });
              await this.hooks.betweenSnapshotReads?.(absolute);
              this.throwIfDisposed(signal);
              const secondBytes = await readBoundedBytes(opened.handle, signal);
              const afterSecondRead = await opened.handle.stat({
                bigint: true,
              });
              if (
                !sameCaptureMetadata(opened.metadata, afterFirstRead) ||
                !sameCaptureMetadata(afterFirstRead, afterSecondRead) ||
                !firstBytes.equals(secondBytes) ||
                !(await this.openedPathIsSafe(absolute, afterSecondRead))
              ) {
                continue;
              }
              const text = decodeUtf8(secondBytes);
              if (text.includes("\0")) continue;
              const size = Buffer.byteLength(text, "utf8");
              if (totalBytes + size > this.maxSnapshotBytes) {
                truncated = true;
                return;
              }
              totalBytes += size;
              files.push({
                relative: opened.relative,
                size,
                text,
              });
            } finally {
              await opened.handle.close();
            }
          }
        } catch (error) {
          if (error instanceof ProviderRequestError) throw error;
          // A concurrently changed or unconfined entry is simply unavailable.
        }
      }
    };

    await walk(root);
    await this.verifyRoot();
    files.sort((left, right) => left.relative.localeCompare(right.relative));
    return { files, truncated };
  }

  private relativeSubset(
    snapshot: { files: SnapshotFile[] },
    requested: string | undefined,
  ): SnapshotFile[] {
    const candidate = requested ?? ".";
    if (
      candidate.length > MAX_PATH_LENGTH ||
      candidate.includes("\0") ||
      excludedPath(candidate)
    ) {
      throw new Error("The requested path is unavailable.");
    }
    const normalized = this.normalizedToolPath(candidate);
    if (
      normalized === ".." ||
      normalized.startsWith("../") ||
      isAbsolute(candidate)
    ) {
      throw new Error("The requested path escapes the reviewed workspace.");
    }
    if (normalized === "." || normalized === "") return snapshot.files;
    const prefix = `${normalized}/`;
    return snapshot.files.filter(
      (file) =>
        file.relative === normalized || file.relative.startsWith(prefix),
    );
  }

  private normalizedToolPath(candidate: string): string {
    const slashPath =
      process.platform === "win32"
        ? candidate.replaceAll("\\", "/")
        : candidate;
    const parts: string[] = [];
    for (const part of slashPath.split("/")) {
      if (part === "" || part === ".") continue;
      if (part === "..") {
        if (parts.length === 0) {
          throw new Error("The requested path escapes the reviewed workspace.");
        }
        parts.pop();
      } else {
        parts.push(part);
      }
    }
    return parts.join("/");
  }

  async listFiles(path: string | undefined, signal: AbortSignal) {
    try {
      const result = await this.createSnapshot(signal);
      const files = this.relativeSubset(result, path);
      return {
        files: files.map((file) => ({
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
      const snapshot = await this.createSnapshot(signal);
      const files = this.relativeSubset(snapshot, path);
      const normalizedPath = this.normalizedToolPath(path);
      const file = files.find((entry) => entry.relative === normalizedPath);
      if (file === undefined)
        return { error: "The requested file is unavailable." };
      const text = file.text;
      const lines = text.split(/\r?\n/);
      const start = Math.min(lines.length || 1, startLine ?? 1);
      const requestedEnd = endLine ?? start + MAX_READ_LINES - 1;
      const end = Math.min(
        lines.length,
        Math.max(start, Math.min(requestedEnd, start + MAX_READ_LINES - 1)),
      );
      return {
        path: file.relative,
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
      const collected = await this.createSnapshot(signal);
      const files = this.relativeSubset(collected, path);
      const needle = caseSensitive ? query : query.toLowerCase();
      const matches: Array<{ path: string; line: number; text: string }> = [];

      for (const file of files) {
        throwIfAborted(signal);
        const text = file.text;
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

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.buildController.abort(
      new Error("The workspace snapshot was disposed."),
    );
    const building = this.snapshot;
    if (building !== undefined) await building.catch(() => undefined);
    delete this.snapshot;
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

interface BoundedAssistantMessage {
  message: ChatMessage;
  toolCalls: Array<{
    call: z.infer<typeof toolCallSchema>;
    executable: boolean;
  }>;
  truncated: boolean;
}

function boundedAssistantMessage(
  message: z.infer<typeof assistantMessageSchema>,
  availableBytes: number,
): BoundedAssistantMessage {
  const maximum = Math.max(
    0,
    Math.min(MAX_ASSISTANT_MESSAGE_BYTES, availableBytes),
  );
  let truncated = false;
  let content = normalizedAssistantContent(message.content);
  if (typeof content === "string") {
    const bounded = truncateUtf8(content, Math.max(0, Math.floor(maximum / 2)));
    truncated ||= bounded !== content;
    content = bounded;
  }
  let toolCalls = (message.tool_calls ?? []).map((original) => {
    const id = truncateUtf8(original.id, 256);
    const name = truncateUtf8(original.function.name, 128);
    const boundedArguments = truncateUtf8(
      original.function.arguments,
      MAX_TOOL_ARGUMENT_BYTES,
    );
    const executable =
      id === original.id &&
      name === original.function.name &&
      boundedArguments === original.function.arguments;
    if (!executable) truncated = true;
    return {
      executable,
      call: {
        ...original,
        id,
        function: { name, arguments: boundedArguments },
      },
    };
  });
  const compose = (): ChatMessage => ({
    role: "assistant",
    ...(content === undefined ? {} : { content }),
    ...(toolCalls.length === 0
      ? {}
      : { tool_calls: toolCalls.map((entry) => entry.call) }),
  });
  let bounded = compose();
  if (jsonByteLength(bounded) > maximum) {
    truncated = true;
    content = undefined;
    toolCalls = toolCalls.map((entry) => ({
      executable: false,
      call: {
        ...entry.call,
        function: { ...entry.call.function, arguments: "{}" },
      },
    }));
    bounded = compose();
  }
  while (toolCalls.length > 0 && jsonByteLength(bounded) > maximum) {
    toolCalls.pop();
    bounded = compose();
    truncated = true;
  }
  if (jsonByteLength(bounded) > maximum) {
    bounded = { role: "assistant" };
    toolCalls = [];
    truncated = true;
  }
  return { message: bounded, toolCalls, truncated };
}

function finalizationReserve(maximumConversationBytes: number): number {
  return Math.min(
    FINALIZATION_RESERVE_BYTES,
    Math.max(4 * 1_024, Math.floor(maximumConversationBytes / 4)),
  );
}

function forceFinalization(
  messages: ChatMessage[],
  reason: string,
  maximumBytes: number,
): boolean {
  let assistantIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "assistant") {
      assistantIndex = index;
      break;
    }
  }
  if (assistantIndex >= 0) {
    const assistant = messages[assistantIndex]!;
    const toolCalls = Array.isArray(assistant.tool_calls)
      ? assistant.tool_calls
      : [];
    messages.splice(assistantIndex);
    if (toolCalls.length > 0) {
      messages.push({ role: "assistant", tool_calls: toolCalls });
      for (const call of toolCalls) {
        const id =
          call !== null && typeof call === "object" && "id" in call
            ? String(call.id)
            : "bounded-tool-call";
        messages.push({
          role: "tool",
          tool_call_id: id,
          content: JSON.stringify({ error: reason, truncated: true }),
        });
      }
    }
  }
  messages.push({
    role: "user",
    content:
      "The bounded inspection context is full. Do not call more tools. Return the final reviewer result now using the evidence already collected.",
  });
  if (conversationBytes(messages) <= maximumBytes) return true;
  const system = messages.find((message) => message.role === "system");
  const user = {
    role: "user",
    content:
      "Inspection context limit reached. Return the final reviewer result now.",
  };
  messages.splice(
    0,
    messages.length,
    ...(system === undefined ? [] : [system]),
    user,
  );
  return conversationBytes(messages) <= maximumBytes;
}

function normalizedAssistantContent(
  content: z.infer<typeof assistantMessageSchema>["content"],
): string | null | undefined {
  if (
    content === undefined ||
    content === null ||
    typeof content === "string"
  ) {
    return content;
  }
  return content.map((part) => part.text).join("");
}

function relaxedStructuredOutputSchema(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  return structuredClone(schema);
}

type ReviewerResultParse =
  | { success: true; data: z.infer<typeof reviewerResultSchema> }
  | { success: false; diagnostic: string };

function parseReviewerResult(
  content: string | null | undefined,
): ReviewerResultParse {
  if (typeof content !== "string" || content.trim() === "") {
    return { success: false, diagnostic: "No JSON content was returned." };
  }
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    return { success: false, diagnostic: "The response was not valid JSON." };
  }
  const parsed = reviewerResultSchema.safeParse(value);
  if (parsed.success) return parsed;
  const issues = parsed.error.issues.slice(0, 12).map((issue) => {
    const path = issue.path.length === 0 ? "$" : `$.${issue.path.join(".")}`;
    return `${path}: ${truncateUtf8(issue.message, 160)}`;
  });
  return {
    success: false,
    diagnostic: truncateUtf8(`Schema issues: ${issues.join("; ")}`, 2 * 1_024),
  };
}

function jsonByteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function truncateUtf8(value: string, maximumBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maximumBytes) return value;
  const bytes = Buffer.from(value, "utf8").subarray(0, maximumBytes);
  return new TextDecoder("utf-8", { fatal: false })
    .decode(bytes)
    .replace(/\uFFFD$/, "");
}

function boundedToolResult(value: unknown, maximumBytes: number): string {
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded, "utf8") <= maximumBytes) {
    return encoded;
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.content === "string") {
      const overhead = jsonByteLength({
        ...record,
        content: "",
        truncated: true,
      });
      return JSON.stringify({
        ...record,
        content: truncateUtf8(
          record.content,
          Math.max(0, maximumBytes - overhead - 16),
        ),
        truncated: true,
      });
    }
    if (Array.isArray(record.files)) {
      const files: unknown[] = [];
      for (const file of record.files) {
        const candidate = JSON.stringify({
          ...record,
          files: [...files, file],
          truncated: true,
        });
        if (Buffer.byteLength(candidate, "utf8") > maximumBytes) break;
        files.push(file);
      }
      return JSON.stringify({ ...record, files, truncated: true });
    }
    if (Array.isArray(record.matches)) {
      const matches: unknown[] = [];
      for (const match of record.matches) {
        const candidate = JSON.stringify({
          ...record,
          matches: [...matches, match],
          truncated: true,
        });
        if (Buffer.byteLength(candidate, "utf8") > maximumBytes) break;
        matches.push(match);
      }
      return JSON.stringify({ ...record, matches, truncated: true });
    }
  }
  return JSON.stringify({
    error: "The inspection result exceeded the safe output limit.",
    truncated: true,
  });
}

function conversationBytes(messages: ChatMessage[]): number {
  return jsonByteLength(messages);
}

const INITIAL_PROMPT_TRUNCATION_MARKER =
  "\n\n[Review Mesh truncated the untrusted review prompt to fit the bounded provider context.]";

function boundedInitialMessages(
  system: string,
  user: string,
  maximumConversationBytes: number,
): ChatMessage[] {
  const reserve = finalizationReserve(maximumConversationBytes);
  const limit = maximumConversationBytes - reserve;
  const minimum: ChatMessage[] = [
    { role: "system", content: system },
    { role: "user", content: INITIAL_PROMPT_TRUNCATION_MARKER.trim() },
  ];
  if (limit <= 0 || conversationBytes(minimum) > limit) {
    throw new ProviderRequestError(
      adapterFailure.read(
        "The configured conversation budget is too small for the trusted review policy.",
      ),
    );
  }
  const messages: ChatMessage[] = [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
  if (conversationBytes(messages) <= limit) return messages;
  let low = 0;
  let high = Buffer.byteLength(user, "utf8");
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    messages[1] = {
      role: "user",
      content: `${truncateUtf8(user, middle)}${INITIAL_PROMPT_TRUNCATION_MARKER}`,
    };
    if (conversationBytes(messages) <= limit) low = middle;
    else high = middle - 1;
  }
  messages[1] = {
    role: "user",
    content: `${truncateUtf8(user, low)}${INITIAL_PROMPT_TRUNCATION_MARKER}`,
  };
  return messages;
}

class OpenAICompatibleAdapter implements ReviewAdapter {
  readonly id = "openai_compatible";
  private readonly environment: NodeJS.ProcessEnv;
  private readonly fetchFacade: typeof fetch;
  private readonly sessionIdFactory: () => string;
  private readonly requestTimeoutMs: number;
  private readonly maxTurns: number;
  private readonly workspaceHooks: ReadOnlyWorkspaceHooks;
  private readonly fileSystemIdentity: FileSystemIdentityFacade;
  private readonly maxSnapshotBytes: number;
  private readonly maxToolResultBytes: number;
  private readonly maxConversationBytes: number;
  private readonly activeRequests = new Set<AbortController>();
  private readonly activeWorkspaces = new Set<ReadOnlyWorkspace>();

  constructor(
    private readonly registration: OpenAICompatibleRegistration,
    dependencies: OpenAICompatibleAdapterDependencies,
  ) {
    this.environment = dependencies.environment ?? process.env;
    this.fetchFacade = dependencies.fetch ?? globalThis.fetch;
    this.sessionIdFactory = dependencies.sessionIdFactory ?? randomUUID;
    this.requestTimeoutMs =
      dependencies.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.maxTurns = dependencies.maxTurns ?? DEFAULT_MAX_TURNS;
    this.workspaceHooks = dependencies.workspaceHooks ?? {};
    this.fileSystemIdentity = dependencies.fileSystemIdentity ?? {
      lstat: (path) => lstat(path, { bigint: true }),
      realpath,
    };
    this.maxSnapshotBytes = dependencies.maxSnapshotBytes ?? MAX_SNAPSHOT_BYTES;
    this.maxToolResultBytes =
      dependencies.maxToolResultBytes ?? MAX_TOOL_RESULT_BYTES;
    this.maxConversationBytes =
      dependencies.maxConversationBytes ?? MAX_CONVERSATION_BYTES;
  }

  private configuration(): ProviderConfiguration | AdapterFailure {
    const apiKey = Object.hasOwn(
      this.environment,
      this.registration.api_key_env,
    )
      ? this.environment[this.registration.api_key_env]
      : undefined;
    if (apiKey === undefined || apiKey.trim() === "") {
      return adapterFailure.authentication(
        "The configured OpenAI-compatible API key environment variable is unavailable.",
      );
    }
    const configuredBaseUrl = Object.hasOwn(
      this.environment,
      this.registration.base_url_env,
    )
      ? this.environment[this.registration.base_url_env]
      : undefined;
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
    sessionId: string,
    body: Record<string, unknown>,
  ) {
    if (
      "messages" in body &&
      Array.isArray(body.messages) &&
      conversationBytes(body.messages as ChatMessage[]) >
        this.maxConversationBytes
    ) {
      throw new ProviderRequestError(
        adapterFailure.read(
          "The bounded provider conversation exceeded its configured limit.",
        ),
      );
    }
    const response = await this.requestJson(
      configuration,
      "/chat/completions",
      "chat",
      signal,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Client-Session-Id": sessionId,
        },
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

    const workspace = new ReadOnlyWorkspace(
      input.context.workspace,
      this.workspaceHooks,
      this.fileSystemIdentity,
      this.maxSnapshotBytes,
    );
    this.activeWorkspaces.add(workspace);
    const sessionId = this.sessionIdFactory();
    const system = [
      input.prompt.system,
      "# TRUSTED TOOL POLICY",
      "Use only list_files, read_file, and search_text.",
      "Never execute shell commands, command-line tools, programs, scripts, builds, tests, Git commands, or code.",
      "Never write, edit, create, delete, rename, or change permissions on files.",
      "Never request any other capability.",
      "Inspect enough relevant source and tests to substantiate the verdict.",
    ].join("\n\n");
    let messages: ChatMessage[];
    try {
      messages = boundedInitialMessages(
        system,
        input.prompt.user,
        this.maxConversationBytes,
      );
    } catch (error) {
      const failure =
        error instanceof ProviderRequestError
          ? error.failure
          : adapterFailure.read(
              "The initial review context could not be safely bounded.",
            );
      yield { type: "failure", failure, isolation };
      await workspace.dispose().catch(() => undefined);
      this.activeWorkspaces.delete(workspace);
      return;
    }

    yield {
      type: "progress",
      phase: "reviewing",
      message:
        "The OpenAI-compatible reviewer is inspecting repository files with bounded read-only tools.",
    };

    try {
      let inspectionBudgetReached = false;
      for (let turn = 0; turn < this.maxTurns; turn += 1) {
        const message = await this.chat(
          configuration,
          input.signal,
          sessionId,
          {
            model: input.reviewer.model,
            ...(input.reviewer.effort === undefined
              ? {}
              : { reasoning_effort: input.reviewer.effort }),
            messages,
            tools: READ_ONLY_TOOLS,
            tool_choice: turn === 0 ? "required" : "auto",
            max_tokens: 8_192,
          },
        );
        const reserve = finalizationReserve(this.maxConversationBytes);
        const assistant = boundedAssistantMessage(
          message,
          this.maxConversationBytes - reserve - conversationBytes(messages),
        );
        messages.push(assistant.message);
        if (
          assistant.truncated ||
          conversationBytes(messages) > this.maxConversationBytes - reserve
        ) {
          inspectionBudgetReached = true;
        }
        const toolCalls = assistant.toolCalls;
        if (toolCalls.length > MAX_TOOL_CALLS_PER_TURN) {
          throw new ProviderRequestError(
            adapterFailure.protocolViolation(
              "The OpenAI-compatible endpoint returned too many inspection tool calls.",
            ),
          );
        }
        if (toolCalls.length > 0) {
          for (const entry of toolCalls) {
            const call = entry.call;
            if (inspectionBudgetReached) {
              messages.push({
                role: "tool",
                tool_call_id: call.id,
                content: JSON.stringify({
                  error: entry.executable
                    ? "The bounded inspection context is full. Return the final reviewer result now."
                    : "The inspection tool arguments exceeded the safe input limit.",
                  truncated: true,
                }),
              });
              continue;
            }
            const result = !entry.executable
              ? {
                  error:
                    "The inspection tool arguments exceeded the safe input limit.",
                  truncated: true,
                }
              : await this.runTool(
                  workspace,
                  call.function.name,
                  call.function.arguments,
                  input.signal,
                );
            const toolMessage = {
              role: "tool",
              tool_call_id: call.id,
              content: boundedToolResult(result, this.maxToolResultBytes),
            };
            if (
              conversationBytes([...messages, toolMessage]) >
              this.maxConversationBytes
            ) {
              inspectionBudgetReached = true;
              toolMessage.content = JSON.stringify({
                error:
                  "The bounded inspection context is full. Return the final reviewer result now.",
                truncated: true,
              });
            }
            messages.push(toolMessage);
          }
          yield {
            type: "activity",
            message:
              "The reviewer completed a bounded read-only inspection step.",
          };
          if (!inspectionBudgetReached) continue;
          messages.push({
            role: "user",
            content:
              "The bounded inspection context is full. Do not call more tools. Return the final reviewer result now using the evidence already collected.",
          });
        }

        if (!inspectionBudgetReached)
          messages.push({
            role: "user",
            content:
              "Return the final reviewer result now. Do not call tools. Follow the supplied JSON Schema exactly.",
          });
        else if (conversationBytes(messages) > this.maxConversationBytes) {
          if (
            !forceFinalization(
              messages,
              "The bounded inspection context is full. Return the final reviewer result now.",
              this.maxConversationBytes,
            )
          ) {
            throw new ProviderRequestError(
              adapterFailure.read(
                "The configured conversation budget cannot fit a valid finalization request.",
              ),
            );
          }
        } else if (toolCalls.length === 0) {
          messages.push({
            role: "user",
            content:
              "The bounded inspection context is full. Do not call more tools. Return the final reviewer result now using the evidence already collected.",
          });
        }
        yield {
          type: "progress",
          phase: "validating",
          message: "The reviewer is producing its structured result.",
        };
        const responseFormat = {
          type: "json_schema",
          json_schema: {
            name: "reviewer_result",
            strict: false,
            schema: relaxedStructuredOutputSchema(input.resultJsonSchema),
          },
        } as const;
        const finalMessage = await this.chat(
          configuration,
          input.signal,
          sessionId,
          {
            model: input.reviewer.model,
            ...(input.reviewer.effort === undefined
              ? {}
              : { reasoning_effort: input.reviewer.effort }),
            messages,
            response_format: responseFormat,
            max_tokens: 8_192,
          },
        );
        let parsedResult = parseReviewerResult(
          normalizedAssistantContent(finalMessage.content),
        );
        if (!parsedResult.success) {
          const repairMessage = {
            role: "user",
            content: `Your previous final result was invalid. ${parsedResult.diagnostic} Return exactly one JSON object that satisfies the supplied reviewer_result schema. Include every required top-level field, use no markdown or commentary, and do not call tools.`,
          };
          if (
            conversationBytes([...messages, repairMessage]) >
            this.maxConversationBytes
          ) {
            if (
              !forceFinalization(
                messages,
                "The invalid final result could not be repaired within the bounded context.",
                this.maxConversationBytes,
              )
            ) {
              throw new ProviderRequestError(
                adapterFailure.read(
                  "The bounded conversation cannot fit a schema repair request.",
                ),
              );
            }
            messages.push({
              role: "user",
              content: truncateUtf8(parsedResult.diagnostic, 512),
            });
          } else {
            messages.push(repairMessage);
          }
          const repairedMessage = await this.chat(
            configuration,
            input.signal,
            sessionId,
            {
              model: input.reviewer.model,
              ...(input.reviewer.effort === undefined
                ? {}
                : { reasoning_effort: input.reviewer.effort }),
              messages,
              response_format: responseFormat,
              max_tokens: 8_192,
            },
          );
          parsedResult = parseReviewerResult(
            normalizedAssistantContent(repairedMessage.content),
          );
        }
        if (!parsedResult.success) {
          throw new ProviderRequestError(
            adapterFailure.invalidResult(
              "The OpenAI-compatible endpoint returned a reviewer result that violates the required schema after one repair attempt.",
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
    } finally {
      await workspace.dispose().catch(() => undefined);
      this.activeWorkspaces.delete(workspace);
    }
  }

  async forceCleanup(): Promise<void> {
    for (const controller of this.activeRequests) {
      controller.abort(new Error("Review Mesh forced adapter cleanup."));
    }
    await Promise.all(
      [...this.activeWorkspaces].map((workspace) => workspace.dispose()),
    );
    this.activeWorkspaces.clear();
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
