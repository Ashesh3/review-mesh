import { writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";

const mode = process.env.REVIEW_MESH_FIXTURE_MODE ?? "pass";
const lines = (async function* () {
  let buffered = "";
  for await (const chunk of process.stdin) {
    buffered += chunk.toString("utf8");
    for (;;) {
      const newline = buffered.indexOf("\n");
      if (newline < 0) break;
      yield JSON.parse(buffered.slice(0, newline));
      buffered = buffered.slice(newline + 1);
    }
  }
  if (buffered.trim() !== "") yield JSON.parse(buffered);
})();
const first = await lines.next();
const request = first.value;
const capturePath = process.env.REVIEW_MESH_FIXTURE_CAPTURE;
const descendant =
  mode === "silent"
    ? spawn(process.execPath, ["-e", "setInterval(() => undefined, 60000)"], {
        stdio: "ignore",
      })
    : undefined;

if (capturePath !== undefined) {
  await writeFile(
    capturePath,
    JSON.stringify({
      request,
      env: process.env,
      pid: process.pid,
      ...(descendant?.pid === undefined ? {} : { child_pid: descendant.pid }),
    }),
  );
}

const passResult = {
  schema_version: "3",
  verdict: "pass",
  review_markdown: "# Review\n\nClean.",
  summary: "clean",
  actionable_findings: [],
  informational_notes: [],
};

const failResult = {
  schema_version: "3",
  verdict: "fail",
  review_markdown: "# Review\n\nOne actionable finding.",
  summary: "one actionable finding",
  actionable_findings: [
    {
      id: "fixture-medium",
      severity: "medium",
      title: "Fixture finding",
      description: "The fixture found a controlled defect.",
      evidence: [{ path: "fixture.ts", detail: "Controlled evidence." }],
      suggested_direction: "Correct the controlled defect.",
      confidence: "high",
      classification: "confirmed_defect",
      external_assumptions: [],
      root_issue_id: "fixture-shared-root",
      category: "correctness",
      verification: "Controlled evidence demonstrates the defect.",
    },
  ],
  informational_notes: [],
};

const largePassResult = {
  ...passResult,
  review_markdown: `# Review\n\nClean.\n\n${"Complete acceptance evidence. ".repeat(4_096)}`,
};

const largeFailResult = {
  ...failResult,
  review_markdown: `# Review\n\nOne actionable finding.\n\n${"Complete acceptance evidence. ".repeat(4_096)}`,
};

const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);

switch (mode) {
  case "v2-page": {
    emit({ type: "activity", message: "fixture page", identity: "activity-1" });
    const next = await lines.next();
    const assignment = next.value;
    emit({
      type: "result_page",
      page: JSON.stringify({
        schema_version: "1",
        kind: "review-mesh.result-page",
        result_id: assignment.request.result_id,
        result_kind: "reviewer",
        result_schema_version: "4",
        page_index: assignment.request.page_index,
        page_count: 1,
        page_kind: "header",
        previous_page_digest: assignment.request.previous_page_digest,
        payload: {
          verdict: "pass",
          summary: "clean",
          informational_notes: [],
          narrative_byte_count: 0,
          narrative_fragment_count: 0,
          actionable_finding_count: 0,
          coverage_attestation: null,
        },
      }),
    });
    break;
  }
  case "v2-duplicate-claim": {
    const claim = {
      type: "access_claim",
      identity: "claim-1",
      claim: {
        path: "src/a.ts",
        method: "full_file",
        snapshot_digest: "b".repeat(64),
      },
    };
    emit(claim);
    emit(claim);
    break;
  }
  case "v2-claim-page": {
    emit({
      type: "access_claim",
      identity: "claim-1",
      claim: {
        path: "src/a.ts",
        method: "full_file",
        snapshot_digest: "b".repeat(64),
      },
    });
    const next = await lines.next();
    const assignment = next.value;
    emit({
      type: "result_page",
      page: JSON.stringify({
        schema_version: "1",
        kind: "review-mesh.result-page",
        result_id: assignment.request.result_id,
        result_kind: "reviewer",
        result_schema_version: "4",
        page_index: assignment.request.page_index,
        page_count: 1,
        page_kind: "header",
        previous_page_digest: assignment.request.previous_page_digest,
        payload: {
          verdict: "pass",
          summary: "clean",
          informational_notes: [],
          narrative_byte_count: 0,
          narrative_fragment_count: 0,
          actionable_finding_count: 0,
          coverage_attestation: null,
        },
      }),
    });
    break;
  }
  case "pass":
    emit({ type: "progress", phase: "reviewing", message: "fixture active" });
    emit({ type: "result", result: passResult });
    break;
  case "secret-messages":
    emit({
      type: "progress",
      phase: "reviewing",
      message: "Authorization: Bearer progress-secret reviewing",
    });
    emit({
      type: "activity",
      message: "Authorization=Bearer activity-secret reviewing",
    });
    emit({ type: "result", result: passResult });
    break;
  case "fail":
    emit({ type: "result", result: failResult });
    break;
  case "large-pass":
    emit({ type: "result", result: largePassResult });
    break;
  case "large-fail":
    emit({ type: "result", result: largeFailResult });
    break;
  case "capabilities-enforced":
    emit({ type: "capabilities", isolation: "enforced_read_only" });
    emit({ type: "result", result: passResult });
    break;
  case "capabilities-late":
    emit({ type: "progress", phase: "reviewing", message: "fixture active" });
    emit({ type: "capabilities", isolation: "enforced_read_only" });
    emit({ type: "result", result: passResult });
    break;
  case "malformed":
    process.stdout.write("not json\n");
    break;
  case "no-terminal":
    emit({ type: "progress", phase: "reviewing", message: "fixture active" });
    break;
  case "double-terminal":
    emit({ type: "result", result: passResult });
    emit({ type: "result", result: passResult });
    break;
  case "extra-after-terminal":
    emit({ type: "result", result: passResult });
    emit({ type: "progress", phase: "reviewing", message: "too late" });
    break;
  case "oversized-line":
    emit({
      type: "progress",
      phase: "reviewing",
      message: "x".repeat(1024 * 1024),
    });
    break;
  case "oversized-total": {
    const event = `${JSON.stringify({
      type: "progress",
      phase: "reviewing",
      message: "x".repeat(64 * 1024),
    })}\n`;
    let written = 0;
    while (written <= 9 * 1024 * 1024) {
      if (!process.stdout.write(event)) {
        await new Promise((resolve) => process.stdout.once("drain", resolve));
      }
      written += Buffer.byteLength(event);
    }
    break;
  }
  case "large-result":
    emit({
      type: "result",
      result: {
        ...passResult,
        review_markdown: `# Review\n\n${"x".repeat(9 * 1024 * 1024)}`,
      },
    });
    break;
  case "escape-heavy-result":
    emit({
      type: "result",
      result: {
        ...passResult,
        review_markdown: `# Review\n\n${'"\\\n\t'.repeat(1_400_000)}`,
      },
    });
    break;
  case "silent":
    setInterval(() => undefined, 60_000);
    break;
  case "crash":
    process.stderr.write(
      "Authorization: Bearer fixture-secret controlled crash\n",
    );
    process.exitCode = 7;
    break;
  case "crash-large":
    process.stderr.write("x".repeat(128 * 1024));
    process.exitCode = 9;
    break;
  default:
    throw new Error(`unknown fixture mode: ${mode}`);
}
