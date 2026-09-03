import {
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
  expect(persisted).not.toContain("key-value");
});

describe("RunRecorder", () => {
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
    await Promise.all([writeFile(old, "old\n"), writeFile(middle, "middle\n")]);
    await utimes(
      old,
      new Date("2026-08-28T00:00:00.000Z"),
      new Date("2026-08-28T00:00:00.000Z"),
    );
    await utimes(
      middle,
      new Date("2026-08-29T00:00:00.000Z"),
      new Date("2026-08-29T00:00:00.000Z"),
    );
    const recorder = createRunRecorder({
      runsDirectory,
      applicationDataRoot: root,
      runId: "run-current",
      maxRuns: 2,
      resolution: {},
    });

    await recorder.onEvent(startedEvent());
    await recorder.close();

    await expect(stat(old)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(middle, "utf8")).resolves.toBe("middle\n");
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
    await Promise.all([
      writeFile(join(runsDirectory, "run-old-a.jsonl"), "old\n"),
      writeFile(join(runsDirectory, "run-old-b.jsonl"), "old\n"),
    ]);
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
      first.onEvent(startedEvent()),
      second.onEvent(startedEvent()),
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

    await first.onEvent(startedEvent());
    await second.onEvent(startedEvent());
    const closingSecond = second.close();
    await retentionStarted;
    await first.onEvent({ ...startedEvent(), seq: 2 });

    await expect(
      readFile(await activeRecordPath(runsDirectory), "utf8"),
    ).resolves.toContain('"seq":2');
    releaseRetention();
    await closingSecond;
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
