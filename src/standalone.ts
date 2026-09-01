import { runCli } from "./cli.js";

await runCli().catch(() => {
  process.stderr.write(
    `${JSON.stringify({
      error: "startup_failed",
      message: "Review Mesh could not complete process cleanup.",
    })}\n`,
  );
  process.exitCode = 2;
});
