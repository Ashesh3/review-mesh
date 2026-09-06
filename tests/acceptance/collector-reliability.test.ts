import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";

const enabled = process.env.REVIEW_MESH_VERIFY_STANDALONE === "1";
async function execute(
  file: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  input = "",
) {
  const child = spawn(file, args, {
    cwd,
    env,
    stdio: "pipe",
    windowsHide: true,
  });
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (chunk) => (stdout += String(chunk)));
  child.stderr.on("data", (chunk) => (stderr += String(chunk)));
  child.stdin.end(input);
  const code = await new Promise<number | null>((done, reject) => {
    child.once("error", reject);
    child.once("close", done);
  });
  return { code, stdout, stderr };
}

it.skipIf(!enabled)(
  "completes a strict 35-file 1.6MB review when the provider never asks for source",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "mesh-collector-acceptance-"));
    const workspace = join(root, "workspace"),
      home = join(root, "home");
    await mkdir(workspace);
    await mkdir(home);
    const expected = new Map<string, Buffer>();
    for (let index = 0; index < 35; index++)
      expected.set(
        `source-${index}.txt`,
        Buffer.from(
          `source ${index}: λ deterministic evidence\n`.repeat(
            index === 0 ? 6000 : 1250,
          ),
        ),
      );
    const delivered = new Map<string, Map<string, Array<[number, number]>>>();
    let providerCalls = 0;
    const capacities = [64000, 96000, 128000, 192000, 256000];
    const server = createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/v1/models") {
        res.end(
          JSON.stringify({
            data: Array.from({ length: 5 }, (_, i) => ({
              id: `model-${i}`,
              capabilities: {
                limits: {
                  max_context_window_tokens: capacities[i],
                  max_output_tokens: 8192,
                },
              },
            })),
          }),
        );
        return;
      }
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString());
          expect(Buffer.byteLength(JSON.stringify(body)) + 256).toBeLessThan(
            capacities[Number(body.model.split("-")[1])]! - 8192,
          );
          providerCalls++;
          const key = String(req.headers["x-client-session-id"]);
          const byFile =
            delivered.get(key) ?? new Map<string, Array<[number, number]>>();
          delivered.set(key, byFile);
          const segment = body.messages.flatMap((m: { content: unknown }) => {
            try {
              const value = JSON.parse(String(m.content));
              return value.kind === "review-mesh.segment" ? [value] : [];
            } catch {
              return [];
            }
          })[0];
          if (segment) {
            for (const range of segment.source_ranges.filter(
              (r: { kind: string }) => r.kind === "snapshot",
            )) {
              const bytes = Buffer.from(range.content, "utf8");
              expect(
                bytes.equals(
                  expected
                    .get(range.path)!
                    .subarray(range.offset, range.offset + range.byte_count),
                ),
              ).toBe(true);
              const seen = byFile.get(range.path) ?? [];
              seen.push([range.offset, range.offset + range.byte_count]);
              byFile.set(range.path, seen);
            }
            res.end(
              JSON.stringify({
                choices: [
                  {
                    message: {
                      role: "assistant",
                      content: JSON.stringify({
                        summary:
                          "Synthetic bounded-source checkpoint; quality not evaluated.",
                        findings: [],
                        unresolved_questions: [],
                        resolved_question_ids: [],
                        follow_up_reads: [],
                        scenario_checks: [
                          {
                            path:
                              segment.source_ranges.find(
                                (r: { kind: string }) => r.kind === "snapshot",
                              )?.path ?? "source-0.txt",
                            start_line: 1,
                            end_line: 1,
                            input: 1,
                            expected: 1,
                            observed: 1,
                            reasoning: "Synthetic infrastructure fixture only.",
                          },
                        ],
                      }),
                    },
                    finish_reason: "stop",
                  },
                ],
              }),
            );
            return;
          }
          for (const message of body.messages) {
            if (
              typeof message.content !== "string" ||
              !message.content.startsWith(
                "Required source snapshot (untrusted data):\n",
              )
            )
              continue;
            const range = JSON.parse(
              message.content.split("\n").slice(1).join("\n"),
            );
            const bytes = Buffer.from(
              range.content,
              range.encoding === "base64" ? "base64" : "utf8",
            );
            expect(
              bytes.equals(
                expected
                  .get(range.path)!
                  .subarray(range.offset, range.offset + range.byte_count),
              ),
            ).toBe(true);
            const seen = byFile.get(range.path) ?? [];
            seen.push([range.offset, range.offset + range.byte_count]);
            byFile.set(range.path, seen);
          }
          let message: Record<string, unknown> = {
            role: "assistant",
            content:
              "Inspecting supplied source; retain coverage requirements.",
          };
          if (!body.tools) {
            for (const [path, bytes] of expected) {
              let covered = 0;
              for (const [start, end] of (byFile.get(path) ?? []).sort(
                (a, b) => a[0] - b[0],
              )) {
                expect(start).toBeLessThanOrEqual(covered);
                covered = Math.max(covered, end);
              }
              expect(covered, path).toBe(bytes.length);
            }
            const assignment = [...body.messages]
              .reverse()
              .flatMap((m: { content: string }) => {
                try {
                  const value = JSON.parse(m.content);
                  return value.result_id && Number.isInteger(value.page_index)
                    ? [value]
                    : [];
                } catch {
                  return [];
                }
              })[0];
            if (!assignment) throw Error("Missing page assignment");
            message = {
              role: "assistant",
              content: JSON.stringify({
                schema_version: "1",
                kind: "review-mesh.result-page",
                result_id: assignment.result_id,
                result_kind: "reviewer",
                result_schema_version: "4",
                page_index: 0,
                page_count: 1,
                page_kind: "header",
                previous_page_digest: null,
                payload: {
                  verdict: "pass",
                  summary:
                    "All 35 source files were delivered exactly and reviewed.",
                  informational_notes: [
                    {
                      title: "Coverage",
                      description: "Observed exact immutable source delivery.",
                    },
                  ],
                  narrative_byte_count: 0,
                  narrative_fragment_count: 0,
                  actionable_finding_count: 0,
                },
              }),
            };
          }
          res.end(
            JSON.stringify({ choices: [{ message, finish_reason: "stop" }] }),
          );
        } catch (error) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: { message: String(error) } }));
        }
      });
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const address = server.address();
    if (!address || typeof address === "string") throw Error("No listener");
    try {
      for (const [path, bytes] of expected)
        await writeFile(join(workspace, path), bytes);
      for (const args of [
        ["init", "--initial-branch=main"],
        ["add", "."],
        [
          "-c",
          "user.name=Fixture",
          "-c",
          "user.email=fixture@localhost",
          "-c",
          "commit.gpgsign=false",
          "-c",
          "core.hooksPath=/dev/null",
          "commit",
          "-m",
          "baseline",
        ],
      ])
        expect((await execute("git", args, workspace, process.env)).code).toBe(
          0,
        );
      for (const [path, bytes] of expected) {
        const changed = Buffer.concat([bytes, Buffer.from("changed line\n")]);
        expected.set(path, changed);
        await writeFile(join(workspace, path), changed);
      }
      const config = join(home, "review-mesh", "Config", "config.toml");
      await mkdir(resolve(config, ".."), { recursive: true });
      await writeFile(
        config,
        `schema_version="7"
[execution]
max_concurrency=5
heartbeat_interval_ms=1000
shutdown_grace_period_ms=1000
deadline_mode="fixed"
run_deadline_ms=120000
no_progress_timeout_ms=30000
review_profile="strict-evaluation"
[diagnostics]
persist_runs=true
max_runs=10
[adapters.fixture]
type="openai_compatible"
base_url_env="COLLECTOR_BASE"
api_key_env="COLLECTOR_KEY"
streaming="disabled"
[agents.collector]
adapter="fixture"
purpose="Collector acceptance"
instructions="Inspect every required file."
isolation="prefer_enforced"
timeout_ms=90000
kind="generic"
required_input=[]
adjudication="off"
pass_quorum=5
minimum_provider_groups=5
allow_zero_outage_tolerance=true
model_runs=[${Array.from({ length: 5 }, (_, i) => `{id="m${i}",model="model-${i}",provider_group="group-${i}"}`).join(",")}]
[agents.collector.applicability]
mode="always"
[agents.collector.change_coverage]
relevant_paths=["**"]
minimum_inspection="full_file"
proof="observed"
[defaults]
agents=["collector"]
`,
      );
      const env = {
        ...process.env,
        APPDATA: home,
        LOCALAPPDATA: home,
        COLLECTOR_BASE: `http://127.0.0.1:${address.port}/v1`,
        COLLECTOR_KEY: "synthetic-local-only",
      };
      const binary = resolve("dist/release/review-mesh-windows-x64.exe");
      const run = await execute(
        binary,
        ["review", "--output-mode", "full-jsonl"],
        root,
        env,
        JSON.stringify({
          schema_version: "3",
          project_name: "workspace",
          workspace,
          instructions: "Review the changed evidence",
          review_scope: { mode: "changes", base: "HEAD" },
        }),
      );
      const failedEvents = run.stdout
        .trim()
        .split(/\r?\n/)
        .flatMap((line) => {
          try {
            const event = JSON.parse(line);
            return event.event === "reviewer.incomplete" ||
              event.event === "run.persistence_failed"
              ? [event]
              : [];
          } catch {
            return [];
          }
        });
      expect(
        run.code,
        run.stderr + JSON.stringify(failedEvents) + run.stdout.slice(-4000),
      ).toBe(0);
      const events = run.stdout
        .trim()
        .split(/\r?\n/)
        .map((line) => JSON.parse(line));
      const terminal = events.at(-1);
      expect(terminal.data).toMatchObject({
        run_outcome: "clear",
        model_runs: { completed: 5, incomplete: 0 },
        change_coverage: { status: "complete" },
        review_profile: "strict-evaluation",
      });
      expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
      expect(delivered.size).toBe(5);
      expect(providerCalls).toBeLessThan(400);
      const report = await execute(
        binary,
        ["report", terminal.run_id, "--format", "markdown"],
        root,
        env,
      );
      expect(report.code).toBe(0);
      expect(report.stdout).toContain("All 35 source files");
      expect(report.stdout).toContain("Observed exact immutable");
      const findings = await execute(
        binary,
        ["findings", terminal.run_id, "--json"],
        root,
        env,
      );
      expect(JSON.parse(findings.stdout)).toMatchObject({
        run_outcome: "clear",
        coverage_outcome: "complete",
        findings: [],
      });
      const artifact = await readFile(terminal.data.artifact.path, "utf8");
      expect(artifact.length).toBeLessThan(2_000_000);
    } finally {
      await new Promise<void>((done, reject) =>
        server.close((error) => (error ? reject(error) : done())),
      );
      await rm(root, { recursive: true, force: true });
    }
  },
  120000,
);
