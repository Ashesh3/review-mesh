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
import { afterEach, describe, expect, it } from "vitest";
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
    const outside = await mkdtemp(join(tmpdir(), "review-mesh-evidence-outside-"));
    roots.push(outside);
    await writeFile(join(outside, "outside.ts"), "secret\n");
    await symlink(join(outside, "outside.ts"), join(workspace, "src", "link.ts"));

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
