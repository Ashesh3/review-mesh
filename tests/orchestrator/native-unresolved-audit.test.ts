import { expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AdapterRegistry } from "../../src/adapters/registry.js";
import type { AdapterEvent } from "../../src/adapters/types.js";
import type {
  ActionableFindingV4,
  AdjudicationResultV2,
  ProviderReviewerResultV4,
} from "../../src/protocol/v9.js";
import { runNativeReview } from "../../src/orchestrator/run-native.js";
import {
  resolvedContext,
  resolvedReviewer,
  roundInput,
} from "../helpers/fixtures.js";

it.each(["unresolved", "upgrade-after-downgrade"] as const)(
  "keeps %s adjudication inconclusive without erasing stronger verified evidence",
  async (mode) => {
    const workspace = await mkdtemp(join(tmpdir(), "mesh-unresolved-audit-"));
    try {
      await writeFile(join(workspace, "source.ts"), "return oldValue;\n");
      const finding: ActionableFindingV4 = {
        id: "f1",
        severity: "high",
        confidence: "high",
        classification: "confirmed_defect",
        category: "correctness",
        title: "Stale result",
        description: "Returns old state.",
        evidence: [
          {
            path: "source.ts",
            start_line: 1,
            end_line: 1,
            detail: "Return old state",
          },
        ],
        suggested_direction: "Return current state.",
        verification: "Inspect return.",
        external_assumptions: [],
        claim: {
          trigger: "State changes",
          affected_behavior: "Old value returned",
          outcome: "Caller sees stale state",
        },
      };
      const config = roundInput().config;
      config.execution.review_profile = "strict-evaluation";
      config.reviewers = [0, 1, 2].map((index) =>
        resolvedReviewer({
          id: `lens::m${index}`,
          agentId: "lens",
          modelIndex: index,
          configuredModelIndex: index,
          modelCount: 3,
          model: `model-${index}`,
          providerGroup: `provider-${index}`,
          adapterId: "native",
          adapter: { type: "codex" },
          timeoutMs: 10000,
          policy: {
            passQuorum: 3,
            minimumProviderGroups: 3,
            adjudication: "required",
            gateMinimumSeverity: "medium",
            gateMinimumConfidence: "medium",
            changeCoverage: {
              relevantPaths: ["**"],
              minimumInspection: "full_file",
              proof: "native_attested",
            },
          },
        }),
      );
      const registry = new AdapterRegistry();
      registry.register("codex", () => ({
        id: "native",
        async probe() {
          return {
            available: true,
            authenticated: true,
            model_available: true,
            streaming: true,
            cancellation: true,
            maximumIsolation: "runtime_read_only" as const,
          };
        },
        async *run(input): AsyncIterable<AdapterEvent> {
          let result: ProviderReviewerResultV4 | AdjudicationResultV2;
          if (input.reviewer.policy?.mode === "adjudication") {
            const source = input.reviewer.policy
              .candidateFindings as unknown as ActionableFindingV4[];
            result = {
              schema_version: "2",
              kind: "review-mesh.adjudication-result",
              verdict: "fail",
              review_markdown: "Claim remains unverified.",
              summary: "External behavior unverified",
              actionable_findings: [],
              informational_notes: [],
              decisions: source.map((candidate) => {
                const { id, ...adjusted } = candidate;
                return {
                  source_finding_id: id,
                  decision: "adjusted",
                  rationale:
                    "File lines verified but required external behavior unknown.",
                  cited_evidence: finding.evidence,
                  unverified_assumptions: [
                    "External caller may intentionally require the old value.",
                  ],
                  adjusted_finding: {
                    ...adjusted,
                    classification:
                      mode === "unresolved"
                        ? "needs_verification"
                        : input.reviewer.modelIndex === 1
                          ? "advisory"
                          : "confirmed_defect",
                    external_assumptions: [
                      "External caller may intentionally require the old value.",
                    ],
                  },
                };
              }),
            };
          } else
            result = {
              schema_version: "4",
              verdict: "fail",
              review_markdown: "Source finding",
              summary: "Potential stale result",
              actionable_findings: [finding],
              informational_notes: [],
              native_scope_attestation: {
                complete: true,
                reviewed_paths: ["source.ts"],
                limitations: [],
              },
            };
          yield { type: "result", result, isolation: "runtime_read_only" };
        },
      }));
      const output = await runNativeReview({
        runId: "unresolved-audit",
        config,
        context: resolvedContext({
          workspace,
          review_scope: { mode: "full", source: "request" },
        }),
        registry,
        signal: new AbortController().signal,
        record: async () => {},
        recordResult: async () => {},
        writer: {
          emit: async () => {},
          finish: async () => ({
            path: "/artifact",
            sha256: "a".repeat(64),
            byte_count: 1,
            completed_results: 3,
          }),
          outputFailed: () => false,
          close: async () => {},
        },
      });
      if (mode === "unresolved")
        expect(output.canonical.counts.needs_verification_subfindings).toBe(1);
      else expect(output.canonical.counts.gate_eligible_subfindings).toBe(1);
      expect(output.summary).toMatchObject({
        run_outcome: "inconclusive",
        coverage_outcome: "partial",
        exit_code: 3,
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  },
);
