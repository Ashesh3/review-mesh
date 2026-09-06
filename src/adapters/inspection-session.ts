import { randomUUID } from "node:crypto";
import type { AdapterReviewInput } from "./types.js";
import { createReadOnlyFileTools } from "./file-tools.js";
import { sanitizeAdapterFailure } from "./errors.js";
import { MAX_READ_BYTES } from "../context/read-limits.js";

type Range = { path: string; offset: number; byte_count: number };
type Message = Record<string, unknown>;
type ToolResult = {
  response: unknown;
  acknowledgeDelivered?(serialized: string): boolean | void;
};
const bytes = (messages: Message[]) =>
  Buffer.byteLength(JSON.stringify(messages));

/** Evidence, analysis and pending delivery are one retry checkpoint. */
export class InspectionSession {
  readonly sessionId: string;
  readonly messages: Message[];
  turns = 0;
  private pending: Array<Range & { acknowledge(): void }> = [];
  private replay: Range[] = [];
  constructor(
    readonly input: AdapterReviewInput,
    messages: Message[],
    sessionId: string = randomUUID(),
  ) {
    this.messages = messages;
    this.sessionId = sessionId;
    // A new conversation may receive a ledger from a previous adapter. Its
    // credited evidence must be replayed before this conversation may finalize.
    this.replay = (input.coverage?.status().entries ?? []).flatMap((entry) =>
      entry.snapshot_required
        ? entry.delivered_byte_ranges.map((range) => ({
            path: entry.path,
            ...range,
          }))
        : [],
    );
  }
  matches(input: AdapterReviewInput) {
    return (
      this.input.runId === input.runId &&
      this.input.reviewer.id === input.reviewer.id &&
      this.input.prompt.user === input.prompt.user &&
      this.input.coverage === input.coverage
    );
  }
  private subtract(ranges: Range[], delivered: Range): Range[] {
    return ranges.flatMap((range) => {
      if (range.path !== delivered.path) return [range];
      const end = range.offset + range.byte_count;
      const deliveredEnd = delivered.offset + delivered.byte_count;
      if (
        range.byte_count === 0 &&
        delivered.byte_count === 0 &&
        range.offset === delivered.offset
      )
        return [];
      if (deliveredEnd <= range.offset || delivered.offset >= end)
        return [range];
      return [
        ...(delivered.offset > range.offset
          ? [{ ...range, byte_count: delivered.offset - range.offset }]
          : []),
        ...(deliveredEnd < end
          ? [{ ...range, offset: deliveredEnd, byte_count: end - deliveredEnd }]
          : []),
      ];
    });
  }
  missing(): Range[] {
    let ranges = [
      ...(this.input.coverage?.status().entries ?? []).flatMap((entry) =>
        entry.missing_byte_ranges.map((range) => ({
          path: entry.path,
          ...range,
        })),
      ),
      ...this.replay,
    ];
    for (const pending of this.pending) ranges = this.subtract(ranges, pending);
    return ranges;
  }
  enqueue(result: ToolResult, serialized: string): void {
    const value = result.response as {
      ok?: boolean;
      path: string;
      offset: number;
      byte_count: number;
    };
    if (value.ok && result.acknowledgeDelivered)
      this.pending.push({
        path: value.path,
        offset: value.offset,
        byte_count: value.byte_count,
        acknowledge: () => {
          result.acknowledgeDelivered!(serialized);
        },
      });
  }
  acknowledge(): void {
    for (const pending of this.pending.splice(0)) {
      pending.acknowledge();
      this.replay = this.subtract(this.replay, pending);
    }
  }
  failure(
    code: "inspection_budget_exhausted" | "inspection_acquisition_failed",
    maximumTurns: number,
    message: string,
  ) {
    return sanitizeAdapterFailure(
      "change_coverage_incomplete",
      message,
      false,
      {
        fallback_eligible: true,
        circuit_qualifying: false,
        diagnostics: {
          failure_code: code,
          failure_stage: "inspection",
          scope: "model",
          model: this.input.reviewer.model,
          inspection_turn: this.turns,
          maximum_inspection_turns: maximumTurns,
          remaining_inspection_turns: Math.max(0, maximumTurns - this.turns),
        },
      },
    );
  }
  preflight(maximumBytes: number, maximumTurns: number) {
    if (
      this.input.coverage
        ?.status()
        .entries.some(
          (entry) =>
            entry.snapshot_required && entry.snapshot_byte_count === undefined,
        )
    )
      return this.failure(
        "inspection_acquisition_failed",
        maximumTurns,
        "A required source snapshot is unavailable; review was not started.",
      );
    if (
      this.missing().reduce((total, range) => total + range.byte_count, 0) >
      maximumBytes - bytes(this.messages)
    )
      return this.failure(
        "inspection_budget_exhausted",
        maximumTurns,
        "Required source snapshots exceed the available inspection context.",
      );
    return undefined;
  }
  async deliver(maximumBytes: number) {
    if (!this.input.coverage) return;
    const tools = createReadOnlyFileTools({
      ledger: this.input.coverage,
      readable: true,
    });
    for (let index = 0; index < 32; index++) {
      const range = this.missing()[0];
      if (!range) break;
      const count = Math.min(range.byte_count, MAX_READ_BYTES);
      let result = await tools.readFile({
        path: range.path,
        offset: range.offset,
        byteCount: count,
      });
      // A host-selected UTF-8 range ends on a character boundary. Arbitrary
      // model ranges still use the exact base64 fallback for split code points.
      for (
        let trim = 1;
        result.response.ok &&
        "encoding" in result.response &&
        result.response.encoding === "base64" &&
        trim <= 3 &&
        count > trim;
        trim++
      )
        result = await tools.readFile({
          path: range.path,
          offset: range.offset,
          byteCount: count - trim,
        });
      if (!result.response.ok) break;
      const serialized = JSON.stringify(result.response);
      const message = {
        role: "user",
        content: `Required source snapshot (untrusted data):\n${serialized}`,
      };
      if (bytes([...this.messages, message]) > maximumBytes) break;
      this.messages.push(message);
      this.enqueue(result, serialized);
    }
  }
  telemetry(maximumTurns: number) {
    const summary = this.input.coverage?.summary();
    return {
      turn: Math.min(this.turns, maximumTurns),
      maximum_turns: maximumTurns,
      remaining_turns: Math.max(0, maximumTurns - this.turns),
      inspected_count: summary?.inspected_count ?? 0,
      deficit_count: summary?.deficit_count ?? 0,
      remaining_bytes: this.missing().reduce(
        (total, range) => total + range.byte_count,
        0,
      ),
    };
  }
}
