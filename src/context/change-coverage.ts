import { createHash } from "node:crypto";
import {
  lstat,
  open,
  opendir,
  realpath,
  type FileHandle,
} from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  changedPathMatchesGlob,
  validateChangedPath,
} from "../orchestrator/lens-policy.js";
import type {
  CoverageAttestation,
  ChangeCoverageResult,
} from "../protocol/v9.js";
import { canonicalJson } from "../results/digest.js";
import type { ResolvedContext } from "./resolve.js";
import { MAX_FILE_BYTES, MAX_READ_BYTES } from "./read-limits.js";

const MAX_SNAPSHOT_BYTES = 32 * 1024 * 1024;
const MAX_ATTESTED_PATHS = 256;
const MAX_LIST_ENTRIES = 20_000;
const SKIPPED_DIRECTORIES = new Set([".git", "node_modules", ".review-mesh"]);
const NO_FOLLOW =
  (constants as unknown as Record<string, number>).O_NOFOLLOW ?? 0;

export interface ChangeCoveragePolicy {
  relevantPaths: readonly string[];
  minimumInspection: "full_file" | "diff";
  proof: "observed" | "attested";
}

export type SnapshotReadState =
  | "satisfied"
  | "not_required"
  | "unavailable"
  | "oversize"
  | "binary"
  | "not_inspected";
export type DiffDeliveryState =
  | "satisfied"
  | "not_required"
  | "context_truncated"
  | "unavailable"
  | "binary"
  | "not_inspected";

export interface ChangeCoverageEntry {
  path: string;
  kind: "tracked" | "deleted" | "untracked";
  required_method: "full_file" | "diff" | "deleted_diff";
  proof_kind: "observed" | "attested";
  relevant: boolean;
  snapshot_digest?: string;
  snapshot_byte_count?: number;
  snapshot_read: SnapshotReadState;
  diff_delivery: DiffDeliveryState;
  disposition: "satisfied" | "deficit";
  reason?: string;
}

export type CoverageReadFailureReason =
  | "invalid_path"
  | "unavailable"
  | "oversize"
  | "binary"
  | "closed"
  | "invalid_range";

export type CoverageReadResult =
  | {
      ok: true;
      path: string;
      bytes: Uint8Array;
      offset: number;
      byteCount: number;
      totalByteCount: number;
      sha256: string;
      snapshotDigest: string;
      eof: boolean;
      acknowledgeDelivered(): void;
    }
  | {
      ok: false;
      path: string;
      reason: CoverageReadFailureReason;
      maximumByteCount?: number;
      totalByteCount?: number;
    };

export interface CoverageByteRange {
  offset: number;
  byte_count: number;
}

export interface ChangeCoverageStatusEntry extends ChangeCoverageEntry {
  snapshot_required: boolean;
  diff_required: boolean;
  attestation_required: boolean;
  attestation_received: boolean;
  delivered_byte_ranges: CoverageByteRange[];
  missing_byte_ranges: CoverageByteRange[];
  snapshot_content_delivered: boolean;
}

export interface ChangeCoverageStatus {
  complete: boolean;
  scope_digest: string;
  proof_kind: ChangeCoveragePolicy["proof"];
  maximum_read_bytes: number;
  summary: ChangeCoverageResult;
  entries: ChangeCoverageStatusEntry[];
  deficits: ChangeCoverageStatusEntry[];
}

interface SnapshotFile {
  path: string;
  bytes: Buffer;
  digest: string;
}

interface MutableEntry extends ChangeCoverageEntry {
  snapshot?: SnapshotFile;
  intervals: Array<[number, number]>;
  stickyFailure?: string;
  attested: boolean;
}

interface SharedSnapshot {
  files: Map<string, SnapshotFile>;
  failures: Map<string, CoverageReadFailureReason>;
  complete: boolean;
}

export interface RunSnapshotIdentity {
  schema_version: "1";
  sha256: string;
  file_count: number;
  complete: boolean;
}

const sharedSnapshots = new WeakMap<ResolvedContext, Promise<SharedSnapshot>>();

export type ChangeCoverageNotApplicable =
  | { reason: "full_review" }
  | {
      reason: "policy_excluded";
      policy_reference: { relevant_paths: string[] };
    };

export interface ChangeCoverageLedger {
  readonly scopeDigest: string;
  readonly notApplicable?: ChangeCoverageNotApplicable;
  observedFile(path: string): boolean;
  readFile(input: {
    path: string;
    offset?: number;
    byteCount?: number;
  }): Promise<CoverageReadResult>;
  recordDiffDelivery(
    paths: readonly string[],
    delivery: { byteCount: number; sha256: string },
  ): void;
  reconcileAttestation(attestation: CoverageAttestation): ChangeCoverageResult;
  summary(): ChangeCoverageResult;
  status(): ChangeCoverageStatus;
  snapshotIdentity(): RunSnapshotIdentity;
  entries(): ChangeCoverageEntry[];
  snapshotFiles(): Array<{
    path: string;
    bytes: Uint8Array;
    byteCount: number;
  }>;
  close(): Promise<void>;
}

export function releaseRunSnapshot(context: ResolvedContext): void {
  sharedSnapshots.delete(context);
}

function digest(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function compareCodePoints(left: string, right: string): number {
  const a = Array.from(left, (value) => value.codePointAt(0)!);
  const b = Array.from(right, (value) => value.codePointAt(0)!);
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    if (a[index] !== b[index]) return a[index]! - b[index]!;
  }
  return a.length - b.length;
}

function canonicalPath(path: string): string {
  const normalized = path.replaceAll("\\", "/").normalize("NFC");
  validateChangedPath(normalized);
  if (
    ["__proto__", "prototype", "constructor"].some((part) =>
      normalized.split("/").includes(part),
    )
  ) {
    throw new Error("unsafe path");
  }
  return normalized;
}

function inside(root: string, candidate: string): boolean {
  const value = relative(root, candidate);
  return value === "" || (!value.startsWith("..") && !isAbsolute(value));
}

async function safeOpen(
  root: string,
  path: string,
): Promise<{ handle: FileHandle; size: number } | CoverageReadFailureReason> {
  const absolute = resolve(root, ...path.split("/"));
  if (!inside(root, absolute)) return "invalid_path";
  let cursor = root;
  for (const part of path.split("/").slice(0, -1)) {
    cursor = resolve(cursor, part);
    try {
      const parent = await lstat(cursor, { bigint: true });
      if (!parent.isDirectory() || parent.isSymbolicLink())
        return "unavailable";
      const canonicalParent = await realpath(cursor);
      if (!inside(root, canonicalParent)) return "unavailable";
    } catch {
      return "unavailable";
    }
  }
  let before;
  try {
    before = await lstat(absolute, { bigint: true });
  } catch {
    return "unavailable";
  }
  if (!before.isFile() || before.isSymbolicLink()) return "unavailable";
  if (before.size > BigInt(MAX_FILE_BYTES)) return "oversize";
  let canonical: string;
  try {
    canonical = await realpath(absolute);
  } catch {
    return "unavailable";
  }
  if (!inside(root, canonical)) return "unavailable";
  let handle: FileHandle | undefined;
  try {
    handle = await open(absolute, constants.O_RDONLY | NO_FOLLOW);
    const opened = await handle.stat({ bigint: true });
    const after = await lstat(absolute, { bigint: true });
    if (
      !opened.isFile() ||
      after.isSymbolicLink() ||
      !after.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      opened.size !== before.size ||
      after.size !== before.size ||
      opened.mtimeNs !== before.mtimeNs ||
      opened.ctimeNs !== before.ctimeNs ||
      after.mtimeNs !== before.mtimeNs ||
      after.ctimeNs !== before.ctimeNs
    ) {
      await handle.close();
      return "unavailable";
    }
    return { handle, size: Number(opened.size) };
  } catch {
    await handle?.close().catch(() => undefined);
    return "unavailable";
  }
}

async function capture(
  root: string,
  path: string,
): Promise<SnapshotFile | CoverageReadFailureReason> {
  const opened = await safeOpen(root, path);
  if (typeof opened === "string") return opened;
  try {
    const readOnce = async (): Promise<Buffer | undefined> => {
      const bytes = Buffer.alloc(opened.size);
      let offset = 0;
      while (offset < bytes.length) {
        const result = await opened.handle.read(
          bytes,
          offset,
          bytes.length - offset,
          offset,
        );
        if (result.bytesRead === 0) return undefined;
        offset += result.bytesRead;
      }
      return bytes;
    };
    const before = await opened.handle.stat({ bigint: true });
    const first = await readOnce();
    const middle = await opened.handle.stat({ bigint: true });
    const bytes = await readOnce();
    const after = await opened.handle.stat({ bigint: true });
    if (
      first === undefined ||
      bytes === undefined ||
      !first.equals(bytes) ||
      before.size !== middle.size ||
      before.size !== after.size ||
      before.mtimeNs !== middle.mtimeNs ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== middle.ctimeNs ||
      before.ctimeNs !== after.ctimeNs
    )
      return "unavailable";
    if (bytes.includes(0)) return "binary";
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return "binary";
    }
    return { path, bytes, digest: digest(bytes) };
  } finally {
    await opened.handle.close();
  }
}

async function captureWorkspace(
  root: string,
  includedPaths: readonly string[] | undefined,
  changedPaths: readonly string[],
  signal?: AbortSignal,
): Promise<SharedSnapshot> {
  const snapshots = new Map<string, SnapshotFile>();
  const failures = new Map<string, CoverageReadFailureReason>();
  let entries = 0;
  let bytes = 0;
  let complete = true;
  const included = (path: string): boolean =>
    includedPaths === undefined ||
    includedPaths.some(
      (scopePath) =>
        scopePath === "" ||
        path === scopePath ||
        path.startsWith(`${scopePath}/`),
    );
  const canContainIncludedPath = (path: string): boolean =>
    includedPaths === undefined ||
    includedPaths.some(
      (scopePath) =>
        scopePath === "" ||
        path === scopePath ||
        path.startsWith(`${scopePath}/`) ||
        scopePath.startsWith(`${path}/`),
    );
  const capturePath = async (path: string): Promise<void> => {
    if (!included(path) || snapshots.has(path) || failures.has(path)) return;
    if (signal?.aborted) throw signal.reason;
    let snapshot = await capture(root, path);
    // Windows can settle metadata on the first open after a write. Retry only
    // during initial capture, and require the complete stable-read checks again.
    if (snapshot === "unavailable") snapshot = await capture(root, path);
    if (typeof snapshot === "string") {
      failures.set(path, snapshot);
    } else if (bytes + snapshot.bytes.length > MAX_SNAPSHOT_BYTES) {
      failures.set(path, "oversize");
    } else {
      bytes += snapshot.bytes.length;
      snapshots.set(path, snapshot);
    }
  };
  // Pin changed evidence before optional support files consume the run budget.
  // Failed captures are pinned too, so later reviewers cannot read newer bytes.
  for (const path of changedPaths) await capturePath(path);
  const walk = async (directory: string): Promise<void> => {
    const stream = await opendir(directory);
    try {
      for await (const item of stream) {
        if (signal?.aborted) throw signal.reason;
        entries += 1;
        if (entries > MAX_LIST_ENTRIES || bytes > MAX_SNAPSHOT_BYTES) {
          complete = false;
          return;
        }
        if (SKIPPED_DIRECTORIES.has(item.name.toLocaleLowerCase("en-US")))
          continue;
        const absolute = resolve(directory, item.name);
        let metadata;
        try {
          metadata = await lstat(absolute);
        } catch {
          complete = false;
          continue;
        }
        if (metadata.isSymbolicLink()) {
          complete = false;
          continue;
        }
        const path = relative(root, absolute)
          .split(sep)
          .join("/")
          .normalize("NFC");
        if (metadata.isDirectory()) {
          if (canContainIncludedPath(path)) await walk(absolute);
        } else if (metadata.isFile()) {
          if (!included(path)) continue;
          try {
            await capturePath(canonicalPath(path));
          } catch {
            if (signal?.aborted) throw signal.reason;
            complete = false;
            continue;
          }
        }
      }
    } finally {
      await stream.close().catch(() => undefined);
    }
  };
  await walk(root);
  return {
    files: snapshots,
    failures,
    complete: complete && failures.size === 0,
  };
}

function requiredMethod(
  kind: MutableEntry["kind"],
  minimum: ChangeCoveragePolicy["minimumInspection"],
): MutableEntry["required_method"] {
  if (kind === "deleted") return "deleted_diff";
  if (kind === "untracked") return "full_file";
  return minimum;
}

function snapshotRequired(entry: MutableEntry): boolean {
  return entry.required_method === "full_file";
}

function diffRequired(entry: MutableEntry): boolean {
  return entry.kind !== "untracked";
}

function intervalsCover(
  intervals: Array<[number, number]>,
  total: number,
): boolean {
  if (total === 0)
    return intervals.some(([start, end]) => start === 0 && end === 0);
  const sorted = intervals
    .slice()
    .sort((left, right) => left[0] - right[0] || left[1] - right[1]);
  let end = 0;
  for (const [start, nextEnd] of sorted) {
    if (start > end) return false;
    end = Math.max(end, nextEnd);
    if (end >= total) return true;
  }
  return false;
}

function deliveredRanges(
  intervals: Array<[number, number]>,
): CoverageByteRange[] {
  const ranges: CoverageByteRange[] = [];
  for (const [start, end] of intervals.slice().sort((a, b) => a[0] - b[0])) {
    const previous = ranges.at(-1);
    if (
      previous !== undefined &&
      start <= previous.offset + previous.byte_count
    ) {
      previous.byte_count =
        Math.max(previous.offset + previous.byte_count, end) - previous.offset;
    } else {
      ranges.push({ offset: start, byte_count: end - start });
    }
  }
  return ranges;
}

function missingRanges(entry: MutableEntry): CoverageByteRange[] {
  if (!snapshotRequired(entry) || entry.snapshot_byte_count === undefined)
    return [];
  const total = entry.snapshot_byte_count;
  if (total === 0)
    return intervalsCover(entry.intervals, 0)
      ? []
      : [{ offset: 0, byte_count: 0 }];
  const missing: CoverageByteRange[] = [];
  const append = (start: number, end: number): void => {
    for (let offset = start; offset < end; offset += MAX_READ_BYTES)
      missing.push({
        offset,
        byte_count: Math.min(MAX_READ_BYTES, end - offset),
      });
  };
  let offset = 0;
  for (const range of deliveredRanges(entry.intervals)) {
    append(offset, range.offset);
    offset = Math.max(offset, range.offset + range.byte_count);
  }
  append(offset, total);
  return missing;
}

function exposed(entry: MutableEntry): ChangeCoverageEntry {
  const {
    snapshot: _snapshot,
    intervals: _intervals,
    stickyFailure: _failure,
    attested: _attested,
    ...value
  } = entry;
  return structuredClone(value);
}

export async function createChangeCoverageLedger(input: {
  context: ResolvedContext;
  policy: ChangeCoveragePolicy;
  signal?: AbortSignal;
}): Promise<ChangeCoverageLedger> {
  const root = await realpath(input.context.workspace);
  if (input.signal?.aborted) throw input.signal.reason;
  let closed = false;
  const paths = input.context.git.is_repository
    ? (input.context.git.changed_paths ??
      input.context.git.changed_files.map((path) => ({
        path,
        kind: "tracked" as const,
      })))
    : [];
  const normalized = paths
    .map((entry) => ({ path: canonicalPath(entry.path), kind: entry.kind }))
    .sort((left, right) => compareCodePoints(left.path, right.path));
  const fullReview = input.context.review_scope.mode === "full";
  const fullScopePaths =
    fullReview && input.context.review_scope.paths !== undefined
      ? input.context.review_scope.paths.map((path) =>
          path === "." ? "" : canonicalPath(path.replace(/\/+$/u, "")),
        )
      : undefined;
  let snapshotPromise = sharedSnapshots.get(input.context);
  if (snapshotPromise === undefined) {
    snapshotPromise = captureWorkspace(
      root,
      fullScopePaths,
      normalized
        .filter((entry) => entry.kind !== "deleted")
        .map((entry) => entry.path),
      input.signal,
    );
    sharedSnapshots.set(input.context, snapshotPromise);
  }
  const sharedSnapshot = await snapshotPromise;
  const snapshots = sharedSnapshot.files;
  const snapshotIdentity: RunSnapshotIdentity = {
    schema_version: "1",
    sha256: digest(
      canonicalJson(
        [...snapshots.values()]
          .sort((a, b) => compareCodePoints(a.path, b.path))
          .map((snapshot) => ({
            path: snapshot.path,
            byte_count: snapshot.bytes.length,
            sha256: snapshot.digest,
          })),
      ),
    ),
    file_count: snapshots.size,
    complete: sharedSnapshot.complete,
  };
  const entries = new Map<string, MutableEntry>();
  const authoritativePaths = new Set(normalized.map((entry) => entry.path));
  const changedFilesTruncated =
    input.context.git.is_repository &&
    input.context.git.truncated.changed_files;

  for (const changed of normalized) {
    const relevant =
      !fullReview &&
      input.policy.relevantPaths.some((pattern) =>
        changedPathMatchesGlob(pattern, changed.path),
      );
    const method = requiredMethod(changed.kind, input.policy.minimumInspection);
    const entry: MutableEntry = {
      path: changed.path,
      kind: changed.kind,
      required_method: method,
      proof_kind: input.policy.proof,
      relevant,
      snapshot_read: snapshotRequired({
        kind: changed.kind,
        required_method: method,
      } as MutableEntry)
        ? "not_inspected"
        : "not_required",
      diff_delivery: diffRequired({ kind: changed.kind } as MutableEntry)
        ? input.context.git.is_repository && input.context.git.truncated.diff
          ? "context_truncated"
          : "not_inspected"
        : "not_required",
      disposition: relevant ? "deficit" : "satisfied",
      intervals: [],
      attested: false,
    };
    if (changed.kind !== "deleted") {
      const snapshot = snapshots.get(changed.path);
      if (snapshot !== undefined) {
        entry.snapshot = snapshot;
        entry.snapshot_digest = snapshot.digest;
        entry.snapshot_byte_count = snapshot.bytes.length;
      } else if (relevant && snapshotRequired(entry)) {
        const failure = sharedSnapshot.failures.get(changed.path);
        entry.snapshot_read =
          failure === "oversize" || failure === "binary"
            ? failure
            : "unavailable";
        entry.stickyFailure = entry.snapshot_read;
      }
    }
    entries.set(changed.path, entry);
  }

  for (const [path, snapshot] of snapshots) {
    if (entries.has(path)) continue;
    entries.set(path, {
      path,
      kind: "untracked",
      required_method: "full_file",
      proof_kind: input.policy.proof,
      relevant: false,
      snapshot_digest: snapshot.digest,
      snapshot_byte_count: snapshot.bytes.length,
      snapshot_read: "not_required",
      diff_delivery: "not_required",
      disposition: "satisfied",
      snapshot,
      intervals: [],
      attested: false,
    });
  }

  const rawDiffDigest = input.context.git.is_repository
    ? (input.context.git.raw_diff?.sha256 ?? digest(input.context.git.diff))
    : digest("");
  const scopeDigest = digest(
    canonicalJson({
      schema_version: "1",
      diff_sha256: rawDiffDigest,
      changed_files_truncated: changedFilesTruncated,
      paths: [...entries.values()]
        .filter((entry) => authoritativePaths.has(entry.path))
        .map((entry) => ({
          path: entry.path,
          kind: entry.kind,
          relevant: entry.relevant,
          required_method: entry.required_method,
          proof_kind: entry.proof_kind,
        })),
    }),
  );
  const relevantEntries = [...entries.values()].filter(
    (entry) => entry.relevant,
  );
  if (
    input.policy.proof === "attested" &&
    relevantEntries.length > MAX_ATTESTED_PATHS
  ) {
    for (const entry of relevantEntries)
      entry.stickyFailure = "attestation_path_limit";
  }
  const notApplicable: ChangeCoverageNotApplicable | undefined = fullReview
    ? { reason: "full_review" }
    : relevantEntries.length === 0 && !changedFilesTruncated
      ? {
          reason: "policy_excluded",
          policy_reference: {
            relevant_paths: [...input.policy.relevantPaths],
          },
        }
      : undefined;

  function refresh(entry: MutableEntry): void {
    if (!entry.relevant) {
      entry.disposition = "satisfied";
      return;
    }
    if (entry.stickyFailure !== undefined) {
      entry.disposition = "deficit";
      entry.reason = entry.stickyFailure;
      return;
    }
    const snapshotOk =
      !snapshotRequired(entry) ||
      (input.policy.proof === "observed"
        ? entry.snapshot !== undefined &&
          intervalsCover(entry.intervals, entry.snapshot.bytes.length)
        : entry.attested);
    const diffOk = !diffRequired(entry) || entry.diff_delivery === "satisfied";
    if (snapshotOk)
      entry.snapshot_read = snapshotRequired(entry)
        ? "satisfied"
        : "not_required";
    entry.disposition = snapshotOk && diffOk ? "satisfied" : "deficit";
    if (entry.disposition === "satisfied") delete entry.reason;
    else if (!snapshotOk) entry.reason = entry.snapshot_read;
    else entry.reason = entry.diff_delivery;
  }

  function summary(): ChangeCoverageResult {
    const relevant = [...entries.values()].filter((entry) => entry.relevant);
    if (notApplicable !== undefined) {
      return {
        status: "not_applicable",
        inspected_count: 0,
        deficit_count: 0,
        deficit_sample: [],
      };
    }
    for (const entry of relevant) refresh(entry);
    const deficits = relevant.filter(
      (entry) => entry.disposition === "deficit",
    );
    const scopeDeficit = changedFilesTruncated
      ? [{ path: "<change_scope>", reason: "changed_files_truncated" }]
      : [];
    const deficitCount = deficits.length + scopeDeficit.length;
    return {
      status: deficitCount === 0 ? "complete" : "incomplete",
      proof_kind: input.policy.proof,
      scope_digest: scopeDigest,
      inspected_count: relevant.length - deficits.length,
      deficit_count: deficitCount,
      deficit_sample: [
        ...scopeDeficit,
        ...deficits.map((entry) => ({
          path: entry.path,
          reason: entry.reason ?? "not_inspected",
        })),
      ].slice(0, 8),
    };
  }

  return {
    scopeDigest,
    observedFile(path) {
      const entry = entries.get(canonicalPath(path));
      return (
        entry !== undefined &&
        entry.snapshot !== undefined &&
        entry.stickyFailure === undefined &&
        intervalsCover(entry.intervals, entry.snapshot.bytes.length)
      );
    },
    ...(notApplicable === undefined ? {} : { notApplicable }),
    async readFile(request) {
      if (closed) return { ok: false, path: request.path, reason: "closed" };
      let path: string;
      try {
        path = canonicalPath(request.path);
      } catch {
        return { ok: false, path: request.path, reason: "invalid_path" };
      }
      const entry = entries.get(path);
      if (entry === undefined || entry.snapshot === undefined) {
        return {
          ok: false,
          path,
          reason: sharedSnapshot.failures.get(path) ?? "unavailable",
        };
      }
      const offset = request.offset ?? 0;
      const byteCount =
        request.byteCount ??
        Math.min(MAX_READ_BYTES, entry.snapshot.bytes.length - offset);
      if (
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        offset > entry.snapshot.bytes.length ||
        !Number.isSafeInteger(byteCount) ||
        byteCount < 0 ||
        byteCount > MAX_READ_BYTES
      ) {
        return {
          ok: false,
          path,
          reason: "invalid_range",
          maximumByteCount: MAX_READ_BYTES,
          totalByteCount: entry.snapshot.bytes.length,
        };
      }
      const bytes = Buffer.from(
        entry.snapshot.bytes.subarray(
          offset,
          Math.min(entry.snapshot.bytes.length, offset + byteCount),
        ),
      );
      const delivered = Buffer.from(bytes);
      const deliveredDigest = digest(delivered);
      let acknowledged = false;
      return {
        ok: true,
        path,
        bytes,
        offset,
        byteCount: bytes.length,
        totalByteCount: entry.snapshot.bytes.length,
        sha256: digest(bytes),
        snapshotDigest: entry.snapshot.digest,
        eof: offset + bytes.length >= entry.snapshot.bytes.length,
        acknowledgeDelivered() {
          if (acknowledged) return;
          acknowledged = true;
          if (closed) return;
          if (!bytes.equals(delivered) || digest(bytes) !== deliveredDigest) {
            entry.stickyFailure ??= "response_bytes_changed";
            refresh(entry);
            return;
          }
          entry.intervals.push([offset, offset + bytes.length]);
          refresh(entry);
        },
      };
    },
    recordDiffDelivery(deliveredPaths, delivery) {
      const expected = input.context.git.is_repository
        ? input.context.git.raw_diff
        : undefined;
      if (
        expected === undefined ||
        delivery.byteCount !== expected.byte_count ||
        delivery.sha256 !== expected.sha256
      )
        return;
      for (const rawPath of deliveredPaths) {
        let path: string;
        try {
          path = canonicalPath(rawPath);
        } catch {
          continue;
        }
        const entry = entries.get(path);
        if (entry === undefined || !entry.relevant || !diffRequired(entry))
          continue;
        if (
          entry.diff_delivery === "context_truncated" ||
          !diffContainsPath(input.context, path)
        )
          continue;
        entry.diff_delivery = "satisfied";
        refresh(entry);
      }
    },
    reconcileAttestation(attestation) {
      if (input.policy.proof !== "attested") {
        throw new Error(
          "Observed coverage cannot accept provider attestation as proof.",
        );
      }
      const relevant = [...entries.values()].filter((entry) => entry.relevant);
      if (relevant.length > MAX_ATTESTED_PATHS) return summary();
      if (
        attestation.entries.length > MAX_ATTESTED_PATHS ||
        attestation.scope_digest !== scopeDigest
      ) {
        throw new Error("Coverage attestation scope or path count is invalid.");
      }
      const asserted = new Map(
        attestation.entries.map((entry) => [entry.path, entry]),
      );
      for (const entry of relevant) {
        const claim = asserted.get(entry.path);
        const matches =
          claim !== undefined &&
          claim.method === entry.required_method &&
          (snapshotRequired(entry)
            ? claim.snapshot_digest === entry.snapshot?.digest
            : claim.snapshot_digest === undefined);
        if (!matches)
          throw new Error(`Coverage attestation is invalid for ${entry.path}.`);
        else entry.attested = true;
        refresh(entry);
      }
      if (asserted.size !== relevant.length) {
        throw new Error("Coverage attestation path set is invalid.");
      }
      return summary();
    },
    summary,
    snapshotIdentity() {
      return { ...snapshotIdentity };
    },
    status() {
      const currentSummary = summary();
      const currentEntries = relevantEntries.map(
        (entry): ChangeCoverageStatusEntry => ({
          ...exposed(entry),
          snapshot_required: snapshotRequired(entry),
          diff_required: diffRequired(entry),
          attestation_required: input.policy.proof === "attested",
          attestation_received: entry.attested,
          delivered_byte_ranges: deliveredRanges(entry.intervals),
          missing_byte_ranges: missingRanges(entry),
          snapshot_content_delivered:
            entry.snapshot_byte_count !== undefined &&
            intervalsCover(entry.intervals, entry.snapshot_byte_count),
        }),
      );
      return {
        complete: currentSummary.status !== "incomplete",
        scope_digest: scopeDigest,
        proof_kind: input.policy.proof,
        maximum_read_bytes: MAX_READ_BYTES,
        summary: currentSummary,
        entries: currentEntries,
        deficits: currentEntries.filter(
          (entry) => entry.disposition === "deficit",
        ),
      };
    },
    entries() {
      for (const entry of entries.values()) refresh(entry);
      return [...entries.values()].map(exposed);
    },
    snapshotFiles() {
      return [...snapshots.values()].map((snapshot) => ({
        path: snapshot.path,
        bytes: Buffer.from(snapshot.bytes),
        byteCount: snapshot.bytes.length,
      }));
    },
    async close() {
      closed = true;
      for (const entry of entries.values()) {
        delete entry.snapshot;
      }
    },
  };
}

function diffContainsPath(context: ResolvedContext, path: string): boolean {
  if (
    !context.git.is_repository ||
    context.git.truncated.diff ||
    context.git.diff.length === 0
  )
    return false;
  const quoted = path.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
  return (
    context.git.diff.includes(`a/${path}`) ||
    context.git.diff.includes(`b/${path}`) ||
    context.git.diff.includes(`a/${quoted}`) ||
    context.git.diff.includes(`b/${quoted}`)
  );
}
