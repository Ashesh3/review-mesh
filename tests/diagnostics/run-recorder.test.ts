import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
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
    schema_version: "1",
    event: "run.started",
    run_id: "run-current",
    seq: 1,
    timestamp: "2026-08-30T10:00:00.000Z",
    data: { consistency_mode: "live_worktree" },
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("RunRecorder", () => {
  it("writes a sanitized resolution header and normalized public events at the exact run path", async () => {
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
    await recorder.close();
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
    await recorder.close();
  });

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

    await expect(stat(old)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(middle, "utf8")).resolves.toBe("middle\n");
    await expect(
      readFile(join(runsDirectory, "run-current.jsonl"), "utf8"),
    ).resolves.toContain('"event":"run.started"');
    await recorder.close();
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
    await recorder.close();
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

    const header = JSON.parse(
      (await readFile(join(runsDirectory, "run-current.jsonl"), "utf8")).split(
        "\n",
      )[0]!,
    ) as { resolution: Record<string, string> };
    expect(Object.hasOwn(header.resolution, "__proto__")).toBe(true);
    expect(header.resolution.__proto__).toBe("own-prototype-value");
    expect(header.resolution.ordinary).toBe("kept");
    await recorder.close();
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

    expect(
      (await readdir(runsDirectory)).filter((name) => name.endsWith(".jsonl")),
    ).toHaveLength(2);
    await Promise.all([first.close(), second.close()]);
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
});
