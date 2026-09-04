import { afterEach, describe, expect, it, vi } from "vitest";
import { adapterFailure } from "../../src/adapters/errors.js";
import { runReviewRound } from "../../src/orchestrator/run-review.js";
import type { PublicEvent } from "../../src/protocol/schemas.js";
import { FakeAdapter } from "../helpers/fake-adapter.js";
import {
  fakeAdapterReturning,
  failResult,
  passResult,
  resolvedContext,
  roundInput,
} from "../helpers/fixtures.js";

describe("v6 review feedback semantics", () => {
  afterEach(() => vi.useRealTimers());
  it("fails over after an operational protocol failure and recovers lens coverage", async () => {
    const first = new FakeAdapter({
      onRun: (queue) => {
        queue.push({
          type: "failure",
          failure: adapterFailure.protocolViolation(
            "Invalid chat envelope.",
            false,
            {
              diagnostics: {
                failure_stage: "envelope_parsing",
                scope: "provider",
                http_status: 200,
              },
            },
          ),
          isolation: "runtime_read_only",
        });
      },
    });
    const fallback = fakeAdapterReturning(passResult("Recovered coverage."));
    const completion = await runReviewRound(
      roundInput({
        adapters: { first, fallback },
        config: {
          reviewers: [
            {
              id: "security::primary",
              agentId: "security",
              modelIndex: 0,
              modelCount: 2,
              policy: {
                passQuorum: 1,
                minimumProviderGroups: 1,
                adjudication: "off",
                gateMinimumSeverity: "medium",
                gateMinimumConfidence: "medium",
              },
            },
            {
              id: "security::fallback",
              agentId: "security",
              modelIndex: 1,
              modelCount: 2,
              previousReviewerId: "security::primary",
              policy: {
                passQuorum: 1,
                minimumProviderGroups: 1,
                adjudication: "off",
                gateMinimumSeverity: "medium",
                gateMinimumConfidence: "medium",
              },
            },
          ],
        },
      }),
    );

    expect(first.runCalls).toBe(1);
    expect(fallback.runCalls).toBe(1);
    expect(completion).toMatchObject({
      status: "passed",
      gateOutcome: "no_findings",
      coverageOutcome: "complete",
      exitCode: 0,
    });
  });

  it("uses a diverse pass quorum and skips redundant models", async () => {
    const first = fakeAdapterReturning(passResult("First pass."));
    const second = fakeAdapterReturning(passResult("Second pass."));
    const third = fakeAdapterReturning(passResult("Redundant."));
    const completion = await runReviewRound(
      roundInput({
        adapters: { first, second, third },
        config: {
          reviewers: [
            {
              agentId: "deployment",
              modelIndex: 0,
              modelCount: 3,
              providerGroup: "provider-a",
              policy: {
                passQuorum: 2,
                minimumProviderGroups: 2,
                adjudication: "required",
                gateMinimumSeverity: "medium",
                gateMinimumConfidence: "medium",
              },
            },
            {
              agentId: "deployment",
              modelIndex: 1,
              modelCount: 3,
              providerGroup: "provider-b",
              policy: {
                passQuorum: 2,
                minimumProviderGroups: 2,
                adjudication: "required",
                gateMinimumSeverity: "medium",
                gateMinimumConfidence: "medium",
              },
            },
            {
              agentId: "deployment",
              modelIndex: 2,
              modelCount: 3,
              providerGroup: "provider-c",
              policy: {
                passQuorum: 2,
                minimumProviderGroups: 2,
                adjudication: "required",
                gateMinimumSeverity: "medium",
                gateMinimumConfidence: "medium",
              },
            },
          ],
        },
      }),
    );

    expect([first.runCalls, second.runCalls, third.runCalls]).toEqual([
      1, 1, 0,
    ]);
    expect(completion.reviewers[2]).toMatchObject({
      status: "skipped",
      reason: "not_needed_after_quorum",
    });
  });

  it("keeps rotated-primary identities out of the compact public suite", async () => {
    const first = fakeAdapterReturning(passResult("First."));
    const second = fakeAdapterReturning(passResult("Second."));
    const third = fakeAdapterReturning(passResult("Third."));
    const events: PublicEvent[] = [];
    await runReviewRound(
      roundInput({
        adapters: { first, second, third },
        onEvent: (event) => events.push(event),
        config: {
          execution: { distribute_primaries: true },
          reviewers: [
            {
              id: "security::b",
              agentId: "security",
              modelIndex: 0,
              configuredModelIndex: 1,
              modelCount: 3,
            },
            {
              id: "security::c",
              agentId: "security",
              modelIndex: 1,
              configuredModelIndex: 2,
              modelCount: 3,
              previousReviewerId: "security::b",
            },
            {
              id: "security::a",
              agentId: "security",
              modelIndex: 2,
              configuredModelIndex: 0,
              modelCount: 3,
              previousReviewerId: "security::c",
            },
          ],
        },
      }),
    );

    expect(
      events.find((event) => event.event === "suite.resolved"),
    ).toMatchObject({
      data: {
        execution: { distribute_primaries: true },
        lenses: [
          {
            id: "security",
            model_runs: 3,
          },
        ],
      },
    });
    const suite = events.find((event) => event.event === "suite.resolved");
    expect(JSON.stringify(suite)).not.toMatch(
      /security::a|security::b|security::c|execution_order/u,
    );
  });

  it("enforces the configured provider concurrency independently of suite concurrency", async () => {
    let active = 0;
    let peak = 0;
    const serialized = () =>
      new FakeAdapter({
        onRun: async (queue) => {
          active += 1;
          peak = Math.max(peak, active);
          await new Promise((resolve) => setTimeout(resolve, 15));
          queue.push({
            type: "result",
            result: passResult(),
            isolation: "enforced_read_only",
          });
          active -= 1;
        },
      });
    const first = serialized();
    const second = serialized();
    const third = serialized();

    const completion = await runReviewRound(
      roundInput({
        adapters: { first, second, third },
        config: {
          execution: {
            max_concurrency: 3,
            default_provider_concurrency: 3,
            provider_limits: { shared: 1 },
          },
          reviewers: [
            { providerGroup: "shared" },
            { providerGroup: "shared" },
            { providerGroup: "shared" },
          ],
        },
      }),
    );

    expect(peak).toBe(1);
    expect([first.runCalls, second.runCalls, third.runCalls]).toEqual([
      1, 1, 1,
    ]);
    expect(completion.status).toBe("passed");
  });

  it("opens a provider circuit only for provider-health failures and suppresses later queued calls", async () => {
    const failing = new FakeAdapter({
      onRun: (queue) => {
        queue.push({
          type: "failure",
          failure: adapterFailure.timeout(
            "Provider request timed out.",
            false,
            {
              circuit_qualifying: true,
              fallback_eligible: true,
              diagnostics: { scope: "provider" },
            },
          ),
          isolation: "runtime_read_only",
        });
      },
    });
    const suppressed = fakeAdapterReturning(passResult());

    const completion = await runReviewRound(
      roundInput({
        adapters: { failing, suppressed },
        config: {
          execution: {
            max_concurrency: 1,
            circuit_breaker_threshold: 1,
            retry_attempts: 1,
          },
          reviewers: [
            { agentId: "first-lens", providerGroup: "shared" },
            { agentId: "second-lens", providerGroup: "shared" },
          ],
        },
      }),
    );

    expect(failing.runCalls).toBe(1);
    expect(suppressed.probeCalls).toHaveLength(0);
    expect(suppressed.runCalls).toBe(0);
    expect(completion.reviewers[1]).toMatchObject({
      status: "skipped",
      reason: "circuit_open",
    });
    expect(completion.coverageOutcome).toBe("partial");
  });

  it("does not open a provider circuit for fallback-eligible invalid output", async () => {
    const malformed = new FakeAdapter({
      onRun: (queue) => {
        queue.push({
          type: "failure",
          failure: {
            reason: "invalid_result",
            message: "The model output was truncated.",
            retryable: false,
            fallback_eligible: true,
            circuit_qualifying: false,
          },
          isolation: "enforced_read_only",
        });
      },
    });
    const healthy = fakeAdapterReturning(passResult());
    const completion = await runReviewRound(
      roundInput({
        adapters: { malformed, healthy },
        config: {
          execution: {
            max_concurrency: 1,
            circuit_breaker_threshold: 1,
            retry_attempts: 1,
          },
          reviewers: [
            { agentId: "first-lens", providerGroup: "shared" },
            { agentId: "second-lens", providerGroup: "shared" },
          ],
        },
      }),
    );

    expect(malformed.runCalls).toBe(1);
    expect(healthy.runCalls).toBe(1);
    expect(completion.reviewers[1]).toMatchObject({ status: "completed" });
  });

  it("admits one half-open recovery call after cooldown and resets on success", async () => {
    let nowMs = 0;
    const failing = new FakeAdapter({
      onRun: (queue) => {
        queue.push({
          type: "failure",
          failure: {
            reason: "timeout",
            message: "Provider timed out.",
            retryable: false,
            fallback_eligible: true,
            circuit_qualifying: true,
          },
          isolation: "enforced_read_only",
        });
      },
    });
    const recovery = fakeAdapterReturning(passResult());
    const afterReset = fakeAdapterReturning(passResult());
    const completionPromise = runReviewRound(
      roundInput({
        adapters: { failing, recovery, afterReset },
        clock: {
          now: () => new Date((nowMs += 10)),
          setTimeout: globalThis.setTimeout.bind(globalThis),
          clearTimeout: globalThis.clearTimeout.bind(globalThis),
          setInterval: globalThis.setInterval.bind(globalThis),
          clearInterval: globalThis.clearInterval.bind(globalThis),
        },
        config: {
          execution: {
            max_concurrency: 1,
            circuit_breaker_threshold: 1,
            circuit_breaker_cooldown_ms: 1,
            retry_attempts: 1,
          },
          reviewers: [
            { agentId: "first", providerGroup: "shared" },
            { agentId: "second", providerGroup: "shared" },
            { agentId: "third", providerGroup: "shared" },
          ],
        },
      }),
    );
    const completion = await completionPromise;

    expect(recovery.runCalls).toBe(1);
    expect(afterReset.runCalls).toBe(1);
    expect(completion.reviewers.slice(1)).toEqual([
      expect.objectContaining({ status: "completed" }),
      expect.objectContaining({ status: "completed" }),
    ]);
  });

  it("runs only trusted retry lens ids and reports the omitted lenses separately", async () => {
    const selected = fakeAdapterReturning(passResult());
    const omitted = fakeAdapterReturning(passResult());
    const events: PublicEvent[] = [];

    const completion = await runReviewRound(
      roundInput({
        adapters: { selected, omitted },
        onlyLensIds: ["selected-lens"],
        onEvent: (event) => events.push(event),
        config: {
          reviewers: [
            { agentId: "selected-lens" },
            { agentId: "omitted-lens" },
          ],
        },
      }),
    );

    expect(selected.runCalls).toBe(1);
    expect(omitted.probeCalls).toHaveLength(0);
    expect(omitted.runCalls).toBe(0);
    expect(completion.coverageOutcome).toBe("complete");
    expect(completion.reviewers[1]).toMatchObject({
      status: "skipped",
      reason: "not_selected_for_retry",
    });
    const terminal = events.at(-1);
    expect(terminal?.event).toBe("run.completed");
    if (terminal?.event === "run.completed") {
      expect(terminal.data.logical_lenses).toMatchObject({
        total: 2,
        passed: 1,
        not_selected: 1,
        incomplete: 0,
      });
    }
  });

  it("marks irrelevant and missing-input lenses without provider calls", async () => {
    const irrelevant = fakeAdapterReturning(passResult());
    const missing = fakeAdapterReturning(passResult());
    const completion = await runReviewRound(
      roundInput({
        adapters: { irrelevant, missing },
        context: resolvedContext({
          caller_context: {},
          git: {
            is_repository: true,
            root: "F:\\Projects\\demo",
            branch: "feature",
            head: "abc",
            merge_base: "def",
            status_entries: [],
            changed_files: ["src/service.ts"],
            diff_stat: "1 file changed",
            diff: "diff",
            truncated: {
              status_entries: false,
              changed_files: false,
              diff_stat: false,
              diff: false,
            },
          },
        }),
        config: {
          reviewers: [
            {
              agentId: "deployment",
              policy: {
                applicability: { anyChangedPaths: ["deploy/**"] },
                passQuorum: 1,
                minimumProviderGroups: 1,
                adjudication: "required",
                gateMinimumSeverity: "medium",
                gateMinimumConfidence: "medium",
              },
            },
            {
              agentId: "readiness",
              policy: {
                requiredCallerContext: ["/pull_request/number"],
                passQuorum: 1,
                minimumProviderGroups: 1,
                adjudication: "required",
                gateMinimumSeverity: "medium",
                gateMinimumConfidence: "medium",
              },
            },
          ],
        },
      }),
    );

    expect(irrelevant.runCalls).toBe(0);
    expect(missing.runCalls).toBe(0);
    expect(completion.coverageOutcome).toBe("partial");
    expect(completion.reviewers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reason: "not_applicable" }),
        expect.objectContaining({ reason: "not_evaluated_missing_input" }),
      ]),
    );
  });

  it("does not declare not-applicable from a truncated changed-file list", async () => {
    const reviewer = fakeAdapterReturning(passResult());
    const completion = await runReviewRound(
      roundInput({
        adapters: { reviewer },
        context: resolvedContext({
          git: {
            is_repository: true,
            root: "F:\\Projects\\demo",
            branch: "feature",
            head: "abc",
            merge_base: "def",
            status_entries: [],
            changed_files: ["src/service.ts"],
            diff_stat: "truncated",
            diff: "diff",
            truncated: {
              status_entries: false,
              changed_files: true,
              diff_stat: false,
              diff: false,
            },
          },
        }),
        config: {
          reviewers: [
            {
              policy: {
                applicability: { anyChangedPaths: ["deploy/**"] },
                passQuorum: 1,
                minimumProviderGroups: 1,
                adjudication: "off",
                gateMinimumSeverity: "medium",
                gateMinimumConfidence: "medium",
              },
            },
          ],
        },
      }),
    );
    expect(reviewer.runCalls).toBe(1);
    expect(completion.status).toBe("passed");
  });

  it("emits compact context, one aggregate heartbeat, and compact completion", async () => {
    const reviewer = fakeAdapterReturning(passResult(), 60);
    const events: PublicEvent[] = [];
    const input = roundInput({
      adapters: { reviewer },
      onEvent: (event) => events.push(event),
      config: { execution: { heartbeat_interval_ms: 20 } },
    });
    const completion = await runReviewRound(input);
    expect(completion.status).toBe("passed");
    const context = events.find((event) => event.event === "context.resolved");
    expect(JSON.stringify(context)).not.toContain('"diff"');
    expect(
      events.filter((event) => event.event === "reviewer.heartbeat"),
    ).toHaveLength(0);
    expect(
      events.filter((event) => event.event === "suite.heartbeat").length,
    ).toBeGreaterThan(0);
    const terminal = events.at(-1);
    expect(terminal?.event).toBe("run.completed");
    if (terminal?.event === "run.completed") {
      expect(terminal.data).toMatchObject({
        gate_outcome: "no_findings",
        coverage_outcome: "complete",
        logical_lenses: { total: 1, passed: 1 },
      });
    }
  });

  it("lets a focused diverse adjudicator reject a source finding", async () => {
    const source = fakeAdapterReturning(failResult("candidate"));
    const adjudicator = fakeAdapterReturning({
      schema_version: "1",
      kind: "review-mesh.adjudication-result",
      verdict: "pass",
      review_markdown: "# Adjudication\n\nCandidate rejected.",
      summary: "Candidate rejected.",
      actionable_findings: [],
      decisions: [
        {
          source_finding_id: "candidate",
          decision: "rejected",
          rationale: "The cited code does not exhibit the reported defect.",
          cited_evidence: [
            { detail: "The candidate evidence contradicts the conclusion." },
          ],
          unverified_assumptions: [],
        },
      ],
      informational_notes: [],
    });
    const completion = await runReviewRound(
      roundInput({
        adapters: { source, adjudicator },
        config: {
          reviewers: [
            {
              agentId: "security",
              modelIndex: 0,
              modelCount: 2,
              providerGroup: "provider-a",
              policy: {
                passQuorum: 2,
                minimumProviderGroups: 2,
                adjudication: "required",
                gateMinimumSeverity: "medium",
                gateMinimumConfidence: "medium",
              },
            },
            {
              agentId: "security",
              modelIndex: 1,
              modelCount: 2,
              providerGroup: "provider-b",
              policy: {
                passQuorum: 2,
                minimumProviderGroups: 2,
                adjudication: "required",
                gateMinimumSeverity: "medium",
                gateMinimumConfidence: "medium",
              },
            },
          ],
        },
      }),
    );

    expect(adjudicator.inputs[0]?.reviewer.policy?.mode).toBe("adjudication");
    expect(adjudicator.inputs[0]?.prompt.user).toContain(
      "ADJUDICATION CANDIDATE FINDINGS (UNTRUSTED DATA)",
    );
    expect(completion).toMatchObject({
      gateOutcome: "no_findings",
      coverageOutcome: "complete",
      exitCode: 0,
    });
  });

  it("persists a digest-bound core adjudication validation attestation", async () => {
    const source = fakeAdapterReturning(failResult("candidate"));
    const adjudicator = fakeAdapterReturning({
      schema_version: "1",
      kind: "review-mesh.adjudication-result",
      verdict: "pass",
      review_markdown: "# Adjudication\n\nCandidate rejected.",
      summary: "Candidate rejected.",
      actionable_findings: [],
      decisions: [
        {
          source_finding_id: "candidate",
          decision: "rejected",
          rationale: "Rejected.",
          cited_evidence: [],
          unverified_assumptions: [],
        },
      ],
      informational_notes: [],
    });
    const records: Array<Record<string, unknown>> = [];
    const input = roundInput({
      adapters: { source, adjudicator },
      writer: {
        emit: async () => ({}) as never,
        emitFinal: async () => ({}) as never,
        record: async (record: Record<string, unknown>) => {
          records.push(record);
        },
        close: async () => undefined,
      },
      config: {
        reviewers: [
          {
            agentId: "security",
            modelIndex: 0,
            modelCount: 2,
            providerGroup: "provider-a",
            policy: {
              passQuorum: 2,
              minimumProviderGroups: 2,
              adjudication: "required",
              gateMinimumSeverity: "medium",
              gateMinimumConfidence: "medium",
            },
          },
          {
            agentId: "security",
            modelIndex: 1,
            modelCount: 2,
            providerGroup: "provider-b",
            policy: {
              passQuorum: 2,
              minimumProviderGroups: 2,
              adjudication: "required",
              gateMinimumSeverity: "medium",
              gateMinimumConfidence: "medium",
            },
          },
        ],
      },
    });

    await runReviewRound(input);

    expect(
      records.find(
        (record) =>
          record.record === "reviewer.result" &&
          record.mode === "adjudication",
      ),
    ).toMatchObject({
      adjudication_validation: {
        candidate_digest: expect.stringMatching(/^[a-f0-9]{64}$/u),
        adjudication_digest: expect.stringMatching(/^[a-f0-9]{64}$/u),
        verification_digest: expect.stringMatching(/^[a-f0-9]{64}$/u),
        attestation_digest: expect.stringMatching(/^[a-f0-9]{64}$/u),
        outcome: { decisions: [expect.objectContaining({ source_finding_id: "candidate" })] },
      },
    });
  });

  it("marks required findings as partial when no adjudicator can complete", async () => {
    const source = fakeAdapterReturning(failResult("candidate"));
    const unavailable = new FakeAdapter({
      capabilities: {
        available: false,
        authenticated: true,
        model_available: false,
        streaming: false,
        cancellation: true,
        maximumIsolation: "runtime_read_only",
      },
    });
    const completion = await runReviewRound(
      roundInput({
        adapters: { source, unavailable },
        config: {
          reviewers: [
            {
              agentId: "security",
              modelIndex: 0,
              modelCount: 2,
              providerGroup: "provider-a",
              policy: {
                passQuorum: 2,
                minimumProviderGroups: 2,
                adjudication: "required",
                gateMinimumSeverity: "medium",
                gateMinimumConfidence: "medium",
              },
            },
            {
              agentId: "security",
              modelIndex: 1,
              modelCount: 2,
              providerGroup: "provider-b",
              policy: {
                passQuorum: 2,
                minimumProviderGroups: 2,
                adjudication: "required",
                gateMinimumSeverity: "medium",
                gateMinimumConfidence: "medium",
              },
            },
          ],
        },
      }),
    );
    expect(completion).toMatchObject({
      gateOutcome: "findings",
      coverageOutcome: "partial",
      exitCode: 3,
    });
  });

  it("does not treat a same-provider fallback as an independent adjudicator", async () => {
    const source = fakeAdapterReturning(failResult("candidate"));
    const sameProvider = fakeAdapterReturning(passResult("Not independent."));
    const completion = await runReviewRound(
      roundInput({
        adapters: { source, sameProvider },
        config: {
          reviewers: [
            {
              agentId: "security",
              modelIndex: 0,
              modelCount: 2,
              providerGroup: "provider-a",
              policy: {
                passQuorum: 2,
                minimumProviderGroups: 2,
                adjudication: "required",
                gateMinimumSeverity: "medium",
                gateMinimumConfidence: "medium",
              },
            },
            {
              agentId: "security",
              modelIndex: 1,
              modelCount: 2,
              providerGroup: "provider-a",
              policy: {
                passQuorum: 2,
                minimumProviderGroups: 2,
                adjudication: "required",
                gateMinimumSeverity: "medium",
                gateMinimumConfidence: "medium",
              },
            },
          ],
        },
      }),
    );

    expect(sameProvider.runCalls).toBe(0);
    expect(completion).toMatchObject({
      gateOutcome: "findings",
      coverageOutcome: "partial",
      exitCode: 3,
    });
  });
});
