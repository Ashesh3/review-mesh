import { createHash } from "node:crypto";
import { canonicalJson, reviewerResultDigest } from "./digest.js";
import { createResultPageCollector } from "./result-pages.js";
import { sanitizeRunMetadata } from "./sanitize.js";
import {
  resultPageSchema,
  type ProviderReviewerResultV4,
  type AdjudicationResultV2,
} from "../protocol/v9.js";

const digest = (text: string) =>
  createHash("sha256").update(text, "utf8").digest("hex");

/** Rebuilds a sanitized semantic chain; original transport bytes remain ephemeral. */
export async function sanitizedResultPages(
  input: AsyncIterable<{ raw: string; sha256: string }>,
  expected: ProviderReviewerResultV4 | AdjudicationResultV2,
): Promise<Array<{ raw: string; sha256: string }>> {
  const parsed = [];
  for await (const page of input) {
    if (digest(page.raw) !== page.sha256)
      throw new Error("Raw result page digest mismatch.");
    parsed.push(resultPageSchema.parse(JSON.parse(page.raw)));
    if (parsed.length > 951)
      throw new Error("Result page count exceeds limit.");
  }
  if (parsed.length === 0) return [];
  const sanitized = parsed.map(
    (page) => sanitizeRunMetadata(page) as typeof page,
  );
  const header = sanitized[0]!;
  if (header.page_kind !== "header")
    throw new Error("Result page header missing.");
  if (header.result_kind === "reviewer") {
    const narrative = sanitized
      .flatMap((page) =>
        page.result_kind === "reviewer" && page.page_kind === "narrative"
          ? [page.payload.text_fragment]
          : [],
      )
      .join("");
    header.payload.narrative_byte_count = Buffer.byteLength(narrative, "utf8");
    if (header.payload.coverage_attestation) {
      const entries = sanitized.flatMap((page) =>
        page.result_kind === "reviewer" && page.page_kind === "coverage"
          ? page.payload.entries
          : [],
      );
      header.payload.coverage_attestation.entries_digest = digest(
        canonicalJson(entries),
      );
    }
  }
  const result: Array<{ raw: string; sha256: string }> = [];
  for (const page of sanitized) {
    page.previous_page_digest = result.at(-1)?.sha256 ?? null;
    const raw = JSON.stringify(page);
    result.push({ raw, sha256: digest(raw) });
  }
  const collector = createResultPageCollector({
    resultId: header.result_id,
    resultKind: header.result_kind,
    ...(expected.schema_version === "2"
      ? {
          candidateIds: expected.decisions.map(
            (decision) => decision.source_finding_id,
          ),
        }
      : {}),
  });
  for (const page of result) collector.addPage(page.raw);
  if (
    reviewerResultDigest(collector.assemble()) !==
    reviewerResultDigest(expected)
  )
    throw new Error("Sanitized pages do not match the accepted result.");
  return result;
}
