import type { AdapterRegistration } from "../config/schemas.js";
import { createNativeClaudeAdapter } from "./native-claude.js";
import { createNativeCopilotAdapter } from "./native-copilot.js";
import { createNativeCodexAdapter } from "./native-codex.js";
import { adapterFailure } from "./errors.js";
import type {
  AdapterCapabilities,
  AdapterEvent,
  AdapterFactory,
  AdapterReviewInput,
  ReviewAdapter,
} from "./types.js";

class UnavailableAdapter implements ReviewAdapter {
  readonly id: string;

  constructor(
    id: string,
    private readonly type: AdapterRegistration["type"],
  ) {
    this.id = id;
  }

  async probe(): Promise<AdapterCapabilities> {
    return {
      available: false,
      authenticated: "unknown",
      model_available: "unknown",
      streaming: false,
      cancellation: false,
      maximumIsolation: "unknown",
      message: `No trusted factory is registered for adapter type ${this.type}.`,
    };
  }

  async *run(_input: AdapterReviewInput): AsyncIterable<AdapterEvent> {
    yield {
      type: "failure",
      failure: adapterFailure.unavailable(
        `No trusted factory is registered for adapter type ${this.type}.`,
      ),
    };
  }
}

/** Holds factories registered by the trusted application composition only. */
export class AdapterRegistry {
  private readonly factories = new Map<
    AdapterRegistration["type"],
    AdapterFactory
  >();

  constructor() {
    this.register("codex", (registration) => {
      if (registration.type !== "codex")
        throw new Error("Expected Codex registration");
      return createNativeCodexAdapter(registration);
    });
    this.register("claude", (registration) =>
      createNativeClaudeAdapter(registration),
    );
    this.register("copilot", (registration) =>
      createNativeCopilotAdapter(registration),
    );
  }

  register(type: AdapterRegistration["type"], factory: AdapterFactory): void {
    this.factories.set(type, factory);
  }

  create(
    id: string,
    registration: AdapterRegistration,
    options?: { continuationAttempts?: number },
  ): ReviewAdapter {
    const factory = this.factories.get(registration.type);
    return factory === undefined
      ? new UnavailableAdapter(id, registration.type)
      : factory(registration, options);
  }
}
