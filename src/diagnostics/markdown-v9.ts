import type { v9Report } from "./v9-views.js";
import { sanitizeRunMetadata } from "../results/sanitize.js";

function plain(value: unknown): string {
  return String(value ?? "").replace(/[\\`*_[\]<>#]/gu, (c) => `\\${c}`);
}
function code(value: unknown): string {
  return `\`${String(value ?? "")
    .replaceAll("`", "'")
    .replace(/[\r\n]/gu, " ")}\``;
}
function object(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function renderV9Markdown(input: ReturnType<typeof v9Report>): string {
  const report = sanitizeRunMetadata(input) as ReturnType<typeof v9Report>;
  const lines = [
    `# Review Mesh ${plain(report.run_id)}`,
    "",
    report.headline,
    "",
    `Artifact: ${code(report.artifact.path)}`,
    `Elapsed: ${report.total_elapsed_ms === undefined ? "unavailable" : `${report.total_elapsed_ms} ms`}.`,
    `Execution coverage: ${report.execution_coverage.status}; changed-file source delivery: ${report.change_coverage.status}.`,
    "Source delivery records available evidence. Scenario checks below are model reasoning unless independently executed by an evaluator.",
    "",
  ];
  if (report.public_delivery_failure)
    lines.push(
      "## Public delivery failure",
      "",
      code(JSON.stringify(report.public_delivery_failure)),
      "",
      "The review artifact was retained, but public delivery failed.",
      "",
    );
  if (report.review_profile)
    lines.push(`Review profile: ${plain(report.review_profile)}.`, "");
  if (Number(report.total_clean_pass_unreachable) > 0) {
    lines.push(
      "## Quorum feasibility",
      "",
      `A clean pass became unreachable for ${plain(report.total_clean_pass_unreachable)} lenses under the configured policy. Retained individual results remain available.`,
      "",
    );
    for (const record of report.quorum_failures)
      lines.push(`- ${code(JSON.stringify(object(record.data)))}`);
    lines.push("");
  }
  if (report.errors.length) {
    lines.push("## Run failures", "");
    for (const error of report.errors)
      lines.push(`- ${code(JSON.stringify(object(error.data)))}`);
    lines.push("");
  }
  lines.push("## Findings", "");
  if (!report.canonical.atomics.length)
    lines.push(
      report.run_outcome === "clear"
        ? "No verified findings."
        : "No verified findings were retained. This run does not establish a clean review.",
      "",
    );
  for (const finding of report.canonical.atomics) {
    lines.push(
      `### ${plain(finding.severity)}: ${plain(finding.title)}`,
      "",
      plain(finding.description),
      "",
      `Confidence: ${plain(finding.confidence)}; classification: ${plain(finding.classification)}.`,
      `Gate: ${finding.gate_eligibility.eligible ? "eligible" : `excluded (${finding.gate_eligibility.reasons.map(plain).join(", ")})`}.`,
      "",
    );
    for (const evidence of finding.evidence) {
      const location =
        evidence.path === undefined
          ? "Evidence"
          : `${evidence.path}${evidence.start_line === undefined ? "" : `:${evidence.start_line}${evidence.end_line === evidence.start_line ? "" : `-${evidence.end_line}`}`}`;
      lines.push(`- ${code(location)}: ${plain(evidence.detail)}`);
    }
    lines.push(
      "",
      `Suggested direction: ${plain(finding.suggested_direction)}`,
      "",
    );
    if (finding.external_assumptions.length)
      lines.push(
        `Assumptions: ${finding.external_assumptions.map(plain).join("; ")}`,
        "",
      );
  }
  lines.push("## Reviewer results", "");
  for (const reviewer of report.reviewers) {
    lines.push(`### ${plain(reviewer.reviewer_id)}`, "");
    const accepted = reviewer.status === "completed";
    lines.push(
      `Status: ${plain(reviewer.status)}${reviewer.reason ? ` (${plain(reviewer.reason)})` : ""}.`,
    );
    const preflight = report.preflight.find(
      (record) => record.reviewer_id === reviewer.reviewer_id,
    );
    if (preflight)
      lines.push(
        `Inspection preflight: ${code(JSON.stringify(object(preflight.data)))}`,
      );
    const segments = report.segments.filter(
      (segment) => segment.reviewer_id === reviewer.reviewer_id,
    );
    if (segments.length) {
      lines.push("", "Segment analysis (model reasoning):", "");
      for (const segment of segments) {
        lines.push(
          `- ${code(segment.segment_id)} (${plain(segment.phase)}): ${plain(segment.summary)}`,
        );
        if (Array.isArray(segment.source_refs) && segment.source_refs.length)
          lines.push(
            `  Source references: ${code(JSON.stringify(segment.source_refs))}`,
          );
        for (const check of segment.scenario_checks)
          lines.push(
            `  Scenario claim, not runtime-verified: ${code(JSON.stringify(check))}`,
          );
        if (segment.unresolved_questions.length)
          lines.push(
            `  Unresolved questions: ${code(JSON.stringify(segment.unresolved_questions))}`,
          );
      }
    }
    if (reviewer.result) {
      if (!accepted)
        lines.push("Retained structured result; not accepted for clearance.");
      lines.push("", plain(reviewer.result.summary), "");
      for (const note of reviewer.result.informational_notes)
        lines.push(`- ${plain(note.title)}: ${plain(note.description)}`);
      if (reviewer.result.review_markdown.trim())
        lines.push("", reviewer.result.review_markdown, "");
    } else lines.push("No validated structured result was retained.");
    const deficits = (reviewer.coverage ?? []).filter(
      (entry) => entry.relevant === true && entry.disposition === "deficit",
    );
    if (deficits.length) {
      lines.push("", `Coverage deficits (${deficits.length}):`, "");
      for (const entry of deficits)
        lines.push(
          `- ${code(entry.path)}: ${plain(entry.reason ?? entry.snapshot_read ?? "not inspected")}`,
        );
    } else if (
      reviewer.result?.schema_version === "4" &&
      reviewer.result.change_coverage.deficit_count
    ) {
      lines.push(
        "",
        `Coverage deficits: ${reviewer.result.change_coverage.deficit_count}.`,
        "",
      );
      for (const entry of reviewer.result.change_coverage.deficit_sample)
        lines.push(`- ${code(entry.path)}: ${plain(entry.reason)}`);
    }
    const attempts = report.attempts.filter(
      (attempt) => attempt.reviewer_id === reviewer.reviewer_id,
    );
    if (attempts.length) {
      lines.push("", "Attempts:", "");
      for (const attempt of attempts) {
        const data = object(attempt.data),
          failure = object(data.failure),
          diagnostics = object(failure.diagnostics);
        if (!Object.keys(failure).length) {
          lines.push(
            `- Attempt ${plain(data.attempt)} completed in ${plain(data.elapsed_ms ?? "unknown")} ms.`,
          );
          continue;
        }
        lines.push(
          `- Attempt ${plain(data.attempt)}: ${plain(failure.reason ?? failure.code ?? "unknown")}; ${plain(data.elapsed_ms ?? "unknown")} ms. ${plain(failure.message ?? "")}`,
        );
        if (Object.keys(diagnostics).length)
          lines.push(`  Diagnostics: ${code(JSON.stringify(diagnostics))}`);
      }
    }
    lines.push("");
  }
  if (report.unverified_drafts.length) {
    lines.push(
      "## Unverified drafts",
      "",
      "These rejected drafts are diagnostic evidence only; they are not accepted reviews or verified findings.",
      "",
    );
    for (const draft of report.unverified_drafts)
      lines.push(
        `- ${code(draft.reviewer_id)}: ${code(JSON.stringify(object(draft.data)))}`,
      );
    lines.push("");
  }
  if (
    report.run_outcome === "inconclusive" ||
    report.run_outcome === "cancelled"
  )
    lines.push(
      "## Recovery",
      "",
      "Resolve the reported inspection, provider, or result-validation failure, then retry missing work:",
      "",
      code(`review-mesh retry ${report.run_id} --only-incomplete`),
      "",
      "Retry verifies the original scope and snapshot identity before reusing accepted reviews. An empty findings list does not establish clearance.",
      "",
    );
  return `${lines.join("\n").trimEnd()}\n`;
}
