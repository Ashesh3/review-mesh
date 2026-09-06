import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import { z } from "zod";

const cases = ["state", "search", "eligibility"] as const;
export type QualityCase = (typeof cases)[number];
const value = z.number().finite();
const key = z.string().min(1).max(80);
const inputs = {
  state: z.strictObject({
    events: z
      .array(z.strictObject({ key, value, items: z.array(value).max(20) }))
      .max(200),
  }),
  search: z.strictObject({
    records: z.array(z.strictObject({ key, position: value, value })).max(300),
    key,
    position: value,
    page_size: z.number().int().min(1).max(300),
  }),
  eligibility: z.strictObject({
    enabled: z.boolean(),
    threshold: value,
    created: value,
    position: value,
    records: z
      .array(z.strictObject({ start: value, end: value, value }))
      .max(100),
  }),
};
const oracleSchema = z.strictObject({
  schema_version: z.literal("1"),
  case_id: z.enum(cases),
  variant: z.enum(["buggy", "corrected"]),
  workspace: z.string(),
  source_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  contract_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  region: z.strictObject({
    path: z.literal("engine.mjs"),
    start_line: z.number().int().positive(),
    end_line: z.number().int().positive(),
  }),
  probes: z
    .array(z.strictObject({ id: key, input: z.json() }))
    .min(2)
    .max(10),
});
type Oracle = z.infer<typeof oracleSchema>;
const digest = (text: string) =>
  createHash("sha256").update(text).digest("hex");
const equal = (a: unknown, b: unknown): boolean =>
  JSON.stringify(a) === JSON.stringify(b);
const object = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

function contractResult(caseId: QualityCase, input: unknown): unknown {
  if (caseId === "state") {
    const { events } = inputs.state.parse(input);
    const retained = new Map<string, number>();
    return events.map((event) => {
      if (!retained.has(event.key)) retained.set(event.key, event.value);
      return retained.get(event.key);
    });
  }
  if (caseId === "search") {
    const query = inputs.search.parse(input);
    return (
      query.records.find(
        (record) =>
          record.key === query.key && record.position === query.position,
      )?.value ?? null
    );
  }
  const query = inputs.eligibility.parse(input);
  if (
    !query.enabled ||
    query.created < query.threshold ||
    query.position < query.threshold
  )
    return null;
  const record = query.records.find(
    (record) => record.start <= query.position && query.position <= record.end,
  );
  if (!record) return { error: "No matching record" };
  return record.start < query.threshold ? null : record.value;
}

function fixtureContent(caseId: QualityCase, corrected: boolean) {
  if (caseId === "state")
    return {
      source: `export function evaluate(input) {
  const retained = new Map();
  return input.events.map(event => {
    let selected = retained.get(event.key);
    if (selected === undefined) {
      selected = event.value;
      ${corrected ? "retained.set(event.key, selected);" : "if (event.items.length > 0) retained.set(event.key, selected);"}
    }
    return selected;
  });
}
`,
      region: [7, 7],
      contract:
        "The module evaluates a sequence of records. Each key keeps its first selected numeric value for the entire sequence. Later records for that key return the retained value even when their proposed value differs. Items are optional associated numeric data and an empty collection is valid. Different keys are independent.\n",
      probes: [
        {
          id: "boundary",
          input: {
            events: [
              { key: "q", value: 8, items: [] },
              { key: "q", value: 9, items: [] },
            ],
          },
        },
        {
          id: "control",
          input: {
            events: [
              { key: "q", value: 8, items: [1] },
              { key: "q", value: 9, items: [1] },
              { key: "r", value: 7, items: [] },
            ],
          },
        },
      ],
    };
  if (caseId === "search")
    return {
      source: `export function evaluate(input) {
  const records = ${corrected ? "input.records" : "input.records.slice(0, input.page_size)"};
  const match = records.find(record => record.key === input.key && record.position === input.position);
  return match?.value ?? null;
}
`,
      region: [2, 2],
      contract:
        "The module returns the value of the first record matching both requested key and position, or null if the collection has no match. page_size is a retrieval chunk size, not a limit on the searchable collection. Record order determines which duplicate match wins; unrelated records must not affect the result. Empty input is valid.\n",
      probes: [
        {
          id: "boundary",
          input: {
            records: Array.from({ length: 101 }, (_, i) => ({
              key: "q",
              position: i,
              value: i + 20,
            })),
            key: "q",
            position: 100,
            page_size: 100,
          },
        },
        {
          id: "control",
          input: {
            records: [{ key: "q", position: 1, value: 4 }],
            key: "q",
            position: 1,
            page_size: 1,
          },
        },
      ],
    };
  return {
    source: `export function evaluate(input) {
  if (!input.enabled || input.created < input.threshold${corrected ? " || input.position < input.threshold" : ""}) return null;
  const record = input.records.find(record => record.start <= input.position && input.position <= record.end);
  if (!record) throw new Error("No matching record");
  if (record.start < input.threshold) return null;
  return record.value;
}
`,
    region: [2, 4],
    contract:
      "The module resolves a selected numeric value from inclusive record intervals. Disabled requests, requests created before threshold, and requested positions before threshold are ineligible and return null regardless of stored records. For an eligible request, a missing matching interval is an error. An interval starting before threshold is ineligible. Otherwise return its value.\n",
    probes: [
      {
        id: "boundary",
        input: {
          enabled: true,
          threshold: 10,
          created: 12,
          position: 8,
          records: [],
        },
      },
      {
        id: "control",
        input: {
          enabled: true,
          threshold: 10,
          created: 12,
          position: 8,
          records: [{ start: 1, end: 9, value: 4 }],
        },
      },
      {
        id: "eligible",
        input: {
          enabled: true,
          threshold: 10,
          created: 12,
          position: 11,
          records: [{ start: 10, end: 20, value: 5 }],
        },
      },
    ],
  };
}

/** The returned request contains no variant, case label, oracle location, or expected output. */
export async function createQualityFixture(options: {
  caseId: QualityCase;
  variant: "buggy" | "corrected";
  directory?: string;
}) {
  const base = options.directory ?? tmpdir();
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, "review-sample-"));
  const workspace = join(root, "workspace"),
    privateDirectory = join(root, "private");
  await mkdir(workspace);
  await mkdir(privateDirectory);
  const content = fixtureContent(
    options.caseId,
    options.variant === "corrected",
  );
  await writeFile(join(workspace, "engine.mjs"), content.source, "utf8");
  await writeFile(join(workspace, "contract.md"), content.contract, "utf8");
  const oracle: Oracle = {
    schema_version: "1",
    case_id: options.caseId,
    variant: options.variant,
    workspace,
    source_sha256: digest(content.source),
    contract_sha256: digest(content.contract),
    region: {
      path: "engine.mjs",
      start_line: content.region[0]!,
      end_line: content.region[1]!,
    },
    probes: content.probes,
  };
  const oraclePath = join(privateDirectory, "oracle.json");
  await writeFile(oraclePath, JSON.stringify(oracle, null, 2) + "\n", "utf8");
  return {
    workspace,
    oraclePath,
    adapter_requirements: {
      type: "sdk",
      change_coverage_proof: "native_attested",
    },
    request: {
      schema_version: "3",
      project_name: basename(workspace),
      workspace,
      instructions:
        "Review the module against its documented contract. Report concrete incorrect behavior with source locations. Trace representative valid boundary and control inputs, compare expected and observed outputs, and record your scenario checks in the final review_markdown as a fenced code block tagged review-mesh-scenarios. The block must contain a JSON array of objects with path, start_line, end_line, input, expected, observed, reasoning, and optional finding_id linking a finding in the final result. Construct inputs from the documented contract; do not execute code. Distinguish reasoned results from runtime validation.",
      review_scope: { mode: "full" },
    },
  };
}

async function loadOracle(path: string): Promise<Oracle> {
  const oracle = oracleSchema.parse(JSON.parse(await readFile(path, "utf8")));
  const original = fixtureContent(
    oracle.case_id,
    oracle.variant === "corrected",
  );
  if (
    oracle.source_sha256 !== digest(original.source) ||
    oracle.contract_sha256 !== digest(original.contract) ||
    !equal(oracle.region, {
      path: "engine.mjs",
      start_line: original.region[0],
      end_line: original.region[1],
    }) ||
    !equal(oracle.probes, original.probes)
  )
    throw new Error(
      "The private oracle differs from the registered synthetic fixture.",
    );
  const workspace = await realpath(oracle.workspace);
  const oracleReal = await realpath(path);
  const distance = relative(workspace, oracleReal);
  if (!(
    distance === ".." ||
    distance.startsWith(`..${sep}`) ||
    isAbsolute(distance)
  ))
    throw new Error("The oracle must be outside the reviewed workspace.");
  for (const [name, expected] of [
    ["engine.mjs", oracle.source_sha256],
    ["contract.md", oracle.contract_sha256],
  ] as const) {
    const file = await realpath(join(workspace, name));
    if (
      relative(workspace, file).startsWith("..") ||
      digest(await readFile(file, "utf8")) !== expected
    )
      throw new Error("The reviewed fixture changed or escaped its workspace.");
  }
  return { ...oracle, workspace };
}

function execute(oracle: Oracle, input: unknown): unknown {
  inputs[oracle.case_id].parse(input);
  // Only the evaluator executes the checksum-verified synthetic module. No shell,
  // inherited credentials, provider access, or caller-provided code is evaluated.
  const code = `import fs from 'node:fs';import{evaluate}from'./engine.mjs';const input=JSON.parse(fs.readFileSync(0,'utf8'));try{process.stdout.write(JSON.stringify(evaluate(input)));}catch(error){process.stdout.write(JSON.stringify({error:error.message}));}`;
  const environment: NodeJS.ProcessEnv = {};
  for (const key of ["SystemRoot", "SYSTEMROOT", "TEMP", "TMP"])
    if (process.env[key]) environment[key] = process.env[key];
  return JSON.parse(
    execFileSync(process.execPath, ["--input-type=module", "-e", code], {
      cwd: oracle.workspace,
      env: environment,
      input: JSON.stringify(input),
      encoding: "utf8",
      timeout: 3000,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    }),
  );
}

export async function runQualityBehavior(oraclePath: string) {
  const oracle = await loadOracle(oraclePath);
  return oracle.probes.map((probe) => {
    const expected = contractResult(oracle.case_id, probe.input),
      observed = execute(oracle, probe.input);
    return {
      id: probe.id,
      input: probe.input,
      expected,
      observed,
      matches_contract: equal(expected, observed),
    };
  });
}

const scenarioSchema = z.object({
  path: z.literal("engine.mjs"),
  start_line: z.number().int().positive(),
  end_line: z.number().int().positive(),
  input: z.json(),
  expected: z.json(),
  observed: z.json(),
  reasoning: z.string().min(20).max(8000),
  finding_id: key.optional(),
});

/** Evaluation-only data: parse JSON claims, never execute Markdown or model code. */
function markdownScenarios(markdown: unknown): unknown[] {
  if (typeof markdown !== "string") return [];
  if (Buffer.byteLength(markdown, "utf8") > 4 * 1024 * 1024)
    throw new Error(
      "Quality scoring accepts at most 4 MiB of reviewer Markdown.",
    );
  const scenarios: unknown[] = [];
  for (const match of markdown.matchAll(
    /^ {0,3}(`{3,}|~{3,})review-mesh-scenarios[ \t]*\r?\n([\s\S]*?)^ {0,3}\1[ \t]*$/gm,
  )) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(match[2]!);
    } catch {
      parsed = undefined;
    }
    if (Array.isArray(parsed)) {
      if (parsed.length + scenarios.length > 128)
        throw new Error(
          "Quality scoring accepts at most 128 scenario claims per fixture report.",
        );
      scenarios.push(...parsed);
    } else scenarios.push(undefined);
    if (scenarios.length > 128)
      throw new Error(
        "Quality scoring accepts at most 128 scenario claims per fixture report.",
      );
  }
  return scenarios;
}

function scenarioClasses(caseId: QualityCase, input: unknown): string[] {
  if (caseId === "state") {
    const { events } = inputs.state.parse(input);
    const seen = new Map<string, { value: number; items: number[] }>();
    const classes = new Set<string>();
    for (const event of events) {
      const first = seen.get(event.key);
      if (first && first.value !== event.value)
        classes.add(
          first.items.length ? "retained_nonempty" : "retained_empty",
        );
      if (!first) seen.set(event.key, event);
    }
    return [...classes];
  }
  if (caseId === "search") {
    const query = inputs.search.parse(input);
    const index = query.records.findIndex(
      (record) =>
        record.key === query.key && record.position === query.position,
    );
    return [
      index >= query.page_size
        ? "match_after_chunk"
        : index >= 0
          ? "match_within_chunk"
          : "no_match",
    ];
  }
  const query = inputs.eligibility.parse(input);
  const record = query.records.find(
    (record) => record.start <= query.position && query.position <= record.end,
  );
  return [
    !query.enabled
      ? "disabled"
      : query.created >= query.threshold && query.position < query.threshold
        ? record
          ? "ineligible_present"
          : "ineligible_absent"
        : "eligible",
  ];
}

/** Scores executable counterexamples, not finding wording; never runs a provider. */
export async function evaluateQualityReport(
  oraclePath: string,
  reportInput: unknown,
) {
  const oracle = await loadOracle(oraclePath);
  const behavior = await runQualityBehavior(oraclePath);
  const defectPresent = behavior.some((probe) => !probe.matches_contract);
  const report = object(reportInput);
  const reportWorkspace = object(report.context).workspace;
  if (
    typeof reportWorkspace !== "string" ||
    (await realpath(reportWorkspace)) !== oracle.workspace
  )
    throw new Error(
      "Scoring requires a raw report for this exact fixture workspace.",
    );
  const reviewers = Array.isArray(report.reviewers)
    ? report.reviewers.map(object)
    : [];
  const completed = reviewers.filter(
    (reviewer) => reviewer.status === "completed",
  );
  const findings = completed.flatMap((reviewer) => {
    const result = object(reviewer.result);
    return (
      Array.isArray(result.actionable_findings)
        ? result.actionable_findings
        : []
    ).map((finding) => ({
      reviewerId: reviewer.reviewer_id,
      finding: object(finding),
    }));
  });
  const records = Array.isArray(report.records)
    ? report.records.map(object)
    : [];
  const historicalScenarios = records
    .filter((record) => record.record === "reviewer.segment")
    .flatMap((record) => {
      const data = object(record.data);
      const checkpoint = Array.isArray(data.scenario_checks)
        ? data
        : object(data.data);
      return (
        Array.isArray(checkpoint.scenario_checks)
          ? checkpoint.scenario_checks
          : []
      ).map((value) => ({ reviewerId: record.reviewer_id, value }));
    });
  const scenarios = [
    ...historicalScenarios,
    ...completed.flatMap((reviewer) =>
      markdownScenarios(object(reviewer.result).review_markdown).map(
        (value) => ({ reviewerId: reviewer.reviewer_id, value }),
      ),
    ),
  ];
  if (scenarios.length > 128)
    throw new Error(
      "Quality scoring accepts at most 128 scenario claims per fixture report.",
    );
  const matched = new Set<string>();
  const checkedClasses = new Map<unknown, Set<string>>();
  let verified = 0,
    rejected = 0;
  for (const item of scenarios) {
    const parsed = scenarioSchema.safeParse(item.value);
    if (
      !parsed.success ||
      !completed.some((r) => r.reviewer_id === item.reviewerId)
    ) {
      rejected++;
      continue;
    }
    const scenario = parsed.data;
    let expected: unknown, observed: unknown;
    try {
      expected = contractResult(oracle.case_id, scenario.input);
      observed = execute(oracle, scenario.input);
    } catch {
      rejected++;
      continue;
    }
    if (
      !equal(expected, scenario.expected) ||
      !equal(observed, scenario.observed)
    ) {
      rejected++;
      continue;
    }
    verified++;
    const checked = checkedClasses.get(item.reviewerId) ?? new Set<string>();
    for (const category of scenarioClasses(oracle.case_id, scenario.input))
      checked.add(category);
    checkedClasses.set(item.reviewerId, checked);
    if (equal(expected, observed) || scenario.finding_id === undefined)
      continue;
    const candidate = findings.find(
      (f) =>
        f.reviewerId === item.reviewerId &&
        f.finding.id === scenario.finding_id,
    );
    if (!candidate) continue;
    const claim = object(candidate.finding.claim);
    const evidence = Array.isArray(candidate.finding.evidence)
      ? candidate.finding.evidence.map(object)
      : [];
    const intersects = (entry: Record<string, unknown>) =>
      entry.path === oracle.region.path &&
      typeof entry.start_line === "number" &&
      typeof entry.end_line === "number" &&
      entry.start_line <= oracle.region.end_line &&
      entry.end_line >= oracle.region.start_line &&
      entry.end_line >= entry.start_line;
    if (
      !intersects(scenario) ||
      !evidence.some(intersects) ||
      ![claim.trigger, claim.affected_behavior, claim.outcome].every(
        (value) => typeof value === "string" && value.trim().length > 0,
      )
    )
      continue;
    matched.add(`${String(item.reviewerId)}#${scenario.finding_id}`);
  }
  const detected = defectPresent && matched.size > 0;
  const unmatched = findings.filter(
    (f) => !matched.has(`${String(f.reviewerId)}#${String(f.finding.id)}`),
  ).length;
  const requiredClasses = [
    ...new Set(
      oracle.probes.flatMap((probe) =>
        scenarioClasses(oracle.case_id, probe.input),
      ),
    ),
  ];
  const passChecks = completed
    .filter((reviewer) => object(reviewer.result).verdict === "pass")
    .map((reviewer) => ({
      reviewer_id: reviewer.reviewer_id,
      checked: [...(checkedClasses.get(reviewer.reviewer_id) ?? [])],
      missing: requiredClasses.filter(
        (category) => !checkedClasses.get(reviewer.reviewer_id)?.has(category),
      ),
    }));
  return {
    schema_version: "1",
    kind: "review-mesh.quality-evaluation",
    run_id: report.run_id ?? null,
    model_execution: "not_performed_by_evaluator",
    oracle_provenance: "independent_executable_contract",
    infrastructure: {
      completed_reviewers: completed.length,
      run_outcome: report.run_outcome ?? "unavailable",
      coverage_outcome: report.coverage_outcome ?? "unavailable",
    },
    detection: {
      true_positives: detected ? 1 : 0,
      false_negatives: defectPresent && !detected ? 1 : 0,
      unmatched_findings: unmatched,
      false_positives_on_control: defectPresent ? 0 : findings.length,
    },
    verified_scenarios: verified,
    rejected_scenarios: rejected,
    unsupported_clear: defectPresent && report.run_outcome === "clear",
    unsubstantiated_passes: passChecks.filter(
      (check) => check.missing.length > 0,
    ).length,
    pass_scenario_checks: passChecks,
    fixture_contract_satisfied: !defectPresent,
    source_identity: { path: "engine.mjs", sha256: oracle.source_sha256 },
    limitations: [
      "A matched executable counterexample and source location substantiate detection; free-form causal reasoning is retained for independent human assessment.",
      "These scores evaluate this synthetic fixture only and do not certify general review accuracy.",
    ],
  };
}
