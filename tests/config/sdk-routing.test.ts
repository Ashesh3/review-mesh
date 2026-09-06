import { describe, expect, it } from "vitest";
import {
  sdkForModel,
  routeSdkReviewers,
} from "../../src/config/sdk-routing.js";
import { resolvedReviewer, roundInput } from "../helpers/fixtures.js";
import type { ResolvedConfig } from "../../src/config/schemas.js";

const resolvedConfig = (input: Partial<ResolvedConfig>): ResolvedConfig => ({
  ...roundInput().config,
  ...input,
});

describe("SDK model routing", () => {
  it("preserves all command-only execution settings without rewriting the config", () => {
    const config = resolvedConfig({
      reviewers: [resolvedReviewer()],
      execution: {
        ...roundInput().config.execution,
        retry_attempts: 4,
        continuation_attempts: 3,
        retry_backoff_ms: 725,
      },
    });
    expect(routeSdkReviewers(config)).toBe(config);
    expect(config.execution).toMatchObject({
      retry_attempts: 4,
      continuation_attempts: 3,
      retry_backoff_ms: 725,
    });
  });
  it("rejects a mixed command and native SDK roster before execution", () => {
    const config = resolvedConfig({
      reviewers: [
        resolvedReviewer({ id: "command" }),
        resolvedReviewer({
          id: "native",
          model: "gpt-5.6",
          adapter: { type: "sdk" },
        }),
      ],
    });
    expect(() => routeSdkReviewers(config)).toThrow(
      /command.*SDK.*cannot.*same run/i,
    );
  });
  it("validates the selected family effort after resolving a generic SDK registration", () => {
    const config = resolvedConfig({
      reviewers: [
        resolvedReviewer({
          model: "claude-opus",
          effort: "ultra",
          adapter: { type: "sdk", api_key_env: "KEY" },
        }),
      ],
    });
    expect(() => routeSdkReviewers(config)).toThrow(
      /unsupported claude effort ultra/,
    );
  });
  it.each([
    ["gpt-5.6", "codex"],
    ["openai/gpt-5.5", "codex"],
    ["o3", "codex"],
    ["codex-mini-latest", "codex"],
    ["claude-opus-4-6", "claude"],
    ["anthropic/claude-sonnet", "claude"],
    ["kimi-k3", "copilot"],
    ["moonshotai/kimi-k3", "copilot"],
  ])("routes %s to %s", (model, expected) => {
    expect(sdkForModel(model)).toBe(expected);
  });

  it("routes a mixed SDK roster without changing model ids or credentials", () => {
    const config = resolvedConfig({
      reviewers: [
        resolvedReviewer({
          id: "openai",
          model: "gpt-5.6",
          adapterId: "gateway",
          adapter: {
            type: "sdk",
            base_url_env: "REVIEW_URL",
            api_key_env: "REVIEW_KEY",
          },
        }),
        resolvedReviewer({
          id: "anthropic",
          model: "claude-opus",
          adapterId: "gateway",
          adapter: {
            type: "sdk",
            base_url_env: "REVIEW_URL",
            api_key_env: "REVIEW_KEY",
          },
        }),
        resolvedReviewer({
          id: "other",
          model: "kimi-k3",
          adapterId: "gateway",
          adapter: {
            type: "sdk",
            base_url_env: "REVIEW_URL",
            api_key_env: "REVIEW_KEY",
          },
        }),
      ],
    });
    const routed = routeSdkReviewers(config);
    expect(routed.reviewers.map((r) => [r.model, r.adapter.type])).toEqual([
      ["gpt-5.6", "codex"],
      ["claude-opus", "claude"],
      ["kimi-k3", "copilot"],
    ]);
    expect(
      routed.reviewers.every(
        (r) =>
          "base_url_env" in r.adapter &&
          r.adapter.base_url_env === "REVIEW_URL",
      ),
    ).toBe(true);
    expect(config.reviewers.every((r) => r.adapter.type === "sdk")).toBe(true);
  });

  it("rejects the retired raw inference path instead of silently running it", () => {
    const config = resolvedConfig({
      reviewers: [
        resolvedReviewer({
          model: "gpt-5.6",
          adapter: {
            type: "openai_compatible",
            base_url_env: "URL",
            api_key_env: "KEY",
          },
        }),
      ],
    });
    expect(() => routeSdkReviewers(config)).toThrow(/type.*sdk/i);
  });

  it("rejects vendor models assigned to the wrong native harness", () => {
    const config = resolvedConfig({
      reviewers: [
        resolvedReviewer({ model: "claude-opus", adapter: { type: "codex" } }),
      ],
    });
    expect(() => routeSdkReviewers(config)).toThrow(/Claude.*claude/i);
  });

  it("requires explicit migration of old snapshot coverage", () => {
    const config = resolvedConfig({
      reviewers: [
        resolvedReviewer({
          model: "gpt-5.6",
          adapter: { type: "sdk" },
          policy: {
            applicability: { mode: "always" },
            requiredCallerContext: [],
            passQuorum: 1,
            minimumProviderGroups: 1,
            adjudication: "off",
            gateMinimumSeverity: "medium",
            gateMinimumConfidence: "medium",
            changeCoverage: {
              relevantPaths: ["**"],
              minimumInspection: "full_file",
              proof: "observed",
            },
          },
        }),
      ],
    });
    expect(() => routeSdkReviewers(config)).toThrow(/native_attested/);
  });
});
