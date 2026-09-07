import type { SessionEvent } from "@github/copilot-sdk";
import { createHash } from "node:crypto";
import type { AdapterEvent } from "../adapters/types.js";

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, canonical(child)]),
    );
  return value;
}

const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Emit content-free progress; repeated reads and replayed deltas earn no new identity. */
export function createCopilotProgressTracker(capacity = 4096) {
  const tools = new Map<string, string>();
  const deltas = new Set<string>();
  const bytes = new Map<string, number>();
  return (
    event: SessionEvent,
  ): Extract<AdapterEvent, { type: "activity" }> | undefined => {
    const message = `Copilot ${event.type.replaceAll(".", " ")}.`;
    if (event.type === "tool.execution_start") {
      const serialized = JSON.stringify(event.data.arguments ?? null);
      const key = hash(event.data.toolCallId);
      if (
        serialized.length > 1024 * 1024 ||
        (!tools.has(key) && tools.size >= capacity)
      )
        return { type: "activity", message };
      const identity = hash([
        event.data.toolName,
        canonical(event.data.arguments ?? null),
      ]);
      tools.set(key, identity);
      return {
        type: "activity",
        message,
        identity: `copilot:tool:start:${identity}`,
      };
    }
    if (event.type === "tool.execution_complete") {
      const key = hash(event.data.toolCallId);
      const identity = tools.get(key);
      tools.delete(key);
      return {
        type: "activity",
        message,
        ...(event.data.success && identity
          ? { identity: `copilot:tool:complete:${identity}` }
          : {}),
      };
    }
    if (
      event.type === "assistant.message_delta" ||
      event.type === "assistant.reasoning_delta"
    ) {
      const eventId = hash(event.id);
      if (deltas.has(eventId) || !event.data.deltaContent) return undefined;
      const key = hash([
        event.type,
        event.type === "assistant.message_delta"
          ? event.data.messageId
          : event.data.reasoningId,
      ]);
      // Keep recent replay identities bounded without making active long streams
      // stop advancing after a lifetime event cap. Older replays are not retained.
      if (deltas.size >= capacity) deltas.delete(deltas.values().next().value!);
      if (!bytes.has(key) && bytes.size >= capacity)
        bytes.delete(bytes.keys().next().value!);
      deltas.add(eventId);
      const count = Math.min(
        Number.MAX_SAFE_INTEGER,
        (bytes.get(key) ?? 0) +
          Buffer.byteLength(event.data.deltaContent, "utf8"),
      );
      bytes.set(key, count);
      return {
        type: "activity",
        message,
        identity: `copilot:response:${key}`,
        byteCount: count,
      };
    }
    if (
      event.type === "session.compaction_start" ||
      event.type === "session.compaction_complete"
    )
      return {
        type: "activity",
        message,
        identity: `copilot:compaction:${hash([event.type, event.id])}`,
      };
    if (event.type === "assistant.turn_start")
      return { type: "activity", message };
    return undefined;
  };
}
