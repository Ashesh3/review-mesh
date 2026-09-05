import {
  open,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix, win32 } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createRunRecorder,
  directoriesBelow,
  isWithinDirectory,
  type RunRecorderFileSystem,
  type RunRecorderOperation,
} from "../../src/diagnostics/run-recorder.js";
import { reviewerResultDigest } from "../../src/results/digest.js";
import type { PublicEvent } from "../../src/protocol/schemas.js";

const temporaryRoots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "review-mesh-recorder-"));
  temporaryRoots.push(root);
  return root;
}

function startedEvent(): PublicEvent {
  return {
    schema_version: "5",
    event: "run.started",
    run_id: "run-current",
    seq: 1,
    timestamp: "2026-08-30T10:00:00.000Z",
    data: { consistency_mode: "live_worktree" },
  };
}

function completedEvent(runId: string): PublicEvent {
  return {
    schema_version: "5",
    event: "run.completed",
    run_id: runId,
    seq: 2,
    timestamp: "2026-09-05T10:00:00.000Z",
    data: {},
  } as PublicEvent;
}

async function completedLegacy(root: string, runId: string, maxRuns = 100) {
  const recorder = createRunRecorder({
    applicationDataRoot: root,
    runsDirectory: join(root, "runs"),
    runId,
    maxRuns,
    resolution: {},
  });
  await recorder.onEvent({ ...startedEvent(), run_id: runId });
  await recorder.onEvent(completedEvent(runId));
  await recorder.close();
}

async function activeRecordPath(runsDirectory: string): Promise<string> {
  const names = (await readdir(runsDirectory)).filter((name) =>
    name.includes(".jsonl.active."),
  );
  expect(names).toHaveLength(1);
  return join(runsDirectory, names[0]!);
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

it("redacts credentials embedded in persisted string values", async () => {
  const root = await temporaryRoot();
  const runsDirectory = join(root, "runs");
  const recorder = createRunRecorder({
    applicationDataRoot: root,
    runsDirectory,
    runId: "run-redaction",
    maxRuns: 10,
    resolution: {},
  });
  await recorder.onRecord({
    record: "context",
    run_id: "run-redaction",
    values: [
      "https://user:password@example.test/path?token=abc",
      "client_secret=super-secret",
      "Authorization: Bearer spaced-bearer-secret",
      "Authorization=Bearer equals-bearer-secret",
      "DefaultEndpointsProtocol=https;AccountName=demo;AccountKey=key-value;EndpointSuffix=core.windows.net",
    ],
  });
  await recorder.close();
  const persisted = await readFile(
    join(runsDirectory, "run-redaction.jsonl"),
    "utf8",
  );
  expect(persisted).not.toContain("password");
  expect(persisted).not.toContain("super-secret");
  expect(persisted).not.toContain("spaced-bearer-secret");
  expect(persisted).not.toContain("equals-bearer-secret");
  expect(persisted).not.toContain("key-value");
});

describe("RunRecorder", () => {
  it("retains only owned completed legacy files while current reviews and caller copies coexist", async () => {
    const root = await temporaryRoot();
    const runsDirectory = join(root, "runs");
    await mkdir(runsDirectory);
    const protectedFiles = new Map([
      [
        "current-active.jsonl",
        '{"record":"run.artifact","artifact_format_version":"2","run_id":"current-active"}\n',
      ],
      [
        "current-final.jsonl",
        '{"record":"run.artifact","artifact_format_version":"2","run_id":"current-final"}\n{"record":"run.artifact_terminal"}\n',
      ],
      [
        "current-final.index.json",
        '{"kind":"review-mesh.run-index","run_id":"current-final"}\n',
      ],
      [
        "orphan.index.json",
        '{"kind":"review-mesh.run-index","run_id":"orphan"}\n',
      ],
      [
        "caller-details.jsonl",
        '{"record":"resolution","run_id":"different-run","resolution":{}}\n{"schema_version":"5","event":"run.completed","run_id":"different-run"}\n',
      ],
      [
        "old-unmarked.jsonl",
        '{"record":"resolution","run_id":"old-unmarked","resolution":{}}\n{"schema_version":"5","event":"run.completed","run_id":"old-unmarked"}\n',
      ],
      [
        "backup.jsonl",
        '{"record":"run.artifact","artifact_format_version":"2","run_id":"backup"}\n',
      ],
      [
        "current-lookalike.jsonl.active.424242.1.old-owner",
        '{"record":"run.artifact","artifact_format_version":"2","run_id":"current-lookalike"}\n',
      ],
    ]);
    for (const [name, bytes] of protectedFiles) {
      await writeFile(join(runsDirectory, name), bytes);
      await utimes(join(runsDirectory, name), new Date(1000), new Date(1000));
    }
    const activePath = join(runsDirectory, "doctor-active.jsonl.active");
    const active = await open(activePath, "wx", 0o600);
    try {
      await active.writeFile(
        '{"record":"run.artifact","artifact_format_version":"2","run_id":"doctor-active"}\n',
      );
      await completedLegacy(root, "legacy-old");
      await completedLegacy(root, "legacy-new", 1);
      await active.appendFile(
        '{"record":"reviewer.activity","run_id":"doctor-active"}\n',
      );
      for (const [name, bytes] of protectedFiles)
        await expect(readFile(join(runsDirectory, name), "utf8")).resolves.toBe(
          bytes,
        );
      await expect(
        stat(join(runsDirectory, "legacy-old.jsonl")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      await expect(
        readFile(join(runsDirectory, "legacy-new.jsonl"), "utf8"),
      ).resolves.toContain('"event":"run.completed"');
      await expect(readFile(activePath, "utf8")).resolves.toContain(
        '"record":"reviewer.activity"',
      );
    } finally {
      await active.close();
    }
  });

  it("preserves marked files replaced by current artifacts and indexed legacy candidates", async () => {
    const root = await temporaryRoot();
    const runsDirectory = join(root, "runs");
    await completedLegacy(root, "changed-to-current");
    await completedLegacy(root, "indexed-legacy");
    const changed = join(runsDirectory, "changed-to-current.jsonl");
    const current =
      '{"record":"run.artifact","artifact_format_version":"2","run_id":"changed-to-current"}\n';
    await writeFile(changed, current);
    // Even a stale/mistaken marker that has the new identity cannot establish
    // legacy ownership for a current-format header.
    const metadata = await stat(changed, { bigint: true });
    await writeFile(
      join(runsDirectory, ".legacy-owned", "changed-to-current.json"),
      JSON.stringify({
        schema_version: "1",
        kind: "review-mesh.legacy-run-ownership",
        run_id: "changed-to-current",
        completed: true,
        dev: String(metadata.dev),
        ino: String(metadata.ino),
        byte_count: Number(metadata.size),
        mtime_ns: String(metadata.mtimeNs),
      }),
    );
    const index =
      '{"kind":"review-mesh.run-index","run_id":"indexed-legacy","artifact":{"path":"caller-owned"}}';
    await writeFile(join(runsDirectory, "indexed-legacy.index.json"), index);
    await completedLegacy(root, "newest", 1);
    await expect(readFile(changed, "utf8")).resolves.toBe(current);
    await expect(
      readFile(join(runsDirectory, "indexed-legacy.jsonl"), "utf8"),
    ).resolves.toContain('"event":"run.completed"');
    await expect(
      readFile(join(runsDirectory, "indexed-legacy.index.json"), "utf8"),
    ).resolves.toBe(index);
  });

  it("does not grant retention ownership to a recorder closed without run completion", async () => {
    const root = await temporaryRoot();
    const runsDirectory = join(root, "runs");
    const interrupted = createRunRecorder({
      applicationDataRoot: root,
      runsDirectory,
      runId: "incomplete-legacy",
      maxRuns: 1,
      resolution: {},
    });
    await interrupted.onEvent({
      ...startedEvent(),
      run_id: "incomplete-legacy",
    });
    await interrupted.close();
    await completedLegacy(root, "completed-legacy", 1);
    await expect(
      readFile(join(runsDirectory, "incomplete-legacy.jsonl"), "utf8"),
    ).resolves.toContain('"event":"run.started"');
    await expect(
      stat(join(runsDirectory, ".legacy-owned", "incomplete-legacy.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves a replaced pathname and an in-place modified owned legacy publication", async () => {
    const root = await temporaryRoot();
    const runsDirectory = join(root, "runs");
    await completedLegacy(root, "replaced");
    await completedLegacy(root, "modified");
    const replaced = join(runsDirectory, "replaced.jsonl");
    const preserved = join(root, "caller-backup.jsonl");
    await rename(replaced, preserved);
    const unrelated = "caller-owned replacement\n";
    await writeFile(replaced, unrelated);
    const modified = join(runsDirectory, "modified.jsonl");
    const original = await readFile(modified, "utf8");
    const changed = original.replace('"seq":2', '"seq":3');
    await writeFile(modified, changed);
    await utimes(modified, new Date(2000), new Date(2000));
    await completedLegacy(root, "newest", 1);
    await expect(readFile(replaced, "utf8")).resolves.toBe(unrelated);
    await expect(readFile(modified, "utf8")).resolves.toBe(changed);
    await expect(readFile(preserved, "utf8")).resolves.toContain(
      '"event":"run.completed"',
    );
  });
  it("keeps an active record observable but does not publish it when publish is disabled", async () => {
    const root = await temporaryRoot();
    const runsDirectory = join(root, "runs");
    const recorder = createRunRecorder({
      applicationDataRoot: root,
      runsDirectory,
      runId: "run-transient",
      maxRuns: 10,
      resolution: {},
      publish: false,
    });
    await recorder.onEvent({ ...startedEvent(), run_id: "run-transient" });
    await expect(
      readFile(await activeRecordPath(runsDirectory), "utf8"),
    ).resolves.toContain('"event":"run.started"');
    await recorder.close();
    await expect(readdir(runsDirectory)).resolves.toEqual([]);
  });

  it("can initialize the active record before the public run begins", async () => {
    const root = await temporaryRoot();
    const runsDirectory = join(root, "runs");
    const recorder = createRunRecorder({
      applicationDataRoot: root,
      runsDirectory,
      runId: "run-ready",
      maxRuns: 10,
      resolution: {},
      publish: false,
    });
    await recorder.ready();
    expect(
      await readFile(await activeRecordPath(runsDirectory), "utf8"),
    ).toContain('"record":"resolution"');
    await recorder.close();
  });

  it("preserves the accepted full reviewer result without per-string truncation", async () => {
    const root = await temporaryRoot();
    const runsDirectory = join(root, "runs");
    const recorder = createRunRecorder({
      applicationDataRoot: root,
      runsDirectory,
      runId: "run-lossless-result",
      maxRuns: 10,
      resolution: {},
    });
    const reviewMarkdown = `# Complete review\n\n${"Evidence. ".repeat(2_000)}`;

    await recorder.onRecord({
      record: "reviewer.result",
      run_id: "run-lossless-result",
      reviewer_id: "reviewer-1",
      digest: "a".repeat(64),
      byte_count: Buffer.byteLength(reviewMarkdown, "utf8"),
      result: {
        schema_version: "3",
        verdict: "pass",
        review_markdown: reviewMarkdown,
        summary: "No actionable findings.",
        actionable_findings: [],
        informational_notes: [],
      },
    });
    await recorder.close();

    const records = (
      await readFile(join(runsDirectory, "run-lossless-result.jsonl"), "utf8")
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(records[1]).toMatchObject({
      record: "reviewer.result",
      result: { review_markdown: reviewMarkdown },
    });
    expect(JSON.stringify(records[1])).not.toContain("[truncated]");
  });

  it("persists a compact reference for the mirrored public reviewer result", async () => {
    const root = await temporaryRoot();
    const runsDirectory = join(root, "runs");
    const recorder = createRunRecorder({
      applicationDataRoot: root,
      runsDirectory,
      runId: "run-result-reference",
      maxRuns: 10,
      resolution: {},
    });
    const result = {
      schema_version: "3" as const,
      verdict: "pass" as const,
      review_markdown: `# Review\n\n${"Exact evidence. ".repeat(8_000)}`,
      summary: "No findings.",
      actionable_findings: [],
      informational_notes: [],
    };
    const digest = reviewerResultDigest(result);
    const byteCount = Buffer.byteLength(JSON.stringify(result), "utf8");
    await recorder.onRecord({
      record: "reviewer.result",
      run_id: "run-result-reference",
      reviewer_id: "reviewer-1",
      digest,
      byte_count: byteCount,
      result,
    });
    await recorder.onEvent({
      schema_version: "5",
      event: "reviewer.result",
      run_id: "run-result-reference",
      seq: 1,
      timestamp: "2026-09-04T00:00:00.000Z",
      reviewer_id: "reviewer-1",
      data: { digest, byte_count: byteCount },
    });
    await recorder.close();

    const records = (
      await readFile(join(runsDirectory, "run-result-reference.jsonl"), "utf8")
    )
      .trim()
      .split("\n")
      .map((entry) => JSON.parse(entry) as Record<string, unknown>);
    const mirrored = records.find((entry) => entry.event === "reviewer.result");
    expect(mirrored).toMatchObject({
      event: "reviewer.result",
      data: { digest, byte_count: byteCount },
    });
    expect((mirrored?.data as Record<string, unknown>).result).toBeUndefined();
    expect(JSON.stringify(records).match(/Exact evidence\./gu)).toHaveLength(
      8_000,
    );
  });

  it("publishes a sanitized run record at the exact run path only after close", async () => {
    const root = await temporaryRoot();
    const runsDirectory = join(root, "application-data", "runs");
    const recorder = createRunRecorder({
      runsDirectory,
      applicationDataRoot: join(root, "application-data"),
      runId: "run-current",
      maxRuns: 3,
      resolution: {
        reviewer: { id: "reviewer-1", api_key: "must-not-persist" },
        nested: [{ authorization: "Bearer must-not-persist" }],
      },
    });

    await recorder.onEvent(startedEvent());
    await expect(
      readFile(join(runsDirectory, "run-current.jsonl"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      readFile(await activeRecordPath(runsDirectory), "utf8"),
    ).resolves.toContain('"event":"run.started"');
    await recorder.close();

    const lines = (
      await readFile(join(runsDirectory, "run-current.jsonl"), "utf8")
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines).toEqual([
      {
        record: "resolution",
        run_id: "run-current",
        resolution: {
          reviewer: { id: "reviewer-1", api_key: "[redacted]" },
          nested: [{ authorization: "[redacted]" }],
        },
      },
      startedEvent(),
    ]);
    expect((await stat(join(root, "application-data"))).isDirectory()).toBe(
      true,
    );
    await expect(readdir(runsDirectory)).resolves.not.toEqual(
      expect.arrayContaining([expect.stringMatching(/active/)]),
    );
  });

  it("rejects events atomically once close begins while flushing already queued work", async () => {
    const root = await temporaryRoot();
    const runsDirectory = join(root, "runs");
    let releaseOpen!: () => void;
    const openMayContinue = new Promise<void>((resolve) => {
      releaseOpen = resolve;
    });
    let signalOpenStarted!: () => void;
    const openStarted = new Promise<void>((resolve) => {
      signalOpenStarted = resolve;
    });
    const recorder = createRunRecorder({
      runsDirectory,
      applicationDataRoot: root,
      runId: "run-current",
      maxRuns: 1,
      resolution: {},
      beforeOperation: async (operation) => {
        if (operation !== "open") return;
        signalOpenStarted();
        await openMayContinue;
      },
    });
    const queued = recorder.onEvent(startedEvent());
    await openStarted;

    const closing = recorder.close();
    await expect(
      recorder.onEvent({ ...startedEvent(), seq: 2 }),
    ).rejects.toThrow(/closing|closed/i);
    releaseOpen();
    await Promise.all([queued, closing]);

    const contents = await readFile(
      join(runsDirectory, "run-current.jsonl"),
      "utf8",
    );
    expect(contents).toContain('"seq":1');
    expect(contents).not.toContain('"seq":2');
  });

  it("rejects post-close events without recreating or modifying the record", async () => {
    const root = await temporaryRoot();
    const runsDirectory = join(root, "runs");
    const recorder = createRunRecorder({
      runsDirectory,
      applicationDataRoot: root,
      runId: "run-current",
      maxRuns: 1,
      resolution: {},
    });
    await recorder.onEvent(startedEvent());
    const firstClose = recorder.close();
    const secondClose = recorder.close();
    expect(secondClose).toBe(firstClose);
    await firstClose;
    const before = await readFile(
      join(runsDirectory, "run-current.jsonl"),
      "utf8",
    );

    await expect(
      recorder.onEvent({ ...startedEvent(), seq: 2 }),
    ).rejects.toThrow(/closing|closed/i);
    await recorder.close();

    await expect(
      readFile(join(runsDirectory, "run-current.jsonl"), "utf8"),
    ).resolves.toBe(before);
    expect(
      (await readdir(runsDirectory)).filter((name) =>
        name.includes(".active."),
      ),
    ).toEqual([]);
  });

  it("redacts matching keys recursively and caps each persisted string at 64 KiB", async () => {
    const root = await temporaryRoot();
    const runsDirectory = join(root, "runs");
    const recorder = createRunRecorder({
      runsDirectory,
      applicationDataRoot: root,
      runId: "run-current",
      maxRuns: 1,
      resolution: {
        token: "top-secret",
        children: [{ PASSWORD: "nested-secret" }],
        long: "x".repeat(64 * 1024 + 100),
      },
    });

    await recorder.onEvent(startedEvent());
    await recorder.close();

    const header = JSON.parse(
      (await readFile(join(runsDirectory, "run-current.jsonl"), "utf8")).split(
        "\n",
      )[0]!,
    ) as { resolution: Record<string, unknown> };
    expect(header.resolution).toMatchObject({
      token: "[redacted]",
      children: [{ PASSWORD: "[redacted]" }],
    });
    const long = header.resolution.long;
    expect(typeof long).toBe("string");
    if (typeof long !== "string") throw new Error("missing long string");
    expect(Buffer.byteLength(long, "utf8")).toBeLessThanOrEqual(64 * 1024);
    expect(long).toContain("[truncated]");
  });

  it("truncates multi-megabyte UTF-8 values and colliding keys on character boundaries", async () => {
    const root = await temporaryRoot();
    const runsDirectory = join(root, "runs");
    const large = "😀漢é".repeat(300_000);
    const recorder = createRunRecorder({
      runsDirectory,
      applicationDataRoot: root,
      runId: "run-current",
      maxRuns: 1,
      resolution: {
        [`${large}a`]: large,
        [`${large}b`]: "second",
        [`token${large}`]: "must-not-persist",
      },
    });

    await recorder.onEvent(startedEvent());
    await recorder.close();

    const header = JSON.parse(
      (await readFile(join(runsDirectory, "run-current.jsonl"), "utf8")).split(
        "\n",
      )[0]!,
    ) as { resolution: Record<string, string> };
    const keys = Object.keys(header.resolution);
    expect(keys).toHaveLength(3);
    expect(new Set(keys)).toHaveLength(3);
    expect(
      keys.every(
        (key) =>
          Buffer.byteLength(key, "utf8") <= 64 * 1024 && !key.includes("�"),
      ),
    ).toBe(true);
    const truncatedValue = Object.values(header.resolution).find((value) =>
      value.endsWith("[truncated]"),
    );
    expect(truncatedValue).toBeDefined();
    if (truncatedValue === undefined)
      throw new Error("missing truncated value");
    expect(Buffer.byteLength(truncatedValue, "utf8")).toBeLessThanOrEqual(
      64 * 1024,
    );
    expect(Buffer.byteLength(truncatedValue, "utf8")).toBeGreaterThan(
      64 * 1024 - 4,
    );
    expect(truncatedValue).not.toContain("�");
    expect(Object.values(header.resolution)).toEqual(
      expect.arrayContaining(["second", "[redacted]"]),
    );
  }, 10_000);

  it("removes the oldest prior run records above the configured retention count", async () => {
    const root = await temporaryRoot();
    const runsDirectory = join(root, "runs");
    await mkdir(runsDirectory, { recursive: true });
    const old = join(runsDirectory, "run-old.jsonl");
    const middle = join(runsDirectory, "run-middle.jsonl");
    await completedLegacy(root, "run-old");
    await completedLegacy(root, "run-middle");
    const recorder = createRunRecorder({
      runsDirectory,
      applicationDataRoot: root,
      runId: "run-current",
      maxRuns: 2,
      resolution: {},
    });

    await recorder.onEvent(startedEvent());
    await recorder.onEvent(completedEvent("run-current"));
    await recorder.close();

    await expect(stat(old)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(middle, "utf8")).resolves.toContain(
      '"event":"run.completed"',
    );
    await expect(
      readFile(join(runsDirectory, "run-current.jsonl"), "utf8"),
    ).resolves.toContain('"event":"run.started"');
  });

  it("rejects an injected disk error for the event writer to handle as a non-fatal mirror failure", async () => {
    const root = await temporaryRoot();
    const diskError = new Error("disk unavailable");
    const fileSystem: RunRecorderFileSystem = {
      mkdir: async () => undefined,
      readdir: async () => {
        throw diskError;
      },
      stat: async () => {
        throw new Error("not reached");
      },
      rm: async () => undefined,
      link,
    };
    const recorder = createRunRecorder({
      runsDirectory: join(root, "runs"),
      applicationDataRoot: root,
      runId: "run-current",
      maxRuns: 1,
      resolution: {},
      fileSystem,
    });

    await expect(recorder.onEvent(startedEvent())).rejects.toBe(diskError);
  });

  it.each(["", "..", "nested/name", "nested\\name", "run:stream"])(
    "rejects unsafe run id %j before any filesystem write",
    (runId) => {
      const root = join(tmpdir(), "review-mesh-recorder-invalid");

      expect(() =>
        createRunRecorder({
          runsDirectory: join(root, "runs"),
          applicationDataRoot: root,
          runId,
          maxRuns: 1,
          resolution: {},
        }),
      ).toThrow(/run id/i);
    },
  );

  it("rejects a lexically outside runs directory", () => {
    const root = join(tmpdir(), "review-mesh-recorder-root");

    expect(() =>
      createRunRecorder({
        applicationDataRoot: root,
        runsDirectory: join(root, "..", "escaped-runs"),
        runId: "run-current",
        maxRuns: 1,
        resolution: {},
      }),
    ).toThrow(/within the application-data root/i);
  });

  it("uses POSIX path component rules when checking containment", () => {
    expect(
      isWithinDirectory("/application-data", "/application-data/runs", posix),
    ).toBe(true);
    expect(
      isWithinDirectory(
        "/application-data",
        "/application-data-other/runs",
        posix,
      ),
    ).toBe(false);
    expect(isWithinDirectory("/application-data", "/outside/runs", posix)).toBe(
      false,
    );
  });

  it("walks mixed-case win32 paths with path-semantic equality", () => {
    expect(
      directoriesBelow(
        "C:\\ApplicationData",
        "c:\\applicationdata\\runs",
        win32,
      ),
    ).toEqual(["c:\\applicationdata\\runs"]);
  });

  it("rejects an ancestor walk that reaches a fixed path before its root", () => {
    const fixedPathSemantics = {
      relative: () => "different",
      isAbsolute: () => false,
      sep: "/",
      dirname: (path: string) => path,
    };

    expect(() =>
      directoriesBelow(
        "/application-data",
        "/application-data/runs",
        fixedPathSemantics,
      ),
    ).toThrow(/could not reach application-data root/i);
  });

  it("preserves distinct values when long keys truncate to the same prefix", async () => {
    const root = await temporaryRoot();
    const runsDirectory = join(root, "runs");
    const shared = "x".repeat(64 * 1024 + 10);
    const firstKey = `${shared}a`;
    const secondKey = `${shared}b`;
    const sensitiveKey = `token${shared}`;
    const recorder = createRunRecorder({
      runsDirectory,
      applicationDataRoot: root,
      runId: "run-current",
      maxRuns: 1,
      resolution: {
        [firstKey]: "first",
        [secondKey]: "second",
        [sensitiveKey]: "must-not-persist",
      },
    });

    await recorder.onEvent(startedEvent());
    await recorder.close();

    const header = JSON.parse(
      (await readFile(join(runsDirectory, "run-current.jsonl"), "utf8")).split(
        "\n",
      )[0]!,
    ) as { resolution: Record<string, string> };
    const keys = Object.keys(header.resolution);
    expect(keys).toHaveLength(3);
    expect(new Set(keys)).toHaveLength(3);
    expect(
      keys.every((key) => Buffer.byteLength(key, "utf8") <= 64 * 1024),
    ).toBe(true);
    expect(Object.values(header.resolution)).toEqual(
      expect.arrayContaining(["first", "second", "[redacted]"]),
    );
  });

  it("preserves an own __proto__ property through sanitized JSON serialization", async () => {
    const root = await temporaryRoot();
    const runsDirectory = join(root, "runs");
    const resolution = JSON.parse(
      '{"__proto__":"own-prototype-value","ordinary":"kept"}',
    ) as Record<string, string>;
    const recorder = createRunRecorder({
      runsDirectory,
      applicationDataRoot: root,
      runId: "run-current",
      maxRuns: 1,
      resolution,
    });

    await recorder.onEvent(startedEvent());
    await recorder.close();

    const header = JSON.parse(
      (await readFile(join(runsDirectory, "run-current.jsonl"), "utf8")).split(
        "\n",
      )[0]!,
    ) as { resolution: Record<string, string> };
    expect(Object.hasOwn(header.resolution, "__proto__")).toBe(true);
    expect(header.resolution.__proto__).toBe("own-prototype-value");
    expect(header.resolution.ordinary).toBe("kept");
  });

  it("converges retention when recorders initialize concurrently", async () => {
    const root = await temporaryRoot();
    const runsDirectory = join(root, "runs");
    await mkdir(runsDirectory, { recursive: true });
    await completedLegacy(root, "run-old-a");
    await completedLegacy(root, "run-old-b");
    const first = createRunRecorder({
      runsDirectory,
      applicationDataRoot: root,
      runId: "run-current-a",
      maxRuns: 2,
      resolution: {},
    });
    const second = createRunRecorder({
      runsDirectory,
      applicationDataRoot: root,
      runId: "run-current-b",
      maxRuns: 2,
      resolution: {},
    });

    await Promise.all([
      first.onEvent({ ...startedEvent(), run_id: "run-current-a" }),
      second.onEvent({ ...startedEvent(), run_id: "run-current-b" }),
    ]);
    await Promise.all([
      first.onEvent(completedEvent("run-current-a")),
      second.onEvent(completedEvent("run-current-b")),
    ]);

    await Promise.all([first.close(), second.close()]);
    expect(
      (await readdir(runsDirectory)).filter((name) => name.endsWith(".jsonl")),
    ).toHaveLength(2);
    expect(
      (await readdir(runsDirectory)).filter((name) =>
        name.includes(".active."),
      ),
    ).toEqual([]);
  });

  it("never considers another recorder's active file for retention", async () => {
    const root = await temporaryRoot();
    const runsDirectory = join(root, "runs");
    let releaseRetention!: () => void;
    const retentionMayContinue = new Promise<void>((resolve) => {
      releaseRetention = resolve;
    });
    let signalRetentionStarted!: () => void;
    const retentionStarted = new Promise<void>((resolve) => {
      signalRetentionStarted = resolve;
    });
    const pausingFileSystem: RunRecorderFileSystem = {
      mkdir,
      readdir: async (path, options) => {
        if ((await readdir(path)).some((name) => name.endsWith(".jsonl"))) {
          signalRetentionStarted();
          await retentionMayContinue;
        }
        return readdir(path, options);
      },
      stat,
      rm: async (path) => rm(path),
      link,
    };
    const first = createRunRecorder({
      runsDirectory,
      applicationDataRoot: root,
      runId: "run-current-a",
      maxRuns: 1,
      resolution: {},
    });
    const second = createRunRecorder({
      runsDirectory,
      applicationDataRoot: root,
      runId: "run-current-b",
      maxRuns: 1,
      resolution: {},
      fileSystem: pausingFileSystem,
    });

    await first.onEvent({ ...startedEvent(), run_id: "run-current-a" });
    await second.onEvent({ ...startedEvent(), run_id: "run-current-b" });
    await second.onEvent(completedEvent("run-current-b"));
    const closingSecond = second.close();
    await retentionStarted;
    await first.onEvent({ ...startedEvent(), seq: 2 });

    await expect(
      readFile(await activeRecordPath(runsDirectory), "utf8"),
    ).resolves.toContain('"seq":2');
    releaseRetention();
    await closingSecond;
    await first.onEvent(completedEvent("run-current-a"));
    await first.close();

    expect(
      (await readdir(runsDirectory)).filter((name) =>
        name.includes(".active."),
      ),
    ).toEqual([]);
    expect(
      (await readdir(runsDirectory)).filter((name) => name.endsWith(".jsonl")),
    ).toHaveLength(1);
  });

  it("removes an old abandoned active record owned by a dead process", async () => {
    const root = await temporaryRoot();
    const runsDirectory = join(root, "runs");
    await mkdir(runsDirectory, { recursive: true });
    const stale = join(
      runsDirectory,
      "run-abandoned.jsonl.active.424242.1000.abandoned-owner",
    );
    await writeFile(stale, "partial\n");
    await utimes(stale, new Date(1_000), new Date(1_000));
    const recorder = createRunRecorder({
      runsDirectory,
      applicationDataRoot: root,
      runId: "run-current",
      maxRuns: 1,
      resolution: {},
      now: () => 2 * 60 * 60 * 1_000,
      isProcessAlive: () => false,
    });

    await recorder.onEvent(startedEvent());

    await expect(stat(stale)).rejects.toMatchObject({ code: "ENOENT" });
    await recorder.close();
  });

  it("keeps an old active record while its owning process is alive", async () => {
    const root = await temporaryRoot();
    const runsDirectory = join(root, "runs");
    await mkdir(runsDirectory, { recursive: true });
    const live = join(
      runsDirectory,
      "run-live.jsonl.active.31337.1000.live-owner",
    );
    await writeFile(live, "partial\n");
    await utimes(live, new Date(1_000), new Date(1_000));
    const recorder = createRunRecorder({
      runsDirectory,
      applicationDataRoot: root,
      runId: "run-current",
      maxRuns: 1,
      resolution: {},
      now: () => 2 * 60 * 60 * 1_000,
      isProcessAlive: () => true,
    });

    await recorder.onEvent(startedEvent());
    await recorder.close();

    await expect(readFile(live, "utf8")).resolves.toBe("partial\n");
  });

  it("eventually removes an orphan older than the maximum age despite PID reuse", async () => {
    const root = await temporaryRoot();
    const runsDirectory = join(root, "runs");
    await mkdir(runsDirectory, { recursive: true });
    const reusedPidOrphan = join(
      runsDirectory,
      "run-orphan.jsonl.active.31337.1000.reused-pid",
    );
    await writeFile(reusedPidOrphan, "partial\n");
    await utimes(reusedPidOrphan, new Date(1_000), new Date(1_000));
    const recorder = createRunRecorder({
      runsDirectory,
      applicationDataRoot: root,
      runId: "run-current",
      maxRuns: 1,
      resolution: {},
      now: () => 31 * 24 * 60 * 60 * 1_000,
      isProcessAlive: () => true,
    });

    await recorder.onEvent(startedEvent());

    await expect(stat(reusedPidOrphan)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await recorder.close();
  });

  it("does not let an abandoned active name block a new owner of the same run id", async () => {
    const root = await temporaryRoot();
    const runsDirectory = join(root, "runs");
    await mkdir(runsDirectory, { recursive: true });
    await writeFile(
      join(
        runsDirectory,
        "run-current.jsonl.active.424242.1000.previous-owner",
      ),
      "partial\n",
    );
    const recorder = createRunRecorder({
      runsDirectory,
      applicationDataRoot: root,
      runId: "run-current",
      maxRuns: 1,
      resolution: {},
      processIdentity: {
        pid: 31337,
        startedAtMs: 2000,
        nonce: "new-owner",
      },
    });

    await recorder.onEvent(startedEvent());
    await recorder.close();

    await expect(
      readFile(join(runsDirectory, "run-current.jsonl"), "utf8"),
    ).resolves.toContain('"event":"run.started"');
  });

  it("fails closed when the runs directory is a symlink outside application data", async () => {
    const root = await temporaryRoot();
    const applicationDataRoot = join(root, "application-data");
    const outside = join(root, "outside");
    const runsDirectory = join(applicationDataRoot, "runs");
    await Promise.all([
      mkdir(applicationDataRoot, { recursive: true }),
      mkdir(outside, { recursive: true }),
    ]);
    await symlink(
      outside,
      runsDirectory,
      process.platform === "win32" ? "junction" : "dir",
    );
    const recorder = createRunRecorder({
      runsDirectory,
      applicationDataRoot,
      runId: "run-current",
      maxRuns: 1,
      resolution: {},
    });

    await expect(recorder.onEvent(startedEvent())).rejects.toThrow(/symlink/i);
    await expect(readdir(outside)).resolves.toEqual([]);
  });

  it("fails closed when the requested run file is a symlink", async () => {
    const root = await temporaryRoot();
    const runsDirectory = join(root, "runs");
    const outside = join(root, "outside.jsonl");
    await mkdir(runsDirectory, { recursive: true });
    await writeFile(outside, "outside\n");
    await symlink(outside, join(runsDirectory, "run-current.jsonl"));
    const recorder = createRunRecorder({
      runsDirectory,
      applicationDataRoot: root,
      runId: "run-current",
      maxRuns: 1,
      resolution: {},
    });

    await expect(recorder.onEvent(startedEvent())).rejects.toThrow(
      /exist|symlink/i,
    );
    await expect(readFile(outside, "utf8")).resolves.toBe("outside\n");
  });

  it("ignores unrelated active-looking symlinks instead of following them", async () => {
    const root = await temporaryRoot();
    const runsDirectory = join(root, "runs");
    const outside = join(root, "outside.jsonl");
    await mkdir(runsDirectory, { recursive: true });
    await writeFile(outside, "outside\n");
    await symlink(
      outside,
      join(runsDirectory, "run-current.jsonl.active.12.1.stale-owner"),
    );
    const recorder = createRunRecorder({
      runsDirectory,
      applicationDataRoot: root,
      runId: "run-current",
      maxRuns: 1,
      resolution: {},
    });

    await expect(recorder.onEvent(startedEvent())).resolves.toBeUndefined();
    await recorder.close();
    await expect(readFile(outside, "utf8")).resolves.toBe("outside\n");
  });

  it("rejects an active-path replacement before publication and removes no replacement target", async () => {
    const root = await temporaryRoot();
    const runsDirectory = join(root, "runs");
    const displaced = join(root, "displaced-active.jsonl");
    let activePath: string | undefined;
    let replaceBeforeLink = false;
    const observingFileSystem: RunRecorderFileSystem = {
      mkdir,
      readdir,
      stat,
      rm: async (path) => rm(path),
      link: async (existingPath, newPath) => {
        activePath = existingPath;
        if (replaceBeforeLink) {
          await rename(existingPath, displaced);
          await writeFile(existingPath, "attacker replacement\n");
        }
        await link(existingPath, newPath);
      },
    };
    const recorder = createRunRecorder({
      runsDirectory,
      applicationDataRoot: root,
      runId: "run-current",
      maxRuns: 1,
      resolution: {},
      fileSystem: observingFileSystem,
      beforeOperation: async (operation) => {
        if (operation === "link") replaceBeforeLink = true;
      },
    });

    await recorder.onEvent(startedEvent());
    await expect(recorder.close()).rejects.toThrow(/identity/i);

    expect(activePath).toBeDefined();
    await expect(
      stat(join(runsDirectory, "run-current.jsonl")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(displaced, "utf8")).resolves.toContain(
      '"event":"run.started"',
    );
  });

  it("rejects an immutable link failure and leaves no published artifact", async () => {
    const root = await temporaryRoot();
    const runsDirectory = join(root, "runs");
    const failure = new Error("link failed");
    const recorder = createRunRecorder({
      applicationDataRoot: root,
      runsDirectory,
      runId: "run-link-failure",
      maxRuns: 1,
      resolution: {},
      fileSystem: {
        mkdir,
        readdir,
        stat,
        rm: async (path) => rm(path),
        link: async () => {
          throw failure;
        },
      },
    });

    await recorder.onEvent(startedEvent());
    await expect(recorder.close()).rejects.toBe(failure);
    await expect(
      stat(join(runsDirectory, "run-link-failure.jsonl")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("detects a runs-directory swap before open without writing outside", async () => {
    const root = await temporaryRoot();
    const applicationDataRoot = join(root, "application-data");
    const runsDirectory = join(applicationDataRoot, "runs");
    const displacedRuns = join(applicationDataRoot, "runs-original");
    const outside = join(root, "outside");
    await Promise.all([
      mkdir(runsDirectory, { recursive: true }),
      mkdir(outside, { recursive: true }),
    ]);
    const recorder = createRunRecorder({
      runsDirectory,
      applicationDataRoot,
      runId: "run-current",
      maxRuns: 1,
      resolution: {},
      beforeOperation: async (operation: RunRecorderOperation) => {
        if (operation !== "open") return;
        await rename(runsDirectory, displacedRuns);
        await symlink(
          outside,
          runsDirectory,
          process.platform === "win32" ? "junction" : "dir",
        );
      },
    });

    await expect(recorder.onEvent(startedEvent())).rejects.toThrow(
      /runs directory changed|identity/i,
    );
    await expect(readdir(outside)).resolves.toEqual([]);
    await expect(readdir(displacedRuns)).resolves.toEqual([]);
    expect((await lstat(runsDirectory)).isSymbolicLink()).toBe(true);
  });
});
