import { CopilotClient, RuntimeConnection } from "@github/copilot-sdk";
import { runCli } from "../src/cli.ts";
import { registerEmbeddedCopilotSdkModule } from "../src/copilot/runtime.ts";
import { runSdkRuntimeVerification } from "../src/runtime/verify-runtime.ts";

registerEmbeddedCopilotSdkModule({ CopilotClient, RuntimeConnection });

const verifyingRuntime = process.argv[2] === "--verify-sdk-runtime";
const main = verifyingRuntime
  ? () => runSdkRuntimeVerification(process.argv.slice(3))
  : runCli;

await main().catch((error) => {
  if (verifyingRuntime) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
    return;
  }
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
