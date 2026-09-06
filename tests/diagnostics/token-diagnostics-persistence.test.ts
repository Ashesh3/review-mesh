import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import {
  createManagedRunArtifact,
  readRunArtifact,
} from "../../src/diagnostics/run-artifact.js";
import { sanitizeRunMetadata } from "../../src/results/sanitize.js";
import { sanitizeDashboardValue } from "../../src/diagnostics/dashboard-projection.js";
import { readNormalizedRun } from "../../src/diagnostics/normalize-run.js";
import {
  v9Status,
  v9Report,
  v9DashboardRun,
} from "../../src/diagnostics/v9-views.js";
import { createOpenAICompatibleAdapter } from "../../src/adapters/openai-compatible.js";
import { createChangeCoverageLedger } from "../../src/context/change-coverage.js";
import { resolvedContext, resolvedReviewer } from "../helpers/fixtures.js";
import { reviewerResultJsonSchema } from "../../src/protocol/json-schema.js";
import { writeFile, mkdir } from "node:fs/promises";
import {
  readDashboardRun,
  readDashboardReviewer,
} from "../../src/server/dashboard-data.js";

const budget = {
  budget_source: "conservative_default",
  token_estimation: "utf8_upper_bound",
  input_budget_tokens: 113408,
  output_reserve_tokens: 8192,
  estimated_input_tokens: 24500,
  context_window_tokens: 128000,
  input_tokens: 150000,
  limit_tokens: 128000,
  segment_index: 0,
};

it("persists an actual segmented HTTP failure as an ordinary incomplete attempt", async () => {
  const root = await mkdtemp(join(tmpdir(), "mesh-segment-http-persist-"));
  const workspace = join(root, "source");
  await mkdir(workspace);
  await writeFile(join(workspace, "worker.ts"), "x".repeat(100_000));
  const context = resolvedContext({
    workspace,
    git: {
      is_repository: true,
      root: workspace,
      branch: "main",
      head: "a".repeat(40),
      merge_base: "b".repeat(40),
      status_entries: [],
      changed_files: ["worker.ts"],
      changed_paths: [{ path: "worker.ts", kind: "untracked" }],
      diff: "",
      diff_stat: "",
      truncated: {
        status_entries: false,
        changed_files: false,
        diff_stat: false,
        diff: false,
      },
    },
  });
  const ledger = await createChangeCoverageLedger({
    context,
    policy: {
      relevantPaths: ["**"],
      minimumInspection: "full_file",
      proof: "observed",
    },
  });
  const writer = await createManagedRunArtifact({
    runsDirectory: root,
    runId: "segmented-http",
    toolVersion: "9.5.0",
    publishManaged: false,
  });
  const registration = {
    type: "openai_compatible" as const,
    base_url_env: "URL",
    api_key_env: "KEY",
    context_window_tokens: 32768,
  };
  let requests = 0;
  const adapter = createOpenAICompatibleAdapter(registration, {
    environment: { URL: "https://no-network.invalid/v1", KEY: "synthetic" },
    fetch: async () => {
      requests++;
      return new Response(
        JSON.stringify({ error: { message: "Synthetic upstream failure" } }),
        { status: 500, headers: { "content-type": "application/json" } },
      );
    },
  });
  try {
    let failure;
    for await (const event of adapter.run({
      runId: "segmented-http",
      reviewer: resolvedReviewer({ adapter: registration }),
      context,
      coverage: ledger,
      prompt: { system: "Synthetic", user: "Synthetic", combined: "Synthetic" },
      resultJsonSchema: reviewerResultJsonSchema,
      isolationPolicy: "prefer_enforced",
      signal: new AbortController().signal,
    }))
      if (event.type === "failure") failure = event.failure;
    expect(requests).toBe(1);
    expect(failure).toMatchObject({
      reason: "adapter_unavailable",
      diagnostics: {
        http_status: 500,
        operation_phase: "evidence",
        input_budget_tokens: expect.any(Number),
        token_estimation: "utf8_upper_bound",
      },
    });
    await expect(
      writer.record({
        record: "reviewer.attempt",
        reviewer_id: "synthetic",
        data: {
          attempt: 1,
          started_at: "2026-09-06T00:00:00Z",
          ended_at: "2026-09-06T00:00:01Z",
          elapsed_ms: 1000,
          failure,
        },
      }),
    ).resolves.toBeUndefined();
    const artifact = await readRunArtifact(
      join(root, "segmented-http.jsonl.active"),
      { allowActive: true },
    );
    expect(
      (
        artifact.records.find((record) => record.record === "reviewer.attempt")
          ?.data as any
      ).failure.diagnostics.http_status,
    ).toBe(500);
  } finally {
    await ledger.close();
    await writer.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("persists typed token diagnostics in managed attempt and segment records", async () => {
  const root = await mkdtemp(join(tmpdir(), "mesh-token-diagnostics-"));
  const writer = await createManagedRunArtifact({
    runsDirectory: root,
    runId: "token-diagnostics",
    toolVersion: "9.5.0",
    publishManaged: false,
  });
  try {
    await expect(
      writer.record({
        record: "reviewer.attempt",
        reviewer_id: "synthetic",
        data: {
          attempt: 1,
          started_at: "2026-09-06T00:00:00Z",
          ended_at: "2026-09-06T00:00:01Z",
          elapsed_ms: 1000,
          failure: {
            reason: "adapter_unavailable",
            message: "Synthetic HTTP failure.",
            retryable: true,
            fallback_eligible: true,
            circuit_qualifying: true,
            diagnostics: {
              ...budget,
              http_status: 500,
              failure_stage: "http_response",
              scope: "provider",
              failure_code: "provider_unavailable",
            },
          },
        },
      }),
    ).resolves.toBeUndefined();
    await expect(
      writer.record({
        record: "reviewer.segment",
        reviewer_id: "synthetic",
        data: {
          attempt: 1,
          segment_id: "segment-0",
          index: 0,
          phase: "evidence",
          data: {
            provenance: "model_reasoning",
            runtime_validation: "not_executed",
            summary: "Synthetic reasoning.",
            findings: [],
            unresolved_questions: [],
            scenario_checks: [
              {
                path: "source.ts",
                start_line: 1,
                end_line: 1,
                input: 0,
                expected: 0,
                observed: 0,
                reasoning: "Synthetic input remains zero.",
              },
            ],
            source_ranges: [
              {
                kind: "snapshot",
                path: "source.ts",
                offset: 0,
                byte_count: 5,
                sha256: "a".repeat(64),
                snapshot_digest: "a".repeat(64),
              },
            ],
            budget,
          },
        },
      }),
    ).resolves.toBeUndefined();
    const artifact = await readRunArtifact(
      join(root, "token-diagnostics.jsonl.active"),
      { allowActive: true },
    );
    const attempt = artifact.records.find(
      (record) => record.record === "reviewer.attempt",
    ) as any;
    const segment = artifact.records.find(
      (record) => record.record === "reviewer.segment",
    ) as any;
    expect(attempt.data.failure.diagnostics).toMatchObject(budget);
    expect(segment.data.data.budget).toEqual(budget);
    await writer.record({
      record: "reviewer.terminal",
      reviewer_id: "synthetic",
      data: {
        lens_id: "synthetic",
        status: "incomplete",
        reason: "adapter_unavailable",
      },
    });
    const normalized = await readNormalizedRun(
      join(root, "token-diagnostics.jsonl.active"),
      { allowActive: true },
    );
    for (const details of [false, true]) {
      const selected = v9Status(normalized, "synthetic", details) as any;
      expect(selected.latest_failure.diagnostics).toMatchObject(budget);
    }
    expect(
      (v9Status(normalized, undefined, true) as any).attempts[0].data.failure
        .diagnostics,
    ).toMatchObject(budget);
    expect(
      (v9Report(normalized).attempts[0]!.data as any).failure.diagnostics,
    ).toMatchObject(budget);
    expect(
      (v9DashboardRun(normalized).attempts[0]!.data as any).failure.diagnostics,
    ).toMatchObject(budget);
    const appPaths = {
      configFile: join(root, "config.toml"),
      reviewersDirectory: join(root, "reviewers"),
      runsDirectory: root,
    };
    const dashboard = (await readDashboardRun({
      appPaths,
      runId: "token-diagnostics",
    })) as any;
    expect(dashboard.attempts[0].data.failure.diagnostics).toMatchObject(
      budget,
    );
    const dashboardReviewer = (await readDashboardReviewer({
      appPaths,
      runId: "token-diagnostics",
      reviewerId: "synthetic",
    })) as any;
    expect(dashboardReviewer.attempts[0].failure.diagnostics).toMatchObject(
      budget,
    );
  } finally {
    await writer.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("allows only valid typed token telemetry and still redacts credentials", () => {
  expect(
    sanitizeRunMetadata({
      ...budget,
      api_token: "private-api-token",
      access_token: 42,
      nested: { auth_token: "private-nested-token" },
    }),
  ).toEqual({
    ...budget,
    api_token: "[redacted]",
    access_token: "[redacted]",
    nested: { auth_token: "[redacted]" },
  });
  const invalid = {
    input_tokens: "private-token",
    limit_tokens: -1,
    input_budget_tokens: { value: "private-token" },
    output_reserve_tokens: Infinity,
    estimated_input_tokens: 1.5,
    context_window_tokens: Number.MAX_SAFE_INTEGER + 1,
    token_estimation: "private-estimator",
  };
  expect(sanitizeRunMetadata(invalid)).toEqual(
    Object.fromEntries(Object.keys(invalid).map((key) => [key, "[redacted]"])),
  );
  expect(sanitizeDashboardValue({ ...budget, ...invalid })).toEqual({
    ...budget,
    ...Object.fromEntries(
      Object.keys(invalid).map((key) => [key, "[redacted]"]),
    ),
  });
  expect(
    sanitizeDashboardValue({
      ...budget,
      access_token: 123,
      api_token: "secret",
      token_estimation: "utf8_upper_bound",
      context_window_tokens: 128000,
    }),
  ).toEqual({
    ...budget,
    access_token: "[redacted]",
    api_token: "[redacted]",
    token_estimation: "utf8_upper_bound",
    context_window_tokens: 128000,
  });
});
