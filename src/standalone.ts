import { runCli } from "./cli.js";

await runCli().catch(() => {
  process.stderr.write(
    `${JSON.stringify({
      schema_version: "1",
      kind: "review-mesh.diagnostic",
      error: "startup_failed",
      message: "Review Mesh could not complete process cleanup.",
      retryable: false,
    })}\n`,
  );
  process.exitCode = 2;
});
