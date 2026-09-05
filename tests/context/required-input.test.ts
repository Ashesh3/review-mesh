import { describe, expect, it } from "vitest";
import { evaluateRequiredInput } from "../../src/context/required-input.js";

const request = {
  schema_version: "3" as const,
  project_name: "review-mesh",
  workspace: ".",
  instructions: "Review.",
  review_scope: { mode: "changes" as const },
};

describe("evaluateRequiredInput", () => {
  it("reports an absent pull-request selector", () => {
    expect(
      evaluateRequiredInput(request, ["/request/pull_request/id"]),
    ).toEqual([
      {
        selector: "/request/pull_request/id",
        code: "missing_required_input",
      },
    ]);
  });

  it("enumerates empty and invalid values while accepting explicitly empty arrays", () => {
    expect(
      evaluateRequiredInput(
        {
          ...request,
          pull_request: {
            id: "   ",
            url: "http://example.test/pr/1",
            title: "Title",
            description: "Description",
            work_items: [],
            validation: [],
            contract_impact: {
              status: "changed" as const,
              summary: "Changed",
              references: ["../escape", "https://user@example.test/contract"],
            },
          },
        },
        [
          "/request/pull_request/id",
          "/request/pull_request/url",
          "/request/pull_request/work_items",
          "/request/pull_request/validation",
          "/request/pull_request/contract_impact",
        ],
      ),
    ).toEqual([
      { selector: "/request/pull_request/id", code: "invalid_required_input" },
      { selector: "/request/pull_request/url", code: "invalid_required_input" },
      {
        selector: "/request/pull_request/contract_impact",
        code: "invalid_required_input",
      },
    ]);
  });

  it("uses own properties and RFC6901 escapes without prototype traversal", () => {
    const context = Object.create({ inherited: "secret" }) as Record<
      string,
      unknown
    >;
    context["a/b"] = { "~key": "present" };
    expect(
      evaluateRequiredInput({ ...request, context: context as never }, [
        "/context/inherited",
        "/context/a~1b/~0key",
        "/context/__proto__/x",
      ]),
    ).toEqual([
      { selector: "/context/inherited", code: "missing_required_input" },
      { selector: "/context/__proto__/x", code: "missing_required_input" },
    ]);
  });
});
