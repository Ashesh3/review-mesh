import { CopilotClient } from "@github/copilot-sdk";
import { runCli } from "../src/cli.ts";
import { registerEmbeddedCopilotSdkModule } from "../src/copilot/runtime.ts";

registerEmbeddedCopilotSdkModule({ CopilotClient });

await runCli().catch(() => {
  process.stderr.write(
    `${JSON.stringify({
      error: "startup_failed",
      message: "Review Mesh could not complete process cleanup.",
    })}\n`,
  );
  process.exitCode = 2;
});
