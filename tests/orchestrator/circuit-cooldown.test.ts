import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { runV9Review } from "../../src/orchestrator/run-v9.js";
import { AdapterRegistry } from "../../src/adapters/registry.js";
import { roundInput, resolvedContext } from "../helpers/fixtures.js";
import type { ReviewAdapter } from "../../src/adapters/types.js";

async function runFixture(
  runAdapter: ReviewAdapter["run"],
  signal = new AbortController().signal,
  deadline = 5000,
  concurrency = 1,
  lensDeadlines: Record<string, number> = {},
) {
  const root = await mkdtemp(join(tmpdir(), "mesh-cooldown-"));
  const base = roundInput();
  Object.assign(base.config.execution, {
    deadline_mode: "fixed",
    run_deadline_ms: deadline,
    max_concurrency: concurrency,
    default_provider_concurrency: concurrency,
    retry_attempts: 1,
    circuit_breaker_threshold: 1,
    circuit_breaker_cooldown_ms: 150,
  });
  base.config.reviewers = ["first", "second", "third", "other"].map((id) => ({
    ...base.config.reviewers[0]!,
    id,
    agentId: id,
    providerGroup: id === "other" ? "other" : "shared",
    timeoutMs: 5000,
    policy: {
      ...(lensDeadlines[id] === undefined
        ? {}
        : { lensDeadlineMs: lensDeadlines[id] }),
      applicability: { mode: "always" },
      requiredCallerContext: [],
      passQuorum: 1,
      minimumProviderGroups: 1,
      adjudication: "off",
      gateMinimumSeverity: "medium",
      gateMinimumConfidence: "medium",
      changeCoverage: {
        relevantPaths: ["**"],
        minimumInspection: "diff",
        proof: "observed",
      },
    },
  }));
  let firstStarted!: () => void;
  const first = new Promise<void>((resolve) => {
    firstStarted = resolve;
  });
  const registry = new AdapterRegistry();
  registry.register("command", () => ({
    id: "fixture",
    probe: async (reviewer) => {
      if (reviewer.id !== "first") await first;
      if (reviewer.id !== "first")
        await new Promise((resolve) => setTimeout(resolve, 10));
      return {
        available: true,
        authenticated: true,
        model_available: true,
        streaming: false,
        cancellation: true,
        maximumIsolation: "runtime_read_only" as const,
        observed_file_access: true,
      };
    },
    async *run(input) {
      if (input.reviewer.id === "first") firstStarted();
      yield* runAdapter(input);
    },
  }));
  const events: any[] = [],
    records: any[] = [];
  try {
    const result = await runV9Review({
      runId: "cooldown",
      config: base.config,
      context: resolvedContext({
        workspace: root,
        review_scope: { mode: "full", source: "request" },
      }),
      registry,
      signal,
      writer: {
        emit: async (e) => {
          events.push(e);
        },
        finish: async () => ({
          path: "/artifact",
          sha256: "a".repeat(64),
          byte_count: 1,
          completed_results: 0,
        }),
        outputFailed: () => false,
        close: async () => {},
      },
      record: async (r) => {
        records.push(r);
      },
      recordResult: async () => {},
    });
    return { result, events, records };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
const pass = {
  type: "result" as const,
  isolation: "runtime_read_only" as const,
  result: {
    schema_version: "4" as const,
    verdict: "pass" as const,
    summary: "Done",
    review_markdown: "",
    actionable_findings: [],
    informational_notes: [],
  },
};

it("waits for one half-open probe without holding an execution slot or inventing a failed attempt", async () => {
  const starts: Array<{ id: string; at: number }> = [];
  let failedAt = 0,
    probeComplete = 0;
  const { result, events, records } = await runFixture(async function* (input) {
    starts.push({ id: input.reviewer.id, at: Date.now() });
    if (input.reviewer.id === "first") {
      failedAt = Date.now();
      yield {
        type: "failure",
        failure: {
          reason: "provider_timeout",
          message: "Provider timeout",
          retryable: false,
          fallback_eligible: true,
          circuit_qualifying: true,
          diagnostics: { failure_code: "gateway_timeout", scope: "provider" },
        },
      };
      return;
    }
    if (input.reviewer.id === "second") {
      await new Promise((resolve) => setTimeout(resolve, 30));
      probeComplete = Date.now();
    }
    if (input.reviewer.id === "third")
      expect(Date.now()).toBeGreaterThanOrEqual(probeComplete);
    yield pass;
  });
  expect(starts.slice(0, 2).map((x) => x.id)).toEqual(["first", "other"]);
  expect(
    starts
      .slice(2)
      .map((x) => x.id)
      .sort(),
  ).toEqual(["second", "third"]);
  expect(starts[2]!.at - failedAt).toBeGreaterThanOrEqual(140);
  expect(result.jobs.filter((job) => job.status === "completed")).toHaveLength(
    3,
  );
  expect(records.filter((r) => r.record === "reviewer.attempt")).toHaveLength(
    4,
  );
  expect(
    records.filter((r) => r.record === "reviewer.attempt" && r.data.failure),
  ).toHaveLength(1);
  expect(
    events.some(
      (e) =>
        e.event === "reviewer.progress" &&
        e.data.queue_reason === "circuit_cooldown" &&
        e.data.retry_at &&
        e.data.circuit_cause,
    ),
  ).toBe(true);
});

it("aborts cooldown waits promptly without starting another provider request", async () => {
  const abort = new AbortController();
  const starts: string[] = [];
  const { result } = await runFixture(async function* (input) {
    starts.push(input.reviewer.id);
    if (input.reviewer.id === "first") {
      setTimeout(() => abort.abort(), 25);
      yield {
        type: "failure",
        failure: {
          reason: "provider_timeout",
          message: "Provider timeout",
          retryable: false,
          circuit_qualifying: true,
        },
      };
      return;
    }
    yield pass;
  }, abort.signal);
  expect(starts).not.toContain("second");
  expect(starts).not.toContain("third");
  expect(result.runOutcome).toBe("cancelled");
});

it("admits only one half-open request even when shared provider capacity permits several", async () => {
  let activeShared = 0,
    maximumHalfOpen = 0,
    healed = false;
  const { result } = await runFixture(
    async function* (input) {
      if (input.reviewer.id === "first") {
        yield {
          type: "failure",
          failure: {
            reason: "provider_timeout",
            message: "Outage",
            retryable: false,
            circuit_qualifying: true,
          },
        };
        return;
      }
      if (input.reviewer.id !== "other") {
        activeShared++;
        if (!healed) maximumHalfOpen = Math.max(maximumHalfOpen, activeShared);
        await new Promise((resolve) => setTimeout(resolve, 30));
        healed = true;
        activeShared--;
      }
      yield pass;
    },
    new AbortController().signal,
    5000,
    3,
  );
  expect(maximumHalfOpen).toBe(1);
  expect(result.jobs.filter((job) => job.status === "completed")).toHaveLength(
    3,
  );
});

it("releases a half-open reservation that expires in the global queue without declaring the provider healthy", async () => {
  const starts: string[] = [];
  const { result, events, records } = await runFixture(
    async function* (input) {
      starts.push(input.reviewer.id);
      if (input.reviewer.id === "first") {
        yield {
          type: "failure",
          failure: {
            reason: "provider_timeout",
            message: "Outage",
            retryable: false,
            circuit_qualifying: true,
            diagnostics: { failure_code: "gateway_timeout", scope: "provider" },
          },
        };
        return;
      }
      if (input.reviewer.id === "other")
        await new Promise((resolve) => setTimeout(resolve, 300));
      yield pass;
    },
    new AbortController().signal,
    5000,
    1,
    { second: 220 },
  );
  expect(starts).not.toContain("second");
  expect(starts).toContain("third");
  const second = result.jobs.find((job) => job.reviewer.id === "second")!;
  expect(second.reason).toBe("queue_deadline_exceeded");
  expect(
    events
      .filter(
        (e) =>
          e.reviewer_id === "third" &&
          e.data?.queue_reason === "circuit_cooldown",
      )
      .every((e) => e.data.circuit_cause.reviewer_id === "first"),
  ).toBe(true);
  expect(
    records.filter(
      (r) =>
        r.record === "reviewer.attempt" &&
        r.data.failure?.circuit_qualifying === true,
    ),
  ).toHaveLength(1);
});

it("keeps an admitted local half-open failure from declaring the provider healthy", async () => {
  const sharedStarts: string[] = [];
  let failedLocal = false;
  const { result, events } = await runFixture(
    async function* (input) {
      if (input.reviewer.id === "first") {
        yield {
          type: "failure",
          failure: {
            reason: "provider_timeout",
            message: "Outage",
            retryable: false,
            circuit_qualifying: true,
            diagnostics: { failure_code: "gateway_timeout" },
          },
        };
        return;
      }
      if (input.reviewer.id !== "other") {
        sharedStarts.push(input.reviewer.id);
        if (!failedLocal) {
          failedLocal = true;
          yield {
            type: "failure",
            failure: {
              reason: "change_coverage_incomplete",
              message: "Local request budget cannot fit",
              retryable: false,
              circuit_qualifying: false,
            },
          };
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      yield pass;
    },
    new AbortController().signal,
    5000,
    3,
  );
  expect(sharedStarts).toHaveLength(2);
  expect(result.jobs.filter((job) => job.status === "completed")).toHaveLength(
    2,
  );
  const cooldowns = events.filter(
    (e) => e.data?.queue_reason === "circuit_cooldown",
  );
  expect(
    cooldowns.every((e) => e.data.circuit_cause.reviewer_id === "first"),
  ).toBe(true);
});
