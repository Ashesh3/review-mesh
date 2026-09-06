import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";

/** Synthetic infrastructure acceptance, never a claim of live model quality. */
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
  child.stdout.on("data", (value) => {
    stdout += String(value);
  });
  child.stderr.on("data", (value) => {
    stderr += String(value);
  });
  child.stdin.end(input);
  const timer = setTimeout(() => child.kill(), 100000);
  const code = await new Promise<number | null>((done, reject) => {
    child.once("error", reject);
    child.once("close", done);
  }).finally(() => clearTimeout(timer));
  return { code, stdout, stderr };
}
const sha = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
const candidate = {
  id: "cross-file-value",
  severity: "high",
  title: "Changed value violates its consumer contract",
  description:
    "The changed producer returns two while the consumer contract requires one.",
  evidence: [
    {
      path: "src/value.ts",
      start_line: 1,
      end_line: 1,
      detail: "Producer now supplies value two.",
    },
    {
      path: "src/contract.ts",
      start_line: 1,
      end_line: 1,
      detail: "Consumer requires value one.",
    },
  ],
  suggested_direction: "Restore the producer contract.",
  confidence: "high",
  classification: "confirmed_defect",
  external_assumptions: [],
  category: "correctness",
  verification: "Compare producer with the consumer contract.",
  change_impact: "The changed producer value breaks the unchanged contract.",
  claim: {
    trigger: "The producer is imported.",
    affected_behavior: "The consumer receives a value.",
    outcome: "It receives two instead of one.",
  },
};
type ModelState = {
  segments: number;
  syntheses: number;
  corrected: boolean;
  sawErrors: boolean;
  delivered: Map<string, Array<[number, number]>>;
  firstManifest?: unknown;
};

it("completes metadata-first partial-diff follow-up correction through synthesis and nonempty adjudication", async () => {
  const root = await mkdtemp(join(tmpdir(), "mesh-v96-workflow-"));
  const workspace = join(root, "workspace"),
    home = join(root, "home");
  await mkdir(join(workspace, "src"), { recursive: true });
  await mkdir(home);
  const expected = new Map<string, Buffer>();
  const paths = [
    "src/value.ts",
    ...Array.from(
      { length: 34 },
      (_, i) => `src/padding-${String(i).padStart(2, "0")}.ts`,
    ),
  ];
  const content = (path: string, changed: boolean) =>
    Buffer.from(
      (path === "src/value.ts"
        ? `export const value = ${changed ? 2 : 1};\n`
        : `// ${path}\n`) +
        Array.from(
          { length: 700 },
          (_, i) =>
            `// ${changed && i < 100 ? "new" : "old"} ${String(i).padStart(3, "0")} synthetic neutral evidence ${"x".repeat(34)}\n`,
        ).join(""),
    );
  const title = "Synthetic metadata supplied before source review";
  const workItem = "synthetic-work-item-96";
  const states = new Map<string, ModelState>();
  const serverErrors: string[] = [];
  let sourceDiff = Buffer.alloc(0),
    calls = 0;
  const server = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/v1/models") {
      res.end(
        JSON.stringify({
          data: ["reader", "judge"].map((id) => ({
            id,
            capabilities: {
              limits: {
                max_context_window_tokens: 256000,
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
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (++calls > 300)
          throw new Error("Synthetic provider call budget exceeded");
        const model = String(body.model);
        const state: ModelState = states.get(model) ?? {
          segments: 0,
          syntheses: 0,
          corrected: false,
          sawErrors: false,
          delivered: new Map(),
        };
        states.set(model, state);
        const objects = body.messages.flatMap(
          (message: { content: unknown }) => {
            try {
              return [JSON.parse(String(message.content))];
            } catch {
              return [];
            }
          },
        );
        const segment = objects.find(
          (value: any) => value.kind === "review-mesh.segment",
        );
        let result: unknown;
        if (segment) {
          if (state.segments === 0) {
            const text = JSON.stringify(body.messages);
            expect(text).toMatch(/\bJSON\b/);
            expect(text).toContain(title);
            expect(text).toContain(workItem);
            expect(segment.input_manifest).toMatchObject({
              metadata: { pull_request: "supplied", changed_files: "supplied" },
              caller_context: { status: "delivered" },
            });
            state.firstManifest = segment.input_manifest;
          }
          for (const range of segment.source_ranges) {
            const bytes = range.content.startsWith("base64:")
              ? Buffer.from(range.content.slice(7), "base64")
              : Buffer.from(range.content, "utf8");
            expect(bytes.length).toBe(range.byte_count);
            expect(sha(bytes)).toBe(range.sha256);
            if (range.kind === "snapshot" || range.kind === "diff") {
              const original =
                range.kind === "diff" ? sourceDiff : expected.get(range.path);
              expect(original, range.path).toBeDefined();
              expect(
                bytes.equals(
                  original!.subarray(
                    range.offset,
                    range.offset + range.byte_count,
                  ),
                ),
              ).toBe(true);
              const key = range.kind === "diff" ? "<change-diff>" : range.path;
              state.delivered.set(key, [
                ...(state.delivered.get(key) ?? []),
                [range.offset, range.offset + range.byte_count],
              ]);
            }
          }
          const feedback = segment.follow_up_results ?? [];
          if (feedback.some((item: any) => item.status === "rejected")) {
            expect(feedback).toEqual(
              expect.arrayContaining([
                expect.objectContaining({
                  status: "rejected",
                  reason: "not_in_snapshot",
                }),
                expect.objectContaining({
                  status: "rejected",
                  reason: "invalid_range",
                }),
              ]),
            );
            expect(feedback).toEqual(
              expect.arrayContaining([
                expect.objectContaining({
                  status: "queued",
                  kind: "diff",
                  path: "<change-diff>",
                }),
                expect.objectContaining({
                  status: "queued",
                  kind: "context",
                  path: "<caller-context>",
                }),
                expect.objectContaining({
                  status: "queued",
                  kind: "snapshot",
                  path: "src/value.ts",
                }),
              ]),
            );
            expect(
              segment.checkpoint.completed_segments.length,
            ).toBeGreaterThan(0);
            expect(segment.checkpoint.unresolved_questions).toContainEqual(
              expect.objectContaining({ id: "consumer-contract" }),
            );
            if (model === "reader")
              expect(segment.checkpoint.candidate_findings).toContainEqual(
                candidate,
              );
            state.sawErrors = true;
            state.corrected = true;
          }
          const first = state.segments++ === 0;
          if (first)
            expect(segment.input_manifest.change_diff.status).not.toBe(
              "delivered",
            );
          const support = state.delivered.has("src/contract.ts");
          if (segment.phase === "synthesis") {
            state.syntheses++;
            expect(state.sawErrors).toBe(true);
            expect(support).toBe(true);
          }
          result = {
            summary:
              "Synthetic checkpoint checks infrastructure only; PR and work-item metadata were supplied.",
            findings: model === "reader" ? [candidate] : [],
            unresolved_questions: support
              ? []
              : [
                  {
                    id: "consumer-contract",
                    question:
                      "Confirm the unchanged consumer contract from its exact source.",
                  },
                ],
            resolved_question_ids: [
              ...(support ? ["consumer-contract"] : []),
              ...feedback
                .filter(
                  (item: any) =>
                    item.status === "rejected" &&
                    typeof item.error_id === "string",
                )
                .map((item: any) => item.error_id),
            ],
            follow_up_reads: first
              ? [
                  { path: "<change-diff>", offset: 131072, byte_count: 8192 },
                  { path: "<caller-context>", offset: 0, byte_count: 1024 },
                  { path: "./src/value.ts", offset: 0, byte_count: 128 },
                  {
                    kind: "snapshot",
                    path: "src/missing.ts",
                    offset: 0,
                    byte_count: 128,
                  },
                  { path: "src/value.ts", offset: 9999999, byte_count: 128 },
                ]
              : feedback.some((item: any) => item.status === "rejected")
                ? [
                    {
                      kind: "snapshot",
                      path: "./src/contract.ts",
                      offset: 0,
                      byte_count: 128,
                    },
                  ]
                : [],
            scenario_checks: [
              {
                path: "src/value.ts",
                start_line: 1,
                end_line: 1,
                input: { consumer: true },
                expected: 1,
                observed: 2,
                reasoning:
                  "Synthetic producer and consumer disagree; not an executed test.",
                ...(model === "reader" ? { finding_id: candidate.id } : {}),
              },
            ],
          };
        } else {
          expect(state.syntheses).toBeGreaterThan(0);
          for (const path of paths) {
            let end = 0;
            for (const [start, next] of [
              ...(state.delivered.get(path) ?? []),
            ].sort((a, b) => a[0] - b[0])) {
              expect(start, path).toBeLessThanOrEqual(end);
              end = Math.max(end, next);
            }
            expect(end, path).toBe(expected.get(path)!.length);
          }
          let diffEnd = 0;
          for (const [start, end] of [
            ...(state.delivered.get("<change-diff>") ?? []),
          ].sort((a, b) => a[0] - b[0])) {
            expect(start).toBeLessThanOrEqual(diffEnd);
            diffEnd = Math.max(diffEnd, end);
          }
          expect(diffEnd).toBe(sourceDiff.length);
          const assignment = [...objects]
            .reverse()
            .find(
              (value: any) =>
                value.result_id && Number.isInteger(value.page_index),
            );
          expect(assignment).toBeDefined();
          const adjudication = assignment.result_kind === "adjudication";
          const payload =
            assignment.page_index === 0
              ? adjudication
                ? {
                    verdict: "fail",
                    summary:
                      "Synthetic adjudication confirms the retained candidate.",
                    review_markdown: "",
                    informational_notes: [],
                    candidate_count: assignment.candidate_count,
                    candidate_ids_digest: assignment.candidate_ids_digest,
                  }
                : {
                    verdict: "fail",
                    summary: "Synthetic cross-file finding preserved.",
                    informational_notes: [],
                    actionable_finding_count: 1,
                    narrative_fragment_count: 0,
                    narrative_byte_count: 0,
                  }
              : adjudication
                ? {
                    decisions: assignment.candidate_ids.map((id: string) => ({
                      source_finding_id: id,
                      decision: "confirmed",
                      rationale:
                        "Synthetic source comparison confirms the changed value.",
                      cited_evidence: candidate.evidence,
                      unverified_assumptions: [],
                      base_head_comparison: {
                        base: {
                          behavior: "Producer supplied one.",
                          citation: {
                            path: "src/value.ts",
                            start_line: 1,
                            end_line: 1,
                            detail: "Old changed line returns one.",
                          },
                        },
                        head: {
                          behavior: "Producer supplies two.",
                          citation: candidate.evidence[0],
                        },
                        impact: "Consumer still requires one.",
                      },
                    })),
                  }
                : { actionable_findings: [candidate] };
          result = {
            schema_version: "1",
            kind: "review-mesh.result-page",
            result_id: assignment.result_id,
            result_kind: assignment.result_kind,
            result_schema_version: adjudication ? "2" : "4",
            page_index: assignment.page_index,
            page_count: 2,
            previous_page_digest: assignment.previous_page_digest,
            page_kind:
              assignment.page_index === 0
                ? "header"
                : adjudication
                  ? "decisions"
                  : "findings",
            payload,
          };
        }
        // Exercise both supported text encodings, not just a string-only fake.
        const content =
          calls % 2
            ? JSON.stringify(result)
            : [{ type: "text", text: JSON.stringify(result) }];
        res.end(
          JSON.stringify({
            choices: [
              {
                message: { role: "assistant", content },
                finish_reason: "stop",
              },
            ],
          }),
        );
      } catch (error) {
        serverErrors.push(
          error instanceof Error ? error.message : String(error),
        );
        res.statusCode = 400;
        res.end(
          JSON.stringify({
            error: { message: "Synthetic acceptance assertion failed" },
          }),
        );
      }
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("No fixture listener");
  try {
    for (const path of paths)
      await writeFile(join(workspace, path), content(path, false));
    expected.set(
      "src/contract.ts",
      Buffer.from("export const expected = 1;\n"),
    );
    await writeFile(
      join(workspace, "src/contract.ts"),
      expected.get("src/contract.ts")!,
    );
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
      expect((await execute("git", args, workspace, process.env)).code).toBe(0);
    for (const path of paths) {
      expected.set(path, content(path, true));
      await writeFile(join(workspace, path), expected.get(path)!);
    }
    const diff = await execute(
      "git",
      ["diff", "--no-ext-diff", "--no-textconv", "HEAD", "--"],
      workspace,
      process.env,
    );
    // Core Git discovery uses execa's single final-newline stripping.
    sourceDiff = Buffer.from(diff.stdout.replace(/\r?\n$/, ""));
    expect(sourceDiff.length).toBeGreaterThan(128 * 1024);
    const config = join(home, "review-mesh", "Config", "config.toml");
    await mkdir(resolve(config, ".."), { recursive: true });
    await writeFile(
      config,
      `schema_version="7"
[execution]
max_concurrency=2
heartbeat_interval_ms=1000
shutdown_grace_period_ms=1000
deadline_mode="fixed"
run_deadline_ms=90000
no_progress_timeout_ms=30000
review_profile="strict-evaluation"
[diagnostics]
persist_runs=true
max_runs=10
[adapters.fixture]
type="openai_compatible"
base_url_env="FIXTURE_BASE"
api_key_env="FIXTURE_KEY"
streaming="disabled"
[agents.collector]
adapter="fixture"
purpose="Synthetic workflow acceptance"
instructions="Trace exact source and preserve cross-file obligations."
isolation="prefer_enforced"
timeout_ms=80000
kind="generic"
required_input=[]
adjudication="required"
pass_quorum=2
minimum_provider_groups=2
allow_zero_outage_tolerance=true
model_runs=[{id="reader",model="reader",provider_group="one"},{id="judge",model="judge",provider_group="two"}]
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
      XDG_CONFIG_HOME: home,
      XDG_DATA_HOME: home,
      FIXTURE_BASE: `http://127.0.0.1:${address.port}/v1`,
      FIXTURE_KEY: "synthetic-local-only",
    };
    const command = process.env.REVIEW_MESH_V96_BINARY;
    const file = command ?? process.execPath;
    const prefix = command
      ? []
      : [
          "--import",
          pathToFileURL(resolve("node_modules/tsx/dist/loader.mjs")).href,
          resolve("src/cli.ts"),
        ];
    const request = {
      schema_version: "3",
      project_name: "workspace",
      workspace,
      instructions: "Review the synthetic changed source.",
      review_scope: { mode: "changes", base: "HEAD" },
      pull_request: {
        id: "96",
        title,
        description:
          "The producer changes its returned value; preserve the unchanged consumer contract.",
        work_items: [
          { id: workItem, title: "Synthetic contract compatibility" },
        ],
      },
      context: {
        work_items: [
          { id: workItem, description: "The consumer expects one." },
        ],
      },
    };
    const run = await execute(
      file,
      [...prefix, "review", "--output-mode", "full-jsonl"],
      root,
      env,
      JSON.stringify(request),
    );
    expect(run.stdout.trim(), run.stderr).not.toBe("");
    expect(serverErrors, "Model-visible workflow assertions").toEqual([]);
    const events = run.stdout
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line));
    const terminal = events.at(-1);
    expect(terminal.data, run.stderr + run.stdout.slice(-2000)).toMatchObject({
      model_runs: { completed: 2, incomplete: 0 },
      change_coverage: { status: "complete" },
    });
    expect(
      events.some(
        (event) =>
          event.event === "reviewer.started" &&
          event.data.mode === "adjudication",
      ),
    ).toBe(true);
    expect(events.map((event) => event.seq)).toEqual(
      events.map((_, i) => i + 1),
    );
    expect(
      [...states.values()].every(
        (state) => state.sawErrors && state.corrected && state.syntheses > 0,
      ),
    ).toBe(true);
    const report = await execute(
      file,
      [...prefix, "report", terminal.run_id, "--format", "json", "--raw"],
      root,
      env,
    );
    expect(report.code, report.stderr).toBe(0);
    const artifact = (await readFile(terminal.data.artifact.path, "utf8"))
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line));
    const results = artifact.filter(
      (record) => record.record === "reviewer.result" && record.result,
    );
    expect(results).toHaveLength(2);
    expect(
      results.find((record) => record.result.schema_version === "4").result
        .actionable_findings,
    ).toEqual([candidate]);
    expect(
      results.find((record) => record.result.schema_version === "2").result
        .decisions,
    ).toHaveLength(1);
    expect(
      artifact.filter(
        (record) =>
          record.record === "reviewer.segment" &&
          record.data.phase === "synthesis",
      ).length,
    ).toBeGreaterThanOrEqual(2);
    expect(
      artifact.some((record) =>
        JSON.stringify(record).includes('"not_in_snapshot"'),
      ),
    ).toBe(true);
    expect(
      artifact.some((record) =>
        JSON.stringify(record).includes('"invalid_range"'),
      ),
    ).toBe(true);
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
    await rm(root, { recursive: true, force: true });
  }
}, 120000);
