import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
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
    env: { ...process.env, REVIEW_MESH_VERIFY_STANDALONE: "1" },
  },
);

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
