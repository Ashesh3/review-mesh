import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { AdjudicationResult } from "../protocol/schemas.js";

export const MAX_EVIDENCE_BYTES_PER_PATH = 1024 * 1024;

export type EvidenceVerificationFailure =
  | "unsafe_file"
  | "read_failed"
  | "line_out_of_range"
  | "evidence_too_large"
  | "identity_changed";

export interface AdjudicationEvidenceVerification {
  by_source_finding_id: Record<
    string,
    { verified: boolean; failures: EvidenceVerificationFailure[] }
  >;
}

interface EvidenceFileStats {
  dev: bigint;
  ino: bigint;
  size: bigint;
  ctimeNs?: bigint;
  birthtimeNs?: bigint;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

interface EvidenceFileHandle {
  stat(): Promise<EvidenceFileStats>;
  read(
    buffer: Buffer,
    offset: number,
    length: number,
    position: number | null,
  ): Promise<{ bytesRead: number; buffer: Buffer }>;
  close(): Promise<void>;
}

export interface EvidenceVerifierFileSystem {
  realpath(path: string): Promise<string>;
  lstat(path: string): Promise<EvidenceFileStats>;
  open(path: string, flags: number): Promise<EvidenceFileHandle>;
}

const nativeFileSystem: EvidenceVerifierFileSystem = {
  realpath,
  lstat: (path) => lstat(path, { bigint: true }),
  open: async (path, flags) => {
    const handle = await open(path, flags);
    return {
      stat: () => handle.stat({ bigint: true }),
      read: handle.read.bind(handle),
      close: handle.close.bind(handle),
    };
  },
};

export interface VerifyAdjudicationEvidenceInput {
  workspace: string;
  adjudicationResult: AdjudicationResult;
  beforeIdentityCheck?: () => Promise<void>;
  fileSystem?: EvidenceVerifierFileSystem;
  platform?: NodeJS.Platform;
}

type Citation = {
  path?: string | undefined;
  start_line?: number | undefined;
  end_line?: number | undefined;
};

function within(root: string, target: string): boolean {
  const path = relative(root, target);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function sameIdentity(
  left: EvidenceFileStats,
  right: EvidenceFileStats,
  platform: NodeJS.Platform,
): boolean {
  const meaningfulIds =
    left.dev !== 0n && left.ino !== 0n && right.dev !== 0n && right.ino !== 0n;
  if (platform !== "win32" || meaningfulIds) {
    return left.dev === right.dev && left.ino === right.ino;
  }
  return (
    left.size === right.size &&
    left.birthtimeNs !== undefined &&
    right.birthtimeNs !== undefined &&
    left.ctimeNs !== undefined &&
    right.ctimeNs !== undefined &&
    left.birthtimeNs === right.birthtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function citations(
  result: AdjudicationResult["decisions"][number],
): Citation[] {
  return [
    ...result.cited_evidence,
    ...(result.ordered_execution_proof?.steps.map((step) => step.citation) ??
      []),
    ...(result.ordered_execution_proof?.failure_point.citation === undefined
      ? []
      : [result.ordered_execution_proof.failure_point.citation]),
    ...(result.base_head_comparison === undefined
      ? []
      : [
          result.base_head_comparison.base.citation,
          result.base_head_comparison.head.citation,
        ]),
  ];
}

async function proveLine(
  handle: EvidenceFileHandle,
  endLine: number,
): Promise<EvidenceVerificationFailure | undefined> {
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let bytes = 0;
  let newlines = 0;
  for (;;) {
    const remaining = MAX_EVIDENCE_BYTES_PER_PATH + 1 - bytes;
    const read = await handle
      .read(buffer, 0, Math.min(buffer.length, remaining), bytes)
      .catch(() => undefined);
    if (read === undefined) return "read_failed";
    if (read.bytesRead === 0) {
      return bytes > 0 && newlines >= endLine - 1
        ? undefined
        : "line_out_of_range";
    }
    bytes += read.bytesRead;
    for (let index = 0; index < read.bytesRead; index += 1) {
      if (buffer[index] === 0x0a) newlines += 1;
    }
    if (newlines >= endLine - 1) return undefined;
    if (bytes > MAX_EVIDENCE_BYTES_PER_PATH) return "evidence_too_large";
  }
}

async function verifyPath(
  root: string,
  relativePath: string,
  endLine: number,
  fileSystem: EvidenceVerifierFileSystem,
  platform: NodeJS.Platform,
  beforeIdentityCheck?: () => Promise<void>,
): Promise<EvidenceVerificationFailure | undefined> {
  const target = resolve(root, relativePath);
  if (!within(root, target)) return "unsafe_file";
  const before = await fileSystem.lstat(target).catch(() => undefined);
  if (before === undefined) return "read_failed";
  if (!before.isFile() || before.isSymbolicLink()) return "unsafe_file";
  const handle = await fileSystem
    .open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    .catch(() => undefined);
  if (handle === undefined) return "read_failed";
  try {
    const opened = await handle.stat().catch(() => undefined);
    if (
      opened === undefined ||
      !opened.isFile() ||
      !sameIdentity(before, opened, platform)
    ) {
      return "identity_changed";
    }
    const canonical = await fileSystem.realpath(target).catch(() => undefined);
    if (canonical === undefined || !within(root, canonical))
      return "unsafe_file";
    const evidenceFailure = await proveLine(handle, endLine);
    await beforeIdentityCheck?.();
    const [afterHandle, afterPath, afterCanonical] = await Promise.all([
      handle.stat().catch(() => undefined),
      fileSystem.lstat(target).catch(() => undefined),
      fileSystem.realpath(target).catch(() => undefined),
    ]);
    if (
      afterHandle === undefined ||
      afterPath === undefined ||
      afterCanonical === undefined ||
      afterPath.isSymbolicLink() ||
      !afterPath.isFile() ||
      afterCanonical !== canonical ||
      !within(root, afterCanonical) ||
      !sameIdentity(opened, afterHandle, platform) ||
      !sameIdentity(opened, afterPath, platform)
    ) {
      return "identity_changed";
    }
    return evidenceFailure;
  } finally {
    await handle.close();
  }
}

export async function verifyAdjudicationEvidence({
  workspace,
  adjudicationResult,
  beforeIdentityCheck,
  fileSystem = nativeFileSystem,
  platform = process.platform,
}: VerifyAdjudicationEvidenceInput): Promise<AdjudicationEvidenceVerification> {
  const root = await fileSystem.realpath(resolve(workspace));
  const bySource: AdjudicationEvidenceVerification["by_source_finding_id"] = {};
  const requests = new Map<string, number>();
  const decisionCitations = new Map<string, Citation[]>();
  for (const decision of adjudicationResult.decisions) {
    const values = citations(decision);
    decisionCitations.set(decision.source_finding_id, values);
    for (const citation of values) {
      if (citation.path === undefined || citation.start_line === undefined)
        continue;
      requests.set(
        citation.path,
        Math.max(
          requests.get(citation.path) ?? 0,
          citation.end_line ?? citation.start_line,
        ),
      );
    }
  }
  const verifiedPaths = new Map<
    string,
    EvidenceVerificationFailure | undefined
  >();
  let hook = beforeIdentityCheck;
  for (const [path, endLine] of requests) {
    verifiedPaths.set(
      path,
      await verifyPath(root, path, endLine, fileSystem, platform, hook),
    );
    hook = undefined;
  }
  for (const decision of adjudicationResult.decisions) {
    const failures = new Set<EvidenceVerificationFailure>();
    for (const citation of decisionCitations.get(decision.source_finding_id) ??
      []) {
      if (
        citation.path === undefined ||
        citation.start_line === undefined ||
        !Number.isSafeInteger(citation.start_line) ||
        citation.start_line < 1 ||
        (citation.end_line !== undefined &&
          (!Number.isSafeInteger(citation.end_line) ||
            citation.end_line < citation.start_line))
      ) {
        failures.add("unsafe_file");
        continue;
      }
      const failure = verifiedPaths.get(citation.path);
      if (failure !== undefined) failures.add(failure);
    }
    bySource[decision.source_finding_id] = {
      verified: failures.size === 0,
      failures: [...failures].sort(),
    };
  }
  return { by_source_finding_id: bySource };
}
