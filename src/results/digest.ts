import { createHash } from "node:crypto";
import type { ReviewerOutput } from "../protocol/schemas.js";
import type { AdjudicationOutcome } from "../findings/adjudication.js";

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

export function reviewerResultDigest(result: ReviewerOutput): string {
  return createHash("sha256").update(canonicalJson(result), "utf8").digest("hex");
}

export function adjudicationAttestationDigest(value: {
  candidate_digest: string;
  adjudication_digest: string;
  context_head: string | null;
  outcome: AdjudicationOutcome;
}): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}
