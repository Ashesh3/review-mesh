import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDoctorV9 } from "../../src/diagnostics/doctor-v9.js";
import { readRunArtifact } from "../../src/diagnostics/run-artifact.js";
import { resolvedReviewer, roundInput } from "../helpers/fixtures.js";
import type {
  AdapterReviewInput,
  ReviewAdapter,
} from "../../src/adapters/types.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function runNativeDoctor(
  options: {
    incompleteScope?: boolean;
    omitAttestation?: boolean;
    fail?: boolean;
    caveats?: boolean;
    findings?: boolean;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "mesh-doctor-native-"));
  roots.push(root);
  const received: AdapterReviewInput[] = [];
  const reviewer = resolvedReviewer({
    adapter: { type: "codex" },
    model: "gpt-native",
    runtime: { execution_contract: "native_review_v1" },
    timeoutMs: 5_000,
  });
  const adapter: ReviewAdapter = {
    id: "codex",
    async probe() {
      return {
        available: true,
        authenticated: "unknown",
        model_available: "unknown",
        streaming: true,
        cancellation: true,
        maximumIsolation: "runtime_read_only",
        runtime_version: "fixture",
        observed_file_access: false,
        progress_observable: false,
      };
    },
    async *run(input) {
      received.push(input);
      if (options.fail) {
        yield {
          type: "failure",
          failure: {
            reason: "invalid_result",
            message: "SDK result was invalid.",
            retryable: false,
          },
        };
        return;
      }
      const content = await readFile(
        join(input.context.workspace, "review-mesh-doctor.txt"),
        "utf8",
      );
      expect(content).toContain("Review Mesh doctor.");
      yield {
        type: "result",
        isolation: "runtime_read_only",
        result: {
          schema_version: "4",
          verdict: options.findings ? "fail" : "pass",
          review_markdown: "Native doctor review complete.",
          summary: "No findings.",
          actionable_findings: options.findings
            ? [
                {
                  id: "doctor-finding",
                  severity: "high",
                  confidence: "high",
                  classification: "confirmed_defect",
                  title: "Controlled diagnostic finding",
                  description:
                    "Synthetic native doctor result used to verify execution readiness with findings.",
                  evidence: [
                    {
                      path: "review-mesh-doctor.txt",
                      start_line: 1,
                      end_line: 1,
                      detail: "Controlled fixture line.",
                    },
                  ],
                  suggested_direction:
                    "Resolve the synthetic finding outside the readiness test.",
                  external_assumptions: [],
                  category: "correctness",
                  verification: "Controlled diagnostic fixture.",
                  change_impact: "The fixture line changed from the baseline.",
                  claim: {
                    trigger: "Changed fixture is reviewed.",
                    affected_behavior:
                      "The synthetic review returns a finding.",
                    outcome:
                      "The gate reports findings without making SDK execution unavailable.",
                  },
                },
              ]
            : [],
          informational_notes: [],
          ...(options.omitAttestation
            ? {}
            : {
                native_scope_attestation: {
                  reviewed_paths: options.incompleteScope
                    ? []
                    : ["review-mesh-doctor.txt"],
                  complete: !options.incompleteScope,
                  limitations: options.incompleteScope
                    ? ["Fixture not inspected"]
                    : options.caveats
                      ? [
                          "No tests were executed.",
                          "Not exhaustive proof of correctness.",
                        ]
                      : [],
                },
              }),
        },
      };
    },
  };
  return {
    result: await runDoctorV9(
      adapter,
      reviewer,
      new AbortController().signal,
      roundInput().config,
      join(root, "runs"),
    ),
    received,
  };
}

describe("native SDK doctor", () => {
  it("checks a persisted native structured review without requiring scope attestation or source-read proof", async () => {
    const { result, received } = await runNativeDoctor({
      omitAttestation: true,
    });
    expect(result.ready).toBe(true);
    expect(result.readiness_scope).toBe("end_to_end_native_review");
    expect(result.proof_kind).toBe("unknown");
    expect(received).toHaveLength(1);
    expect(received[0]?.coverage).toBeUndefined();
    expect(received[0]?.resultPages).toBeUndefined();
    expect(received[0]?.prompt.user).not.toContain("required result pages");
    expect(received[0]?.reviewer.policy?.changeCoverage).toBeUndefined();
    expect(received[0]?.context.instructions).not.toMatch(
      /attest|every file|full.file/i,
    );
    expect(received[0]?.resultJsonSchema.required).not.toContain(
      "native_scope_attestation",
    );
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "authentication", passed: true }),
        expect.objectContaining({ name: "model", passed: true }),
        expect.objectContaining({
          name: "native_schema_submission",
          passed: true,
        }),
        expect.objectContaining({
          name: "native_execution_artifact",
          passed: true,
        }),
        expect.objectContaining({ name: "retry_rerun_all", passed: true }),
      ]),
    );
    for (const name of [
      "result_page_assembly",
      "changed_file_access",
      "observed_coverage",
      "native_scope_attestation",
    ])
      expect(result.checks.map((check) => check.name)).not.toContain(name);
    const artifact = await readRunArtifact(result.artifact);
    expect(artifact.records).toContainEqual(
      expect.objectContaining({
        record: "reviewer.native_execution",
        reviewer_id: "doctor",
        data: expect.objectContaining({
          sdk_completed: true,
          coverage_basis: "agent_selected",
        }),
      }),
    );
    expect(artifact.results[0]?.result).not.toHaveProperty(
      "native_scope_attestation",
    );
    expect(artifact.results[0]?.result).toMatchObject({
      schema_version: "4",
      change_coverage: { status: "not_applicable", proof_kind: "unknown" },
    });
  });
  it("does not use optional historical scope metadata as an SDK readiness gate", async () => {
    const { result } = await runNativeDoctor({ incompleteScope: true });
    expect(result.ready).toBe(true);
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "model", passed: true }),
        expect.objectContaining({
          name: "native_schema_submission",
          passed: true,
        }),
      ]),
    );
  });
  it("treats a persisted completed review with findings as native execution readiness, not a clean-review claim", async () => {
    const { result } = await runNativeDoctor({
      omitAttestation: true,
      findings: true,
    });
    expect(result.ready).toBe(true);
    expect(result.readiness_scope).toBe("end_to_end_native_review");
    const artifact = await readRunArtifact(result.artifact);
    expect(artifact.results[0]?.result).toMatchObject({
      verdict: "fail",
      actionable_findings: [expect.objectContaining({ id: "doctor-finding" })],
    });
    expect(result.checks).toContainEqual(
      expect.objectContaining({ name: "retry_rerun_all", passed: true }),
    );
  });
  it("accepts explicit completed scope with informational caveats", async () => {
    const { result } = await runNativeDoctor({ caveats: true });
    expect(result.ready).toBe(true);
    expect(result.checks).toContainEqual(
      expect.objectContaining({
        name: "native_schema_submission",
        passed: true,
      }),
    );
  });
  it("does not infer model readiness from a probe when native output validation fails", async () => {
    const { result } = await runNativeDoctor({ fail: true });
    expect(result.ready).toBe(false);
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "model", passed: false }),
        expect.objectContaining({
          name: "native_schema_submission",
          passed: false,
          failure: expect.objectContaining({ reason: "invalid_result" }),
        }),
      ]),
    );
  });
});
