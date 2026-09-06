import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

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

await mkdir(outputDirectory, { recursive: true });
// Only replace the artifacts owned by this build; preserve unrelated release files.
for (const output of [
  windowsOutput,
  ...(windowsOnly ? [] : [linuxOutput]),
  checksumOutput,
]) {
  await rm(output, { force: true });
}

const lock = JSON.parse(
  await readFile(join(projectRoot, "package-lock.json"), "utf8"),
);
const stagingRoot = join(projectRoot, "dist", "standalone-assets");
const registry = "https://packagefeedproxy.microsoft.io/npm/";

async function packageRoot(packageName) {
  const entry = lock.packages[`node_modules/${packageName}`];
  if (!entry?.integrity || !entry.resolved || !entry.version) {
    throw new Error(`No locked native package for ${packageName}.`);
  }
  const installed = join(projectRoot, "node_modules", packageName);
  try {
    const metadata = JSON.parse(
      await readFile(join(installed, "package.json"), "utf8"),
    );
    if (metadata.version === entry.version) return installed;
  } catch {
    // Cross-platform optional packages are absent from a normal npm install.
  }
  const cached = join(
    stagingRoot,
    "packages",
    packageName.replaceAll("/", "_"),
    entry.version,
  );
  const root = join(cached, "package");
  try {
    const metadata = JSON.parse(
      await readFile(join(root, "package.json"), "utf8"),
    );
    if (metadata.version === entry.version) return root;
  } catch {
    // Download exactly the lockfile artifact through the approved package proxy.
  }
  const url = new URL(entry.resolved);
  const download = new URL(url.pathname.replace(/^\//, ""), registry);
  console.log(`Fetching locked runtime ${packageName}@${entry.version}`);
  const response = await fetch(download, {
    signal: AbortSignal.timeout(120000),
  });
  if (!response.ok)
    throw new Error(`Could not fetch ${packageName}: HTTP ${response.status}.`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const [algorithm, digest] = entry.integrity.split("-");
  if (createHash(algorithm).update(bytes).digest("base64") !== digest) {
    throw new Error(`Lockfile integrity mismatch for ${packageName}.`);
  }
  await mkdir(cached, { recursive: true });
  const archive = join(cached, "runtime.tgz");
  await writeFile(archive, bytes);
  const extraction = spawnSync("tar", ["-xzf", archive, "-C", cached], {
    cwd: projectRoot,
    windowsHide: true,
    encoding: "utf8",
  });
  if (extraction.error || extraction.status !== 0)
    throw new Error(`Could not extract locked runtime ${packageName}.`);
  await rm(archive, { force: true });
  const metadata = JSON.parse(
    await readFile(join(root, "package.json"), "utf8"),
  );
  if (metadata.version !== entry.version)
    throw new Error(`Native package version mismatch for ${packageName}.`);
  return root;
}

async function listFiles(root, directory = root) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await listFiles(root, path)));
    else if (entry.isFile()) result.push(path);
    else
      throw new Error(
        `Unsupported native runtime asset: ${relative(root, path)}.`,
      );
  }
  return result.sort();
}

async function runtimeEntrypoint(platform) {
  const stage = join(stagingRoot, platform);
  await mkdir(stage, { recursive: true });
  const specifier = (path) => path.replaceAll("\\", "/");
  const lines = [
    `import { join } from "node:path";`,
    `import { extractFromBunfs } from "@anthropic-ai/claude-agent-sdk/extract";`,
    `import { extractRuntimeAssets, registerEmbeddedSdkRuntime } from ${JSON.stringify(specifier(join(projectRoot, "src/runtime/sdk-runtime.ts")))};`,
  ];
  const windows = platform === "win32";
  const claudeRoot = await packageRoot(
    `@anthropic-ai/claude-agent-sdk-${platform}-x64`,
  );
  const claudeMetadata = JSON.parse(
    await readFile(
      join(
        projectRoot,
        "node_modules/@anthropic-ai/claude-agent-sdk/package.json",
      ),
      "utf8",
    ),
  );
  lines.push(
    `import claudeAsset from ${JSON.stringify(specifier(join(claudeRoot, windows ? "claude.exe" : "claude")))} with { type: "file" };`,
  );
  lines.push(
    `registerEmbeddedSdkRuntime("claude", () => ({ executablePath: extractFromBunfs(claudeAsset), pathEntries: [], sdkVersion: ${JSON.stringify(claudeMetadata.version)}, runtimeVersion: ${JSON.stringify(claudeMetadata.claudeCodeVersion)}, mode: "managed_process" }));`,
  );

  for (const sdk of ["codex", "copilot"]) {
    const packageName =
      sdk === "codex"
        ? `@openai/codex-${platform}-x64`
        : `@github/copilot-${platform}-x64`;
    const root = await packageRoot(packageName);
    const sdkPackage =
      sdk === "codex" ? "@openai/codex-sdk" : "@github/copilot-sdk";
    const sdkMetadata = JSON.parse(
      await readFile(
        join(projectRoot, "node_modules", sdkPackage, "package.json"),
        "utf8",
      ),
    );
    const nativeMetadata = JSON.parse(
      await readFile(join(root, "package.json"), "utf8"),
    );
    const triple = windows
      ? "x86_64-pc-windows-msvc"
      : "x86_64-unknown-linux-musl";
    const assetRoot = sdk === "codex" ? join(root, "vendor", triple) : root;
    const assets = [];
    for (const [index, path] of (await listFiles(assetRoot)).entries()) {
      const relativePath = specifier(relative(assetRoot, path));
      const bytes = await readFile(path);
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const compressedPath = join(
        stage,
        `${sdk}-${index}-${sha256.slice(0, 16)}.gz`,
      );
      const compressed = gzipSync(bytes, { level: 6 });
      await writeFile(compressedPath, compressed);
      const variable = `${sdk}Asset${index}`;
      lines.push(
        `import ${variable} from ${JSON.stringify(specifier(compressedPath))} with { type: "file" };`,
      );
      const mode = (await stat(path)).mode;
      const executable =
        (mode & 0o111) !== 0 ||
        /\.exe$/i.test(path) ||
        !basename(path).includes(".") ||
        relativePath.includes("/bin/");
      assets.push(
        `{ relativePath: ${JSON.stringify(relativePath)}, assetPath: ${variable}, sha256: ${JSON.stringify(sha256)}, executable: ${executable} }`,
      );
    }
    const nativeInfo =
      sdk === "codex"
        ? JSON.parse(
            await readFile(join(assetRoot, "codex-package.json"), "utf8"),
          )
        : undefined;
    const executable =
      sdk === "codex"
        ? nativeInfo.entrypoint
        : windows
          ? "copilot.exe"
          : "copilot";
    const runtimeVersion =
      sdk === "codex" ? nativeInfo.version : nativeMetadata.version;
    lines.push(
      `registerEmbeddedSdkRuntime(${JSON.stringify(sdk)}, () => { const root = extractRuntimeAssets([${assets.join(",\n")}]); return { executablePath: join(root, ${JSON.stringify(executable)}), pathEntries: ${sdk === "codex" ? ` [join(root, ${JSON.stringify(nativeInfo.pathDir)})]` : "[]"}, sdkVersion: ${JSON.stringify(sdkMetadata.version)}, runtimeVersion: ${JSON.stringify(runtimeVersion)}, mode: "managed_process" }; });`,
    );
  }
  lines.push(
    `await import(${JSON.stringify(specifier(join(projectRoot, "scripts/standalone-entry.mjs")))});`,
  );
  const entrypoint = join(stage, "entry.mjs");
  await writeFile(entrypoint, `${lines.join("\n")}\n`, "utf8");
  return entrypoint;
}

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
  await runtimeEntrypoint("win32"),
  "bun-windows-x64",
  windowsOutput,
  undefined,
  true,
);
if (!windowsOnly) {
  build(
    await runtimeEntrypoint("linux"),
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
