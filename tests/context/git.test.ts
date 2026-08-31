import { describe, expect, it, vi } from "vitest";
import { createGitRunner, type GitExecutor } from "../../src/context/git.js";

describe("createGitRunner", () => {
  it("runs Git with trusted helper-disabling arguments and environment", async () => {
    const execute = vi.fn<GitExecutor>().mockResolvedValue({
      stdout: "ok",
      stderr: "",
      exitCode: 0,
    });
    const signal = new AbortController().signal;

    const result = await createGitRunner(execute).run(["status", "--short"], {
      cwd: "C:\\workspace",
      signal,
    });

    expect(result).toEqual({ stdout: "ok", stderr: "", exitCode: 0 });
    expect(execute).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledWith(
      "git",
      [
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "core.pager=cat",
        "-c",
        "pager.status=false",
        "-c",
        "pager.diff=false",
        "status",
        "--short",
      ],
      {
        cwd: "C:\\workspace",
        reject: false,
        timeout: 15_000,
        cancelSignal: signal,
        env: {
          GIT_ATTR_NOSYSTEM: "1",
          GIT_DIFF_OPTS: "",
          GIT_EXTERNAL_DIFF: "",
          GIT_OPTIONAL_LOCKS: "0",
          GIT_PAGER: "",
          GIT_TERMINAL_PROMPT: "0",
          PAGER: "",
        },
        maxBuffer: 1_048_576,
      },
    );
  });

  it("retains max-buffer truncation metadata", async () => {
    const execute = vi.fn<GitExecutor>().mockResolvedValue({
      stdout: "partial",
      stderr: "",
      exitCode: null,
      isMaxBuffer: true,
    });

    await expect(
      createGitRunner(execute).run(["rev-parse", "HEAD"], {
        cwd: "/workspace",
      }),
    ).resolves.toEqual({
      stdout: "partial",
      stderr: "",
      exitCode: 1,
      outputTruncated: true,
    });
  });
});
