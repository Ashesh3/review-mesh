import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

export type SdkRuntimeName = "claude" | "codex" | "copilot";

export interface SdkRuntime {
  executablePath: string;
  pathEntries: string[];
  sdkVersion: string;
  runtimeVersion: string;
  mode: "managed_process";
}

export interface EmbeddedRuntimeAsset {
  relativePath: string;
  assetPath: string;
  sha256: string;
  executable: boolean;
}

const embeddedRuntimes = new Map<SdkRuntimeName, () => SdkRuntime>();

/** Registers lazy extraction so ordinary CLI discovery does not unpack runtimes. */
export function registerEmbeddedSdkRuntime(
  sdk: SdkRuntimeName,
  factory: () => SdkRuntime,
): void {
  let runtime: SdkRuntime | undefined;
  embeddedRuntimes.set(sdk, () => (runtime ??= factory()));
}

function hash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function privateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("SDK runtime cache path is not a private directory.");
  }
  if (typeof process.getuid === "function") {
    if (stat.uid !== process.getuid()) {
      throw new Error("SDK runtime cache belongs to another user.");
    }
    chmodSync(path, 0o700);
  }
}

/** Extracts compressed assets atomically, retaining vendor-relative paths. */
export function extractRuntimeAssets(
  files: readonly EmbeddedRuntimeAsset[],
  cacheRoot = join(
    tmpdir(),
    `review-mesh-runtimes-${process.getuid?.() ?? "user"}`,
  ),
): string {
  const names = new Set<string>();
  for (const file of files) {
    if (
      !file.relativePath ||
      file.relativePath.includes("\\") ||
      file.relativePath.includes(":") ||
      file.relativePath
        .split("/")
        .some((part) => !part || part === "." || part === "..") ||
      names.has(file.relativePath)
    ) {
      throw new Error("Invalid SDK runtime asset path.");
    }
    names.add(file.relativePath);
    if (!/^[a-f0-9]{64}$/.test(file.sha256)) {
      throw new Error("Invalid SDK runtime asset integrity digest.");
    }
  }
  const manifestHash = hash(
    Buffer.from(
      JSON.stringify(
        files.map(({ relativePath, sha256, executable }) => ({
          relativePath,
          sha256,
          executable,
        })),
      ),
    ),
  );
  privateDirectory(cacheRoot);
  const output = join(resolve(cacheRoot), manifestHash);
  privateDirectory(output);
  for (const file of files) {
    const target = join(output, ...file.relativePath.split("/"));
    let directory = output;
    for (const segment of file.relativePath.split("/").slice(0, -1)) {
      directory = join(directory, segment);
      privateDirectory(directory);
    }
    if (existsSync(target)) {
      if (!lstatSync(target).isFile() || lstatSync(target).isSymbolicLink()) {
        throw new Error("SDK runtime asset path is not a regular file.");
      }
      if (hash(readFileSync(target)) === file.sha256) continue;
    }
    const bytes = gunzipSync(readFileSync(file.assetPath));
    if (hash(bytes) !== file.sha256) {
      throw new Error("SDK runtime asset integrity verification failed.");
    }
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, bytes, {
        flag: "wx",
        mode: file.executable ? 0o700 : 0o600,
      });
      try {
        renameSync(temporary, target);
      } catch (error) {
        // Windows cannot replace a running executable: a concurrent extractor
        // may already have published the same verified bytes.
        if (
          !existsSync(target) ||
          !lstatSync(target).isFile() ||
          hash(readFileSync(target)) !== file.sha256
        )
          throw error;
      }
    } finally {
      rmSync(temporary, { force: true });
    }
  }
  return output;
}

function metadata(entry: string): {
  root: string;
  version: string;
  claudeCodeVersion?: string;
} {
  let directory = dirname(entry);
  for (;;) {
    const candidate = join(directory, "package.json");
    if (existsSync(candidate)) {
      const info = JSON.parse(readFileSync(candidate, "utf8"));
      if (typeof info.version === "string") return { root: directory, ...info };
    }
    const parent = dirname(directory);
    if (parent === directory)
      throw new Error("SDK package metadata is missing.");
    directory = parent;
  }
}

export function resolveSdkRuntime(sdk: SdkRuntimeName): SdkRuntime {
  const embedded = embeddedRuntimes.get(sdk);
  if (embedded) return embedded();
  const sdkPackages = {
    claude: "@anthropic-ai/claude-agent-sdk",
    codex: "@openai/codex-sdk",
    copilot: "@github/copilot-sdk",
  };
  const sdkEntry = fileURLToPath(import.meta.resolve(sdkPackages[sdk]));
  const sdkMetadata = metadata(sdkEntry);
  const sdkRequire = createRequire(sdkEntry);
  const platform = process.platform;
  const arch = process.arch;
  if (
    !["x64", "arm64"].includes(arch) ||
    !["win32", "linux", "darwin"].includes(platform)
  ) {
    throw new Error(`SDK runtimes are unsupported on ${platform}-${arch}.`);
  }
  const musl =
    platform === "linux" &&
    !(
      process.report?.getReport() as {
        header?: { glibcVersionRuntime?: string };
      }
    ).header?.glibcVersionRuntime;
  let executablePath: string;
  let runtimeVersion: string;
  const pathEntries: string[] = [];
  if (sdk === "claude") {
    const packageName = `@anthropic-ai/claude-agent-sdk-${platform}-${arch}${musl ? "-musl" : ""}`;
    const packageRoot = dirname(
      sdkRequire.resolve(`${packageName}/package.json`),
    );
    executablePath = join(
      packageRoot,
      platform === "win32" ? "claude.exe" : "claude",
    );
    runtimeVersion = sdkMetadata.claudeCodeVersion ?? sdkMetadata.version;
  } else if (sdk === "codex") {
    const packageRoot = dirname(
      sdkRequire.resolve(`@openai/codex-${platform}-${arch}/package.json`),
    );
    const machine = arch === "x64" ? "x86_64" : "aarch64";
    const triple = `${machine}-${platform === "win32" ? "pc-windows-msvc" : platform === "darwin" ? "apple-darwin" : "unknown-linux-musl"}`;
    const runtimeRoot = join(packageRoot, "vendor", triple);
    const nativeMetadata = JSON.parse(
      readFileSync(join(runtimeRoot, "codex-package.json"), "utf8"),
    );
    executablePath = join(runtimeRoot, nativeMetadata.entrypoint);
    runtimeVersion = nativeMetadata.version;
    pathEntries.push(join(runtimeRoot, nativeMetadata.pathDir));
  } else {
    executablePath = sdkRequire.resolve(
      `@github/copilot-${musl ? "linuxmusl" : platform}-${arch}`,
    );
    runtimeVersion = metadata(executablePath).version;
  }
  if (!existsSync(executablePath)) {
    throw new Error(`The packaged ${sdk} runtime executable is missing.`);
  }
  return {
    executablePath,
    pathEntries,
    sdkVersion: sdkMetadata.version,
    runtimeVersion,
    mode: "managed_process",
  };
}
