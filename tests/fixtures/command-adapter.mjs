import { writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);

const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
const mode = process.env.REVIEW_MESH_FIXTURE_MODE ?? "pass";
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
      category: "correctness",
      verification: "Controlled evidence demonstrates the defect.",
    },
  ],
  informational_notes: [],
};

const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);

switch (mode) {
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
