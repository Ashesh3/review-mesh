import { spawnSync } from "node:child_process";

const result = spawnSync(
  process.execPath,
  [
    "node_modules/vitest/vitest.mjs",
    "run",
    "tests/acceptance/standalone-cli.test.ts",
  ],
  {
    cwd: process.cwd(),
    stdio: "inherit",
    env: { ...process.env, REVIEW_MESH_VERIFY_STANDALONE: "1" },
  },
);

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
