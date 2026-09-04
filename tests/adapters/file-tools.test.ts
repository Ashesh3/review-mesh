import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createReadOnlyFileTools } from "../../src/adapters/file-tools.js";
import { createChangeCoverageLedger } from "../../src/context/change-coverage.js";
import type { ResolvedContext } from "../../src/context/resolve.js";

const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

function context(
  workspace: string,
  changedFiles = ["worker.ts"],
): ResolvedContext {
  return {
    consistency_mode: "live_worktree",
    workspace,
    project_name: "tools-test",
    instructions: "Review.",
    review_scope: { mode: "changes", source: "request" },
    git: {
      is_repository: true,
      root: workspace,
      branch: "main",
      head: "a".repeat(40),
      merge_base: "b".repeat(40),
      status_entries: [],
      changed_files: changedFiles,
      changed_paths: changedFiles.map((path) => ({
        path,
        kind: "untracked" as const,
      })),
      diff_stat: "",
      diff: "",
      raw_diff: { byte_count: 0, sha256: sha256("") },
      truncated: {
        status_entries: false,
        changed_files: false,
        diff_stat: false,
        diff: false,
      },
    },
  };
}

describe("createReadOnlyFileTools", () => {
  const directories: string[] = [];
  afterEach(async () => {
    await Promise.all(
      directories
        .splice(0)
        .map((path) => rm(path, { recursive: true, force: true })),
    );
  });

  it("returns exact base64 bytes and records only an acknowledged response", async () => {
    const root = await mkdtemp(join(tmpdir(), "review-mesh-tools-"));
    directories.push(root);
    await writeFile(join(root, "worker.ts"), "éclair", "utf8");
    const ledger = await createChangeCoverageLedger({
      context: context(root),
      policy: {
        relevantPaths: ["**"],
        minimumInspection: "full_file",
        proof: "observed",
      },
    });
    const tools = createReadOnlyFileTools({ ledger });

    const result = await tools.readFile({
      path: "worker.ts",
      offset: 0,
      byteCount: 3,
    });
    expect(result.response).toMatchObject({
      ok: true,
      path: "worker.ts",
      encoding: "base64",
      offset: 0,
      byte_count: 3,
      total_byte_count: Buffer.byteLength("éclair"),
      content: Buffer.from("éc", "utf8").toString("base64"),
      sha256: sha256("éc"),
      eof: false,
    });
    expect(ledger.summary().status).toBe("incomplete");
    result.acknowledgeDelivered();
    expect(ledger.summary().status).toBe("incomplete");
  });

  it("lists and searches pinned text without crediting full-file inspection", async () => {
    const root = await mkdtemp(join(tmpdir(), "review-mesh-tools-"));
    directories.push(root);
    await writeFile(
      join(root, "worker.ts"),
      "first\nneedle here\nlast\n",
      "utf8",
    );
    await writeFile(join(root, "other.ts"), "needle there\n", "utf8");
    const ledger = await createChangeCoverageLedger({
      context: context(root, ["other.ts", "worker.ts"]),
      policy: {
        relevantPaths: ["**"],
        minimumInspection: "full_file",
        proof: "observed",
      },
    });
    const tools = createReadOnlyFileTools({ ledger });

    await expect(tools.listFiles({ path: "." })).resolves.toMatchObject({
      files: [
        { path: "other.ts", byte_count: 13 },
        { path: "worker.ts", byte_count: 23 },
      ],
      truncated: false,
    });
    await expect(
      tools.searchText({ query: "needle", path: "." }),
    ).resolves.toEqual({
      matches: [
        { path: "other.ts", line: 1, text: "needle there" },
        { path: "worker.ts", line: 2, text: "needle here" },
      ],
      truncated: false,
    });
    expect(ledger.summary()).toMatchObject({
      status: "incomplete",
      deficit_count: 2,
    });
  });

  it("lists whole-workspace snapshot files during a full review", async () => {
    const root = await mkdtemp(join(tmpdir(), "review-mesh-tools-"));
    directories.push(root);
    await writeFile(join(root, "worker.ts"), "whole workspace\n", "utf8");
    const full = context(root, []);
    full.review_scope = { mode: "full", source: "request" };
    const ledger = await createChangeCoverageLedger({
      context: full,
      policy: {
        relevantPaths: ["**"],
        minimumInspection: "full_file",
        proof: "observed",
      },
    });
    const tools = createReadOnlyFileTools({ ledger });
    await expect(tools.listFiles()).resolves.toMatchObject({
      files: [{ path: "worker.ts", byte_count: 16 }],
    });
    expect(ledger.summary().status).toBe("not_applicable");
  });
});
