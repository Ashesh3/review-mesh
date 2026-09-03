import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { dashboardHtml } from "../../src/server/dashboard-ui.js";

const style = /<style>([\s\S]*?)<\/style>/u.exec(dashboardHtml)?.[1] ?? "";

function cssRule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, "u").exec(style);
  expect(match, `missing CSS rule: ${selector}`).not.toBeNull();
  return match?.[1] ?? "";
}

function expectTouchSafeTarget(selector: string): void {
  expect(cssRule(selector)).toMatch(
    /(?:min-height|height):\s*(?:var\(--control-size\)|44px)/u,
  );
}

describe("embedded dashboard UI", () => {
  it("uses accessible inline SVG icons for structural controls", () => {
    const icons =
      dashboardHtml.match(
        /<svg\b[^>]*class="[^"]*\bicon\b[^"]*"[^>]*aria-hidden="true"[^>]*>/gu,
      ) ?? [];

    expect(icons.length).toBeGreaterThanOrEqual(6);
    expect(dashboardHtml).not.toMatch(/[◎◇▦⌁↻×←]/u);

    const refresh =
      /<button\b[^>]*id="refresh-button"[^>]*>([\s\S]*?)<\/button>/u.exec(
        dashboardHtml,
      );
    expect(refresh?.[0]).toContain('aria-label="Refresh dashboard"');
    expect(refresh?.[1]).toMatch(/<svg\b/u);
  });

  it("gives primary navigation and controls touch-safe targets", () => {
    expect(style).toMatch(/--control-size:\s*44px/u);
    expectTouchSafeTarget(".icon-button");
    expectTouchSafeTarget(".nav a");
    expectTouchSafeTarget(".reviewer-chip");
    expectTouchSafeTarget(".reviewer-button");
    expectTouchSafeTarget(".tab");
    expect(style).toMatch(
      /button\s*,\s*a\s*\{[^}]*touch-action:\s*manipulation/u,
    );
  });

  it("keeps long metric values inside their summary cards", () => {
    expect(cssRule(".metric-value")).toMatch(/overflow-wrap:\s*anywhere/u);

    const helper =
      /function compactMetricValue\(value\) \{([\s\S]*?)\n    \}/u.exec(
        dashboardHtml,
      );
    expect(helper).not.toBeNull();
    const compactMetricValue = new Function(
      `${helper?.[0] ?? ""}; return compactMetricValue;`,
    )() as (value: unknown) => string;

    expect(compactMetricValue("1234567890abcdef1234567890abcdef")).toBe(
      "1234567890ab…90abcdef",
    );
    expect(compactMetricValue("Read only")).toBe("Read only");
    expect(dashboardHtml).toMatch(
      /class="metric-value" title="' \+ escapeAttr\(rawValue\)/u,
    );
  });

  it("reflows recent review rows for phone-width viewports", () => {
    expect(style).toMatch(/body\s*\{[^}]*overflow-x:\s*(?:clip|hidden)/u);
    expect(style).toMatch(/\.shell\s*\{[^}]*min-height:\s*100dvh/u);
    expect(style).toMatch(
      /@media\s*\(max-width:\s*480px\)[\s\S]*?\.metric-grid\s*\{[^}]*grid-template-columns:\s*1fr/u,
    );
    expect(style).toMatch(
      /@media\s*\(max-width:\s*480px\)[\s\S]*?thead\s*\{[^}]*display:\s*none/u,
    );
    expect(style).toMatch(
      /@media\s*\(max-width:\s*480px\)[\s\S]*?tbody\s+tr\s*\{[^}]*display:\s*grid/u,
    );
    expect(dashboardHtml).toMatch(/<td\b[^>]*data-label=/u);
  });

  it("fully disables decorative motion when reduced motion is requested", () => {
    const start = style.indexOf("@media (prefers-reduced-motion: reduce)");
    expect(start).toBeGreaterThanOrEqual(0);
    const reducedMotion = style.slice(start);

    expect(reducedMotion).toMatch(/animation:\s*none\s*!important/u);
    expect(reducedMotion).toMatch(/transition:\s*none\s*!important/u);
    expect(reducedMotion).toMatch(/scroll-behavior:\s*auto\s*!important/u);
  });

  it("stays self-contained without a React, StyleX, or Astryx runtime", async () => {
    expect(dashboardHtml).not.toMatch(/<link\b[^>]*rel=["']stylesheet["']/iu);
    expect(dashboardHtml).not.toMatch(/<script\b[^>]*\bsrc\s*=/iu);
    expect(style).not.toMatch(/@import\s|url\(\s*["']?https?:\/\//iu);

    const packageJson = JSON.parse(
      await readFile(new URL("../../package.json", import.meta.url), "utf8"),
    ) as {
      dependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };
    const runtimeNames = Object.keys({
      ...packageJson.dependencies,
      ...packageJson.optionalDependencies,
    });
    const forbiddenRuntime =
      /(?:^|[/@-])(?:react(?:-dom)?|stylex(?:js)?|astryx)(?=$|[/@-])/iu;

    expect(runtimeNames.filter((name) => forbiddenRuntime.test(name))).toEqual(
      [],
    );
  });
});
