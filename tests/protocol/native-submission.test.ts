import { afterEach, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type {
  ActionableFindingV4,
  AdjudicationResultV2,
} from "../../src/protocol/v9.js";
import { resolvedContext, resolvedReviewer } from "../helpers/fixtures.js";
import { validateNativeAdjudicationSubmission } from "../../src/protocol/native-submission.js";

const execute = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
const candidate: ActionableFindingV4 = {
  id: "candidate-1",
  severity: "medium",
  title: "Stale return",
  description: "The new branch returns the old value.",
  evidence: [
    {
      path: "source.ts",
      start_line: 1,
      end_line: 3,
      detail: "The branch returns the old value.",
    },
  ],
  suggested_direction: "Return the new value.",
  confidence: "high",
  classification: "confirmed_defect",
  external_assumptions: [],
  category: "correctness",
  verification: "Inspect the return expression.",
  change_impact: "New behavior returns old state.",
  claim: {
    trigger: "Value changes",
    affected_behavior: "Old value returned",
    outcome: "Caller sees stale state",
  },
};
async function fixture() {
  const workspace = await mkdtemp(join(tmpdir(), "mesh-native-proof-"));
  roots.push(workspace);
  const git = async (...args: string[]) =>
    (
      await execute("git", args, { cwd: workspace, windowsHide: true })
    ).stdout.trim();
  await git("init", "-q");
  await writeFile(
    join(workspace, "source.ts"),
    "function value() {\n  return newValue;\n}\n",
  );
  await git("add", "source.ts");
  await git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "--no-verify",
    "-qm",
    "base",
  );
  const base = await git("rev-parse", "HEAD");
  await writeFile(
    join(workspace, "source.ts"),
    "function value() {\n  return oldValue;\n}\n",
  );
  const diff = await git(
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "HEAD",
    "--",
    "source.ts",
  );
  const context = resolvedContext({
    workspace,
    review_scope: { mode: "changes", source: "request" },
    git: {
      is_repository: true,
      root: workspace,
      branch: "main",
      head: base,
      merge_base: base,
      changed_files: ["source.ts"],
      status_entries: [],
      diff_stat: "",
      diff,
      truncated: {
        status_entries: false,
        changed_files: false,
        diff_stat: false,
        diff: false,
      },
    },
  });
  const reviewer = resolvedReviewer({
    policy: {
      mode: "adjudication",
      candidateFindings: [candidate] as never,
      passQuorum: 1,
      minimumProviderGroups: 1,
      adjudication: "required",
      gateMinimumSeverity: "medium",
      gateMinimumConfidence: "medium",
    },
  });
  return { context, reviewer };
}
function result(): AdjudicationResultV2 {
  return {
    schema_version: "2",
    kind: "review-mesh.adjudication-result",
    verdict: "fail",
    review_markdown: "Candidate proof",
    summary: "Candidate checked",
    actionable_findings: [],
    informational_notes: [],
    decisions: [
      {
        source_finding_id: candidate.id,
        decision: "confirmed",
        rationale: "The return changed from newValue to oldValue.",
        cited_evidence: [
          {
            path: "source.ts",
            start_line: 2,
            end_line: 2,
            detail: "Returns oldValue",
          },
        ],
        base_head_comparison: {
          base: {
            behavior: "Returns newValue",
            citation: {
              path: "source.ts",
              start_line: 2,
              end_line: 2,
              detail: "Prior return",
            },
          },
          head: {
            behavior: "Returns oldValue",
            citation: {
              path: "source.ts",
              start_line: 2,
              end_line: 2,
              detail: "Changed return",
            },
          },
          impact: "Caller sees stale state",
        },
        unverified_assumptions: [],
      },
    ],
  };
}

it.each(["head", "base"] as const)(
  "rejects nonexistent %s line proof and accepts the corrected citation",
  async (side) => {
    const { reviewer, context } = await fixture();
    const value = result();
    value.decisions[0]!.base_head_comparison![side].citation.start_line = 99;
    value.decisions[0]!.base_head_comparison![side].citation.end_line = 99;
    const rejected = await validateNativeAdjudicationSubmission(
      reviewer,
      context,
      value,
      new AbortController().signal,
    );
    expect(rejected).toMatchObject({
      accepted: false,
      message: expect.stringContaining("candidate-1"),
    });
    expect(rejected).toMatchObject({
      message: expect.stringContaining("line_out_of_range"),
    });
    expect(rejected).toMatchObject({
      message: expect.stringContaining("base_head_context_required"),
    });
    expect(
      await validateNativeAdjudicationSubmission(
        reviewer,
        context,
        result(),
        new AbortController().signal,
      ),
    ).toEqual({ accepted: true });
  },
);

it("requires execution ordering for lifecycle claims and accepts inspected ordered proof", async () => {
  const { reviewer, context } = await fixture();
  reviewer.policy!.candidateFindings = [
    { ...candidate, category: "lifecycle" },
  ] as never;
  const value = result();
  expect(
    await validateNativeAdjudicationSubmission(
      reviewer,
      context,
      value,
      new AbortController().signal,
    ),
  ).toMatchObject({
    accepted: false,
    message: expect.stringContaining("ordered_execution_proof_required"),
  });
  value.decisions[0]!.ordered_execution_proof = {
    steps: [
      {
        order: 1,
        description: "Enter branch",
        citation: {
          path: "source.ts",
          start_line: 1,
          end_line: 1,
          detail: "Function entry",
        },
      },
      {
        order: 2,
        description: "Return old state",
        citation: {
          path: "source.ts",
          start_line: 2,
          end_line: 2,
          detail: "Return",
        },
      },
    ],
    failure_point: {
      step_order: 2,
      citation: {
        path: "source.ts",
        start_line: 2,
        end_line: 2,
        detail: "Stale return",
      },
      detail: "Wrong return value",
    },
  };
  expect(
    await validateNativeAdjudicationSubmission(
      reviewer,
      context,
      value,
      new AbortController().signal,
    ),
  ).toEqual({ accepted: true });
});

it.each(["HEAD", "f".repeat(40)])(
  "fails closed for unavailable immutable base %s",
  async (base) => {
    const { reviewer, context } = await fixture();
    if (context.git.is_repository) context.git.merge_base = base;
    const response = await validateNativeAdjudicationSubmission(
      reviewer,
      context,
      result(),
      new AbortController().signal,
    );
    expect(response).toMatchObject({
      accepted: false,
      message: expect.stringContaining("base_revision_unavailable"),
    });
    expect(JSON.stringify(response)).not.toContain(context.workspace);
  },
);

it("accepts an explicit unresolved adjustment without fabricating absent proof", async () => {
  const { reviewer, context } = await fixture();
  const value = result();
  const { id: _id, ...finding } = candidate;
  value.decisions[0]!.decision = "adjusted";
  value.decisions[0]!.adjusted_finding = {
    ...finding,
    classification: "needs_verification",
    external_assumptions: ["Prior behavior cannot be established."],
  };
  value.decisions[0]!.unverified_assumptions = [
    "Prior behavior cannot be established.",
  ];
  delete value.decisions[0]!.base_head_comparison;
  const original = structuredClone(value);
  expect(
    await validateNativeAdjudicationSubmission(
      reviewer,
      context,
      value,
      new AbortController().signal,
    ),
  ).toEqual({ accepted: true });
  expect(value).toEqual(original);
});

it("honors cancellation before reading or accepting proof", async () => {
  const { reviewer, context } = await fixture();
  const controller = new AbortController();
  controller.abort(new Error("fixture cancelled"));
  await expect(
    validateNativeAdjudicationSubmission(
      reviewer,
      context,
      result(),
      controller.signal,
    ),
  ).rejects.toThrow("fixture cancelled");
});
