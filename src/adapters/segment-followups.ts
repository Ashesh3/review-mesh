import { z } from "zod";

export const segmentReadSchema = z.object({
  kind: z.enum(["snapshot", "diff", "context"]).optional(),
  path: z.string().min(1).max(1024).optional(),
  offset: z.number().int().nonnegative().default(0),
  byte_count: z.number().int().min(1).max(32768).default(8192),
});
export type SegmentRead = z.infer<typeof segmentReadSchema>;
export type SourceRange = {
  kind: "snapshot" | "diff" | "context";
  path: string;
  offset: number;
  byte_count: number;
};
export type FollowUpResult = {
  error_id?: string;
  request: SegmentRead;
  status: "queued" | "rejected";
  reason?:
    "invalid_path" | "not_in_snapshot" | "invalid_range" | "kind_path_mismatch";
  retryable?: boolean;
} & Partial<SourceRange>;

/** Only captured bytes can be requested. Invalid optional reads are feedback,
 * never permission to skip the mandatory evidence queue or access the live FS. */
export function resolveSegmentRead(
  request: SegmentRead,
  sources: {
    diffBytes: number;
    contextBytes: number;
    snapshots: readonly { path: string; byteCount: number }[];
  },
): FollowUpResult {
  const reject = (
    reason: NonNullable<FollowUpResult["reason"]>,
  ): FollowUpResult => ({
    request,
    status: "rejected",
    reason,
    retryable: true,
  });
  const kind =
    request.kind ??
    (request.path === "<change-diff>"
      ? "diff"
      : request.path === "<caller-context>"
        ? "context"
        : "snapshot");
  let path: string;
  let size: number;
  if (kind !== "snapshot") {
    path = kind === "diff" ? "<change-diff>" : "<caller-context>";
    if (request.path !== undefined && request.path !== path)
      return reject("kind_path_mismatch");
    size = kind === "diff" ? sources.diffBytes : sources.contextBytes;
  } else {
    const raw = request.path?.replaceAll("\\", "/").normalize("NFC");
    if (
      !raw ||
      raw.startsWith("/") ||
      /^[A-Za-z]:/u.test(raw) ||
      /[\u0000-\u001f\u007f]/u.test(raw) ||
      raw.split("/").includes("..")
    )
      return reject("invalid_path");
    path = raw
      .split("/")
      .filter((part) => part !== "" && part !== ".")
      .join("/");
    if (!path) return reject("invalid_path");
    const file = sources.snapshots.find((file) => file.path === path);
    if (!file) return reject("not_in_snapshot");
    size = file.byteCount;
  }
  if (
    !Number.isSafeInteger(request.offset) ||
    request.offset < 0 ||
    request.offset > size
  )
    return reject("invalid_range");
  return {
    request,
    status: "queued",
    kind,
    path,
    offset: request.offset,
    byte_count: Math.min(request.byte_count, size - request.offset),
  };
}

function subtractRange(
  range: SourceRange,
  removed: SourceRange,
): SourceRange[] {
  if (range.kind !== removed.kind || range.path !== removed.path)
    return [range];
  if (range.byte_count === 0 || removed.byte_count === 0)
    return range.byte_count === 0 &&
      removed.byte_count === 0 &&
      range.offset === removed.offset
      ? []
      : [range];
  const end = range.offset + range.byte_count,
    removedEnd = removed.offset + removed.byte_count;
  if (removedEnd <= range.offset || removed.offset >= end) return [range];
  return [
    ...(removed.offset > range.offset
      ? [{ ...range, byte_count: removed.offset - range.offset }]
      : []),
    ...(removedEnd < end
      ? [{ ...range, offset: removedEnd, byte_count: end - removedEnd }]
      : []),
  ];
}

/** Move requested bytes that are already pending ahead of other source work.
 * New supporting reads and rereads stay behind that work, so repeatedly asking
 * for delivered bytes cannot starve mandatory progress. Context always stays
 * first, and the union of requested and pending bytes is preserved once. */
export function prioritizeSegmentReads(
  queue: readonly SourceRange[],
  requestedRanges: readonly SourceRange[],
): SourceRange[] {
  const contextEnd = queue.findIndex((range) => range.kind !== "context");
  const leading = queue
    .slice(0, contextEnd < 0 ? queue.length : contextEnd)
    .map((range) => ({ ...range }));
  let pending = queue.slice(leading.length).map((range) => ({ ...range }));
  const prioritized: SourceRange[] = [],
    appended: SourceRange[] = [],
    seenRequests: SourceRange[] = [];
  for (const request of requestedRanges) {
    let unique = [{ ...request }];
    for (const prior of [...leading, ...seenRequests])
      unique = unique.flatMap((range) => subtractRange(range, prior));
    seenRequests.push({ ...request });
    for (const part of unique) {
      let notPending = [part];
      for (const original of pending) {
        if (original.kind !== part.kind || original.path !== part.path)
          continue;
        if (
          original.byte_count === 0 &&
          part.byte_count === 0 &&
          original.offset === part.offset
        )
          prioritized.push({ ...part });
        else {
          const start = Math.max(part.offset, original.offset),
            end = Math.min(
              part.offset + part.byte_count,
              original.offset + original.byte_count,
            );
          if (end > start)
            prioritized.push({
              ...part,
              offset: start,
              byte_count: end - start,
            });
        }
        notPending = notPending.flatMap((range) =>
          subtractRange(range, original),
        );
      }
      pending = pending.flatMap((range) => subtractRange(range, part));
      appended.push(...notPending);
    }
  }
  return [...leading, ...prioritized, ...pending, ...appended];
}
