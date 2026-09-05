import { describe, expect, it } from "vitest";
import {
  adapterFailure,
  sanitizeAdapterFailure,
  sanitizePublicText,
} from "../../src/adapters/errors.js";
import { pageFailure } from "../../src/adapters/sdk-pages.js";
import { ResultPageError } from "../../src/results/result-pages.js";

describe("adapter failure diagnostics", () => {
  it("bounds and redacts optional diagnostic metadata", () => {
    const failure = sanitizeAdapterFailure(
      "protocol_violation",
      "Authorization: Bearer message-secret",
      false,
      {
        diagnostics: {
          failure_code: "provider_response_invalid",
          failure_stage: `envelope\u0000${"x".repeat(200)}`,
          scope: "provider",
          http_status: 200,
          provider_request_id: "request Authorization: Bearer request-secret",
          retry_after_ms: 12_000,
          correlation_headers: {
            "CF-Ray": "ray-123",
            traceparent: "00-trace-parent",
            authorization: "Bearer correlation-secret",
          },
          retry_blocked_by_circuit: true,
          circuit_caused_by_reviewer_id:
            "reviewer Authorization: Bearer circuit-secret",
          finish_reason: "length",
          content_types: [
            "application/json",
            "secret=content-secret",
            ...Array.from({ length: 40 }, (_, index) => `type-${index}`),
          ],
          response_bytes: 1234,
          response_fingerprint: "a".repeat(64),
          response_structure: {
            root_type: "object",
            top_level_keys: ["choices", "Authorization: Bearer key-secret"],
            choices_count: 1,
            first_choice_type: "object",
            first_choice_keys: ["message"],
            message_type: "object",
            message_keys: ["content"],
          },
          validation_issues: [
            {
              path: "$.choices[0].message",
              code: "invalid_type",
              message: "Expected object; secret=validation-secret",
            },
          ],
          truncated: false,
          repair_attempted: true,
          repair_outcome: "failed",
          attempt_count: 2,
          retry_outcome: "exhausted",
        },
      },
    );

    expect(failure).toMatchObject({
      message: "[redacted]",
      fallback_eligible: true,
      diagnostics: {
        failure_code: "provider_response_invalid",
        scope: "provider",
        http_status: 200,
        provider_request_id: "request [redacted]",
        retry_after_ms: 12_000,
        correlation_headers: {
          "cf-ray": "ray-123",
          traceparent: "00-trace-parent",
        },
        retry_blocked_by_circuit: true,
        circuit_caused_by_reviewer_id: "reviewer [redacted]",
        finish_reason: "length",
        response_bytes: 1234,
        response_fingerprint: "a".repeat(64),
        response_structure: {
          root_type: "object",
          top_level_keys: ["choices", "[redacted]"],
          choices_count: 1,
          first_choice_type: "object",
          first_choice_keys: ["message"],
          message_type: "object",
          message_keys: ["content"],
        },
        validation_issues: [
          {
            path: "$.choices[0].message",
            code: "invalid_type",
            message: "Expected object; [redacted]",
          },
        ],
        truncated: false,
        repair_attempted: true,
        repair_outcome: "failed",
        attempt_count: 2,
        retry_outcome: "exhausted",
      },
    });
    expect(failure.diagnostics?.failure_stage?.length).toBeLessThanOrEqual(64);
    expect(failure.diagnostics?.failure_stage).not.toContain("\u0000");
    expect(failure.diagnostics?.content_types).toHaveLength(32);
    expect(JSON.stringify(failure)).not.toContain("message-secret");
    expect(JSON.stringify(failure)).not.toContain("request-secret");
    expect(JSON.stringify(failure)).not.toContain("content-secret");
    expect(JSON.stringify(failure)).not.toContain("correlation-secret");
    expect(JSON.stringify(failure)).not.toContain("validation-secret");
    expect(JSON.stringify(failure)).not.toContain("key-secret");
    expect(JSON.stringify(failure)).not.toContain("circuit-secret");
  });

  it("keeps cancellation ineligible while operational failures allow fallback", () => {
    expect(adapterFailure.cancelled().fallback_eligible).toBe(false);
    expect(adapterFailure.timeout("deadline").fallback_eligible).toBe(true);
    expect(
      adapterFailure.protocolViolation("invalid envelope").fallback_eligible,
    ).toBe(true);
    expect(adapterFailure.read("unsafe input").fallback_eligible).toBe(false);
    expect(adapterFailure.cancelled().circuit_qualifying).toBe(false);
    expect(
      adapterFailure.timeout("deadline", true, {
        circuit_qualifying: true,
      }).circuit_qualifying,
    ).toBe(true);
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

  it("redacts and bounds arbitrary public text without creating a failure", () => {
    const text = sanitizePublicText(
      `client_secret=public-secret ${"x".repeat(100)}`,
      32,
    );
    expect(text).toContain("[redacted]");
    expect(text).not.toContain("public-secret");
    expect(text?.length).toBeLessThanOrEqual(32);
  });

  it("drops invalid numeric and enumerated diagnostic fields", () => {
    const failure = sanitizeAdapterFailure("unknown", "failed", false, {
      diagnostics: {
        scope: "not-a-scope" as never,
        http_status: 99,
        response_bytes: -1,
        repair_outcome: "maybe" as never,
        failure_code: "not-a-code" as never,
        retry_after_ms: -1,
        response_fingerprint: "not-a-sha256",
        correlation_headers: { authorization: "Bearer secret-value" },
        validation_issues: [{ path: "", code: "", message: "" }],
        response_structure: { root_type: "" },
        attempt_count: 0,
        retry_outcome: "maybe" as never,
      },
    });

    expect(failure.diagnostics).toBeUndefined();
  });

  it("drops untrusted retry-after values above the bounded maximum", () => {
    const failure = sanitizeAdapterFailure("unknown", "failed", true, {
      diagnostics: { retry_after_ms: 60_001 },
    });

    expect(failure.diagnostics).toBeUndefined();
  });

  it.each([
    "result_page_too_large",
    "structured_page_limit_exceeded",
    "provider_response_invalid",
    "protocol_violation",
  ] as const)("preserves the typed result-page reason %s", (reason) => {
    const failure = pageFailure(
      new ResultPageError(reason, "typed page failure", {
        receivedBytes: 123,
      }),
      "SDK",
    );
    expect(failure).toMatchObject({
      reason,
      diagnostics: { response_bytes: 123 },
    });
  });
});
