import { constants, type BigIntStats } from "node:fs";
import { lstat, open, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { AdjudicationResult } from "../protocol/schemas.js";

export type EvidenceVerificationFailure =
  | "unsafe_file"
  | "read_failed"
  | "line_out_of_range"
  | "identity_changed";

export interface AdjudicationEvidenceVerification {
  by_source_finding_id: Record<
    string,
    { verified: boolean; failures: EvidenceVerificationFailure[] }
  >;
}

export interface VerifyAdjudicationEvidenceInput {
  workspace: string;
  adjudicationResult: AdjudicationResult;
  beforeIdentityCheck?: () => Promise<void>;
}

function within(root: string, target: string): boolean {
  const path = relative(root, target);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function sameIdentity(opened: BigIntStats, current: BigIntStats): boolean {
  if (process.platform === "win32") {
    return opened.size === current.size && opened.mtimeMs === current.mtimeMs;
  }
  return opened.dev === current.dev && opened.ino === current.ino;
}

function citations(result: AdjudicationResult["decisions"][number]) {
  return [
    ...result.cited_evidence,
    ...(result.ordered_execution_proof?.steps.map((step) => step.citation) ?? []),
    ...(result.ordered_execution_proof?.failure_point.citation === undefined
      ? []
      : [result.ordered_execution_proof.failure_point.citation]),
  ];
}

async function verifyCitation(
  root: string,
  citation: {
    path?: string | undefined;
    start_line?: number | undefined;
    end_line?: number | undefined;
  },
  beforeIdentityCheck?: () => Promise<void>,
): Promise<EvidenceVerificationFailure | undefined> {
  if (citation.path === undefined || citation.start_line === undefined)
    return "unsafe_file";
  const target = resolve(root, citation.path);
  if (!within(root, target)) return "unsafe_file";
  const pathMetadata = await lstat(target, { bigint: true }).catch(() => undefined);
  if (pathMetadata === undefined) return "read_failed";
  if (!pathMetadata.isFile() || pathMetadata.isSymbolicLink()) return "unsafe_file";
  const canonical = await realpath(target).catch(() => undefined);
  if (canonical === undefined || !within(root, canonical)) return "unsafe_file";
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
  const handle = await open(target, flags).catch(() => undefined);
  if (handle === undefined) return "read_failed";
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile()) return "unsafe_file";
    const contents = await handle.readFile("utf8").catch(() => undefined);
    if (contents === undefined) return "read_failed";
    const lineCount = contents.length === 0 ? 0 : contents.split(/\r?\n/u).length;
    const endLine = citation.end_line ?? citation.start_line;
    if (citation.start_line < 1 || endLine < citation.start_line || endLine > lineCount)
      return "line_out_of_range";
    await beforeIdentityCheck?.();
    const current = await handle.stat({ bigint: true }).catch(() => undefined);
    const currentPath = await stat(target, { bigint: true }).catch(() => undefined);
    const currentCanonical = await realpath(target).catch(() => undefined);
    if (
      current === undefined ||
      currentPath === undefined ||
      currentCanonical === undefined ||
      currentCanonical !== canonical ||
      !sameIdentity(opened, current) ||
      !sameIdentity(opened, currentPath)
    )
      return "identity_changed";
    return undefined;
  } finally {
    await handle.close();
  }
}

export async function verifyAdjudicationEvidence({
  workspace,
  adjudicationResult,
  beforeIdentityCheck,
}: VerifyAdjudicationEvidenceInput): Promise<AdjudicationEvidenceVerification> {
  const root = await realpath(resolve(workspace));
  const bySource: AdjudicationEvidenceVerification["by_source_finding_id"] = {};
  let hook = beforeIdentityCheck;
  for (const decision of adjudicationResult.decisions) {
    const failures = new Set<EvidenceVerificationFailure>();
    for (const citation of citations(decision)) {
      const failure = await verifyCitation(root, citation, hook);
      hook = undefined;
      if (failure !== undefined) failures.add(failure);
    }
    bySource[decision.source_finding_id] = {
      verified: failures.size === 0,
      failures: [...failures].sort(),
    };
  }
  return { by_source_finding_id: bySource };
}
