import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import {
  extractRuntimeAssets,
  resolveSdkRuntime,
} from "../../src/runtime/sdk-runtime.js";

const roots: string[] = [];
const projectRoot = resolve(import.meta.dirname, "../..");

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "review-mesh-runtime-test-"));
  roots.push(root);
  return root;
}

describe("managed SDK runtime assets", () => {
  it("extracts compressed companions with their directory layout and verifies cached bytes", async () => {
    const root = await fixture();
    const executable = Buffer.from("native-executable-fixture");
    const companion = Buffer.from("native-companion-fixture");
    const files = [];
    for (const [index, [relativePath, bytes]] of [
      ["bin/reviewer", executable],
      ["resources/reviewer", companion],
    ].entries()) {
      const assetPath = join(root, `asset-${index}.gz`);
      await writeFile(assetPath, gzipSync(bytes as Buffer));
      files.push({
        relativePath: relativePath as string,
        assetPath,
        sha256: createHash("sha256")
          .update(bytes as Buffer)
          .digest("hex"),
        executable: index === 0,
      });
    }
    const output = extractRuntimeAssets(files, join(root, "cache"));
    expect(readFileSync(join(output, "bin/reviewer"))).toEqual(executable);
    expect(readFileSync(join(output, "resources/reviewer"))).toEqual(companion);
    await writeFile(join(output, "resources/reviewer"), "corrupted cache");
    const reused = extractRuntimeAssets(files, join(root, "cache"));
    expect(reused).toBe(output);
    expect(readFileSync(join(reused, "resources/reviewer"))).toEqual(companion);
  });

  it("rejects corrupt embedded data before publishing an executable", async () => {
    const root = await fixture();
    const assetPath = join(root, "asset.gz");
    await writeFile(assetPath, gzipSync("unexpected bytes"));
    expect(() =>
      extractRuntimeAssets(
        [
          {
            relativePath: "bin/reviewer",
            assetPath,
            sha256: "0".repeat(64),
            executable: true,
          },
        ],
        join(root, "cache"),
      ),
    ).toThrow(/integrity/i);
  });

  it("rejects embedded paths escaping their runtime directory", async () => {
    const root = await fixture();
    const assetPath = join(root, "asset.gz");
    await writeFile(assetPath, gzipSync("untrusted"));
    expect(() =>
      extractRuntimeAssets(
        [
          {
            relativePath: "../outside",
            assetPath,
            sha256: "0".repeat(64),
            executable: true,
          },
        ],
        join(root, "cache"),
      ),
    ).toThrow(/path/i);
    expect(existsSync(join(root, "outside"))).toBe(false);
  });

  it.each(["claude", "codex", "copilot"] as const)(
    "resolves the installed %s native package without a separate CLI",
    (sdk) => {
      const runtime = resolveSdkRuntime(sdk);
      expect(existsSync(runtime.executablePath)).toBe(true);
      expect(runtime.mode).toBe("managed_process");
      expect(runtime.sdkVersion).toMatch(/^\d+\.\d+\.\d+/);
      expect(runtime.runtimeVersion).toMatch(/^\d+\.\d+\.\d+/);
      if (sdk === "codex") {
        expect(
          existsSync(
            join(
              runtime.pathEntries[0]!,
              process.platform === "win32" ? "rg.exe" : "rg",
            ),
          ),
        ).toBe(true);
      }
    },
  );
});

describe.runIf(process.env.REVIEW_MESH_VERIFY_SDK_RUNTIME === "1")(
  "real managed SDK startup without inference",
  () => {
    it.each(["claude", "codex", "copilot"])(
      "%s starts, handshakes, and shuts down without installed CLIs on PATH",
      async (sdk) => {
        const executable = process.env.REVIEW_MESH_SDK_RUNTIME_EXECUTABLE;
        const wsl = process.env.REVIEW_MESH_SDK_RUNTIME_WSL === "1";
        const args = [
          "--verify-sdk-runtime",
          "--sdk",
          sdk,
          "--mode",
          "managed_process",
        ];
        const result = spawnSync(
          wsl ? "wsl.exe" : executable || process.execPath,
          wsl
            ? [
                "--distribution",
                "Ubuntu",
                "--cd",
                "/tmp",
                "--exec",
                executable!,
                ...args,
              ]
            : executable
              ? args
              : [
                  "scripts/verify-sdk-runtime.mjs",
                  "--sdk",
                  sdk,
                  "--mode",
                  "managed_process",
                ],
          {
            cwd: executable && !wsl ? await fixture() : projectRoot,
            encoding: "utf8",
            windowsHide: true,
            timeout: 60000,
          },
        );
        expect(result.error).toBeUndefined();
        expect(result.status, result.stderr).toBe(0);
        const report = JSON.parse(result.stdout.trim());
        expect(report.sdk).toBe(sdk);
        expect(report.versionCheck).toBe("passed");
        expect(report.handshake).toBe("passed");
        expect(report.shutdown).toBe("passed");
        expect(report.inference).toBe("not_run");
        expect(report.vendorCliOnPath).toBe(false);
      },
      65000,
    );
  },
);
