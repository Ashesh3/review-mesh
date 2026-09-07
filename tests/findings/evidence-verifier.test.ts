import {
  lstat,
  mkdtemp,
  mkdir,
  open,
  realpath,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { createGitRunner, type GitRunner } from "../../src/context/git.js";
import { createGitFixture } from "../fixtures/git-repo.js";
import {
  MAX_EVIDENCE_BYTES_PER_PATH,
  verifyAdjudicationEvidence,
  type EvidenceVerifierFileSystem,
} from "../../src/findings/evidence-verifier.js";
import type { AdjudicationResult } from "../../src/protocol/schemas.js";

const roots: string[] = [];

async function fixture() {
  const workspace = await mkdtemp(join(tmpdir(), "review-mesh-evidence-"));
  roots.push(workspace);
  await mkdir(join(workspace, "src"), { recursive: true });
  await writeFile(join(workspace, "src", "ingest.ts"), "one\ntwo\nthree\n");
  return workspace;
}

function result(path = "src/ingest.ts", line = 2): AdjudicationResult {
  const citation = { path, start_line: line, end_line: line, detail: "Proof." };
  return {
    schema_version: "1",
    kind: "review-mesh.adjudication-result",
    verdict: "fail",
    review_markdown: "# Adjudication\n\nConfirmed.",
    summary: "Confirmed.",
    actionable_findings: [],
    decisions: [
      {
        source_finding_id: "candidate",
        decision: "confirmed",
        rationale: "Confirmed.",
        cited_evidence: [citation],
        ordered_execution_proof: {
          steps: [
            { order: 1, description: "First.", citation },
            { order: 2, description: "Second.", citation },
          ],
          failure_point: { step_order: 2, citation, detail: "Failure." },
        },
        unverified_assumptions: [],
      },
    ],
    informational_notes: [],
  };
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("verifyAdjudicationEvidence", () => {
  it("verifies the effective adjusted citations instead of reusing only the original proof", async () => {
    const workspace = await fixture();
    const judge = result();
    judge.decisions[0]!.decision = "adjusted";
    judge.decisions[0]!.adjusted_finding = {
      severity: "medium",
      title: "Adjusted",
      description: "Adjusted claim",
      evidence: [
        {
          path: "src/missing.ts",
          start_line: 999,
          end_line: 999,
          detail: "Adjusted location",
        },
      ],
      suggested_direction: "Fix",
      confidence: "high",
      classification: "confirmed_defect",
      external_assumptions: [],
    };
    const invalid = await verifyAdjudicationEvidence({
      workspace,
      adjudicationResult: judge,
    });
    expect(invalid.by_source_finding_id.candidate).toMatchObject({
      verified: false,
      failures: ["read_failed"],
    });
    await writeFile(join(workspace, "src", "support.ts"), "supporting code\n");
    judge.decisions[0]!.adjusted_finding.evidence = [
      {
        path: "src/support.ts",
        start_line: 1,
        end_line: 1,
        detail: "Adjusted supporting evidence",
      },
    ];
    const valid = await verifyAdjudicationEvidence({
      workspace,
      adjudicationResult: judge,
    });
    expect(valid.by_source_finding_id.candidate).toMatchObject({
      verified: true,
      verified_citations: expect.arrayContaining([
        expect.objectContaining({
          side: "head",
          path: "src/support.ts",
          start_line: 1,
          end_line: 1,
        }),
      ]),
    });
  });

  it("verifies an old renamed path at the pinned base instead of the current head", async () => {
    const repository = await createGitFixture();
    const gitRunner = createGitRunner();
    const oldBytes = "old one\nold two\nold three\nold four\n";
    try {
      await repository.write("src/old.ts", oldBytes);
      await repository.stage("src/old.ts");
      await gitRunner.run(["commit", "-m", "Base evidence fixture"], {
        cwd: repository.path,
      });
      const base = await gitRunner.run(["rev-parse", "HEAD"], {
        cwd: repository.path,
      });
      await rm(join(repository.path, "src", "old.ts"));
      await repository.write("src/new.ts", "new one\n");
      const judge = result("src/new.ts", 1);
      judge.decisions[0]!.base_head_comparison = {
        base: {
          behavior: "Old behavior",
          citation: {
            path: "src/old.ts",
            start_line: 4,
            end_line: 4,
            detail: "Old fourth line",
          },
        },
        head: {
          behavior: "New behavior",
          citation: {
            path: "src/new.ts",
            start_line: 1,
            end_line: 1,
            detail: "New first line",
          },
        },
        impact: "Renamed and shortened.",
      };
      const verification = await verifyAdjudicationEvidence({
        workspace: repository.path,
        adjudicationResult: judge,
        baseRevision: base.stdout.trim(),
        gitRunner,
      });
      expect(verification.by_source_finding_id.candidate).toMatchObject({
        verified: true,
        failures: [],
        verified_citations: expect.arrayContaining([
          {
            side: "base",
            path: "src/old.ts",
            start_line: 4,
            end_line: 4,
            source_revision: base.stdout.trim(),
            sha256: createHash("sha256").update(oldBytes).digest("hex"),
          },
          {
            side: "head",
            path: "src/new.ts",
            start_line: 1,
            end_line: 1,
            sha256: createHash("sha256").update("new one\n").digest("hex"),
          },
        ]),
      });
    } finally {
      await repository.dispose();
    }
  });

  it("does not claim the base citation is verified without its exact source revision", async () => {
    const workspace = await fixture();
    const judge = result();
    judge.decisions[0]!.base_head_comparison = {
      base: {
        behavior: "Old",
        citation: judge.decisions[0]!.cited_evidence[0]!,
      },
      head: {
        behavior: "New",
        citation: judge.decisions[0]!.cited_evidence[0]!,
      },
      impact: "Changed",
    };
    const verification = await verifyAdjudicationEvidence({
      workspace,
      adjudicationResult: judge,
    });
    expect(verification.by_source_finding_id.candidate).toMatchObject({
      verified: false,
      failures: ["base_revision_unavailable"],
    });
  });

  it("does not treat a trailing newline as an additional cited line", async () => {
    const workspace = await fixture();
    const verification = await verifyAdjudicationEvidence({
      workspace,
      adjudicationResult: result("src/ingest.ts", 4),
    });
    expect(verification.by_source_finding_id.candidate).toMatchObject({
      verified: false,
      failures: ["line_out_of_range"],
    });
  });

  it.each([
    "unsafe-path",
    "moving-ref",
    "symlink",
    "truncated-blob",
    "missing-base-line",
  ])("fails closed for %s while checking base evidence", async (failure) => {
    const workspace = await fixture();
    const judge = result();
    judge.decisions[0]!.base_head_comparison = {
      base: {
        behavior: "Old",
        citation: {
          path: failure === "unsafe-path" ? "../outside.ts" : "src/ingest.ts",
          start_line: failure === "missing-base-line" ? 99 : 1,
          end_line: failure === "missing-base-line" ? 99 : 1,
          detail: "Old",
        },
      },
      head: {
        behavior: "New",
        citation: judge.decisions[0]!.cited_evidence[0]!,
      },
      impact: "Changed",
    };
    const run = vi
      .fn<GitRunner["run"]>()
      .mockResolvedValueOnce({
        stdout: `${failure === "symlink" ? "120000" : "100644"} blob ${"b".repeat(40)}\tsrc/ingest.ts\0`,
        stderr: "",
        exitCode: 0,
      })
      .mockResolvedValueOnce({
        stdout: "old\n",
        stderr: "",
        exitCode: 0,
        ...(failure === "truncated-blob" ? { outputTruncated: true } : {}),
      });
    const verification = await verifyAdjudicationEvidence({
      workspace,
      adjudicationResult: judge,
      baseRevision: failure === "moving-ref" ? "main" : "a".repeat(40),
      gitRunner: { run },
    });
    expect(verification.by_source_finding_id.candidate?.verified).toBe(false);
    if (failure === "unsafe-path" || failure === "moving-ref")
      expect(run).not.toHaveBeenCalled();
    if (failure === "symlink") expect(run).toHaveBeenCalledTimes(1);
    if (failure === "truncated-blob")
      expect(verification.by_source_finding_id.candidate?.failures).toContain(
        "evidence_too_large",
      );
    if (failure === "missing-base-line")
      expect(verification.by_source_finding_id.candidate?.failures).toContain(
        "line_out_of_range",
      );
    if (run.mock.calls.length > 0)
      expect(run.mock.calls[0]?.[0]).toEqual([
        "--no-replace-objects",
        "ls-tree",
        "-z",
        "a".repeat(40),
        "--",
        ":(literal)src/ingest.ts",
      ]);
  });

  it("does not let one invalid range poison another candidate sharing the file", async () => {
    const workspace = await fixture();
    const judge = result("src/ingest.ts", 99);
    judge.decisions.push({
      ...result().decisions[0]!,
      source_finding_id: "valid",
    });
    const verification = await verifyAdjudicationEvidence({
      workspace,
      adjudicationResult: judge,
    });
    expect(verification.by_source_finding_id.candidate?.verified).toBe(false);
    expect(verification.by_source_finding_id.valid?.verified).toBe(true);
  });

  it("fails closed if the same file is overwritten during evidence reading", async () => {
    const workspace = await fixture();
    const verification = await verifyAdjudicationEvidence({
      workspace,
      adjudicationResult: result(),
      beforeIdentityCheck: async () => {
        await writeFile(
          join(workspace, "src", "ingest.ts"),
          "changed longer content\n",
        );
      },
    });
    expect(verification.by_source_finding_id.candidate).toMatchObject({
      verified: false,
      failures: ["identity_changed"],
    });
  });

  it("confirms stable existing full-scope file and line citations", async () => {
    const workspace = await fixture();
    const verification = await verifyAdjudicationEvidence({
      workspace,
      adjudicationResult: result(),
    });

    expect(verification).toMatchObject({
      by_source_finding_id: { candidate: { verified: true, failures: [] } },
    });
  });

  it("rejects nonexistent repeated paths", async () => {
    const workspace = await fixture();
    const verification = await verifyAdjudicationEvidence({
      workspace,
      adjudicationResult: result("src/missing.ts"),
    });
    expect(verification.by_source_finding_id.candidate).toMatchObject({
      verified: false,
      failures: expect.arrayContaining(["read_failed"]),
    });
  });

  it("rejects symlink escapes", async () => {
    const workspace = await fixture();
    const outside = await mkdtemp(
      join(tmpdir(), "review-mesh-evidence-outside-"),
    );
    roots.push(outside);
    await writeFile(join(outside, "outside.ts"), "secret\n");
    await symlink(
      join(outside, "outside.ts"),
      join(workspace, "src", "link.ts"),
    );

    const verification = await verifyAdjudicationEvidence({
      workspace,
      adjudicationResult: result("src/link.ts", 1),
    });
    expect(verification.by_source_finding_id.candidate).toMatchObject({
      verified: false,
      failures: expect.arrayContaining(["unsafe_file"]),
    });
  });

  it("rejects out-of-range lines", async () => {
    const workspace = await fixture();
    const verification = await verifyAdjudicationEvidence({
      workspace,
      adjudicationResult: result("src/ingest.ts", 99),
    });
    expect(verification.by_source_finding_id.candidate).toMatchObject({
      verified: false,
      failures: expect.arrayContaining(["line_out_of_range"]),
    });
  });

  it("fails closed when file identity changes during verification", async () => {
    const workspace = await fixture();
    const verification = await verifyAdjudicationEvidence({
      workspace,
      adjudicationResult: result(),
      beforeIdentityCheck: async () => {
        await rm(join(workspace, "src", "ingest.ts"));
        await writeFile(join(workspace, "src", "ingest.ts"), "replacement\n");
      },
    });
    expect(verification.by_source_finding_id.candidate).toMatchObject({
      verified: false,
      failures: expect.arrayContaining(["identity_changed"]),
    });
  });

  it("opens and reads repeated citations from one path only once", async () => {
    const workspace = await fixture();
    let opens = 0;
    const fileSystem: EvidenceVerifierFileSystem = {
      realpath,
      lstat: (path) => lstat(path, { bigint: true }),
      open: async (path, flags) => {
        opens += 1;
        const handle = await open(path, flags);
        return {
          stat: () => handle.stat({ bigint: true }),
          read: handle.read.bind(handle),
          close: handle.close.bind(handle),
        };
      },
    };

    const verification = await verifyAdjudicationEvidence({
      workspace,
      adjudicationResult: result(),
      fileSystem,
    });

    expect(verification.by_source_finding_id.candidate?.verified).toBe(true);
    expect(opens).toBe(1);
  });

  it("rejects a citation that cannot be proven within the evidence byte bound", async () => {
    const workspace = await fixture();
    await writeFile(
      join(workspace, "src", "ingest.ts"),
      "x".repeat(MAX_EVIDENCE_BYTES_PER_PATH + 1),
    );

    const verification = await verifyAdjudicationEvidence({
      workspace,
      adjudicationResult: result("src/ingest.ts", 2),
    });

    expect(verification.by_source_finding_id.candidate).toMatchObject({
      verified: false,
      failures: expect.arrayContaining(["evidence_too_large"]),
    });
  });

  it("rejects same-size same-mtime replacement when Windows file ids are unavailable", async () => {
    const workspace = await fixture();
    const path = join(workspace, "src", "ingest.ts");
    const original = await lstat(path);
    const zeroIdentity = (stats: Awaited<ReturnType<typeof lstat>>) => ({
      dev: 0n,
      ino: 0n,
      size: BigInt(stats.size),
      mtimeNs: BigInt(Math.trunc(Number(stats.mtimeMs) * 1_000_000)),
      ctimeNs: BigInt(Math.trunc(Number(stats.ctimeMs) * 1_000_000)),
      birthtimeNs: BigInt(Math.trunc(Number(stats.birthtimeMs) * 1_000_000)),
      isFile: () => stats.isFile(),
      isSymbolicLink: () => stats.isSymbolicLink(),
    });
    const fileSystem: EvidenceVerifierFileSystem = {
      realpath,
      lstat: async (target) => zeroIdentity(await lstat(target)),
      open: async (target, flags) => {
        const handle = await open(target, flags);
        return {
          stat: async () => zeroIdentity(await handle.stat()),
          read: handle.read.bind(handle),
          close: handle.close.bind(handle),
        };
      },
    };

    const verification = await verifyAdjudicationEvidence({
      workspace,
      adjudicationResult: result(),
      platform: "win32",
      fileSystem,
      beforeIdentityCheck: async () => {
        await rm(path);
        await writeFile(path, "red\nnew\nother\n");
        await utimes(path, original.atime, original.mtime);
      },
    });

    expect(verification.by_source_finding_id.candidate).toMatchObject({
      verified: false,
      failures: expect.arrayContaining(["identity_changed"]),
    });
  });
});
