import type { SourceRange, FollowUpResult } from "./segment-followups.js";

type RangeReceipt = SourceRange & { sha256: string; snapshot_digest?: string };
type Fact = {
  segment_id: string;
  provenance: "model_reasoning";
  runtime_validation: "not_executed";
  source_link_validation: "path_or_diff_context_only";
  check: unknown;
  source_ranges: RangeReceipt[];
};
const bytes = (value: unknown) =>
  Buffer.byteLength(JSON.stringify(value), "utf8");

/** A bounded view of acknowledged evidence, not a substitute for durable
 * checkpoints or unresolved candidate/question obligations. No model fact is
 * promoted to executed validation. Omitted context is explicit and rereadable. */
export class SegmentEvidenceMemory {
  private readonly facts: Fact[] = [];
  private omittedFacts = 0;
  private readonly paths = new Map<
    string,
    { kind: SourceRange["kind"]; path: string; byteCount: number }
  >();
  private readonly metadata: Record<string, unknown>;
  private pendingReads: Array<
    SourceRange & { question_id?: string; purpose?: string }
  > = [];
  constructor(
    metadata: { request?: unknown; caller_context?: unknown },
    sources: readonly SourceRange[],
  ) {
    const content = JSON.parse(JSON.stringify(metadata));
    this.metadata =
      Object.keys(content).length === 0
        ? { status: "absent" }
        : bytes(content) <= 16 * 1024
          ? { status: "retained", content }
          : {
              status: "requires_context_read",
              path: "<caller-context>",
              byte_count: bytes(content),
            };
    for (const source of sources)
      this.register(source.kind, source.path, source.byte_count);
  }
  register(kind: SourceRange["kind"], path: string, byteCount: number) {
    this.paths.set(`${kind}:${path}`, { kind, path, byteCount });
  }
  addReads(results: readonly FollowUpResult[]) {
    for (const result of results) {
      if (
        result.status !== "queued" ||
        (!result.request.question_id && !result.request.purpose)
      )
        continue;
      const read = {
        kind: result.kind!,
        path: result.path!,
        offset: result.offset!,
        byte_count: result.byte_count!,
        ...(result.request.question_id
          ? { question_id: result.request.question_id }
          : {}),
        ...(result.request.purpose ? { purpose: result.request.purpose } : {}),
      };
      if (
        !this.pendingReads.some(
          (prior) => JSON.stringify(prior) === JSON.stringify(read),
        )
      )
        this.pendingReads.push(read);
    }
    if (this.pendingReads.length > 64 || bytes(this.pendingReads) > 16384)
      throw new Error("Pending follow-up explanations exceed bounded memory.");
  }
  deliveredReads(receipts: readonly RangeReceipt[]) {
    this.pendingReads = this.pendingReads.flatMap((read) => {
      let remaining = [read];
      for (const receipt of receipts)
        remaining = remaining.flatMap((part) => {
          if (part.kind !== receipt.kind || part.path !== receipt.path)
            return [part];
          const end = part.offset + part.byte_count,
            receiptEnd = receipt.offset + receipt.byte_count;
          if (part.byte_count === 0)
            return receipt.offset === part.offset ? [] : [part];
          if (receiptEnd <= part.offset || receipt.offset >= end) return [part];
          return [
            ...(receipt.offset > part.offset
              ? [{ ...part, byte_count: receipt.offset - part.offset }]
              : []),
            ...(receiptEnd < end
              ? [{ ...part, offset: receiptEnd, byte_count: end - receiptEnd }]
              : []),
          ];
        });
      return remaining;
    });
  }
  remember<T extends { path: string }>(
    segmentId: string,
    checks: readonly T[],
    receipts: readonly RangeReceipt[],
  ) {
    for (const check of checks) {
      const fact: Fact = {
        segment_id: segmentId,
        provenance: "model_reasoning",
        runtime_validation: "not_executed",
        source_link_validation: "path_or_diff_context_only",
        check: structuredClone(check),
        source_ranges: receipts
          .filter((r) => r.path === check.path || r.kind === "diff")
          .slice(0, 8)
          .map((r) => ({
            kind: r.kind,
            path: r.path,
            offset: r.offset,
            byte_count: r.byte_count,
            sha256: r.sha256,
            ...(r.snapshot_digest
              ? { snapshot_digest: r.snapshot_digest }
              : {}),
          })),
      };
      if (bytes(fact) > 4096) {
        this.omittedFacts++;
        continue;
      }
      this.facts.push(fact);
      while (this.facts.length > 16 || bytes(this.facts) > 8192) {
        this.facts.shift();
        this.omittedFacts++;
      }
    }
  }
  view(
    delivered: ReadonlyMap<string, readonly [number, number][]>,
    preferredPaths: readonly string[] = [],
    maximumBytes = 32768,
  ) {
    const priorities = new Set([
      "<caller-context>",
      "<change-diff>",
      ...preferredPaths,
    ]);
    const entries = [...this.paths.values()].filter((p) =>
      delivered.has(`${p.kind}:${p.path}`),
    );
    entries.sort(
      (a, b) => Number(priorities.has(b.path)) - Number(priorities.has(a.path)),
    );
    const delivered_ranges = entries.slice(0, 64).map((p) => {
      const intervals = delivered.get(`${p.kind}:${p.path}`)!;
      return {
        kind: p.kind,
        path: p.path,
        intervals: intervals
          .slice(0, 8)
          .map(([start, end]) => ({ offset: start, byte_count: end - start })),
        complete:
          p.byteCount === 0 ||
          (intervals.length === 1 &&
            intervals[0]![0] === 0 &&
            intervals[0]![1] >= p.byteCount),
        intervals_truncated: intervals.length > 8,
      };
    });
    const view = {
      metadata: this.metadata,
      delivered_ranges,
      omitted_paths: entries.length - delivered_ranges.length,
      scenario_facts: [...this.facts],
      omitted_scenario_facts: this.omittedFacts,
      pending_read_obligations: [...this.pendingReads],
    };
    while (bytes(view) > maximumBytes && view.scenario_facts.length) {
      view.scenario_facts.shift();
      view.omitted_scenario_facts++;
    }
    while (bytes(view) > maximumBytes && view.delivered_ranges.length) {
      view.delivered_ranges.pop();
      view.omitted_paths++;
    }
    if (bytes(view) > maximumBytes && view.metadata.status === "retained")
      view.metadata = {
        status: "requires_context_read",
        path: "<caller-context>",
        reason: "current_request_budget",
      };
    return view;
  }
}
