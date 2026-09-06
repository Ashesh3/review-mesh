// Run with: node --import tsx scripts/evaluate-quality.mjs <command> ...
import { readFile } from "node:fs/promises";
import {
  createQualityFixture,
  evaluateQualityReport,
  runQualityBehavior,
} from "../src/evaluation/quality-fixtures.ts";

const [command, ...args] = process.argv.slice(2);
try {
  let output;
  if (command === "create") {
    const [caseId, variant, directory] = args;
    if (
      !["state", "search", "eligibility"].includes(caseId) ||
      !["buggy", "corrected"].includes(variant) ||
      args.length > 3
    )
      throw new Error(
        "Expected: create state|search|eligibility buggy|corrected [directory]",
      );
    output = await createQualityFixture({
      caseId,
      variant,
      ...(directory ? { directory } : {}),
    });
  } else if (command === "verify" && args.length === 1) {
    output = {
      kind: "review-mesh.quality-behavior",
      model_execution: "not_performed",
      probes: await runQualityBehavior(args[0]),
    };
  } else if (command === "score" && args.length === 2) {
    output = await evaluateQualityReport(
      args[0],
      JSON.parse(await readFile(args[1], "utf8")),
    );
  } else
    throw new Error(
      "Usage: node --import tsx scripts/evaluate-quality.mjs create CASE VARIANT [DIRECTORY] | verify ORACLE | score ORACLE RAW_REPORT_JSON",
    );
  process.stdout.write(JSON.stringify(output, null, 2) + "\n");
} catch (error) {
  process.stderr.write(
    JSON.stringify({
      kind: "quality-evaluation-error",
      message: error instanceof Error ? error.message : "Evaluation failed",
    }) + "\n",
  );
  process.exitCode = 2;
}
