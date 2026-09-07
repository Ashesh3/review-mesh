import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { publicEventV6Schema } from "../../src/protocol/v9.js";
import { loadV9Run } from "../../src/diagnostics/v9-views.js";

const roots: string[] = [];
const require = createRequire(import.meta.url);
const fixture = resolve(
  import.meta.dirname,
  "../helpers/native-cli-shutdown-fixture.ts",
);
const runtimes = [
  {
    name: "Node",
    executable: process.execPath,
    args: ["--import", pathToFileURL(require.resolve("tsx")).href],
  },
  ...(process.env.BUN_EXE
    ? [{ name: "Bun", executable: process.env.BUN_EXE, args: [] }]
    : []),
];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

it.each(
  runtimes.flatMap((runtime) =>
    (
      [
        ["complete", 0],
        ["error", 3],
        ["cancel", 4],
        ["deadline", 3],
      ] as const
    ).map(([scenario, expectedCode]) => ({ runtime, scenario, expectedCode })),
  ),
)(
  "$runtime.name naturally exits and flushes the terminal artifact after native Copilot $scenario",
  async ({ runtime, scenario, expectedCode }) => {
    const root = await mkdtemp(join(tmpdir(), "mesh-cli-shutdown-"));
    roots.push(root);
    const child = spawn(
      runtime.executable,
      [...runtime.args, fixture, root, scenario],
      {
        windowsHide: true,
        stdio: "pipe",
      },
    );
    const output: Buffer[] = [];
    const errors: Buffer[] = [];
    let timedOut = false;
    let terminalObserved = false;
    let pendingLine = "";
    let terminalAt: number | undefined;
    const killOwnedFixture = () => {
      timedOut = true;
      child.kill();
    };
    let guard = setTimeout(killOwnedFixture, 12000);
    child.stdout.on("data", (chunk: Buffer) => {
      output.push(chunk);
      pendingLine += chunk.toString("utf8");
      const lines = pendingLine.split("\n");
      pendingLine = lines.pop()!;
      for (const line of lines) {
        if (!line) continue;
        if (JSON.parse(line).event === "run.completed") {
          terminalObserved = true;
          terminalAt = Date.now();
          clearTimeout(guard);
          guard = setTimeout(killOwnedFixture, 1500);
        }
      }
    });
    child.stderr.on("data", (chunk: Buffer) => errors.push(chunk));
    child.stdin.on("error", () => undefined);
    child.stdin.end(
      JSON.stringify({
        schema_version: "3",
        project_name: "workspace",
        workspace: join(root, "workspace"),
        instructions: "Review the fixture.",
        review_scope: { mode: "full" },
      }),
    );
    const result = await new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolveResult, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolveResult({ code, signal }));
    }).finally(() => clearTimeout(guard));
    const closedAt = Date.now();
    const stdout = Buffer.concat(output).toString("utf8");
    const stderr = Buffer.concat(errors).toString("utf8");
    expect(stderr).toBe("");
    expect(terminalObserved).toBe(true);
    const returned = JSON.parse(
      await readFile(join(root, "returned.json"), "utf8"),
    );
    expect(
      timedOut,
      `CLI retained resources after returning: ${JSON.stringify(returned)}`,
    ).toBe(false);
    expect(result).toEqual({ code: expectedCode, signal: null });
    expect(closedAt - terminalAt!).toBeLessThan(1500);
    expect(stdout.endsWith("\n")).toBe(true);
    expect(pendingLine).toBe("");
    const events = stdout
      .trim()
      .split("\n")
      .map((line) => publicEventV6Schema.parse(JSON.parse(line)));
    expect(events.map((event) => event.seq)).toEqual(
      events.map((_, index) => index + 1),
    );
    expect(
      events.filter((event) => event.event === "run.completed"),
    ).toHaveLength(1);
    const terminal = events.at(-1)!;
    expect(terminal).toMatchObject({
      event: "run.completed",
      data: { exit_code: expectedCode },
    });
    const report = await loadV9Run(join(root, "runs"), terminal.run_id);
    expect(report?.active).toBe(false);
    expect(returned).toMatchObject({
      code: expectedCode,
      sends: 1,
      signalListeners: 0,
    });
    const exit = JSON.parse(await readFile(join(root, "exit.json"), "utf8"));
    expect(exit.code).toBe(expectedCode);
  },
);
