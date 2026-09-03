import { describe, expect, it } from "vitest";
import {
  adapterFailure,
  sanitizeAdapterFailure,
} from "../../src/adapters/errors.js";

describe("adapter failure diagnostics", () => {
  it("bounds and redacts optional diagnostic metadata", () => {
    const failure = sanitizeAdapterFailure(
      "protocol_violation",
      "Authorization: Bearer message-secret",
      false,
      {
        diagnostics: {
          failure_stage: `envelope\u0000${"x".repeat(200)}`,
          scope: "provider",
          http_status: 200,
          provider_request_id: "request Authorization: Bearer request-secret",
          finish_reason: "length",
          content_types: [
            "application/json",
            "secret=content-secret",
            ...Array.from({ length: 40 }, (_, index) => `type-${index}`),
          ],
          response_bytes: 1234,
          truncated: false,
          repair_attempted: true,
          repair_outcome: "failed",
        },
      },
    );

    expect(failure).toMatchObject({
      message: "[redacted]",
      fallback_eligible: true,
      diagnostics: {
        scope: "provider",
        http_status: 200,
        provider_request_id: "request [redacted]",
        finish_reason: "length",
        response_bytes: 1234,
        truncated: false,
        repair_attempted: true,
        repair_outcome: "failed",
      },
    });
    expect(failure.diagnostics?.failure_stage?.length).toBeLessThanOrEqual(64);
    expect(failure.diagnostics?.failure_stage).not.toContain("\u0000");
    expect(failure.diagnostics?.content_types).toHaveLength(32);
    expect(JSON.stringify(failure)).not.toContain("message-secret");
    expect(JSON.stringify(failure)).not.toContain("request-secret");
    expect(JSON.stringify(failure)).not.toContain("content-secret");
  });

  it("keeps cancellation ineligible while operational failures allow fallback", () => {
    expect(adapterFailure.cancelled().fallback_eligible).toBe(false);
    expect(adapterFailure.timeout("deadline").fallback_eligible).toBe(true);
    expect(
      adapterFailure.protocolViolation("invalid envelope").fallback_eligible,
    ).toBe(true);
    expect(adapterFailure.read("unsafe input").fallback_eligible).toBe(false);
  });

  it("redacts public failure values beyond bearer tokens", () => {
    const failure = adapterFailure.processCrashed(
      "https://user:password@example.test/path client_secret=value github_pat_abcdefghijklmnopqrstuvwxyz AccountKey=azure-secret",
    );
    const encoded = JSON.stringify(failure);
    expect(encoded).not.toContain("password");
    expect(encoded).not.toContain("github_pat_");
    expect(encoded).not.toContain("azure-secret");
    expect(encoded).not.toContain("client_secret=value");
  });

  it("drops invalid numeric and enumerated diagnostic fields", () => {
    const failure = sanitizeAdapterFailure("unknown", "failed", false, {
      diagnostics: {
        scope: "not-a-scope" as never,
        http_status: 99,
        response_bytes: -1,
        repair_outcome: "maybe" as never,
      },
    });

    expect(failure.diagnostics).toBeUndefined();
  });
});
