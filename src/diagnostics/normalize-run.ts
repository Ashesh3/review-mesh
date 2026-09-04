import { open } from "node:fs/promises";
import { basename, dirname } from "node:path";
import {
  buildCanonicalRawFindings,
  canonicalizeFindings,
  type CanonicalFindingCoreProof,
  type CanonicalFindingSet,
  type CanonicalGatePolicy,
  type CanonicalRawFinding,
} from "../findings/canonical.js";
import type {
  AdjudicationResultV2,
  ReviewerResultV4,
  V9RunOutcome,
} from "../protocol/v9.js";
import { runOutcome } from "../protocol/concise.js";
import { readRunArtifact } from "./run-artifact.js";
import {
  type ArtifactReference,
  type PublicStreamOutcome,
  type ArtifactIdentity,
  verifyArtifactFile,
  RunArtifactError,
} from "./run-index.js";

export interface NormalizedReviewer {
  reviewer_id: string;
  lens_id: string;
  status: "completed" | "incomplete" | "skipped";
  result?: ReviewerResultV4 | AdjudicationResultV2;
  legacy_result?: unknown;
  digest?: string;
  byte_count?: number;
  reason?: string;
  terminal?: Record<string, unknown>;
  coverage?: Record<string, unknown>[];
}
export interface NormalizedRun {
  run_id: string;
  active: boolean;
  artifact_format_version: "1" | "2";
  run_outcome: V9RunOutcome;
  gate_outcome: "no_gate_findings" | "gate_findings";
  coverage_outcome: "complete" | "partial";
  execution_coverage: { status: "complete" | "partial" };
  change_coverage: {
    status: "complete" | "incomplete" | "not_applicable" | "legacy_unknown";
  };
  exit_code: number;
  canonical: CanonicalFindingSet;
  reviewers: NormalizedReviewer[];
  artifact: ArtifactReference;
  digest_status: "verified" | "final_digest_unavailable";
  observed_public_stream?: PublicStreamOutcome;
  reported_outcome?: Record<string, unknown>;
  reported_counts?: Record<string, unknown>;
  summary: Record<string, unknown>;
  request?: Record<string, unknown>;
  context?: Record<string, unknown>;
  resolution?: Record<string, unknown>;
  records: Record<string, unknown>[];
  warnings: Array<Record<string, unknown>>;
}
function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function lens(id: string): string {
  return id.split("::")[0]!;
}
function explicitProofs(
  records: Record<string, unknown>[],
): Record<string, CanonicalFindingCoreProof> {
  const result: Record<string, CanonicalFindingCoreProof> = {};
  for (const record of records) {
    if (record.record !== "reviewer.terminal") continue;
    const data = object(record.data);
    const proofs = object(data?.finding_proofs);
    if (proofs === undefined) continue;
    for (const [id, proof] of Object.entries(proofs)) {
      const parsed = object(proof);
      if (parsed === undefined) continue;
      const known: CanonicalFindingCoreProof = {};
      for (const key of [
        "evidence_verified",
        "source_coverage_verified",
        "ordered_proof_required",
        "ordered_proof_verified",
        "change_impact_required",
        "change_impact_verified",
        "adjudication_required",
        "out_of_scope",
        "policy_non_gating",
      ] as const) {
        if (typeof parsed[key] === "boolean") known[key] = parsed[key];
      }
      result[`${record.reviewer_id}#${id}`] = known;
    }
  }
  return result;
}
function gatePolicies(
  resolution?: Record<string, unknown>,
): Record<string, CanonicalGatePolicy> {
  const policies: Record<string, CanonicalGatePolicy> = {};
  if (!Array.isArray(resolution?.reviewers)) return policies;
  for (const raw of resolution.reviewers) {
    const reviewer = object(raw);
    const policy = object(reviewer?.policy);
    if (!reviewer || typeof reviewer.id !== "string") continue;
    const severity = policy?.gateMinimumSeverity;
    const confidence = policy?.gateMinimumConfidence;
    policies[
      typeof reviewer.agent_id === "string"
        ? reviewer.agent_id
        : lens(reviewer.id)
    ] = {
      minimumSeverity:
        severity === "critical" ||
        severity === "high" ||
        severity === "medium" ||
        severity === "low"
          ? severity
          : "medium",
      minimumConfidence:
        confidence === "high" || confidence === "medium" || confidence === "low"
          ? confidence
          : "medium",
    };
  }
  return policies;
}

export async function readNormalizedRun(
  path: string,
  options: {
    expectedSha256?: string;
    expectedIdentity?: ArtifactIdentity;
    observedPublicStream?: PublicStreamOutcome;
    bestEffort?: boolean;
    allowActive?: boolean;
  } = {},
): Promise<NormalizedRun> {
  const handle = await open(path, "r");
  let first: Record<string, unknown> | undefined;
  try {
    const buffer = Buffer.alloc(64 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const newline = buffer.subarray(0, bytesRead).indexOf(10);
    first = object(
      JSON.parse(
        buffer.subarray(0, newline < 0 ? bytesRead : newline).toString("utf8"),
      ),
    );
  } finally {
    await handle.close();
  }
  if (first?.record !== "run.artifact") {
    // Historical parsing stays owned by the existing strict v4/v5 dispatcher.
    const { readLegacyRunReport } = await import("./run-report.js");
    const id = basename(path).replace(/\.jsonl(?:\.active.*)?$/u, "");
    const legacy = await readLegacyRunReport({
      runsDirectory: dirname(path),
      runId: id,
      ...(options.bestEffort === undefined
        ? {}
        : { bestEffort: options.bestEffort }),
    });
    const raw = legacy.raw_findings as CanonicalRawFinding[];
    const proofs = Object.fromEntries(
      raw.map((finding) => [
        finding.source_ref,
        { evidence_verified: false, source_coverage_verified: false },
      ]),
    );
    const canonical = canonicalizeFindings(raw, { proofBySourceRef: proofs });
    const verified = await verifyArtifactFile(path, options.expectedIdentity);
    if (
      options.expectedSha256 !== undefined &&
      options.expectedSha256 !== verified.sha256
    )
      throw new RunArtifactError(
        "artifact_digest_mismatch",
        "The historical artifact digest does not match its published digest.",
      );
    return {
      run_id: legacy.run_id,
      active: legacy.active,
      artifact_format_version: "1",
      run_outcome: legacy.exit_code === 4 ? "cancelled" : "inconclusive",
      gate_outcome:
        canonical.counts.gate_eligible_subfindings > 0
          ? "gate_findings"
          : "no_gate_findings",
      coverage_outcome: "partial",
      execution_coverage: { status: legacy.coverage_outcome },
      change_coverage: { status: "legacy_unknown" },
      exit_code: legacy.exit_code === 4 ? 4 : 3,
      canonical,
      reviewers: legacy.reviewers.map((reviewer) => ({
        reviewer_id: reviewer.reviewer_id,
        lens_id: reviewer.lens_id,
        status: reviewer.status,
        ...(reviewer.reason === undefined ? {} : { reason: reviewer.reason }),
        legacy_result: reviewer.result,
      })),
      artifact: {
        path,
        sha256: verified.sha256,
        byte_count: verified.byte_count,
        completed_results: legacy.reviewers.filter(
          (reviewer) => reviewer.result !== undefined,
        ).length,
      },
      digest_status:
        options.expectedSha256 === undefined
          ? "final_digest_unavailable"
          : "verified",
      reported_outcome: {
        gate_outcome: legacy.gate_outcome,
        coverage_outcome: legacy.coverage_outcome,
        exit_code: legacy.exit_code,
      },
      reported_counts: { ...legacy.finding_counts },
      summary: { ...legacy },
      records: [],
      warnings: [{ code: "legacy_unknown_change_coverage" }],
    };
  }
  const artifact = await readRunArtifact(path, {
    ...(options.expectedSha256 === undefined
      ? {}
      : { expectedSha256: options.expectedSha256 }),
    ...(options.expectedIdentity === undefined
      ? {}
      : { expectedIdentity: options.expectedIdentity }),
    ...(options.allowActive ? { allowActive: true } : {}),
  });
  const resolution = object(
    artifact.records.find((record) => record.record === "resolution")
      ?.resolution,
  );
  const context = object(
    artifact.records.find((record) => record.record === "context")?.context,
  );
  const request = object(
    artifact.records.find((record) => record.record === "request")?.request,
  );
  const terminals = new Map(
    artifact.records
      .filter((record) => record.record === "reviewer.terminal")
      .map((record) => [String(record.reviewer_id), object(record.data) ?? {}]),
  );
  const reviewers: NormalizedReviewer[] = artifact.results.map((item) => {
    const terminal = terminals.get(item.reviewer_id);
    return {
      reviewer_id: item.reviewer_id,
      lens_id:
        typeof terminal?.lens_id === "string"
          ? terminal.lens_id
          : lens(item.reviewer_id),
      status: terminal?.status === "incomplete" ? "incomplete" : "completed",
      result: item.result,
      digest: item.digest,
      byte_count: item.byte_count,
      ...(typeof terminal?.reason === "string"
        ? { reason: terminal.reason }
        : {}),
      ...(terminal === undefined ? {} : { terminal }),
      coverage: artifact.records
        .filter(
          (record) =>
            record.record === "reviewer.coverage" &&
            record.reviewer_id === item.reviewer_id,
        )
        .flatMap((record) =>
          Array.isArray(object(record.data)?.entries)
            ? (object(record.data)!.entries as Record<string, unknown>[])
            : [],
        ),
    };
  });
  for (const [id, terminal] of terminals) {
    if (reviewers.some((reviewer) => reviewer.reviewer_id === id)) continue;
    reviewers.push({
      reviewer_id: id,
      lens_id:
        typeof terminal.lens_id === "string" ? terminal.lens_id : lens(id),
      status: terminal.status === "skipped" ? "skipped" : "incomplete",
      terminal,
      ...(typeof terminal.reason === "string"
        ? { reason: terminal.reason }
        : {}),
    });
  }
  reviewers.sort((a, b) =>
    a.reviewer_id < b.reviewer_id ? -1 : a.reviewer_id > b.reviewer_id ? 1 : 0,
  );
  const sourceRaw = reviewers.flatMap((reviewer) =>
    reviewer.result?.schema_version === "4"
      ? buildCanonicalRawFindings({
          reviewer_id: reviewer.reviewer_id,
          lens_id: reviewer.lens_id,
          result: reviewer.result,
        })
      : [],
  );
  const findingsRecord = object(
    artifact.records.find((record) => record.record === "run.findings")?.data,
  );
  const raw = Array.isArray(findingsRecord?.raw)
    ? (findingsRecord.raw as CanonicalRawFinding[])
    : sourceRaw;
  const proofs =
    (object(findingsRecord?.proof_by_source_ref) as
      Record<string, CanonicalFindingCoreProof> | undefined) ??
    explicitProofs(artifact.records);
  for (const finding of raw)
    proofs[finding.source_ref] ??= {
      evidence_verified: false,
      source_coverage_verified: false,
    };
  const canonical = canonicalizeFindings(raw, {
    gatePolicies:
      (object(findingsRecord?.gate_policies) as
        Record<string, CanonicalGatePolicy> | undefined) ??
      gatePolicies(resolution),
    proofBySourceRef: proofs,
  });
  const full = object(context?.review_scope)?.mode === "full";
  const contributing = reviewers.filter(
    (reviewer) =>
      reviewer.status === "completed" &&
      reviewer.result?.schema_version === "4",
  );
  const coverageComplete =
    full ||
    (contributing.length > 0 &&
      contributing.every(
        (reviewer) =>
          reviewer.result?.schema_version === "4" &&
          (reviewer.result.change_coverage.status === "complete" ||
            reviewer.result.change_coverage.status === "not_applicable"),
      ));
  const executionComplete =
    (object(artifact.summary.execution_coverage)?.status ??
      artifact.summary.coverage_outcome) === "complete";
  const reportedChange = object(artifact.summary.change_coverage)?.status;
  const changeComplete =
    reportedChange === "not_applicable" || reportedChange === "complete"
      ? coverageComplete || contributing.length === 0
      : coverageComplete;
  const coverage = changeComplete && executionComplete ? "complete" : "partial";
  const gateCount = canonical.counts.gate_eligible_subfindings;
  const cancelled = artifact.summary.run_outcome === "cancelled";
  for (const key of [
    "raw_source_findings",
    "atomic_subfindings",
    "canonical_roots",
    "gate_eligible_subfindings",
    "advisory_subfindings",
    "rejected_subfindings",
    "needs_verification_subfindings",
    "non_gating_subfindings",
  ] as const) {
    if (!artifact.active && artifact.summary[key] !== canonical.counts[key])
      throw new RunArtifactError(
        "invalid_artifact_record",
        "Terminal finding counts do not match the preserved source evidence.",
      );
  }
  return {
    run_id: artifact.run_id,
    active: artifact.active,
    artifact_format_version: "2",
    run_outcome: runOutcome({ cancelled, coverage, gateFindings: gateCount }),
    gate_outcome: gateCount > 0 ? "gate_findings" : "no_gate_findings",
    coverage_outcome: coverage,
    execution_coverage: { status: executionComplete ? "complete" : "partial" },
    change_coverage: {
      status: full
        ? "not_applicable"
        : changeComplete
          ? "complete"
          : "incomplete",
    },
    exit_code: cancelled
      ? 4
      : coverage === "partial"
        ? 3
        : gateCount > 0
          ? 1
          : 0,
    canonical,
    reviewers,
    artifact: {
      path,
      sha256: artifact.sha256,
      byte_count: artifact.byte_count,
      completed_results: artifact.results.length,
    },
    digest_status: artifact.digest_status,
    ...(options.observedPublicStream === undefined
      ? {}
      : { observed_public_stream: options.observedPublicStream }),
    summary: artifact.summary,
    ...(request === undefined ? {} : { request }),
    ...(context === undefined ? {} : { context }),
    ...(resolution === undefined ? {} : { resolution }),
    records: artifact.records,
    warnings: Array.isArray(resolution?.warnings)
      ? resolution.warnings
          .map(object)
          .filter(
            (value): value is Record<string, unknown> => value !== undefined,
          )
      : [],
  };
}
