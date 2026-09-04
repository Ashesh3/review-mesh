import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  realpath,
  type FileHandle,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import {
  adjudicationResultV2Schema,
  reviewerResultV4Schema,
  publicEventV6Schema,
  type AdjudicationResultV2,
  type ReviewerResultV4,
} from "../protocol/v9.js";
import { reviewerResultDigest } from "../results/digest.js";
import { MAX_REVIEWER_RESULT_BYTES } from "../results/sanitize.js";
import { RunArtifactError, type ArtifactReference } from "./run-index.js";

const CURRENT_RESULT = z.union([
  reviewerResultV4Schema,
  adjudicationResultV2Schema,
]);
type CurrentResult = ReviewerResultV4 | AdjudicationResultV2;
const id = z.string().min(1).max(128);
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const count = z.number().int().nonnegative();
const PRIVATE_VERSIONS = {
  resolution: "1",
  request: "3",
  context: "1",
  "reviewer.attempt": "1",
  "reviewer.activity": "1",
  "reviewer.activity_summary": "1",
  "reviewer.coverage": "1",
  "reviewer.result_page": "1",
  "reviewer.narrative": "1",
  "reviewer.result": "1",
  "reviewer.terminal": "1",
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
          z.literal(value),
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
    .refine((value) => Buffer.byteLength(value, "utf8") <= 24 * 1024),
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
  resolution: z.strictObject({
    record: z.literal("resolution"),
    schema_version: z.literal("1"),
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
    schema_version: z.literal("1"),
    run_id: id,
    reviewer_id: id,
    data: z.record(z.string(), z.unknown()),
  });
}

function digest(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}
function fail(message: string): never {
  throw new RunArtifactError("invalid_run_index", message);
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
    let end = Math.min(offset + 24 * 1024, bytes.length);
    while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
    result.push(bytes.subarray(offset, end).toString("utf8"));
    offset = end;
  }
  return result;
}

export async function createRunArtifact(options: {
  path: string;
  runId: string;
  toolVersion: string;
  createdAt?: string;
}) {
  const path = resolve(options.path);
  await mkdir(dirname(path), { recursive: true });
  const parent = await realpath(dirname(path));
  const parentBefore = await lstat(parent, { bigint: true });
  if (parentBefore.isSymbolicLink() || !parentBefore.isDirectory())
    fail("Artifact directory is unsafe.");
  const handle = await open(
    path,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  const opened = await handle.stat({ bigint: true });
  let finalized = false;
  let tail = Promise.resolve();
  let bytes = 0;
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
        await append(
          schema.parse({
            ...value,
            run_id: options.runId,
            schema_version:
              PRIVATE_VERSIONS[kind as keyof typeof PRIVATE_VERSIONS],
          }),
        );
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
        const current = await lstat(path, { bigint: true });
        const parentAfter = await lstat(parent, { bigint: true });
        if (
          !current.isFile() ||
          current.isSymbolicLink() ||
          current.dev !== opened.dev ||
          current.ino !== opened.ino ||
          parentAfter.dev !== parentBefore.dev ||
          parentAfter.ino !== parentBefore.ino
        )
          fail("Artifact identity changed during finalization.");
        return {
          path,
          sha256: contentHash.digest("hex"),
          byte_count: bytes,
          completed_results: resultIds.size,
        };
      } finally {
        await handle.close();
      }
    },
    async close(): Promise<void> {
      if (!finalized) {
        finalized = true;
        await tail.finally(() => handle.close());
      }
    },
  };
}

export interface ArtifactReadResult {
  run_id: string;
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
  options: { expectedSha256?: string } = {},
): Promise<ArtifactReadResult> {
  let handle: FileHandle | undefined;
  try {
    const before = await lstat(path, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink())
      fail("Artifact is not a regular file.");
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat({ bigint: true });
    if (before.dev !== opened.dev || before.ino !== opened.ino)
      fail("Artifact identity changed while opening.");
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
    const narratives = new Map<string, string[]>();
    const consume = (line: Buffer) => {
      if (++lineNumber > 1_000_000)
        fail("Artifact record count limit exceeded.");
      if (terminalSeen) fail("Artifact has a post-terminal record.");
      const raw: unknown = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(line.subarray(0, -1)),
      );
      if (typeof raw !== "object" || raw === null || Array.isArray(raw))
        fail("Artifact record must be an object.");
      const record = raw as Record<string, unknown>;
      if (lineNumber === 1) {
        if (record.artifact_format_version !== "2")
          throw new RunArtifactError(
            "unsupported_schema_version",
            "Artifact format version is unsupported.",
          );
        header = headerSchema.parse(record);
      } else {
        if (header === undefined || record.run_id !== header.run_id)
          fail("Artifact run identity mismatch.");
        if (typeof record.record === "string") {
          const expected =
            PRIVATE_VERSIONS[record.record as keyof typeof PRIVATE_VERSIONS];
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
          const terminal = terminalSchema.parse(record);
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
          summary = summarySchema.parse(record).summary;
          validateTerminalSummary(summary, header.run_id);
        } else if (record.record === "reviewer.narrative") {
          const chunk = narrativeSchema.parse(record);
          const previous = narratives.get(chunk.reviewer_id) ?? [];
          if (
            chunk.index !== previous.length ||
            chunk.sha256 !== digest(chunk.text)
          )
            fail("Artifact narrative chunk is invalid.");
          previous.push(chunk.text);
          narratives.set(chunk.reviewer_id, previous);
        } else if (record.record === "reviewer.result") {
          const item = resultSchema.parse(record);
          if (results.some((result) => result.reviewer_id === item.reviewer_id))
            fail("Artifact repeats a reviewer result.");
          const fragments = narratives.get(item.reviewer_id) ?? [];
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
          const result = CURRENT_RESULT.parse(reconstructed);
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
          narratives.delete(item.reviewer_id);
        } else if (typeof record.event === "string") {
          const event = publicEventV6Schema.parse(record);
          if (event.event === "run.completed")
            fail("Public terminal cannot be mirrored into format two.");
          records.push(event);
        } else {
          const schema = genericRecords[String(record.record)];
          if (schema === undefined)
            fail("Unknown private artifact record type.");
          records.push(schema.parse(record) as Record<string, unknown>);
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
    if (carry.length || !terminalSeen || !header || !summary || narratives.size)
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
    const current = await lstat(path, { bigint: true });
    if (
      after.size !== opened.size ||
      after.mtimeNs !== opened.mtimeNs ||
      after.ctimeNs !== opened.ctimeNs ||
      current.ino !== opened.ino ||
      current.dev !== opened.dev ||
      current.isSymbolicLink()
    )
      fail("Artifact identity changed while reading.");
    const delivery = summary.result_delivery as
      { completed_results?: unknown } | undefined;
    if (delivery?.completed_results !== results.length)
      fail("Artifact terminal result delivery count mismatch.");
    return {
      run_id: header.run_id,
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
