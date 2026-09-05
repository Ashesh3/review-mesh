import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import type { ProviderReviewerResultV4 } from "../../src/protocol/v9.js";

export type V9CommandFixtureMode =
  | "pass"
  | "fail"
  | "large-pass"
  | "large-fail"
  | "secret-messages"
  | "silent"
  | "crash";

export interface V9CommandFixtureEntry {
  id?: string;
  mode: V9CommandFixtureMode;
  result?: ProviderReviewerResultV4;
}

export interface V9CommandConfigOptions {
  scriptPath: string;
  entries: readonly V9CommandFixtureEntry[];
  persistRuns?: boolean;
  timeoutMs?: number;
}

function quoteToml(value: string): string {
  return JSON.stringify(value.replaceAll("\\", "/"));
}

export function v9LargeNarrative(
  heading: string,
  targetBytes = 13 * 1024 * 1024,
): string {
  const prefix = `${heading}\n\n`;
  if (Buffer.byteLength(prefix, "utf8") > targetBytes) {
    throw new Error("large narrative heading exceeds the requested byte size");
  }
  return `${prefix}${"x".repeat(targetBytes - Buffer.byteLength(prefix, "utf8"))}`;
}

export function v9ReviewerResult(options: {
  verdict: "pass" | "fail";
  reviewMarkdown?: string;
  summary?: string;
  findingId?: string;
  evidencePath?: string;
  evidenceDetail?: string;
  rootIssueId?: string;
}): ProviderReviewerResultV4 {
  const reviewMarkdown =
    options.reviewMarkdown ??
    (options.verdict === "pass"
      ? "# Review\n\nClean."
      : "# Review\n\nOne actionable finding.");
  if (options.verdict === "pass") {
    return {
      schema_version: "4",
      verdict: "pass",
      review_markdown: reviewMarkdown,
      summary: options.summary ?? "clean",
      actionable_findings: [],
      informational_notes: [],
    };
  }
  const findingId = options.findingId ?? "fixture-medium";
  return {
    schema_version: "4",
    verdict: "fail",
    review_markdown: reviewMarkdown,
    summary: options.summary ?? "one actionable finding",
    actionable_findings: [
      {
        id: findingId,
        severity: "medium",
        title: "Fixture finding",
        description: "The fixture found a controlled defect.",
        evidence: [
          {
            path: options.evidencePath ?? "source.ts",
            detail: options.evidenceDetail ?? "Controlled evidence.",
          },
        ],
        suggested_direction: "Correct the controlled defect.",
        confidence: "high",
        classification: "confirmed_defect",
        external_assumptions: [],
        root_issue_id: options.rootIssueId ?? "fixture-shared-root",
        category: "correctness",
        verification: "Controlled evidence demonstrates the defect.",
        claim: {
          trigger: "The controlled fixture is reviewed.",
          affected_behavior: "The fixture returns the controlled wrong value.",
          outcome: "The review reports the deterministic defect.",
        },
      },
    ],
    informational_notes: [],
  };
}

export function defaultV9FixtureResult(
  mode: V9CommandFixtureMode,
  index = 0,
): ProviderReviewerResultV4 | undefined {
  if (mode === "silent" || mode === "crash") return undefined;
  const verdict = mode === "fail" || mode === "large-fail" ? "fail" : "pass";
  return v9ReviewerResult({
    verdict,
    ...(mode === "large-pass" || mode === "large-fail"
      ? {
          reviewMarkdown: v9LargeNarrative(
            verdict === "pass"
              ? "# Complete acceptance review"
              : "# Complete acceptance finding",
            256 * 1024,
          ),
        }
      : {}),
    ...(verdict === "fail"
      ? {
          findingId: index === 0 ? "fixture-medium" : `fixture-medium-${index}`,
          evidenceDetail: `Controlled evidence ${index + 1}.`,
        }
      : {}),
  });
}

export function v9AcceptanceNarrative(heading: string): string {
  return v9LargeNarrative(heading, 256 * 1024);
}

export function v9CommandConfig(options: V9CommandConfigOptions): string {
  const timeoutMs = options.timeoutMs ?? 20_000;
  const agents = options.entries
    .map((entry, index) => {
      const id = entry.id ?? `fixture_${index}`;
      return `[adapters.${id}]
type = "command"
command = ${quoteToml(process.execPath)}
args = [${quoteToml(options.scriptPath)}]
env_allowlist = ["REVIEW_MESH_FIXTURE_CAPTURE"]
protocol = "review-mesh-command-v2"

[agents.${id}]
adapter = "${id}"
model = "fixture-model-${index}"
purpose = "Acceptance reviewer ${index}"
instructions = "Review without modifying the workspace."
isolation = "prefer_enforced"
timeout_ms = ${timeoutMs}
kind = "generic"
required_input = []
adjudication = "off"

[agents.${id}.applicability]
mode = "always"

[agents.${id}.change_coverage]
relevant_paths = ["**"]
minimum_inspection = "full_file"
proof = "attested"
`;
    })
    .join("\n");
  const defaults = options.entries
    .map((entry, index) => quoteToml(entry.id ?? `fixture_${index}`))
    .join(", ");
  return `schema_version = "7"

[execution]
max_concurrency = ${Math.max(1, options.entries.length)}
heartbeat_interval_ms = 1000
shutdown_grace_period_ms = 1000
deadline_mode = "adaptive"
no_progress_timeout_ms = 300000

[diagnostics]
persist_runs = ${options.persistRuns === false ? "false" : "true"}
max_runs = 10

${agents}
[defaults]
agents = [${defaults}]
`;
}

export async function writeV9CommandFixture(
  path: string,
  entries: readonly V9CommandFixtureEntry[],
): Promise<void> {
  const fixtures = entries.map((entry, index) => ({
    id: entry.id ?? `fixture_${index}`,
    mode: entry.mode,
    result: entry.result ?? defaultV9FixtureResult(entry.mode, index),
  }));
  const source = `import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";

const fixtures = JSON.parse(Buffer.from(${JSON.stringify(
    Buffer.from(JSON.stringify(fixtures), "utf8").toString("base64"),
  )}, "base64").toString("utf8"));
const lines = (async function* () {
  let buffered = "";
  for await (const chunk of process.stdin) {
    buffered += chunk.toString("utf8");
    for (;;) {
      const newline = buffered.indexOf("\\n");
      if (newline < 0) break;
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      if (line.trim() !== "") yield JSON.parse(line);
    }
  }
  if (buffered.trim() !== "") yield JSON.parse(buffered);
})();
const first = await lines.next();
const request = first.value;
const reviewerId = process.env.REVIEW_MESH_REVIEWER_ID ?? "fixture_0";
const model = process.env.REVIEW_MESH_MODEL ?? "fixture-model-0";
const modelIndex = Number(/-(\\d+)$/.exec(model)?.[1] ?? 0);
const fixture = fixtures.find((candidate) => candidate.id === reviewerId) ?? fixtures[modelIndex] ?? fixtures[0];
const capturePath = process.env.REVIEW_MESH_FIXTURE_CAPTURE;
const descendant = fixture.mode === "silent"
  ? spawn(process.execPath, ["-e", "setInterval(() => undefined, 60000)"], { stdio: "ignore" })
  : undefined;
if (capturePath !== undefined) {
  await writeFile(capturePath, JSON.stringify({
    request,
    env: process.env,
    pid: process.pid,
    ...(descendant?.pid === undefined ? {} : { child_pid: descendant.pid }),
  }));
}
const emit = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
if (fixture.mode === "crash") {
  process.stderr.write("Authorization: Bearer fixture-secret controlled crash\\n");
  process.exit(7);
}
if (fixture.mode === "silent") {
  setInterval(() => undefined, 60_000);
  await new Promise(() => undefined);
}
if (fixture.mode === "secret-messages") {
  emit({ type: "progress", phase: "reviewing", message: "Authorization: Bearer progress-secret reviewing" });
  emit({ type: "activity", message: "Authorization=Bearer activity-secret reviewing", identity: "secret-activity" });
} else {
  emit({ type: "activity", message: "fixture page delivery", identity: "fixture-activity" });
}
const utf8Chunks = (value, maximumBytes) => {
  const chunks = [];
  let chunk = "";
  let bytes = 0;
  for (const character of value) {
    const size = Buffer.byteLength(character, "utf8");
    if (bytes + size > maximumBytes && chunk !== "") {
      chunks.push(chunk);
      chunk = "";
      bytes = 0;
    }
    chunk += character;
    bytes += size;
  }
  if (chunk !== "") chunks.push(chunk);
  return chunks;
};
const result = fixture.result;
const narrative = utf8Chunks(result.review_markdown, 24 * 1024);
const findingPages = [];
for (let index = 0; index < result.actionable_findings.length; index += 2) {
  findingPages.push(result.actionable_findings.slice(index, index + 2));
}
const pageCount = 1 + narrative.length + findingPages.length;
for await (const assignment of lines) {
  if (assignment.type !== "request_page") continue;
  const pageIndex = assignment.request.page_index;
  let pageKind;
  let payload;
  if (pageIndex === 0) {
    pageKind = "header";
    payload = {
      verdict: result.verdict,
      summary: result.summary,
      informational_notes: result.informational_notes,
      narrative_byte_count: Buffer.byteLength(result.review_markdown, "utf8"),
      narrative_fragment_count: narrative.length,
      actionable_finding_count: result.actionable_findings.length,
      coverage_attestation: null,
    };
  } else if (pageIndex <= narrative.length) {
    pageKind = "narrative";
    payload = { text_fragment: narrative[pageIndex - 1] };
  } else {
    pageKind = "findings";
    payload = { actionable_findings: findingPages[pageIndex - narrative.length - 1] };
  }
  const page = JSON.stringify({
    schema_version: "1",
    kind: "review-mesh.result-page",
    result_id: assignment.request.result_id,
    result_kind: "reviewer",
    result_schema_version: "4",
    page_index: pageIndex,
    page_count: pageCount,
    page_kind: pageKind,
    previous_page_digest: assignment.request.previous_page_digest,
    payload,
  });
  emit({ type: "result_page", page });
  if (pageIndex + 1 === pageCount) break;
}
`;
  await writeFile(path, source);
}

export function uniqueV9RunId(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}
