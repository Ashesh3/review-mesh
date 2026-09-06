import { register } from "tsx/esm/api";

register();
const { runSdkRuntimeVerification } =
  await import("../src/runtime/verify-runtime.ts");
await runSdkRuntimeVerification(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
