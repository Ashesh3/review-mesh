import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const args = process.argv.slice(2);
if (args.some((arg) => arg !== "--windows-only"))
  throw new Error("Usage: verify-standalone.mjs [--windows-only]");
const platforms = args.includes("--windows-only") ? "windows" : "windows,linux";
const vitestCli = join(
  dirname(require.resolve("vitest/package.json")),
  "vitest.mjs",
);

const result = spawnSync(
  process.execPath,
  [vitestCli, "run", "tests/acceptance/standalone-cli.test.ts"],
  {
    cwd: process.cwd(),
    stdio: "inherit",
    env: {
      ...process.env,
      REVIEW_MESH_VERIFY_STANDALONE: "1",
      REVIEW_MESH_VERIFY_STANDALONE_PLATFORMS: platforms,
    },
  },
);

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
