import { publicEventV6Schema, type PublicEventV6 } from "./v9.js";
import type {
  ArtifactReference,
  PublicStreamOutcome,
} from "../diagnostics/run-index.js";
import type { EventSink } from "./event-writer.js";

export type V9EventDraft = PublicEventV6 extends infer Event
  ? Event extends PublicEventV6
    ? Omit<
        Event,
        "schema_version" | "run_id" | "request_id" | "seq" | "timestamp"
      >
    : never
  : never;

export interface V9EventWriterOptions {
  output: EventSink;
  runId: string;
  requestId?: string;
  now?: () => Date;
  recordEvent(event: PublicEventV6): Promise<void>;
  finalize(summary: Record<string, unknown>): Promise<ArtifactReference>;
  observe(outcome: PublicStreamOutcome): Promise<void>;
  shutdownGraceMs?: number;
}

/** Serializes public delivery around the authoritative artifact finalization. */
export function createV9EventWriter(options: V9EventWriterOptions) {
  let seq = 0;
  let tail = Promise.resolve();
  let terminal = false;
  let finalizing = false;
  let failure: Error | undefined;
  const grace = options.shutdownGraceMs ?? 5000;
  const remember = (error: Error) => {
    failure ??= error;
    options.output.once("error", remember);
  };
  options.output.once("error", remember);
  function materialize(draft: V9EventDraft): PublicEventV6 {
    return publicEventV6Schema.parse({
      ...draft,
      schema_version: "6",
      run_id: options.runId,
      ...(options.requestId === undefined
        ? {}
        : { request_id: options.requestId }),
      seq: ++seq,
      timestamp: (options.now ?? (() => new Date()))().toISOString(),
    });
  }
  function write(event: PublicEventV6): Promise<void> {
    return new Promise((resolve, reject) => {
      if (
        failure !== undefined ||
        (options.output as { destroyed?: boolean }).destroyed
      ) {
        reject(failure ?? new Error("Public output is closed."));
        return;
      }
      let callback = false,
        drained = false,
        returned = false,
        settled = false;
      const timer = setTimeout(
        () => finish(new Error("Public output exceeded shutdown grace.")),
        grace,
      );
      const finish = (error?: Error | null) => {
        if (settled) return;
        if (error === undefined || error === null) {
          if (!callback || !drained || !returned) return;
        } else failure ??= error;
        settled = true;
        clearTimeout(timer);
        options.output.removeListener("error", onError);
        options.output.removeListener("drain", onDrain);
        if (error) reject(error);
        else resolve();
      };
      const onError = (error: Error) => finish(error);
      const onDrain = () => {
        drained = true;
        finish();
      };
      options.output.once("error", onError);
      try {
        const accepted = options.output.write(
          JSON.stringify(event) + "\n",
          (error) => {
            callback = true;
            finish(error);
          },
        );
        returned = true;
        drained = accepted;
        if (!accepted) options.output.once("drain", onDrain);
        finish();
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }
  const enqueue = (operation: () => Promise<void>) => {
    const result = tail.then(operation);
    tail = result.catch(() => undefined);
    return result;
  };
  return {
    outputFailed() {
      return (
        failure !== undefined ||
        (options.output as { destroyed?: boolean }).destroyed === true
      );
    },
    emit(draft: V9EventDraft): Promise<void> {
      if (terminal)
        return Promise.reject(
          new Error("No public event is allowed after the terminal event."),
        );
      return enqueue(async () => {
        const event = materialize(draft);
        if (event.event === "run.completed")
          throw new Error("Use finish for the terminal event.");
        await options.recordEvent(event);
        await write(event);
      });
    },
    async finish(summary: Record<string, unknown>): Promise<ArtifactReference> {
      if (terminal || finalizing)
        throw new Error("The terminal event has already been finalized.");
      finalizing = true;
      await tail;
      let artifact: ArtifactReference;
      try {
        artifact = await options.finalize(summary);
        // Optional liveness writes remain admissible while durable artifact
        // finalization is in progress, but must settle before the terminal line.
        await tail;
      } finally {
        terminal = true;
        finalizing = false;
      }
      const event = materialize({
        event: "run.completed",
        data: { ...summary, artifact },
      } as V9EventDraft);
      try {
        await write(event);
        const delivery = summary.result_delivery as {
          planned_public_stream: "complete" | "references_only";
        };
        await options.observe(delivery.planned_public_stream);
      } catch (error) {
        await options.observe("failed");
        throw error;
      }
      return artifact;
    },
    async close() {
      await tail;
      options.output.removeListener("error", remember);
    },
  };
}

export type V9EventWriter = ReturnType<typeof createV9EventWriter>;
