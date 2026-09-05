import { describe, expect, it } from "vitest";
import { renderHelp } from "../../src/discovery/help.js";
describe("current protocol help", () => {
  it("advertises current request and config versions and legacy compatibility", () => {
    expect(renderHelp("review")).toContain('The string "3"');
    expect(renderHelp("review")).toContain("pull_request");
    expect(renderHelp("review")).toContain("legacy v2");
    expect(renderHelp("config-file")).toContain("Schema version 7");
  });
});
