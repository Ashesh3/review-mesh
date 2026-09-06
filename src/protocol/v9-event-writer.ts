import { publicEventV6Schema, type PublicEventV6 } from "./v9.js";
import { RunArtifactError } from "../diagnostics/run-index.js";
import { sanitizePublicText } from "../adapters/errors.js";
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
  observe(
    outcome: PublicStreamOutcome,
    failure?: DeliveryFailure,
  ): Promise<void>;
  shutdownGraceMs?: number;
}

export interface DeliveryFailure {
  stage: "event_validation" | "event_persistence" | "output_write";
  event: string;
  attempted_seq: number;
  reviewer_id?: string | undefined;
  message: string;
  native_error_code?: string | undefined;
}
export class PublicDeliveryError extends Error {
  constructor(
    readonly details: DeliveryFailure,
    cause: unknown,
  ) {
    super(details.message, { cause });
    this.name = "PublicDeliveryError";
  }
}

/** Serializes public delivery around the authoritative artifact finalization. */
export function createV9EventWriter(options: V9EventWriterOptions) {
  let seq = 0;
  let tail = Promise.resolve();
  let terminal = false;
  let finalizing = false;
  let failure: Error | undefined;
  let deliveryFailure: DeliveryFailure | undefined;
  const grace = options.shutdownGraceMs ?? 5000;
  const remember = (error: Error) => {
    failure ??= error;
    options.output.once("error", remember);
  };
  options.output.once("error", remember);
  function materialize(draft: V9EventDraft): PublicEventV6 {
    const event = publicEventV6Schema.parse({
      ...draft,
      schema_version: "6",
      run_id: options.runId,
      ...(options.requestId === undefined
        ? {}
        : { request_id: options.requestId }),
      seq: seq + 1,
      timestamp: (options.now ?? (() => new Date()))().toISOString(),
    });
    seq += 1;
    return event;
  }
  function failed(
    stage: DeliveryFailure["stage"],
    draft: V9EventDraft,
    attemptedSeq: number,
    error: unknown,
  ) {
    const nativeCode = (error as { code?: unknown } | undefined)?.code;
    const details: DeliveryFailure = {
      stage,
      event: draft.event,
      attempted_seq: attemptedSeq,
      ...("reviewer_id" in draft && draft.reviewer_id
        ? { reviewer_id: draft.reviewer_id }
        : {}),
      message:
        stage === "event_validation"
          ? "The public event failed schema validation."
          : (sanitizePublicText(
              error instanceof Error ? error.message : error,
            ) ?? "Public delivery failed."),
      ...(typeof nativeCode === "string"
        ? {
            native_error_code: sanitizePublicText(nativeCode, 128) ?? "unknown",
          }
        : {}),
    };
    deliveryFailure ??= details;
    return new PublicDeliveryError(details, error);
  }
  function write(event: PublicEventV6): Promise<void> {
    return new Promise((resolve, reject) => {
      if (
        failure !== undefined ||
        (options.output as { destroyed?: boolean }).destroyed
      ) {
        reject(
          failure ??
            (options.output as { errored?: Error | null }).errored ??
            new Error("Public output is closed."),
        );
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
    failureDetails() {
      return deliveryFailure;
    },
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
      if (finalizing && draft.event !== "suite.heartbeat")
        return Promise.reject(
          new Error(
            "Only suite heartbeat events are allowed during finalization.",
          ),
        );
      const publicOnlyHeartbeat = finalizing;
      return enqueue(async () => {
        let event: PublicEventV6;
        try {
          event = materialize(draft);
        } catch (error) {
          throw failed("event_validation", draft, seq + 1, error);
        }
        if (event.event === "run.completed")
          throw new Error("Use finish for the terminal event.");
        // The artifact is already sealed once finalization begins. Continued
        // suite liveness is public-only and must never append after the private
        // terminal summary or participate in the artifact digest.
        if (!publicOnlyHeartbeat) {
          try {
            await options.recordEvent(event);
          } catch (error) {
            throw failed("event_persistence", draft, event.seq, error);
          }
        }
        try {
          await write(event);
        } catch (error) {
          throw failed("output_write", draft, event.seq, error);
        }
      });
    },
    async finish(summary: Record<string, unknown>): Promise<ArtifactReference> {
      if (terminal || finalizing)
        throw new Error("The terminal event has already been finalized.");
      finalizing = true;
      await tail;
      if (deliveryFailure) {
        summary = {
          ...summary,
          delivery_failure: deliveryFailure,
          result_delivery: {
            ...(summary.result_delivery as Record<string, unknown>),
            planned_public_stream: "failed",
          },
        };
      }
      let artifact: ArtifactReference;
      try {
        artifact = await options.finalize(summary);
        // Optional liveness writes remain admissible while durable artifact
        // finalization is in progress, but must settle before the terminal line.
        await tail;
      } catch (error) {
        await tail;
        terminal = true;
        finalizing = false;
        const details =
          error instanceof RunArtifactError ? error.diagnosticDetails : {};
        const failureEvent = materialize({
          event: "run.persistence_failed",
          data: {
            terminal: true,
            exit_code: 3,
            reason:
              error instanceof RunArtifactError
                ? error.code
                : "persistence_failed",
            stage:
              typeof details.stage === "string"
                ? details.stage
                : "artifact_finalization",
            message:
              error instanceof RunArtifactError
                ? (sanitizePublicText(error.message) ??
                  "Artifact publication failed.")
                : "Artifact publication failed.",
            ...(typeof details.native_error_code === "string"
              ? { native_error_code: details.native_error_code }
              : {}),
            ...(typeof details.path === "string" ? { path: details.path } : {}),
            ...(typeof details.recovery_command === "string"
              ? { recovery_command: details.recovery_command }
              : {}),
            ...(details.recovery_artifact
              ? { recovery_artifact: details.recovery_artifact }
              : {}),
          },
        } as V9EventDraft);
        await write(failureEvent).catch(() => undefined);
        throw error;
      } finally {
        terminal = true;
        finalizing = false;
      }
      const terminalDraft = {
        event: "run.completed",
        data: {
          ...summary,
          artifact,
          ...(deliveryFailure
            ? {
                delivery_failure: deliveryFailure,
                result_delivery: {
                  ...(summary.result_delivery as Record<string, unknown>),
                  planned_public_stream: "failed",
                },
              }
            : {}),
        },
      } as V9EventDraft;
      try {
        let event: PublicEventV6;
        try {
          event = materialize(terminalDraft);
        } catch (error) {
          throw failed("event_validation", terminalDraft, seq + 1, error);
        }
        try {
          await write(event);
        } catch (error) {
          throw failed("output_write", terminalDraft, event.seq, error);
        }
        const delivery = summary.result_delivery as {
          planned_public_stream: "complete" | "references_only" | "failed";
        };
        await options.observe(
          deliveryFailure ? "failed" : delivery.planned_public_stream,
          deliveryFailure,
        );
      } catch (error) {
        await options.observe("failed", deliveryFailure);
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

export type V9EventWriter = Omit<
  ReturnType<typeof createV9EventWriter>,
  "failureDetails"
> & {
  failureDetails?: () => DeliveryFailure | undefined;
};
