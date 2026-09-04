import { createHash } from "node:crypto";
import type {
  AdjudicationResult,
  ReviewerResultV3,
} from "../protocol/schemas.js";
import { canonicalJson, reviewerResultDigest } from "../results/digest.js";
import {
  validateAdjudication,
  type AdjudicationOutcome,
  type AdjudicationValidationContext,
} from "./adjudication.js";

export interface AdjudicationValidationAttestation {
  candidate_digest: string;
  adjudication_digest: string;
  context_head: string | null;
  verification_digest: string;
  evidence_verification: NonNullable<
    AdjudicationValidationContext["evidenceVerification"]
  >;
  outcome: AdjudicationOutcome;
  attestation_digest: string;
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

export function createAdjudicationValidationAttestation(input: {
  candidateResult: ReviewerResultV3;
  adjudicationResult: AdjudicationResult;
  contextHead: string | null;
  validationContext: AdjudicationValidationContext;
}): AdjudicationValidationAttestation {
  const outcome = validateAdjudication(
    input.candidateResult,
    input.adjudicationResult,
    input.validationContext,
  );
  const base = {
    candidate_digest: reviewerResultDigest(input.candidateResult),
    adjudication_digest: reviewerResultDigest(input.adjudicationResult),
    context_head: input.contextHead,
    verification_digest: digest(input.validationContext.evidenceVerification ?? null),
    evidence_verification:
      input.validationContext.evidenceVerification ?? {
        by_source_finding_id: {},
      },
    outcome,
  };
  return { ...base, attestation_digest: digest(base) };
}

export function verifyAdjudicationValidationAttestation(input: {
  attestation: AdjudicationValidationAttestation;
  candidateResult: ReviewerResultV3;
  adjudicationResult: AdjudicationResult;
  contextHead: string | null;
}): AdjudicationOutcome | undefined {
  const { attestation_digest: _digest, ...base } = input.attestation;
  if (
    input.attestation.candidate_digest !==
      reviewerResultDigest(input.candidateResult) ||
    input.attestation.adjudication_digest !==
      reviewerResultDigest(input.adjudicationResult) ||
    input.attestation.context_head !== input.contextHead ||
    input.attestation.verification_digest !==
      digest(input.attestation.evidence_verification) ||
    input.attestation.attestation_digest !== digest(base)
  ) {
    return undefined;
  }
  return structuredClone(input.attestation.outcome);
}
