import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, open, type FileHandle } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import {
  artifactResolutionV1Schema,
  artifactResolutionV2Schema,
  artifactAttemptV1Schema,
  artifactTerminalV1Schema,
  artifactCoverageV1Schema,
  privatePayloadSchemas,
} from "./artifact-payloads.js";
import { runFindingsRecordSchema } from "./artifact-record-schemas.js";
import { createResultPageCollector } from "../results/result-pages.js";
import {
  adjudicationResultV2Schema,
  reviewerResultV4Schema,
  publicEventV6Schema,
  type AdjudicationResultV2,
  type ReviewerResultV4,
} from "../protocol/v9.js";
import { reviewerResultDigest } from "../results/digest.js";
import {
  MAX_REVIEWER_RESULT_BYTES,
  sanitizeRunMetadata,
} from "../results/sanitize.js";
import {
  artifactIdentity,
  createSafeArtifactParent,
  RunArtifactError,
  safeArtifactParent,
  sameArtifactIdentity,
  verifyArtifactFile,
  type ArtifactIdentity,
  type ArtifactReference,
} from "./run-index.js";

const CURRENT_RESULT = z.union([
  reviewerResultV4Schema,
  adjudicationResultV2Schema,
]);
type CurrentResult = ReviewerResultV4 | AdjudicationResultV2;
const id = z.string().min(1).max(128);
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const count = z.number().int().nonnegative();
const NARRATIVE_CHUNK_BYTES = 24 * 1024;
const MAX_NARRATIVE_CHUNKS = Math.ceil(
  MAX_REVIEWER_RESULT_BYTES / NARRATIVE_CHUNK_BYTES,
);
const PRIVATE_VERSIONS = {
  resolution: "3",
  request: "3",
  context: "1",
  "reviewer.attempt": "2",
  "reviewer.activity": "1",
  "reviewer.activity_summary": "1",
  "reviewer.coverage": "2",
  "reviewer.result_page": "1",
  "reviewer.narrative": "1",
  "reviewer.result": "1",
  "reviewer.terminal": "2",
  "run.findings": "1",
  "run.terminal_summary": "1",
  "run.artifact_terminal": "1",
} as const;
const headerSchema = z.strictObject({
  record: z.literal("run.artifact"),
  artifact_format_version: z.literal("2"),
  tool_version: z.string().min(1).max(128),
  run_id: id,
  created_at: z.iso.datetime({ offset: true }),
  private_record_versions: z
    .object(
      Object.fromEntries(
        Object.entries(PRIVATE_VERSIONS).map(([key, value]) => [
          key,
          key === "resolution"
            ? z.enum(["1", "2", "3"])
            : key === "reviewer.attempt" ||
                key === "reviewer.terminal" ||
                key === "reviewer.coverage"
              ? z.enum(["1", "2"])
              : z.literal(value),
        ]),
      ),
    )
    .strict(),
});
const terminalSchema = z.strictObject({
  record: z.literal("run.artifact_terminal"),
  schema_version: z.literal("1"),
  run_id: id,
  content_sha256: hash,
  content_byte_count: count,
});
const summarySchema = z.strictObject({
  record: z.literal("run.terminal_summary"),
  schema_version: z.literal("1"),
  run_id: id,
  summary: z.record(z.string(), z.unknown()),
});
const narrativeSchema = z.strictObject({
  record: z.literal("reviewer.narrative"),
  schema_version: z.literal("1"),
  run_id: id,
  reviewer_id: id,
  index: count,
  text: z
    .string()
    .refine(
      (value) => Buffer.byteLength(value, "utf8") <= NARRATIVE_CHUNK_BYTES,
    ),
  sha256: hash,
});
const resultSchema = z.strictObject({
  record: z.literal("reviewer.result"),
  schema_version: z.literal("1"),
  run_id: id,
  reviewer_id: id,
  digest: hash,
  byte_count: count,
  result: z.record(z.string(), z.unknown()),
  narrative: z
    .strictObject({ chunks: count, byte_count: count, sha256: hash })
    .optional(),
});
const genericRecords: Record<string, z.ZodType> = {
  "run.findings": runFindingsRecordSchema,
  resolution: z.strictObject({
    record: z.literal("resolution"),
    schema_version: z.enum(["1", "2", "3"]),
    run_id: id,
    resolution: z.record(z.string(), z.unknown()),
  }),
  request: z.strictObject({
    record: z.literal("request"),
    schema_version: z.literal("3"),
    run_id: id,
    request: z.record(z.string(), z.unknown()),
  }),
  context: z.strictObject({
    record: z.literal("context"),
    schema_version: z.literal("1"),
    run_id: id,
    context: z.record(z.string(), z.unknown()),
  }),
};
for (const record of [
  "reviewer.attempt",
  "reviewer.activity",
  "reviewer.activity_summary",
  "reviewer.coverage",
  "reviewer.result_page",
  "reviewer.terminal",
] as const) {
  genericRecords[record] = z.strictObject({
    record: z.literal(record),
    schema_version:
      record === "reviewer.attempt" ||
      record === "reviewer.terminal" ||
      record === "reviewer.coverage"
        ? z.enum(["1", "2"])
        : z.literal("1"),
    run_id: id,
    reviewer_id: id,
    data: z.record(z.string(), z.unknown()),
  });
}

function digest(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}
function fail(message: string): never {
  throw new RunArtifactError("invalid_artifact_record", message);
}
function identityFail(message: string): never {
  throw new RunArtifactError("artifact_identity_changed", message);
}
function parseRecord<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw new RunArtifactError(
      "invalid_artifact_record",
      "Artifact record does not match its declared schema.",
      { cause: parsed.error },
    );
  return parsed.data;
}
function validatePayload(record: Record<string, unknown>): void {
  const kind = String(record.record);
  const schema =
    kind === "resolution" && record.schema_version === "1"
      ? artifactResolutionV1Schema
      : kind === "resolution" && record.schema_version === "2"
        ? artifactResolutionV2Schema
        : kind === "reviewer.attempt" && record.schema_version === "1"
          ? artifactAttemptV1Schema
          : kind === "reviewer.terminal" && record.schema_version === "1"
            ? artifactTerminalV1Schema
            : kind === "reviewer.coverage" && record.schema_version === "1"
              ? artifactCoverageV1Schema
              : privatePayloadSchemas[kind];
  if (schema)
    parseRecord(
      schema,
      record[
        kind === "request" || kind === "resolution" || kind === "context"
          ? kind
          : "data"
      ],
    );
}
function validateHeaderManifest(record: Record<string, unknown>): void {
  const manifest = record.private_record_versions;
  if (
    typeof manifest !== "object" ||
    manifest === null ||
    Array.isArray(manifest)
  )
    fail("Artifact header manifest is invalid.");
  for (const [kind, expected] of Object.entries(PRIVATE_VERSIONS)) {
    const declared = (manifest as Record<string, unknown>)[kind];
    if (
      typeof declared === "string" &&
      declared !== expected &&
      !(kind === "resolution" && ["1", "2"].includes(declared)) &&
      !(
        ["reviewer.attempt", "reviewer.terminal", "reviewer.coverage"].includes(
          kind,
        ) && declared === "1"
      )
    )
      throw new RunArtifactError(
        "unsupported_schema_version",
        `Private artifact record ${kind} schema version is unsupported.`,
      );
  }
}
function validateTerminalSummary(
  summary: Record<string, unknown>,
  runId: string,
): void {
  const delivery = summary.result_delivery as
    { completed_results?: number } | undefined;
  publicEventV6Schema.parse({
    schema_version: "6",
    event: "run.completed",
    run_id: runId,
    seq: 1,
    timestamp: "2026-09-05T00:00:00.000Z",
    data: {
      ...summary,
      artifact: {
        path: "artifact.jsonl",
        sha256: "0".repeat(64),
        byte_count: 0,
        completed_results: delivery?.completed_results ?? 0,
      },
    },
  });
}
function chunks(text: string): string[] {
  const bytes = Buffer.from(text, "utf8");
  const result: string[] = [];
  for (let offset = 0; offset < bytes.length;) {
    let end = Math.min(offset + NARRATIVE_CHUNK_BYTES, bytes.length);
    while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
    result.push(bytes.subarray(offset, end).toString("utf8"));
    offset = end;
  }
  return result;
}

/** Copy from an owned open descriptor; never buffer a whole run in memory. */
async function copyArtifactHandle(
  source: FileHandle,
  target: FileHandle,
  expectedBytes: number,
) {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let offset = 0;
  for (;;) {
    const { bytesRead } = await source.read(buffer, 0, buffer.length, offset);
    if (bytesRead === 0) break;
    if (offset + bytesRead > expectedBytes)
      throw new RunArtifactError(
        "artifact_digest_mismatch",
        "Artifact grew during copying.",
      );
    hash.update(buffer.subarray(0, bytesRead));
    let written = 0;
    while (written < bytesRead) {
      const result = await target.write(
        buffer,
        written,
        bytesRead - written,
        offset + written,
      );
      if (result.bytesWritten === 0)
        throw new Error("Artifact copy made no progress.");
      written += result.bytesWritten;
    }
    offset += bytesRead;
  }
  return { sha256: hash.digest("hex"), byte_count: offset };
}

export async function copyVerifiedArtifact(
  reference: ArtifactReference,
  target: FileHandle,
) {
  const verified = await verifyArtifactFile(reference.path);
  if (
    verified.sha256 !== reference.sha256 ||
    verified.byte_count !== reference.byte_count
  )
    throw new RunArtifactError(
      "artifact_digest_mismatch",
      "Artifact source no longer matches its reference.",
    );
  const source = await open(
    reference.path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    if (
      !sameArtifactIdentity(
        artifactIdentity(await source.stat({ bigint: true })),
        verified.identity,
      )
    )
      throw new RunArtifactError(
        "artifact_identity_changed",
        "Artifact source changed before copying.",
      );
    const copied = await copyArtifactHandle(
      source,
      target,
      reference.byte_count,
    );
    if (
      copied.sha256 !== reference.sha256 ||
      copied.byte_count !== reference.byte_count
    )
      throw new RunArtifactError(
        "artifact_digest_mismatch",
        "Artifact copy does not match its reference.",
      );
    await target.sync();
  } finally {
    await source.close();
  }
}

export async function createManagedRunArtifact(options: {
  runsDirectory: string;
  runId: string;
  toolVersion: string;
  createdAt?: string;
  beforeFinalVerify?: () => void | Promise<void>;
  publishManaged?: boolean;
  beforePublication?: (candidatePath: string) => void | Promise<void>;
}) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(options.runId))
    throw new RunArtifactError("invalid_run_id", "Run ID is invalid.");
  const publishedPath = resolve(
    options.runsDirectory,
    `${options.runId}.jsonl`,
  );
  const artifact = await createRunArtifact({
    path: `${publishedPath}.active`,
    retainHandles: true,
    recoveryPath: join(
      options.runsDirectory,
      ".recovery",
      `${options.runId}.${randomUUID()}.jsonl`,
    ),
    runId: options.runId,
    toolVersion: options.toolVersion,
    ...(options.createdAt === undefined
      ? {}
      : { createdAt: options.createdAt }),
    ...(options.beforeFinalVerify === undefined
      ? {}
      : { beforeFinalVerify: options.beforeFinalVerify }),
  });
  let publishedReference: ArtifactReference | undefined;
  return {
    ...artifact,
    get recoveryReference() {
      return artifact.recoveryReference;
    },
    get publishedReference() {
      return publishedReference;
    },
    async finalize(
      summary: Record<string, unknown>,
    ): Promise<ArtifactReference> {
      let stage = "artifact_final_verification";
      try {
        const active = await artifact.finalize(summary);
        if (options.publishManaged === false)
          return artifact.recoveryReference!;
        stage = "artifact_publication";
        const recovery = artifact.recoveryReference!;
        const parent = await safeArtifactParent(publishedPath);
        const candidatePath = join(
          options.runsDirectory,
          ".recovery",
          `${options.runId}.${randomUUID()}.publication`,
        );
        const target = await open(
          candidatePath,
          constants.O_RDWR |
            constants.O_CREAT |
            constants.O_EXCL |
            (constants.O_NOFOLLOW ?? 0),
          0o600,
        );
        let targetIdentity: ArtifactIdentity;
        try {
          targetIdentity = artifactIdentity(
            await target.stat({ bigint: true }),
          );
          await copyVerifiedArtifact(recovery, target);
        } finally {
          await target.close();
        }
        const candidate = await verifyArtifactFile(
          candidatePath,
          targetIdentity,
        );
        if (
          candidate.sha256 !== active.sha256 ||
          candidate.byte_count !== active.byte_count
        )
          throw new RunArtifactError(
            "artifact_digest_mismatch",
            "Published artifact failed verification.",
          );
        await options.beforePublication?.(candidatePath);
        // Link only a complete verified inode; link is exclusive even when the
        // destination appears between the preflight and this operation.
        const currentCandidate = await verifyArtifactFile(
          candidatePath,
          targetIdentity,
        );
        if (
          currentCandidate.sha256 !== active.sha256 ||
          currentCandidate.byte_count !== active.byte_count
        )
          throw new RunArtifactError(
            "artifact_digest_mismatch",
            "Publication candidate changed after verification.",
          );
        await link(candidatePath, publishedPath);
        const verified = await verifyArtifactFile(
          publishedPath,
          targetIdentity,
          parent,
        );
        if (
          verified.sha256 !== active.sha256 ||
          verified.byte_count !== active.byte_count
        )
          throw new RunArtifactError(
            "artifact_digest_mismatch",
            "Published artifact failed verification.",
          );
        publishedReference = { ...active, path: publishedPath };
        return publishedReference;
      } catch (error) {
        throw new RunArtifactError(
          error instanceof RunArtifactError
            ? error.code
            : "artifact_unavailable",
          "Artifact publication failed; retained recovery evidence is available when listed.",
          {
            cause: error,
            diagnosticDetails: {
              ...(error instanceof RunArtifactError
                ? error.diagnosticDetails
                : {}),
              stage,
              path:
                stage === "artifact_publication"
                  ? publishedPath
                  : artifact.path,
              run_id: options.runId,
              ...(typeof error === "object" &&
              error !== null &&
              "code" in error &&
              typeof error.code === "string" &&
              /^[A-Z0-9_]+$/u.test(error.code)
                ? { native_error_code: error.code }
                : {}),
              ...(artifact.recoveryReference === undefined
                ? {}
                : {
                    recovery_artifact: artifact.recoveryReference,
                    recovery_command: `review-mesh recover ${options.runId} --artifact ${JSON.stringify(artifact.recoveryReference.path)}`,
                  }),
            },
          },
        );
      }
    },
    async persisted() {
      await artifact.releaseStaging(options.publishManaged === false);
    },
  };
}

export async function createRunArtifact(options: {
  path: string;
  runId: string;
  toolVersion: string;
  createdAt?: string;
  beforeFinalVerify?: () => void | Promise<void>;
  recoveryPath?: string;
  retainHandles?: boolean;
}) {
  const path = resolve(options.path);
  const parent = await createSafeArtifactParent(path);
  const handle = await open(
    path,
    constants.O_RDWR |
      constants.O_CREAT |
      constants.O_EXCL |
      (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  const opened = await handle.stat({ bigint: true });
  let finalized = false;
  let tail = Promise.resolve();
  let bytes = 0;
  let recoveryReference: ArtifactReference | undefined;
  let recoveryHandle: FileHandle | undefined;
  let handleClosed = false;
  const contentHash = createHash("sha256");
  const resultIds = new Set<string>();
  const append = async (record: unknown) => {
    const text = JSON.stringify(record) + "\n";
    await handle.appendFile(text, "utf8");
    contentHash.update(text);
    bytes += Buffer.byteLength(text, "utf8");
  };
  const enqueue = (operation: () => Promise<void>) => {
    if (finalized) return Promise.reject(new Error("Artifact is finalized."));
    const next = tail.then(operation);
    tail = next;
    return next;
  };
  try {
    await append(
      headerSchema.parse({
        record: "run.artifact",
        artifact_format_version: "2",
        run_id: options.runId,
        tool_version: options.toolVersion,
        created_at: options.createdAt ?? new Date().toISOString(),
        private_record_versions: PRIVATE_VERSIONS,
      }),
    );
  } catch (error) {
    await handle.close();
    throw error;
  }
  return {
    path,
    get recoveryReference() {
      return recoveryReference;
    },
    record(value: Record<string, unknown>): Promise<void> {
      return enqueue(async () => {
        if (value.run_id !== undefined && value.run_id !== options.runId)
          fail("Artifact record has the wrong run identity.");
        if (typeof value.event === "string") {
          const event = publicEventV6Schema.parse(value);
          if (event.run_id !== options.runId || event.event === "run.completed")
            fail("Public terminal cannot be mirrored into an artifact.");
          await append(event);
          return;
        }
        const kind = String(value.record);
        const schema = genericRecords[kind];
        if (schema === undefined) fail("Unknown private artifact record type.");
        const cleanValue =
          kind === "request" ||
          kind === "context" ||
          kind === "resolution" ||
          kind === "reviewer.attempt" ||
          kind === "reviewer.activity" ||
          kind === "reviewer.activity_summary"
            ? (sanitizeRunMetadata(value) as Record<string, unknown>)
            : value;
        const parsed = schema.parse({
          ...cleanValue,
          run_id: options.runId,
          schema_version:
            PRIVATE_VERSIONS[kind as keyof typeof PRIVATE_VERSIONS],
        }) as Record<string, unknown>;
        validatePayload(parsed);
        await append(parsed);
      });
    },
    result(reviewerId: string, input: CurrentResult): Promise<void> {
      return enqueue(async () => {
        id.parse(reviewerId);
        if (resultIds.has(reviewerId))
          fail("A reviewer result was persisted twice.");
        const result = CURRENT_RESULT.parse(input);
        const byteCount = Buffer.byteLength(JSON.stringify(result), "utf8");
        if (byteCount > MAX_REVIEWER_RESULT_BYTES)
          fail("Reviewer result exceeds the assembled limit.");
        const narrative = result.review_markdown;
        const split =
          Buffer.byteLength(narrative, "utf8") > 24 * 1024
            ? chunks(narrative)
            : [];
        for (const [index, text] of split.entries())
          await append(
            narrativeSchema.parse({
              record: "reviewer.narrative",
              schema_version: "1",
              run_id: options.runId,
              reviewer_id: reviewerId,
              index,
              text,
              sha256: digest(text),
            }),
          );
        const stored =
          split.length === 0 ? result : { ...result, review_markdown: "" };
        await append(
          resultSchema.parse({
            record: "reviewer.result",
            schema_version: "1",
            run_id: options.runId,
            reviewer_id: reviewerId,
            digest: reviewerResultDigest(result),
            byte_count: byteCount,
            result: stored,
            ...(split.length === 0
              ? {}
              : {
                  narrative: {
                    chunks: split.length,
                    byte_count: Buffer.byteLength(narrative, "utf8"),
                    sha256: digest(narrative),
                  },
                }),
          }),
        );
        resultIds.add(reviewerId);
      });
    },
    async finalize(
      summary: Record<string, unknown>,
    ): Promise<ArtifactReference> {
      if (finalized) throw new Error("Artifact is finalized.");
      finalized = true;
      try {
        await tail;
        validateTerminalSummary(summary, options.runId);
        const delivery = summary.result_delivery as
          { completed_results?: unknown } | undefined;
        if (delivery?.completed_results !== resultIds.size)
          fail("Artifact result count does not match terminal delivery.");
        await append(
          summarySchema.parse({
            record: "run.terminal_summary",
            schema_version: "1",
            run_id: options.runId,
            summary,
          }),
        );
        const terminal = terminalSchema.parse({
          record: "run.artifact_terminal",
          schema_version: "1",
          run_id: options.runId,
          content_sha256: contentHash.copy().digest("hex"),
          content_byte_count: bytes,
        });
        await append(terminal);
        await handle.sync();
        const completedResults = resultIds.size;
        const expectedMetadata = await handle.stat({ bigint: true });
        const attemptedHash = contentHash.copy().digest("hex");
        if (options.recoveryPath !== undefined) {
          const recoveryPath = resolve(options.recoveryPath);
          await createSafeArtifactParent(recoveryPath);
          const recovery = await open(
            recoveryPath,
            constants.O_RDWR |
              constants.O_CREAT |
              constants.O_EXCL |
              (constants.O_NOFOLLOW ?? 0),
            0o600,
          );
          try {
            const copied = await copyArtifactHandle(handle, recovery, bytes);
            if (copied.sha256 !== attemptedHash || copied.byte_count !== bytes)
              throw new RunArtifactError(
                "artifact_digest_mismatch",
                "Recovery bytes do not match serialized artifact records.",
              );
            await recovery.sync();
            const verifiedRecovery = await verifyArtifactFile(
              recoveryPath,
              artifactIdentity(await recovery.stat({ bigint: true })),
            );
            if (
              verifiedRecovery.sha256 !== attemptedHash ||
              verifiedRecovery.byte_count !== bytes
            )
              throw new RunArtifactError(
                "artifact_digest_mismatch",
                "Recovery copy failed verification.",
              );
            recoveryReference = {
              path: recoveryPath,
              sha256: attemptedHash,
              byte_count: bytes,
              completed_results: completedResults,
            };
            if (options.retainHandles) recoveryHandle = recovery;
          } finally {
            if (recoveryHandle !== recovery) await recovery.close();
          }
        }
        if (!options.retainHandles) {
          await handle.close();
          handleClosed = true;
        }
        await options.beforeFinalVerify?.();
        const verified = await verifyArtifactFile(
          path,
          artifactIdentity(opened),
          parent,
          expectedMetadata,
        );
        if (verified.sha256 !== attemptedHash || verified.byte_count !== bytes)
          throw new RunArtifactError(
            "artifact_digest_mismatch",
            "Final artifact bytes do not match the serialized records.",
          );
        return {
          path,
          sha256: verified.sha256,
          byte_count: verified.byte_count,
          completed_results: completedResults,
        };
      } finally {
        if (!options.retainHandles) {
          await handle.close().catch(() => undefined);
          handleClosed = true;
        }
      }
    },
    async releaseStaging(wipeRecovery: boolean) {
      // Cleanup only after all required verified publication succeeds. The
      // original descriptors avoid deleting a subsequently replaced pathname.
      if (!handleClosed) {
        await handle.truncate(0);
        await handle.sync();
        await handle.close();
        handleClosed = true;
      }
      if (recoveryHandle) {
        if (wipeRecovery) {
          await recoveryHandle.truncate(0);
          await recoveryHandle.sync();
        }
        await recoveryHandle.close();
        recoveryHandle = undefined;
      }
    },
    async close(): Promise<void> {
      if (!finalized) {
        finalized = true;
        await tail.finally(() => handle.close());
        handleClosed = true;
      }
      if (!handleClosed) {
        await handle.close();
        handleClosed = true;
      }
      await recoveryHandle?.close();
      recoveryHandle = undefined;
    },
  };
}

export interface ArtifactReadResult {
  run_id: string;
  active: boolean;
  results: Array<{
    reviewer_id: string;
    digest: string;
    byte_count: number;
    result: CurrentResult;
  }>;
  records: Record<string, unknown>[];
  summary: Record<string, unknown>;
  sha256: string;
  byte_count: number;
  digest_status: "verified" | "final_digest_unavailable";
}

export async function readRunArtifact(
  path: string,
  options: {
    expectedSha256?: string;
    expectedIdentity?: ArtifactIdentity;
    beforeFinalVerify?: () => void | Promise<void>;
    allowActive?: boolean;
  } = {},
): Promise<ArtifactReadResult> {
  let handle: FileHandle | undefined;
  try {
    const parent = await safeArtifactParent(path);
    const before = await lstat(path, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink())
      identityFail("Artifact is not a regular file.");
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat({ bigint: true });
    if (
      !sameArtifactIdentity(
        artifactIdentity(before),
        artifactIdentity(opened),
      ) ||
      (options.expectedIdentity !== undefined &&
        !sameArtifactIdentity(
          artifactIdentity(opened),
          options.expectedIdentity,
        ))
    )
      identityFail("Artifact identity changed while opening.");
    const hashAll = createHash("sha256");
    const hashContent = createHash("sha256");
    let byteCount = 0,
      contentBytes = 0,
      lineNumber = 0;
    let carry = Buffer.alloc(0);
    let header: z.infer<typeof headerSchema> | undefined;
    let summary: Record<string, unknown> | undefined;
    let terminalSeen = false;
    const records: Record<string, unknown>[] = [];
    const results: ArtifactReadResult["results"] = [];
    const pages = new Map<string, string[]>();
    const narratives = new Map<
      string,
      { fragments: string[]; byteCount: number }
    >();
    let narrativeBytes = 0;
    let narrativeChunks = 0;
    const consume = (line: Buffer) => {
      let raw: unknown;
      try {
        if (++lineNumber > 1_000_000)
          fail("Artifact record count limit exceeded.");
        if (terminalSeen) fail("Artifact has a post-terminal record.");
        raw = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(
            line.subarray(0, -1),
          ),
        );
      } catch (error) {
        if (error instanceof RunArtifactError) throw error;
        throw new RunArtifactError(
          "invalid_artifact_record",
          "Artifact record is not valid UTF-8 JSON.",
          { cause: error },
        );
      }
      if (typeof raw !== "object" || raw === null || Array.isArray(raw))
        fail("Artifact record must be an object.");
      const record = raw as Record<string, unknown>;
      if (lineNumber === 1) {
        if (record.artifact_format_version !== "2")
          throw new RunArtifactError(
            "unsupported_schema_version",
            "Artifact format version is unsupported.",
          );
        validateHeaderManifest(record);
        header = parseRecord(headerSchema, record);
      } else {
        if (header === undefined || record.run_id !== header.run_id)
          fail("Artifact run identity mismatch.");
        if (typeof record.record === "string") {
          const expected = header.private_record_versions[record.record];
          if (expected !== undefined && record.schema_version !== expected)
            throw new RunArtifactError(
              "unsupported_schema_version",
              "Private artifact record schema version is unsupported.",
            );
        } else if (record.schema_version !== "6") {
          throw new RunArtifactError(
            "unsupported_schema_version",
            "Artifact event schema version is unsupported.",
          );
        }
        if (record.record === "run.artifact_terminal") {
          const terminal = parseRecord(terminalSchema, record);
          if (
            summary === undefined ||
            terminal.content_sha256 !== hashContent.copy().digest("hex") ||
            terminal.content_byte_count !== contentBytes
          )
            throw new RunArtifactError(
              "artifact_digest_mismatch",
              "Artifact preterminal content digest is invalid.",
            );
          terminalSeen = true;
        } else if (summary !== undefined)
          fail(
            "Artifact terminal summary must immediately precede its digest record.",
          );
        else if (record.record === "run.terminal_summary") {
          summary = parseRecord(summarySchema, record).summary;
          try {
            validateTerminalSummary(summary, header.run_id);
          } catch (error) {
            throw new RunArtifactError(
              "invalid_artifact_record",
              "Artifact terminal summary is invalid.",
              { cause: error },
            );
          }
        } else if (record.record === "reviewer.narrative") {
          const chunk = parseRecord(narrativeSchema, record);
          const previous = narratives.get(chunk.reviewer_id) ?? {
            fragments: [],
            byteCount: 0,
          };
          if (
            chunk.index !== previous.fragments.length ||
            chunk.sha256 !== digest(chunk.text)
          )
            fail("Artifact narrative chunk is invalid.");
          const chunkBytes = Buffer.byteLength(chunk.text, "utf8");
          if (
            previous.byteCount + chunkBytes > MAX_REVIEWER_RESULT_BYTES ||
            previous.fragments.length + 1 > MAX_NARRATIVE_CHUNKS ||
            narrativeBytes + chunkBytes > MAX_REVIEWER_RESULT_BYTES ||
            narrativeChunks + 1 > MAX_NARRATIVE_CHUNKS
          )
            fail("Artifact narrative chunk limit exceeded.");
          previous.fragments.push(chunk.text);
          previous.byteCount += chunkBytes;
          narrativeBytes += chunkBytes;
          narrativeChunks++;
          narratives.set(chunk.reviewer_id, previous);
        } else if (record.record === "reviewer.result") {
          const item = parseRecord(resultSchema, record);
          if (results.some((result) => result.reviewer_id === item.reviewer_id))
            fail("Artifact repeats a reviewer result.");
          const pending = narratives.get(item.reviewer_id);
          const fragments = pending?.fragments ?? [];
          let reconstructed = item.result;
          if (item.narrative !== undefined) {
            const narrative = fragments.join("");
            if (
              fragments.length !== item.narrative.chunks ||
              Buffer.byteLength(narrative, "utf8") !==
                item.narrative.byte_count ||
              digest(narrative) !== item.narrative.sha256
            )
              fail("Artifact narrative reference is invalid.");
            reconstructed = { ...reconstructed, review_markdown: narrative };
          } else if (fragments.length > 0)
            fail("Unreferenced artifact narrative chunks.");
          const result = parseRecord(CURRENT_RESULT, reconstructed);
          if (
            reviewerResultDigest(result) !== item.digest ||
            Buffer.byteLength(JSON.stringify(result), "utf8") !==
              item.byte_count ||
            item.byte_count > MAX_REVIEWER_RESULT_BYTES
          )
            fail("Artifact result digest or size is invalid.");
          results.push({
            reviewer_id: item.reviewer_id,
            digest: item.digest,
            byte_count: item.byte_count,
            result,
          });
          narrativeBytes -= pending?.byteCount ?? 0;
          narrativeChunks -= fragments.length;
          narratives.delete(item.reviewer_id);
        } else if (typeof record.event === "string") {
          const event = parseRecord(publicEventV6Schema, record);
          if (event.event === "run.completed")
            fail("Public terminal cannot be mirrored into format two.");
          records.push(event);
        } else {
          const schema = genericRecords[String(record.record)];
          if (schema === undefined)
            fail("Unknown private artifact record type.");
          const parsed = parseRecord(schema, record) as Record<string, unknown>;
          validatePayload(parsed);
          if (parsed.record === "reviewer.result_page") {
            const body = parsed.data as { index: number; raw: string };
            const previous = pages.get(String(parsed.reviewer_id)) ?? [];
            if (body.index !== previous.length)
              fail("Artifact result pages contain a gap or duplicate.");
            if (previous.length >= 951)
              fail("Artifact result page count exceeds its bound.");
            previous.push(body.raw);
            pages.set(String(parsed.reviewer_id), previous);
          }
          records.push(parsed);
        }
      }
      hashAll.update(line);
      byteCount += line.length;
      if (!terminalSeen) {
        hashContent.update(line);
        contentBytes += line.length;
      }
    };
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    for (;;) {
      const { bytesRead } = await handle.read(
        buffer,
        0,
        buffer.length,
        position,
      );
      if (bytesRead === 0) break;
      position += bytesRead;
      carry = Buffer.concat([carry, buffer.subarray(0, bytesRead)]);
      for (;;) {
        const newline = carry.indexOf(10);
        if (newline < 0) break;
        consume(carry.subarray(0, newline + 1));
        carry = carry.subarray(newline + 1);
      }
      if (carry.length > MAX_REVIEWER_RESULT_BYTES + 1024 * 1024)
        fail("Artifact record exceeds the line limit.");
    }
    const active = !terminalSeen;
    const allowActive =
      active &&
      options.allowActive === true &&
      header !== undefined &&
      options.expectedSha256 === undefined;
    if (
      !allowActive &&
      (carry.length || !terminalSeen || !header || !summary || narratives.size)
    )
      fail("Artifact is incomplete.");
    const sha256 = hashAll.digest("hex");
    if (
      options.expectedSha256 !== undefined &&
      options.expectedSha256 !== sha256
    )
      throw new RunArtifactError(
        "artifact_digest_mismatch",
        "Final artifact digest does not match the published digest.",
      );
    const after = await handle.stat({ bigint: true });
    await handle.close();
    handle = undefined;
    await options.beforeFinalVerify?.();
    let current: Awaited<ReturnType<typeof lstat>>;
    let parentAfter: Awaited<ReturnType<typeof safeArtifactParent>>;
    try {
      current = await lstat(path, { bigint: true });
      parentAfter = await safeArtifactParent(path);
    } catch (error) {
      if (error instanceof RunArtifactError) throw error;
      throw new RunArtifactError(
        "artifact_identity_changed",
        "Artifact identity changed while reading.",
        { cause: error },
      );
    }
    if (
      (!allowActive &&
        (after.size !== opened.size ||
          after.mtimeNs !== opened.mtimeNs ||
          after.ctimeNs !== opened.ctimeNs ||
          current.size !== opened.size ||
          current.mtimeNs !== opened.mtimeNs ||
          current.ctimeNs !== opened.ctimeNs)) ||
      (allowActive &&
        (after.size < opened.size || current.size < opened.size)) ||
      current.ino !== opened.ino ||
      current.dev !== opened.dev ||
      current.isSymbolicLink() ||
      parentAfter.path !== parent.path ||
      !sameArtifactIdentity(parentAfter, parent) ||
      (options.expectedIdentity !== undefined &&
        !sameArtifactIdentity(
          artifactIdentity(current),
          options.expectedIdentity,
        ))
    )
      identityFail("Artifact identity changed while reading.");
    if (allowActive)
      return {
        run_id: header!.run_id,
        active: true,
        results,
        records,
        summary: summary ?? {},
        sha256,
        byte_count: byteCount,
        digest_status: "final_digest_unavailable",
      };
    if (!summary || !header) fail("Artifact is incomplete.");
    for (const [reviewerId, rawPages] of pages) {
      const result = results.find(
        (item) => item.reviewer_id === reviewerId,
      )?.result;
      if (!result) fail("Artifact pages have no complete reviewer result.");
      const firstPage = JSON.parse(rawPages[0]!) as {
        result_id: string;
        result_kind: "reviewer" | "adjudication";
      };
      const collector = createResultPageCollector({
        resultId: firstPage.result_id,
        resultKind: firstPage.result_kind,
        ...(result.schema_version === "2"
          ? {
              candidateIds: result.decisions.map(
                (decision) => decision.source_finding_id,
              ),
            }
          : {}),
      });
      try {
        for (const raw of rawPages) collector.addPage(raw);
        const assembled = collector.assemble();
        const expected =
          result.schema_version === "4"
            ? (({ change_coverage: _coverage, ...provider }) => provider)(
                result,
              )
            : result;
        if (reviewerResultDigest(assembled) !== reviewerResultDigest(expected))
          fail("Artifact result pages do not reproduce the accepted result.");
      } catch (error) {
        if (error instanceof RunArtifactError) throw error;
        throw new RunArtifactError(
          "invalid_artifact_record",
          "Artifact result page chain is invalid.",
          { cause: error },
        );
      }
    }
    const delivery = summary.result_delivery as
      { completed_results?: unknown } | undefined;
    if (delivery?.completed_results !== results.length)
      fail("Artifact terminal result delivery count mismatch.");
    return {
      run_id: header.run_id,
      active,
      results,
      records,
      summary,
      sha256,
      byte_count: byteCount,
      digest_status:
        options.expectedSha256 === undefined
          ? "final_digest_unavailable"
          : "verified",
    };
  } finally {
    await handle?.close();
  }
}
