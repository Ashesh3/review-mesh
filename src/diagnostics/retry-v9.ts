import { createHash } from "node:crypto";
import type { ResolvedConfig } from "../config/schemas.js";
import type { ResolvedContext } from "../context/resolve.js";
import type {
  CanonicalFindingCoreProof,
  CanonicalRawFinding,
} from "../findings/canonical.js";
import type { AdjudicationResultV2, ReviewerResultV4 } from "../protocol/v9.js";
import { reviewerResultDigest } from "../results/digest.js";
import { loadV9Run } from "./v9-views.js";
import { sanitizeRunMetadata } from "../results/sanitize.js";
import {
  createChangeCoverageLedger,
  releaseRunSnapshot,
  type RunSnapshotIdentity,
} from "../context/change-coverage.js";
import { runSnapshotIdentitySchema } from "./artifact-payloads.js";

export interface InheritedV9ReviewerResult {
  reviewerId: string;
  lensId: string;
  result: ReviewerResultV4 | AdjudicationResultV2;
  resultDigest: string;
  resultByteCount: number;
  coverageEntries: Record<string, unknown>[];
  snapshotIdentity?: RunSnapshotIdentity;
  terminal: Record<string, unknown>;
}

export interface PreparedV9Retry {
  parentRunId: string;
  runLensIds: string[];
  inherited: InheritedV9ReviewerResult[];
  inheritance: "exact" | "rerun_all";
  evidenceReason?:
    | "snapshot_identity_verified"
    | "snapshot_identity_unavailable"
    | "scope_or_policy_changed";
  rawFindings: CanonicalRawFinding[];
  proofBySourceRef: Record<string, CanonicalFindingCoreProof>;
  adjudicationOutcomes: Record<string, unknown>[];
}

export class V9RetryError extends Error {
  constructor(
    readonly code:
      | "invalid_retry_parent"
      | "unknown_retry_lens"
      | "retry_parent_unverified"
      | "retry_evidence_changed",
    message: string,
  ) {
    super(message);
    this.name = "V9RetryError";
  }
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonical(item)]),
  );
}

function digest(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)), "utf8")
    .digest("hex");
}

export function reviewerConfigFingerprint(
  reviewer: ResolvedConfig["reviewers"][number],
): string {
  return digest(reviewer);
}

function lensId(reviewer: ResolvedConfig["reviewers"][number]): string {
  return reviewer.agentId ?? reviewer.id;
}

function evidenceIdentity(context: Record<string, unknown>): unknown {
  const git = context.git as Record<string, unknown>;
  return {
    workspace: context.workspace,
    review_scope: context.review_scope,
    git: git?.is_repository
      ? {
          head: git.head,
          base: git.base,
          merge_base: git.merge_base,
          changed_files: git.changed_files,
          changed_paths: git.changed_paths,
          raw_diff: git.raw_diff,
          truncated: git.truncated,
        }
      : git,
  };
}

function currentScope(
  context: ResolvedContext | Record<string, unknown>,
): unknown {
  const git = context.git as Record<string, unknown>;
  return {
    consistency_mode: context.consistency_mode,
    workspace: context.workspace,
    project_name: context.project_name,
    instructions: context.instructions,
    caller_context: context.caller_context,
    request: context.request,
    review_scope: context.review_scope,
    // Narrative is intentionally sanitized on disk; identity comes from the
    // core-owned digest, never a duplicate raw diff in caller context.
    git:
      git?.is_repository && git.raw_diff
        ? { ...git, diff: undefined, diff_stat: undefined }
        : git,
  };
}

function parentScope(context: Record<string, unknown>): unknown {
  return currentScope(context);
}

function currentPolicies(
  config: ResolvedConfig,
  parent: Record<string, unknown>,
): unknown {
  const prior = Array.isArray(parent.reviewers)
    ? (parent.reviewers as Record<string, unknown>[])
    : [];
  return config.reviewers.map((reviewer) => ({
    id: reviewer.id,
    agent_id: lensId(reviewer),
    policy: reviewer.policy,
    ...(prior.some((item) => item.id === reviewer.id && item.config_fingerprint)
      ? { config_fingerprint: reviewerConfigFingerprint(reviewer) }
      : {}),
    ...Object.fromEntries(
      Object.entries({
        adapter: reviewer.adapterId,
        model: reviewer.model,
        effort: reviewer.effort,
        provider_group: reviewer.providerGroup ?? reviewer.adapterId,
        isolation: reviewer.isolationPolicy,
        timeout_ms: reviewer.timeoutMs,
      }).filter(([key]) =>
        prior.some(
          (item) => item.id === reviewer.id && item[key] !== undefined,
        ),
      ),
    ),
  }));
}

function parentPolicies(resolution: Record<string, unknown>): unknown {
  return Array.isArray(resolution.reviewers)
    ? resolution.reviewers.map((item) => {
        const row = item as Record<string, unknown>;
        return Object.fromEntries(
          [
            "id",
            "agent_id",
            "policy",
            "config_fingerprint",
            "adapter",
            "model",
            "effort",
            "provider_group",
            "isolation",
            "timeout_ms",
          ]
            .filter((key) => row[key] !== undefined)
            .map((key) => [key, row[key]]),
        );
      })
    : [];
}

export async function prepareV9Retry(input: {
  runsDirectory: string;
  parentRunId: string;
  selectedLensIds: readonly string[];
  config: ResolvedConfig;
  context: ResolvedContext;
}): Promise<PreparedV9Retry> {
  const configuredLensIds = [
    ...new Set(input.config.reviewers.map((reviewer) => lensId(reviewer))),
  ];
  const selectedLensIds = [...new Set(input.selectedLensIds)];
  const unknown = selectedLensIds.filter(
    (selected) => !configuredLensIds.includes(selected),
  );
  if (selectedLensIds.length === 0 || unknown.length > 0)
    throw new V9RetryError(
      "unknown_retry_lens",
      `Unknown selected retry lens: ${unknown[0] ?? "none"}.`,
    );

  const parent = await loadV9Run(input.runsDirectory, input.parentRunId);
  if (!parent || parent.active || !parent.context || !parent.resolution)
    throw new V9RetryError(
      "invalid_retry_parent",
      "Retry requires a completed parent artifact with captured context and resolution.",
    );
  if (parent.digest_status !== "verified")
    throw new V9RetryError(
      "retry_parent_unverified",
      "Retry inheritance requires a run-index verified parent artifact.",
    );

  if (
    digest(
      evidenceIdentity(input.context as unknown as Record<string, unknown>),
    ) !== digest(evidenceIdentity(parent.context))
  )
    throw new V9RetryError(
      "retry_evidence_changed",
      "Git head, base, scope or changed evidence differs from the parent; start a fresh review.",
    );
  const exactScope =
    digest(sanitizeRunMetadata(canonical(currentScope(input.context)))) ===
    digest(sanitizeRunMetadata(canonical(parentScope(parent.context))));
  const exactPolicies =
    digest(currentPolicies(input.config, parent.resolution)) ===
    digest(parentPolicies(parent.resolution));
  function rerunAll(
    evidenceReason: PreparedV9Retry["evidenceReason"],
  ): PreparedV9Retry {
    return {
      parentRunId: input.parentRunId,
      runLensIds: configuredLensIds,
      inherited: [],
      inheritance: "rerun_all",
      ...(evidenceReason === undefined ? {} : { evidenceReason }),
      rawFindings: [],
      proofBySourceRef: {},
      adjudicationOutcomes: [],
    };
  }
  if (!exactScope || !exactPolicies) return rerunAll("scope_or_policy_changed");

  const selected = new Set(selectedLensIds);
  const parentIncompleteLenses = new Set(
    parent.reviewers
      .filter(
        (reviewer) =>
          reviewer.status === "incomplete" ||
          reviewer.reason === "not_evaluated_missing_input",
      )
      .map((reviewer) => reviewer.lens_id),
  );
  for (const incomplete of parentIncompleteLenses)
    if (!selected.has(incomplete))
      throw new V9RetryError(
        "unknown_retry_lens",
        `Parent incomplete lens was not selected for retry: ${incomplete}.`,
      );

  const snapshotIdentities = new Map<string, RunSnapshotIdentity>();
  for (const reviewer of parent.reviewers.filter(
    (entry) => entry.status === "completed",
  )) {
    const records = parent.records.filter(
      (record) =>
        record.record === "reviewer.coverage" &&
        record.reviewer_id === reviewer.reviewer_id,
    );
    const identities = records.flatMap((record) => {
      const parsed = runSnapshotIdentitySchema.safeParse(
        (record.data as Record<string, unknown> | undefined)?.snapshot_identity,
      );
      return parsed.success ? [parsed.data] : [];
    });
    if (identities.length !== 1 || !identities[0]!.complete)
      return rerunAll("snapshot_identity_unavailable");
    snapshotIdentities.set(reviewer.reviewer_id, identities[0]!);
  }
  if (snapshotIdentities.size > 0) {
    // Pin a fresh snapshot on the actual child context so execution consumes
    // exactly the evidence compared here, including unchanged support files.
    releaseRunSnapshot(input.context);
    let ledger;
    try {
      ledger = await createChangeCoverageLedger({
        context: input.context,
        policy: {
          relevantPaths: ["**"],
          minimumInspection: "full_file",
          proof: "observed",
        },
      });
    } catch {
      return rerunAll("snapshot_identity_unavailable");
    }
    const current = ledger.snapshotIdentity();
    await ledger.close();
    if (!current.complete) return rerunAll("snapshot_identity_unavailable");
    if (
      [...snapshotIdentities.values()].some(
        (prior) =>
          prior.sha256 !== current.sha256 ||
          prior.file_count !== current.file_count,
      )
    )
      throw new V9RetryError(
        "retry_evidence_changed",
        "Captured workspace file set or bytes changed since the parent review; start a fresh review.",
      );
  }
  const currentReviewerIds = new Set(
    input.config.reviewers.map((reviewer) => reviewer.id),
  );
  const inherited = parent.reviewers.flatMap((reviewer) => {
    if (
      reviewer.status !== "completed" ||
      reviewer.result === undefined ||
      reviewer.digest === undefined ||
      reviewer.byte_count === undefined ||
      reviewer.terminal === undefined ||
      !currentReviewerIds.has(reviewer.reviewer_id) ||
      reviewerResultDigest(reviewer.result) !== reviewer.digest ||
      (reviewer.result.schema_version === "4" &&
        reviewer.result.change_coverage.status !== "complete" &&
        reviewer.result.change_coverage.status !== "not_applicable")
    )
      return [];
    return [
      {
        reviewerId: reviewer.reviewer_id,
        lensId: reviewer.lens_id,
        result: structuredClone(reviewer.result),
        resultDigest: reviewer.digest,
        resultByteCount: reviewer.byte_count,
        coverageEntries: structuredClone(reviewer.coverage ?? []),
        ...(snapshotIdentities.get(reviewer.reviewer_id) === undefined
          ? {}
          : {
              snapshotIdentity: snapshotIdentities.get(reviewer.reviewer_id)!,
            }),
        terminal: structuredClone(reviewer.terminal),
      },
    ];
  });

  const inheritedIds = new Set(
    inherited.map((reviewer) => reviewer.reviewerId),
  );
  const runLensIds = configuredLensIds.filter((id) =>
    input.config.reviewers.some(
      (reviewer) => lensId(reviewer) === id && !inheritedIds.has(reviewer.id),
    ),
  );
  const findingsRecord = parent.records.find(
    (record) => record.record === "run.findings",
  )?.data as Record<string, unknown> | undefined;
  const inheritedReviewerIds = new Set(
    inherited.map((reviewer) => reviewer.reviewerId),
  );
  const rawFindings = parent.canonical.raw.filter((finding) =>
    inheritedReviewerIds.has(finding.reviewer_id),
  );
  const allProofs =
    (findingsRecord?.proof_by_source_ref as
      Record<string, CanonicalFindingCoreProof> | undefined) ?? {};
  const proofBySourceRef = Object.fromEntries(
    rawFindings.flatMap((finding) =>
      allProofs[finding.source_ref] === undefined
        ? []
        : [[finding.source_ref, allProofs[finding.source_ref]!]],
    ),
  );
  return {
    parentRunId: input.parentRunId,
    runLensIds,
    inherited,
    inheritance: "exact",
    evidenceReason: "snapshot_identity_verified",
    rawFindings: structuredClone(rawFindings),
    proofBySourceRef: structuredClone(proofBySourceRef),
    adjudicationOutcomes: Array.isArray(findingsRecord?.adjudication_outcomes)
      ? structuredClone(
          findingsRecord.adjudication_outcomes as Record<string, unknown>[],
        )
      : [],
  };
}
