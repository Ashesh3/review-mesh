import { createHash, randomUUID } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import {
  lstat,
  open,
  opendir,
  realpath,
  type FileHandle,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import type { AdapterRegistration } from "../config/schemas.js";
import {
  currentReviewerOutputSchema,
  type CurrentReviewerOutput,
} from "../protocol/schemas.js";
import { MAX_REVIEWER_RESULT_BYTES } from "../results/sanitize.js";
import {
  adapterFailure,
  type AdapterFailure,
  type AdapterFailureDiagnostics,
  type AdapterResponseStructure,
  type AdapterValidationIssue,
} from "./errors.js";
import { OpenAIStreamError, parseOpenAIChatStream } from "./openai-stream.js";
import {
  createResultSpool,
  ResultSpoolError,
  type ResultSpool,
} from "./result-spool.js";
import type {
  AdapterCapabilities,
  AdapterEvent,
  AdapterReviewInput,
  ReviewAdapter,
} from "./types.js";

const DEFAULT_REQUEST_TIMEOUT_MS = 180_000;
const DEFAULT_MAX_TURNS = 80;
const DEFAULT_FINALIZATION_ATTEMPTS = 2;
const MAX_FILE_BYTES = 512 * 1_024;
const MAX_SNAPSHOT_BYTES = 32 * 1_024 * 1_024;
const MAX_LIST_ENTRIES = 2_000;
const MAX_SEARCH_RESULTS = 200;
// A 16 MiB decoded JSON string may use six-byte Unicode escapes, with bounded
// response/SSE framing overhead. Keep transport bounded without rejecting it.
const MAX_PROVIDER_RESPONSE_BYTES =
  MAX_REVIEWER_RESULT_BYTES * 6 + 1_024 * 1_024;
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
const DEFAULT_FINALIZATION_MAX_TOKENS = 8_192;
const MAX_VALIDATION_ISSUES = 12;
const EXACT_CONTINUATION_PROMPT =
  "Continue the same JSON object from the exact stopping point. Return only the next bytes: do not repeat, rewrite, condense, or drop any prior content, and do not call tools.";
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
  finalizationAttempts?: number;
  continuationAttempts?: number;
  now?: () => number;
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
        finish_reason: z.string().nullable().optional(),
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
  diagnostics: Partial<AdapterFailureDiagnostics>,
): AdapterFailure {
  if (status === 401 || status === 403) {
    return adapterFailure.authentication(
      "The OpenAI-compatible endpoint rejected authentication.",
      false,
      {
        circuit_qualifying: false,
        diagnostics: {
          ...diagnostics,
          failure_stage: "http_response",
          scope: "provider",
        },
      },
    );
  }
  if (status === 404 && operation === "chat") {
    return adapterFailure.modelUnavailable(
      "The OpenAI-compatible endpoint could not serve the configured model.",
      false,
      {
        circuit_qualifying: false,
        diagnostics: {
          ...diagnostics,
          failure_stage: "http_response",
          scope: "model",
        },
      },
    );
  }
  if (status === 408 || status === 524) {
    return adapterFailure.timeout(
      status === 524
        ? "The OpenAI-compatible gateway timed out waiting for the upstream model."
        : "The OpenAI-compatible endpoint timed out while processing the request.",
      true,
      {
        circuit_qualifying: true,
        diagnostics: {
          ...diagnostics,
          failure_code: status === 524 ? "gateway_timeout" : "request_timeout",
          failure_stage: "http_response",
          scope: "provider",
        },
      },
    );
  }
  if (status === 429 || status >= 500) {
    return adapterFailure.unavailable(
      status === 429
        ? "The OpenAI-compatible endpoint rate limit was exceeded."
        : "The OpenAI-compatible endpoint is temporarily unavailable.",
      true,
      {
        circuit_qualifying: true,
        diagnostics: {
          ...diagnostics,
          failure_code:
            status === 429 ? "rate_limited" : "provider_unavailable",
          failure_stage: "http_response",
          scope: "provider",
        },
      },
    );
  }
  return adapterFailure.unavailable(
    operation === "probe"
      ? "The OpenAI-compatible models endpoint rejected the readiness check."
      : "The OpenAI-compatible endpoint rejected the review request.",
    false,
    {
      circuit_qualifying: false,
      diagnostics: {
        ...diagnostics,
        failure_stage: "http_response",
        scope: "provider",
      },
    },
  );
}

function correlationHeaders(
  headers: Headers,
): Record<string, string> | undefined {
  const values: Record<string, string> = {};
  for (const name of [
    "x-request-id",
    "request-id",
    "x-correlation-id",
    "trace-id",
    "cf-ray",
    "traceparent",
  ]) {
    const value = headers.get(name)?.trim();
    if (value !== undefined && value.length > 0) values[name] = value;
  }
  return Object.keys(values).length === 0 ? undefined : values;
}

function retryAfterMilliseconds(
  headers: Headers,
  nowMilliseconds: number,
): number | undefined {
  const value = headers.get("retry-after")?.trim();
  if (value === undefined || value.length === 0) return undefined;
  if (/^\d+$/u.test(value)) {
    const seconds = Number.parseInt(value, 10);
    return Number.isSafeInteger(seconds) ? seconds * 1_000 : undefined;
  }
  const date = Date.parse(value);
  if (!Number.isFinite(date)) return undefined;
  return Math.max(0, date - nowMilliseconds);
}

function retryableResultProductionFailure(failure: AdapterFailure): boolean {
  return (
    failure.retryable ||
    (failure.reason === "protocol_violation" &&
      failure.diagnostics?.scope !== "run_input" &&
      failure.diagnostics?.scope !== "adapter") ||
    failure.reason === "invalid_result"
  );
}

function exhaustedResultProductionFailure(
  failure: AdapterFailure,
): AdapterFailure {
  return failure.retryable ? { ...failure, retryable: false } : failure;
}

function outputTruncationFailure(
  diagnostics: AdapterFailureDiagnostics,
  repairAttempted: boolean,
): AdapterFailure {
  return adapterFailure.invalidResult(
    "The OpenAI-compatible endpoint truncated the structured reviewer result at its output limit.",
    true,
    {
      fallback_eligible: true,
      circuit_qualifying: false,
      diagnostics: {
        ...diagnostics,
        failure_code: "output_truncated",
        failure_stage: "structured_result_truncation",
        scope: "model",
        finish_reason: "length",
        truncated: true,
        repair_attempted: repairAttempted,
        repair_outcome: repairAttempted ? "failed" : "not_attempted",
      },
    },
  );
}

interface ProviderJsonResponse {
  value: unknown;
  diagnostics: AdapterFailureDiagnostics;
}

interface ChatResponse {
  message: z.infer<typeof assistantMessageSchema>;
  diagnostics: AdapterFailureDiagnostics;
}

interface ProviderHttpResponse {
  response: Response;
  diagnostics: AdapterFailureDiagnostics;
  controller: AbortController;
  dispose(): void;
  timedOut(): boolean;
}

function providerRequestId(headers: Headers): string | undefined {
  for (const name of [
    "x-request-id",
    "request-id",
    "x-correlation-id",
    "trace-id",
  ]) {
    const value = headers.get(name);
    if (value !== null && value.trim().length > 0) return value;
  }
  return undefined;
}

function valueType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function sortedObjectKeys(value: unknown): string[] | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.keys(value).sort().slice(0, 32)
    : undefined;
}

function responseStructure(value: unknown): AdapterResponseStructure {
  const structure: AdapterResponseStructure = { root_type: valueType(value) };
  const topLevelKeys = sortedObjectKeys(value);
  if (topLevelKeys !== undefined) structure.top_level_keys = topLevelKeys;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return structure;
  }
  const choices = (value as { choices?: unknown }).choices;
  if (!Array.isArray(choices)) return structure;
  structure.choices_count = choices.length;
  const firstChoice = choices[0];
  structure.first_choice_type = valueType(firstChoice);
  const firstChoiceKeys = sortedObjectKeys(firstChoice);
  if (firstChoiceKeys !== undefined)
    structure.first_choice_keys = firstChoiceKeys;
  if (
    typeof firstChoice !== "object" ||
    firstChoice === null ||
    Array.isArray(firstChoice)
  ) {
    return structure;
  }
  const message = (firstChoice as { message?: unknown }).message;
  structure.message_type = valueType(message);
  const messageKeys = sortedObjectKeys(message);
  if (messageKeys !== undefined) structure.message_keys = messageKeys;
  return structure;
}

function responseFingerprint(
  structure: AdapterResponseStructure,
  responseBytes: number,
): string {
  const structuralSummary = {
    response_bytes: responseBytes,
    root_type: structure.root_type,
    top_level_key_count: structure.top_level_keys?.length ?? 0,
    choices_count: structure.choices_count,
    first_choice_type: structure.first_choice_type,
    first_choice_key_count: structure.first_choice_keys?.length ?? 0,
    message_type: structure.message_type,
    message_key_count: structure.message_keys?.length ?? 0,
  };
  return createHash("sha256")
    .update(JSON.stringify(structuralSummary))
    .digest("hex");
}

function zodValidationIssues(error: z.ZodError): AdapterValidationIssue[] {
  return error.issues.slice(0, MAX_VALIDATION_ISSUES).map((issue) => ({
    path:
      issue.path.length === 0
        ? "$"
        : `$${issue.path
            .map((part) =>
              typeof part === "number" ? `[${part}]` : `.${String(part)}`,
            )
            .join("")}`,
    code: issue.code,
    message: truncateUtf8(issue.message, 256),
  }));
}

function responseContentTypes(headers: Headers): string[] | undefined {
  const contentType = headers.get("content-type")?.split(";", 1)[0]?.trim();
  return contentType === undefined || contentType.length === 0
    ? undefined
    : [contentType];
}

function assistantContentTypes(value: unknown): string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return [];
  }
  const choices = (value as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return [];
  const choice = choices[0];
  if (typeof choice !== "object" || choice === null || Array.isArray(choice)) {
    return [];
  }
  const message = (choice as { message?: unknown }).message;
  if (
    typeof message !== "object" ||
    message === null ||
    Array.isArray(message)
  ) {
    return [];
  }
  const labels: string[] = [];
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") labels.push("assistant:text");
  else if (content === null) labels.push("assistant:null");
  else if (Array.isArray(content)) {
    for (const part of content) {
      const type =
        typeof part === "object" && part !== null && !Array.isArray(part)
          ? (part as { type?: unknown }).type
          : undefined;
      labels.push(
        typeof type === "string" && type.trim().length > 0
          ? `assistant:${type}`
          : "assistant:unknown_part",
      );
    }
  } else if (content !== undefined) labels.push("assistant:unknown");
  if (Array.isArray((message as { tool_calls?: unknown }).tool_calls)) {
    labels.push("assistant:tool_calls");
  }
  return [...new Set(labels)];
}

function finishReason(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const choices = (value as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return undefined;
  const choice = choices[0];
  if (typeof choice !== "object" || choice === null || Array.isArray(choice)) {
    return undefined;
  }
  const reason = (choice as { finish_reason?: unknown }).finish_reason;
  return typeof reason === "string" ? reason : undefined;
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
  | { success: true; data: CurrentReviewerOutput }
  | {
      success: false;
      diagnostic: string;
      validationIssues: AdapterValidationIssue[];
    };

function parseReviewerResult(
  content: string | null | undefined,
): ReviewerResultParse {
  if (typeof content !== "string" || content.trim() === "") {
    return {
      success: false,
      diagnostic: "No JSON content was returned.",
      validationIssues: [
        {
          path: "$",
          code: "missing_content",
          message: "No JSON content was returned.",
        },
      ],
    };
  }
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    return {
      success: false,
      diagnostic: "The response was not valid JSON.",
      validationIssues: [
        {
          path: "$",
          code: "invalid_json",
          message: "The response was not valid JSON.",
        },
      ],
    };
  }
  const parsed = currentReviewerOutputSchema.safeParse(value);
  if (parsed.success) return parsed;
  const validationIssues = zodValidationIssues(parsed.error);
  const issues = validationIssues.map(
    (issue) => `${issue.path}: ${truncateUtf8(issue.message, 160)}`,
  );
  return {
    success: false,
    diagnostic: truncateUtf8(`Schema issues: ${issues.join("; ")}`, 2 * 1_024),
    validationIssues,
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
  private readonly finalizationAttempts: number;
  private readonly continuationAttempts: number;
  private readonly now: () => number;
  private readonly workspaceHooks: ReadOnlyWorkspaceHooks;
  private readonly fileSystemIdentity: FileSystemIdentityFacade;
  private readonly maxSnapshotBytes: number;
  private readonly maxToolResultBytes: number;
  private readonly maxConversationBytes: number;
  private readonly activeRequests = new Set<AbortController>();
  private readonly activeWorkspaces = new Set<ReadOnlyWorkspace>();
  private readonly nonStreamingSessions = new Set<string>();

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
    this.finalizationAttempts =
      dependencies.finalizationAttempts ?? DEFAULT_FINALIZATION_ATTEMPTS;
    this.continuationAttempts =
      dependencies.continuationAttempts ?? DEFAULT_FINALIZATION_ATTEMPTS;
    if (
      !Number.isSafeInteger(this.finalizationAttempts) ||
      this.finalizationAttempts < 1 ||
      this.finalizationAttempts > 10
    ) {
      throw new Error("finalizationAttempts must be an integer from 1 to 10");
    }
    if (
      !Number.isSafeInteger(this.continuationAttempts) ||
      this.continuationAttempts < 1 ||
      this.continuationAttempts > 10
    ) {
      throw new Error("continuationAttempts must be an integer from 1 to 10");
    }
    this.now = dependencies.now ?? Date.now;
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

  private async request(
    configuration: ProviderConfiguration,
    path: string,
    operation: "probe" | "chat",
    signal: AbortSignal,
    init: Omit<RequestInit, "signal">,
  ): Promise<ProviderHttpResponse> {
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
          false,
          {
            fallback_eligible: false,
            circuit_qualifying: false,
            diagnostics: {
              failure_stage: "request_encoding",
              scope: "run_input",
              response_bytes: Buffer.byteLength(init.body, "utf8"),
            },
          },
        ),
      );
    }
    const controller = new AbortController();
    let didTimeOut = false;
    const abort = () => controller.abort(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(() => {
      didTimeOut = true;
      controller.abort(new Error("Provider request deadline expired."));
    }, this.requestTimeoutMs);
    this.activeRequests.add(controller);
    const dispose = () => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
      this.activeRequests.delete(controller);
    };
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
      const requestId = providerRequestId(response.headers);
      const contentTypes = responseContentTypes(response.headers);
      const correlations = correlationHeaders(response.headers);
      const retryAfterMs = retryAfterMilliseconds(response.headers, this.now());
      const diagnostics: AdapterFailureDiagnostics = {
        failure_stage: "http_response",
        scope: "provider",
        http_status: response.status,
        ...(requestId === undefined ? {} : { provider_request_id: requestId }),
        ...(retryAfterMs === undefined ? {} : { retry_after_ms: retryAfterMs }),
        ...(correlations === undefined
          ? {}
          : { correlation_headers: correlations }),
        ...(contentTypes === undefined ? {} : { content_types: contentTypes }),
      };
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        dispose();
        throw new ProviderRequestError(
          providerFailureForStatus(response.status, operation, diagnostics),
        );
      }
      return {
        response,
        diagnostics,
        controller,
        dispose,
        timedOut: () => didTimeOut,
      };
    } catch (error) {
      dispose();
      if (error instanceof ProviderRequestError) throw error;
      if (signal.aborted) {
        throw new ProviderRequestError(adapterFailure.cancelled());
      }
      if (didTimeOut) {
        throw new ProviderRequestError(
          adapterFailure.timeout(
            "The OpenAI-compatible endpoint exceeded the request deadline.",
            true,
            {
              circuit_qualifying: true,
              diagnostics: {
                failure_code: "request_timeout",
                failure_stage: "http_request",
                scope: "provider",
              },
            },
          ),
        );
      }
      throw new ProviderRequestError(
        adapterFailure.unavailable(
          "The OpenAI-compatible endpoint could not be reached.",
          true,
          {
            circuit_qualifying: true,
            diagnostics: {
              failure_code: "transport_error",
              failure_stage: "http_request",
              scope: "provider",
            },
          },
        ),
      );
    }
  }

  private async requestJson(
    configuration: ProviderConfiguration,
    path: string,
    operation: "probe" | "chat",
    signal: AbortSignal,
    init: Omit<RequestInit, "signal">,
  ): Promise<ProviderJsonResponse> {
    const request = await this.request(
      configuration,
      path,
      operation,
      signal,
      init,
    );
    const responseDiagnostics = request.diagnostics;
    try {
      return await this.readJsonResponse(
        request.response,
        responseDiagnostics,
        signal,
        request.timedOut,
      );
    } finally {
      request.dispose();
    }
  }

  private async readJsonResponse(
    response: Response,
    responseDiagnostics: AdapterFailureDiagnostics,
    signal: AbortSignal,
    timedOut: () => boolean,
  ): Promise<ProviderJsonResponse> {
    let responseBytes = 0;
    try {
      try {
        const contentLength = response.headers.get("content-length");
        const declaredLength =
          contentLength === null
            ? undefined
            : Number.parseInt(contentLength, 10);
        if (
          declaredLength !== undefined &&
          declaredLength > MAX_PROVIDER_RESPONSE_BYTES
        ) {
          await response.body?.cancel();
          throw new ProviderRequestError(
            adapterFailure.protocolViolation(
              "The OpenAI-compatible endpoint returned an oversized response.",
              false,
              {
                circuit_qualifying: false,
                diagnostics: {
                  ...responseDiagnostics,
                  failure_code: "response_too_large",
                  failure_stage: "response_body",
                  response_bytes: declaredLength,
                  truncated: true,
                },
              },
            ),
          );
        }
        const reader = response.body?.getReader();
        if (reader === undefined) {
          throw new ProviderRequestError(
            adapterFailure.protocolViolation(
              "The OpenAI-compatible endpoint returned no response body.",
              false,
              {
                circuit_qualifying: false,
                diagnostics: {
                  ...responseDiagnostics,
                  failure_code: "provider_response_invalid",
                  failure_stage: "response_body",
                  response_bytes: 0,
                  truncated: false,
                },
              },
            ),
          );
        }
        const chunks: Uint8Array[] = [];
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          responseBytes += chunk.value.byteLength;
          if (responseBytes > MAX_PROVIDER_RESPONSE_BYTES) {
            await reader.cancel();
            throw new ProviderRequestError(
              adapterFailure.protocolViolation(
                "The OpenAI-compatible endpoint returned an oversized response.",
                false,
                {
                  circuit_qualifying: false,
                  diagnostics: {
                    ...responseDiagnostics,
                    failure_code: "response_too_large",
                    failure_stage: "response_body",
                    response_bytes: responseBytes,
                    truncated: true,
                  },
                },
              ),
            );
          }
          chunks.push(chunk.value);
        }
        const bytes = new Uint8Array(responseBytes);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
        const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        let value: unknown;
        try {
          value = JSON.parse(decoded);
        } catch {
          throw new ProviderRequestError(
            adapterFailure.protocolViolation(
              "The OpenAI-compatible endpoint returned invalid JSON.",
              false,
              {
                circuit_qualifying: false,
                diagnostics: {
                  ...responseDiagnostics,
                  failure_code: "provider_response_invalid",
                  failure_stage: "json_decode",
                  response_bytes: responseBytes,
                  response_fingerprint: responseFingerprint(
                    { root_type: "invalid_json" },
                    responseBytes,
                  ),
                  truncated: false,
                  scope: "provider",
                  validation_issues: [
                    {
                      path: "$",
                      code: "invalid_json",
                      message: "The response body was not valid JSON.",
                    },
                  ],
                },
              },
            ),
          );
        }
        const structure = responseStructure(value);
        return {
          value,
          diagnostics: {
            ...responseDiagnostics,
            response_bytes: responseBytes,
            response_fingerprint: responseFingerprint(structure, responseBytes),
            response_structure: structure,
            truncated: false,
          },
        };
      } catch (error) {
        if (error instanceof ProviderRequestError) throw error;
        if (signal.aborted) {
          throw new ProviderRequestError(adapterFailure.cancelled());
        }
        if (timedOut()) {
          throw new ProviderRequestError(
            adapterFailure.timeout(
              "The OpenAI-compatible endpoint exceeded the request deadline.",
              true,
              {
                circuit_qualifying: true,
                diagnostics: {
                  ...responseDiagnostics,
                  failure_code: "request_timeout",
                  failure_stage: "response_body",
                  response_bytes: responseBytes,
                  scope: "provider",
                },
              },
            ),
          );
        }
        throw new ProviderRequestError(
          adapterFailure.protocolViolation(
            "The OpenAI-compatible endpoint returned an unreadable response body.",
            false,
            {
              circuit_qualifying: false,
              diagnostics: {
                ...responseDiagnostics,
                failure_code: "provider_response_invalid",
                failure_stage: "response_body",
                response_bytes: responseBytes,
                truncated: false,
                scope: "provider",
              },
            },
          ),
        );
      }
    } catch (error) {
      if (error instanceof ProviderRequestError) throw error;
      if (signal.aborted) {
        throw new ProviderRequestError(adapterFailure.cancelled());
      }
      if (timedOut()) {
        throw new ProviderRequestError(
          adapterFailure.timeout(
            "The OpenAI-compatible endpoint exceeded the request deadline.",
            true,
            {
              circuit_qualifying: true,
              diagnostics: {
                ...responseDiagnostics,
                failure_code: "request_timeout",
                failure_stage: "http_request",
                response_bytes: responseBytes,
                scope: "provider",
              },
            },
          ),
        );
      }
      throw new ProviderRequestError(
        adapterFailure.unavailable(
          "The OpenAI-compatible endpoint could not be reached.",
          true,
          {
            circuit_qualifying: true,
            diagnostics: {
              failure_code: "transport_error",
              failure_stage: "http_request",
              scope: "provider",
            },
          },
        ),
      );
    }
  }

  private async chatResponse(
    configuration: ProviderConfiguration,
    signal: AbortSignal,
    sessionId: string,
    body: Record<string, unknown>,
  ): Promise<ProviderJsonResponse> {
    const configuredStreamingMode = this.registration.streaming ?? "disabled";
    const streamingMode = this.nonStreamingSessions.has(sessionId)
      ? "disabled"
      : configuredStreamingMode;
    const requestBody =
      streamingMode === "disabled"
        ? body
        : { ...body, stream: true, stream_options: { include_usage: true } };
    const requestInit = {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Client-Session-Id": sessionId,
      },
      body: JSON.stringify(requestBody),
    } as const;
    if (streamingMode === "disabled") {
      return this.requestJson(
        configuration,
        "/chat/completions",
        "chat",
        signal,
        requestInit,
      );
    } else {
      try {
        const streamed = await this.request(
          configuration,
          "/chat/completions",
          "chat",
          signal,
          requestInit,
        );
        try {
          const contentType =
            streamed.response.headers.get("content-type")?.toLowerCase() ?? "";
          if (!contentType.includes("text/event-stream")) {
            return await this.readJsonResponse(
              streamed.response,
              streamed.diagnostics,
              signal,
              streamed.timedOut,
            );
          } else if (streamed.response.body === null) {
            throw new OpenAIStreamError(
              "invalid_stream",
              "The streaming response had no body.",
            );
          } else {
            const parsed = await parseOpenAIChatStream(streamed.response.body, {
              signal: streamed.controller.signal,
              maximumBytes: MAX_PROVIDER_RESPONSE_BYTES,
            });
            const value = {
              choices: [
                {
                  message: parsed.message,
                  ...(parsed.finish_reason === undefined
                    ? {}
                    : { finish_reason: parsed.finish_reason }),
                },
              ],
              ...(parsed.usage === undefined ? {} : { usage: parsed.usage }),
            };
            const structure = responseStructure(value);
            return {
              value,
              diagnostics: {
                ...streamed.diagnostics,
                response_bytes: parsed.response_bytes,
                response_fingerprint: responseFingerprint(
                  structure,
                  parsed.response_bytes,
                ),
                response_structure: structure,
                truncated: false,
              },
            };
          }
        } catch (error) {
          if (error instanceof OpenAIStreamError) {
            throw new ProviderRequestError(
              error.code === "cancelled"
                ? adapterFailure.cancelled()
                : adapterFailure.protocolViolation(
                    "The OpenAI-compatible endpoint returned an invalid stream.",
                    false,
                    {
                      fallback_eligible: true,
                      circuit_qualifying: false,
                      diagnostics: {
                        ...streamed.diagnostics,
                        failure_code:
                          error.code === "response_too_large"
                            ? "response_too_large"
                            : "provider_response_invalid",
                        failure_stage: "stream_decode",
                        scope: "provider",
                      },
                    },
                  ),
            );
          }
          throw error;
        } finally {
          streamed.dispose();
        }
      } catch (error) {
        const unsupported =
          error instanceof ProviderRequestError &&
          (error.failure.diagnostics?.http_status === 400 ||
            error.failure.diagnostics?.http_status === 406 ||
            error.failure.diagnostics?.http_status === 415 ||
            error.failure.diagnostics?.http_status === 422);
        if (unsupported && streamingMode === "auto") {
          this.nonStreamingSessions.add(sessionId);
          return await this.requestJson(
            configuration,
            "/chat/completions",
            "chat",
            signal,
            {
              ...requestInit,
              body: JSON.stringify(body),
            },
          );
        } else if (unsupported) {
          throw new ProviderRequestError(
            adapterFailure.protocolViolation(
              "The OpenAI-compatible endpoint does not support required streaming.",
              false,
              {
                fallback_eligible: true,
                circuit_qualifying: false,
                diagnostics: {
                  ...error.failure.diagnostics,
                  failure_code: "streaming_unsupported",
                  failure_stage: "streaming_negotiation",
                  scope: "provider",
                  attempt_count: 1,
                  retry_outcome: "not_attempted",
                },
              },
            ),
          );
        } else {
          throw error;
        }
      }
    }
  }

  private async chat(
    configuration: ProviderConfiguration,
    signal: AbortSignal,
    sessionId: string,
    body: Record<string, unknown>,
    failureDiagnostics: Partial<AdapterFailureDiagnostics> = {},
  ): Promise<ChatResponse> {
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
    let retriedEnvelope = false;
    let response: ProviderJsonResponse;
    try {
      response = await this.chatResponse(
        configuration,
        signal,
        sessionId,
        body,
      );
    } catch (error) {
      if (
        !(error instanceof ProviderRequestError) ||
        error.failure.diagnostics?.failure_code !==
          "provider_response_invalid" ||
        error.failure.diagnostics.http_status !== 200
      ) {
        throw error;
      }
      retriedEnvelope = true;
      try {
        response = await this.chatResponse(
          configuration,
          signal,
          sessionId,
          body,
        );
        response.diagnostics = {
          ...response.diagnostics,
          attempt_count: 2,
          retry_outcome: "succeeded",
        };
      } catch (retryError) {
        if (retryError instanceof ProviderRequestError) {
          throw new ProviderRequestError({
            ...retryError.failure,
            diagnostics: {
              ...retryError.failure.diagnostics,
              attempt_count: 2,
              retry_outcome: "exhausted",
            },
          });
        }
        throw retryError;
      }
    }
    let parsed = chatResponseSchema.safeParse(response.value);
    if (!parsed.success) {
      const choices =
        typeof response.value === "object" &&
        response.value !== null &&
        !Array.isArray(response.value)
          ? (response.value as { choices?: unknown }).choices
          : undefined;
      if (Array.isArray(choices) && choices.length === 0) {
        retriedEnvelope = true;
        response = await this.chatResponse(
          configuration,
          signal,
          sessionId,
          body,
        );
        parsed = chatResponseSchema.safeParse(response.value);
        if (parsed.success) {
          response.diagnostics = {
            ...response.diagnostics,
            attempt_count: 2,
            retry_outcome: "succeeded",
          };
        }
      }
    }
    const receivedContentTypes = [
      ...(response.diagnostics.content_types ?? []),
      ...assistantContentTypes(response.value),
    ];
    const receivedFinishReason = finishReason(response.value);
    const diagnostics: AdapterFailureDiagnostics = {
      ...response.diagnostics,
      ...failureDiagnostics,
      ...(receivedContentTypes.length === 0
        ? {}
        : { content_types: receivedContentTypes }),
      ...(receivedFinishReason === undefined
        ? {}
        : { finish_reason: receivedFinishReason }),
    };
    if (!parsed.success) {
      throw new ProviderRequestError(
        adapterFailure.protocolViolation(
          "The OpenAI-compatible endpoint returned an invalid chat response.",
          false,
          {
            fallback_eligible: true,
            circuit_qualifying: false,
            diagnostics: {
              ...diagnostics,
              failure_code: "provider_response_invalid",
              failure_stage:
                failureDiagnostics.failure_stage ?? "envelope_validation",
              scope: "provider",
              validation_issues: zodValidationIssues(parsed.error),
              attempt_count: retriedEnvelope ? 2 : 1,
              retry_outcome: retriedEnvelope ? "exhausted" : "not_attempted",
            },
          },
        ),
      );
    }
    return {
      message: parsed.data.choices[0]!.message,
      diagnostics: {
        ...response.diagnostics,
        ...failureDiagnostics,
        ...(receivedContentTypes.length === 0
          ? {}
          : { content_types: receivedContentTypes }),
        ...(receivedFinishReason === undefined
          ? {}
          : { finish_reason: receivedFinishReason }),
      },
    };
  }

  async probe(
    reviewer: AdapterReviewInput["reviewer"],
    signal: AbortSignal,
  ): Promise<AdapterCapabilities> {
    const base: Omit<AdapterCapabilities, "available"> = {
      authenticated: "unknown",
      model_available: "unknown",
      streaming: (this.registration.streaming ?? "disabled") !== "disabled",
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
      const parsed = modelsResponseSchema.safeParse(response.value);
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
        retryable: failure.retryable,
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
        const chatResponse = await this.chat(
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
        const message = chatResponse.message;
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
        // Retain one immutable post-inspection checkpoint. Result-production
        // transport/envelope/schema failures can retry from it without
        // repeating any repository tool calls or inspection turns.
        const finalizationCheckpoint = structuredClone(messages);
        const finalizationDeadline =
          this.now() +
          this.requestTimeoutMs *
            (this.finalizationAttempts + this.continuationAttempts);
        let lastFinalizationFailure: AdapterFailure | undefined;
        let continuationSpool: ResultSpool | undefined;
        let continuationFragments: string[] = [];
        let continuationRequests = 0;
        let finalizationAttempt = 1;
        while (finalizationAttempt <= this.finalizationAttempts) {
          throwIfAborted(input.signal);
          if (this.now() >= finalizationDeadline) {
            lastFinalizationFailure = adapterFailure.timeout(
              "Structured result production exceeded its bounded deadline.",
              true,
              {
                diagnostics: {
                  failure_stage: "structured_result_deadline",
                  scope: "provider",
                },
              },
            );
            break;
          }
          const finalizationMessages = structuredClone(finalizationCheckpoint);
          if (continuationFragments.length > 0) {
            const assembled = await continuationSpool!.readText();
            finalizationMessages.push({
              role: "assistant",
              content: assembled,
            });
            finalizationMessages.push({
              role: "user",
              content: EXACT_CONTINUATION_PROMPT,
            });
          }
          let resultDiagnostics: AdapterFailureDiagnostics = {
            failure_stage: "structured_result_envelope",
            scope: "provider",
            repair_attempted: false,
            repair_outcome: "not_attempted",
          };
          try {
            const finalResponse = await this.chat(
              configuration,
              input.signal,
              sessionId,
              {
                model: input.reviewer.model,
                ...(input.reviewer.effort === undefined
                  ? {}
                  : { reasoning_effort: input.reviewer.effort }),
                messages: finalizationMessages,
                response_format: responseFormat,
                max_tokens: DEFAULT_FINALIZATION_MAX_TOKENS,
              },
              {
                failure_stage: "structured_result_envelope",
                repair_attempted: false,
                repair_outcome: "not_attempted",
              },
            );
            resultDiagnostics = finalResponse.diagnostics;
            const fragment = normalizedAssistantContent(
              finalResponse.message.content,
            );
            let resultTruncated =
              finalResponse.diagnostics.finish_reason === "length";
            if (
              typeof fragment === "string" &&
              (resultTruncated || continuationSpool !== undefined)
            ) {
              if (continuationSpool === undefined) {
                continuationSpool = await createResultSpool({
                  directory: join(tmpdir(), "review-mesh-result-spools"),
                  id: `${input.runId}-${input.reviewer.id}-${randomUUID()}`.replace(
                    /[^A-Za-z0-9_-]/gu,
                    "-",
                  ),
                  reviewedWorkspace: input.context.workspace,
                });
              }
              await continuationSpool.append(fragment);
              continuationFragments.push(fragment);
            }
            let parsedResult = parseReviewerResult(
              continuationSpool === undefined
                ? fragment
                : await continuationSpool.readText(),
            );
            if (resultTruncated) {
              lastFinalizationFailure = outputTruncationFailure(
                finalResponse.diagnostics,
                false,
              );
              if (continuationRequests < this.continuationAttempts) {
                continuationRequests += 1;
                yield {
                  type: "progress",
                  phase: "validating",
                  message: `Continuing the exact structured result from its stopping point (fragment ${continuationRequests} of ${this.continuationAttempts}).`,
                };
                continue;
              }
            } else if (!parsedResult.success) {
              if (continuationSpool !== undefined) {
                await continuationSpool.cleanup();
                continuationSpool = undefined;
                continuationFragments = [];
              }
              const repairMessage = {
                role: "user",
                content: `Your previous final result was invalid. ${parsedResult.diagnostic} Return exactly one JSON object that satisfies the supplied reviewer_result schema. Include every required top-level field, use no markdown or commentary, and do not call tools.`,
              };
              if (
                conversationBytes([...finalizationMessages, repairMessage]) >
                this.maxConversationBytes
              ) {
                if (
                  !forceFinalization(
                    finalizationMessages,
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
                finalizationMessages.push({
                  role: "user",
                  content: truncateUtf8(parsedResult.diagnostic, 512),
                });
              } else {
                finalizationMessages.push(repairMessage);
              }
              const repairedResponse = await this.chat(
                configuration,
                input.signal,
                sessionId,
                {
                  model: input.reviewer.model,
                  ...(input.reviewer.effort === undefined
                    ? {}
                    : { reasoning_effort: input.reviewer.effort }),
                  messages: finalizationMessages,
                  response_format: responseFormat,
                  max_tokens: DEFAULT_FINALIZATION_MAX_TOKENS,
                },
                {
                  failure_stage: "structured_result_repair_envelope",
                  repair_attempted: true,
                  repair_outcome: "failed",
                },
              );
              resultDiagnostics = repairedResponse.diagnostics;
              const repairedFragment = normalizedAssistantContent(
                repairedResponse.message.content,
              );
              resultTruncated =
                repairedResponse.diagnostics.finish_reason === "length";
              if (resultTruncated) {
                if (typeof repairedFragment === "string") {
                  if (continuationSpool === undefined) {
                    continuationSpool = await createResultSpool({
                      directory: join(tmpdir(), "review-mesh-result-spools"),
                      id: `${input.runId}-${input.reviewer.id}-${randomUUID()}`.replace(
                        /[^A-Za-z0-9_-]/gu,
                        "-",
                      ),
                      reviewedWorkspace: input.context.workspace,
                    });
                  }
                  await continuationSpool.append(repairedFragment);
                  continuationFragments.push(repairedFragment);
                }
                lastFinalizationFailure = outputTruncationFailure(
                  repairedResponse.diagnostics,
                  true,
                );
                if (continuationRequests < this.continuationAttempts) {
                  continuationRequests += 1;
                  yield {
                    type: "progress",
                    phase: "validating",
                    message: `Continuing the exact structured result from its stopping point (fragment ${continuationRequests} of ${this.continuationAttempts}).`,
                  };
                  continue;
                }
              }
              parsedResult = parseReviewerResult(
                continuationSpool === undefined
                  ? repairedFragment
                  : await continuationSpool.readText(),
              );
            }
            if (parsedResult.success && !resultTruncated) {
              await continuationSpool?.cleanup();
              continuationSpool = undefined;
              yield { type: "result", result: parsedResult.data, isolation };
              return;
            }
            if (
              lastFinalizationFailure?.diagnostics?.failure_code !==
              "output_truncated"
            ) {
              lastFinalizationFailure = adapterFailure.invalidResult(
                "The OpenAI-compatible endpoint returned a reviewer result that violates the required schema after one repair attempt.",
                false,
                {
                  fallback_eligible: true,
                  circuit_qualifying: false,
                  diagnostics: {
                    ...resultDiagnostics,
                    failure_stage: "structured_result_validation",
                    scope: "model",
                    validation_issues: parsedResult.success
                      ? []
                      : parsedResult.validationIssues,
                    repair_attempted: true,
                    repair_outcome: "failed",
                  },
                },
              );
            }
          } catch (error) {
            if (error instanceof ResultSpoolError) {
              lastFinalizationFailure =
                error.code === "result_too_large"
                  ? adapterFailure.resultTooLarge(error.message, {
                      fallback_eligible: true,
                      circuit_qualifying: false,
                      diagnostics: {
                        failure_stage: "structured_result_spool",
                        scope: "model",
                      },
                    })
                  : adapterFailure.invalidResult(error.message, false, {
                      fallback_eligible: true,
                      circuit_qualifying: false,
                      diagnostics: {
                        failure_stage: "structured_result_spool",
                        scope: "adapter",
                      },
                    });
            } else {
              if (!(error instanceof ProviderRequestError)) throw error;
              lastFinalizationFailure = error.failure;
            }
          }
          if (
            finalizationAttempt < this.finalizationAttempts &&
            lastFinalizationFailure !== undefined &&
            retryableResultProductionFailure(lastFinalizationFailure)
          ) {
            await continuationSpool?.cleanup();
            continuationSpool = undefined;
            continuationFragments = [];
            yield {
              type: "progress",
              phase: "validating",
              message: `Retrying structured result production from the retained inspection checkpoint (attempt ${finalizationAttempt + 1} of ${this.finalizationAttempts}).`,
            };
            finalizationAttempt += 1;
            continuationRequests = 0;
            continue;
          }
          break;
        }
        await continuationSpool?.cleanup().catch(() => undefined);
        throw new ProviderRequestError(
          exhaustedResultProductionFailure(
            lastFinalizationFailure ??
              adapterFailure.invalidResult(
                "The OpenAI-compatible endpoint did not return a valid reviewer result.",
              ),
          ),
        );
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
