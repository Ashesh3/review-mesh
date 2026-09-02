import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = resolve(projectRoot, "dist", "release");
const windowsOutput = join(outputDirectory, "review-mesh-windows-x64.exe");
const linuxOutput = join(outputDirectory, "review-mesh-linux-x64");
const checksumOutput = join(outputDirectory, "SHA256SUMS.txt");
const linuxBun = process.env.BUN_LINUX_X64_EXE;
const expectedBunVersion = "1.4.0";
const expectedLinuxBunSha256 =
  "33d56b070be6a9e3da0ab013038b43d1645d0534ca811ecdba4472599117eb4b";
const windowsOnly = process.argv.includes("--windows-only");

const localBun =
  process.platform === "win32"
    ? join(homedir(), ".bun", "bin", "bun.exe")
    : join(homedir(), ".bun", "bin", "bun");
const bun = process.env.BUN_EXE || localBun;
const commonArguments = [
  "build",
  "--compile",
  "--format=esm",
  "--minify",
  "--no-compile-autoload-dotenv",
  "--no-compile-autoload-bunfig",
];

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });

function version(executable) {
  const result = spawnSync(executable, ["--version"], {
    cwd: projectRoot,
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  if (result.status !== 0 || result.stdout.trim() !== expectedBunVersion) {
    throw new Error(
      `Expected Bun ${expectedBunVersion} at ${executable}; received ${result.stdout.trim() || `exit ${result.status}`}.`,
    );
  }
}

function build(entrypoint, target, output, executablePath, defineStandalone) {
  const result = spawnSync(
    bun,
    [
      ...commonArguments,
      ...(defineStandalone ? ["--define=REVIEW_MESH_STANDALONE=true"] : []),
      `--target=${target}`,
      ...(executablePath
        ? [`--compile-executable-path=${executablePath}`]
        : []),
      "--outfile",
      output,
      entrypoint,
    ],
    { cwd: projectRoot, stdio: "inherit" },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Bun failed to build ${target} (exit ${result.status}).`);
  }
}

version(bun);
if (linuxBun) {
  const linuxBunSha256 = createHash("sha256")
    .update(await readFile(linuxBun))
    .digest("hex");
  if (linuxBunSha256 !== expectedLinuxBunSha256) {
    throw new Error(
      `BUN_LINUX_X64_EXE must be the official Bun ${expectedBunVersion} Linux x64 runtime (${expectedLinuxBunSha256}).`,
    );
  }
}
build(
  "./scripts/standalone-entry.mjs",
  "bun-windows-x64",
  windowsOutput,
  undefined,
  true,
);
if (!windowsOnly) {
  build(
    "./scripts/standalone-entry.mjs",
    "bun-linux-x64",
    linuxOutput,
    linuxBun,
    true,
  );
  if (process.platform !== "win32") await chmod(linuxOutput, 0o755);
}

const checksumLines = [];
for (const output of windowsOnly
  ? [windowsOutput]
  : [windowsOutput, linuxOutput]) {
  const digest = createHash("sha256")
    .update(await readFile(output))
    .digest("hex");
  checksumLines.push(`${digest}  ${output.split(/[\\/]/u).at(-1)}`);
}
await writeFile(checksumOutput, `${checksumLines.join("\n")}\n`, "ascii");

console.log(`Built ${windowsOutput}`);
if (!windowsOnly) console.log(`Built ${linuxOutput}`);
console.log(`Wrote ${checksumOutput}`);
