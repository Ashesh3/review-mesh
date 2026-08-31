import { adapterFailure } from "../../src/adapters/errors.js";
import type {
  AdapterCapabilities,
  AdapterEvent,
  AdapterReviewInput,
  ReviewAdapter,
} from "../../src/adapters/types.js";
import type { ResolvedReviewer } from "../../src/config/schemas.js";
import { AsyncQueue } from "./async-queue.js";

export interface FakeAdapterOptions {
  id?: string;
  capabilities?: AdapterCapabilities;
  onRun?: (
    queue: AsyncQueue<AdapterEvent>,
    input: AdapterReviewInput,
  ) => void | Promise<void>;
}

const defaultCapabilities: AdapterCapabilities = {
  available: true,
  authenticated: true,
  model_available: true,
  streaming: true,
  cancellation: true,
  maximumIsolation: "prompt_only",
};

export class FakeAdapter implements ReviewAdapter {
  readonly id: string;
  runCalls = 0;
  readonly inputs: AdapterReviewInput[] = [];
  readonly probeCalls: Array<{
    reviewer: ResolvedReviewer;
    signal: AbortSignal;
  }> = [];
  private readonly capabilities: AdapterCapabilities;
  private readonly onRun?: FakeAdapterOptions["onRun"];

  constructor(options: FakeAdapterOptions = {}) {
    this.id = options.id ?? "fake";
    this.capabilities = options.capabilities ?? defaultCapabilities;
    this.onRun = options.onRun;
  }

  async probe(
    reviewer: ResolvedReviewer,
    signal: AbortSignal,
  ): Promise<AdapterCapabilities> {
    this.probeCalls.push({ reviewer, signal });
    return this.capabilities;
  }

  run(input: AdapterReviewInput): AsyncIterable<AdapterEvent> {
    this.runCalls += 1;
    this.inputs.push(input);
    const queue = new AsyncQueue<AdapterEvent>();
    void Promise.resolve(this.onRun?.(queue, input)).then(
      () => queue.end(),
      (error: unknown) => {
        queue.push({
          type: "failure",
          failure: adapterFailure.unknown(
            error instanceof Error ? error.message : error,
          ),
        });
        queue.end();
      },
    );
    return queue;
  }
}
