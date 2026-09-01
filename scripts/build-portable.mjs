import { chmod, mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputFile = resolve(projectRoot, "dist", "review-mesh.mjs");

await mkdir(dirname(outputFile), { recursive: true });
await rm(outputFile, { force: true });
await build({
  absWorkingDir: projectRoot,
  entryPoints: ["src/cli.ts"],
  outfile: outputFile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  packages: "bundle",
  legalComments: "none",
  sourcemap: false,
  minify: false,
  treeShaking: true,
});

if (process.platform !== "win32") await chmod(outputFile, 0o755);
