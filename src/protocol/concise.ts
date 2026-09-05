import { createHash } from "node:crypto";
import { canonicalJson } from "../results/digest.js";
import type { V9RunOutcome } from "./v9.js";

function compareCodePoints(left: string, right: string): number {
  const a = Array.from(left, (value) => value.codePointAt(0)!);
  const b = Array.from(right, (value) => value.codePointAt(0)!);
  for (let index = 0; index < Math.min(a.length, b.length); index++) {
    if (a[index] !== b[index]) return a[index]! - b[index]!;
  }
  return a.length - b.length;
}

/** Samples whole entries while binding the public sample to the complete list. */
export function boundedList<T>(
  values: readonly T[],
  key: (value: T) => string,
  maximum = 8,
) {
  if (!Number.isSafeInteger(maximum) || maximum < 0 || maximum > 8)
    throw new TypeError("public list maximum must be between zero and eight");
  const ordered = [...values].sort(
    (left, right) =>
      compareCodePoints(key(left), key(right)) ||
      compareCodePoints(canonicalJson(left), canonicalJson(right)),
  );
  return {
    items: structuredClone(ordered.slice(0, maximum)),
    total: ordered.length,
    omitted: Math.max(0, ordered.length - maximum),
    sha256: createHash("sha256")
      .update(canonicalJson(ordered), "utf8")
      .digest("hex"),
  };
}

export function runOutcome(input: {
  cancelled: boolean;
  coverage: "complete" | "partial";
  gateFindings: number;
}): V9RunOutcome {
  if (input.cancelled) return "cancelled";
  if (input.coverage === "partial") return "inconclusive";
  return input.gateFindings > 0 ? "gate_findings" : "clear";
}

/** Detailed-byte exhaustion reduces payloads, never the scheduled liveness rate. */
export function createHeartbeatBudget(options: {
  intervalMs: number;
  maximumBytes?: number;
}) {
  if (
    !Number.isSafeInteger(options.intervalMs) ||
    options.intervalMs < 1000 ||
    options.intervalMs > 300_000
  )
    throw new TypeError("heartbeat interval must be 1000-300000 ms");
  const maximumBytes = options.maximumBytes ?? 1024 * 1024;
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1)
    throw new TypeError(
      "heartbeat byte budget must be a positive safe integer",
    );
  let lastAt: number | undefined;
  let detailedBytes = 0;
  let totalBytes = 0;
  let minimalMode = false;
  return {
    get detailedBytes() {
      return detailedBytes;
    },
    get totalBytes() {
      return totalBytes;
    },
    select<T extends object, U extends object>(
      at: number,
      detailed: T,
      minimal: U,
    ): { data: T | U; minimal: boolean } | undefined {
      if (!Number.isSafeInteger(at) || at < 0)
        throw new TypeError(
          "heartbeat time must be a nonnegative safe integer",
        );
      if (lastAt !== undefined && at - lastAt < options.intervalMs)
        return undefined;
      const detailedSize = minimalMode
        ? 0
        : Buffer.byteLength(JSON.stringify(detailed) + "\n", "utf8");
      if (detailedSize >= 16 * 1024)
        throw new Error("heartbeat must remain below 16 KiB");
      const nextMinimal =
        minimalMode || detailedBytes + detailedSize > maximumBytes;
      const data = nextMinimal ? minimal : detailed;
      const size = Buffer.byteLength(JSON.stringify(data) + "\n", "utf8");
      if (size >= 16 * 1024)
        throw new Error("heartbeat must remain below 16 KiB");
      lastAt = at;
      minimalMode = nextMinimal;
      if (!nextMinimal) detailedBytes += size;
      totalBytes += size;
      return { data, minimal: nextMinimal };
    },
  };
}
