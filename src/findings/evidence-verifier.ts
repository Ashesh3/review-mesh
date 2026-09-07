import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { AdjudicationResult } from "../protocol/schemas.js";
import type { AdjudicationResultV2 } from "../protocol/v9.js";
import { createGitRunner, type GitRunner } from "../context/git.js";

type VerifiableAdjudicationResult = AdjudicationResult | AdjudicationResultV2;

export const MAX_EVIDENCE_BYTES_PER_PATH = 1024 * 1024;

export type EvidenceVerificationFailure =
  | "unsafe_file"
  | "read_failed"
  | "line_out_of_range"
  | "evidence_too_large"
  | "identity_changed"
  | "base_revision_unavailable";

export interface VerifiedEvidenceCitation {
  side: "base" | "head";
  path: string;
  start_line: number;
  end_line: number;
  source_revision?: string;
  /** SHA256 of the exact bounded file bytes read by the verifier. */
  sha256: string;
}

export interface AdjudicationEvidenceVerification {
  by_source_finding_id: Record<
    string,
    {
      verified: boolean;
      failures: EvidenceVerificationFailure[];
      verified_citations?: VerifiedEvidenceCitation[];
    }
  >;
}

interface EvidenceFileStats {
  dev: bigint;
  ino: bigint;
  size: bigint;
  ctimeNs?: bigint;
  mtimeNs?: bigint;
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
  adjudicationResult: VerifiableAdjudicationResult;
  beforeIdentityCheck?: () => Promise<void>;
  fileSystem?: EvidenceVerifierFileSystem;
  platform?: NodeJS.Platform;
  /** Full immutable merge-base commit used by the reviewed Git diff. */
  baseRevision?: string;
  gitRunner?: GitRunner;
  signal?: AbortSignal;
}

type Citation = {
  path?: string | undefined;
  start_line?: number | undefined;
  end_line?: number | undefined;
};
type LocatedCitation = Citation & { side: "base" | "head" };
type VerifiedFile = { sha256: string; lineCount: number };
type FileVerification = VerifiedFile | EvidenceVerificationFailure;

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
  result: VerifiableAdjudicationResult["decisions"][number],
): LocatedCitation[] {
  return [
    ...result.cited_evidence.map((citation) => ({
      ...citation,
      side: "head" as const,
    })),
    ...(result.ordered_execution_proof?.steps.map((step) => ({
      ...step.citation,
      side: "head" as const,
    })) ?? []),
    ...(result.ordered_execution_proof?.failure_point.citation === undefined
      ? []
      : [
          {
            ...result.ordered_execution_proof.failure_point.citation,
            side: "head" as const,
          },
        ]),
    ...(result.base_head_comparison === undefined
      ? []
      : [
          {
            ...result.base_head_comparison.base.citation,
            side: "base" as const,
          },
          {
            ...result.base_head_comparison.head.citation,
            side: "head" as const,
          },
        ]),
  ];
}

function verifyBytes(bytes: Buffer): FileVerification {
  if (bytes.length > MAX_EVIDENCE_BYTES_PER_PATH) return "evidence_too_large";
  if (bytes.includes(0)) return "unsafe_file";
  let lineCount = bytes.length > 0 ? 1 : 0;
  for (let index = 0; index < bytes.length - 1; index++)
    if (bytes[index] === 0x0a) lineCount++;
  return {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    lineCount,
  };
}

async function readEvidence(
  handle: EvidenceFileHandle,
): Promise<FileVerification> {
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let bytes = 0;
  const parts: Buffer[] = [];
  for (;;) {
    const remaining = MAX_EVIDENCE_BYTES_PER_PATH + 1 - bytes;
    const read = await handle
      .read(buffer, 0, Math.min(buffer.length, remaining), bytes)
      .catch(() => undefined);
    if (read === undefined) return "read_failed";
    if (read.bytesRead === 0) {
      return verifyBytes(Buffer.concat(parts, bytes));
    }
    bytes += read.bytesRead;
    if (bytes > MAX_EVIDENCE_BYTES_PER_PATH) return "evidence_too_large";
    parts.push(Buffer.from(buffer.subarray(0, read.bytesRead)));
  }
}

async function verifyPath(
  root: string,
  relativePath: string,
  fileSystem: EvidenceVerifierFileSystem,
  platform: NodeJS.Platform,
  beforeIdentityCheck?: () => Promise<void>,
): Promise<FileVerification> {
  const target = resolve(root, relativePath);
  if (!within(root, target)) return "unsafe_file";
  const before = await fileSystem.lstat(target).catch(() => undefined);
  if (before === undefined) return "read_failed";
  if (!before.isFile() || before.isSymbolicLink()) return "unsafe_file";
  if (before.size > BigInt(MAX_EVIDENCE_BYTES_PER_PATH))
    return "evidence_too_large";
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
    const evidence = await readEvidence(handle);
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
      !sameIdentity(opened, afterPath, platform) ||
      opened.size !== afterHandle.size ||
      opened.size !== afterPath.size ||
      opened.mtimeNs !== afterHandle.mtimeNs ||
      opened.mtimeNs !== afterPath.mtimeNs ||
      opened.ctimeNs !== afterHandle.ctimeNs ||
      opened.ctimeNs !== afterPath.ctimeNs
    ) {
      return "identity_changed";
    }
    return evidence;
  } finally {
    await handle.close();
  }
}

function safePath(path: string): boolean {
  return (
    path.length > 0 &&
    !isAbsolute(path) &&
    !/[:\\\u0000-\u001f]/.test(path) &&
    !path.split("/").some((part) => !part || part === "." || part === "..")
  );
}

async function verifyBasePath(
  root: string,
  path: string,
  revision: string | undefined,
  git: GitRunner,
  signal: AbortSignal | undefined,
): Promise<FileVerification> {
  if (!revision || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(revision))
    return "base_revision_unavailable";
  try {
    const options = { cwd: root, ...(signal === undefined ? {} : { signal }) };
    const tree = await git.run(
      [
        "--no-replace-objects",
        "ls-tree",
        "-z",
        revision,
        "--",
        `:(literal)${path}`,
      ],
      options,
    );
    if (tree.outputTruncated) return "evidence_too_large";
    if (tree.exitCode !== 0) return "base_revision_unavailable";
    const records = tree.stdout.split("\0").filter(Boolean);
    if (records.length !== 1) return "read_failed";
    const entry =
      /^(100644|100755) blob ([a-f0-9]{40}|[a-f0-9]{64})\t([\s\S]+)$/.exec(
        records[0]!,
      );
    if (!entry || entry[3] !== path) return "unsafe_file";
    const blob = await git.run(
      ["--no-replace-objects", "cat-file", "blob", entry[2]!],
      {
        ...options,
        preserveOutput: true,
      },
    );
    if (blob.outputTruncated) return "evidence_too_large";
    if (blob.exitCode !== 0) return "read_failed";
    return verifyBytes(Buffer.from(blob.stdout, "latin1"));
  } catch {
    return "read_failed";
  }
}

export async function verifyAdjudicationEvidence({
  workspace,
  adjudicationResult,
  beforeIdentityCheck,
  fileSystem = nativeFileSystem,
  platform = process.platform,
  baseRevision,
  gitRunner = createGitRunner(),
  signal,
}: VerifyAdjudicationEvidenceInput): Promise<AdjudicationEvidenceVerification> {
  const root = await fileSystem.realpath(resolve(workspace));
  const bySource: AdjudicationEvidenceVerification["by_source_finding_id"] = {};
  const requests = new Map<string, { side: "base" | "head"; path: string }>();
  const decisionCitations = new Map<string, LocatedCitation[]>();
  const key = (citation: LocatedCitation) =>
    `${citation.side}:${citation.path}`;
  for (const decision of adjudicationResult.decisions) {
    const values = citations(decision);
    decisionCitations.set(decision.source_finding_id, values);
    for (const citation of values) {
      if (
        citation.path === undefined ||
        !safePath(citation.path) ||
        citation.start_line === undefined
      )
        continue;
      requests.set(key(citation), { path: citation.path, side: citation.side });
    }
  }
  const verifiedPaths = new Map<string, FileVerification>();
  let hook = beforeIdentityCheck;
  for (const [requestKey, { path, side }] of requests) {
    verifiedPaths.set(
      requestKey,
      side === "base"
        ? await verifyBasePath(root, path, baseRevision, gitRunner, signal)
        : await verifyPath(root, path, fileSystem, platform, hook),
    );
    if (side === "head") hook = undefined;
  }
  for (const decision of adjudicationResult.decisions) {
    const failures = new Set<EvidenceVerificationFailure>();
    const verified: VerifiedEvidenceCitation[] = [];
    for (const citation of decisionCitations.get(decision.source_finding_id) ??
      []) {
      if (
        citation.path === undefined ||
        !safePath(citation.path) ||
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
      const file = verifiedPaths.get(key(citation));
      if (file === undefined) failures.add("read_failed");
      else if (typeof file === "string") failures.add(file);
      else if ((citation.end_line ?? citation.start_line) > file.lineCount)
        failures.add("line_out_of_range");
      else
        verified.push({
          side: citation.side,
          path: citation.path,
          start_line: citation.start_line,
          end_line: citation.end_line ?? citation.start_line,
          ...(citation.side === "base" && baseRevision
            ? { source_revision: baseRevision }
            : {}),
          sha256: file.sha256,
        });
    }
    bySource[decision.source_finding_id] = {
      verified: failures.size === 0,
      failures: [...failures].sort(),
      verified_citations: verified.filter(
        (citation, index) =>
          verified.findIndex(
            (other) => JSON.stringify(other) === JSON.stringify(citation),
          ) === index,
      ),
    };
  }
  return { by_source_finding_id: bySource };
}
