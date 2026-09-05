import { Window } from "happy-dom";
import { afterEach, describe, expect, it } from "vitest";
import { dashboardHtml } from "../../src/server/dashboard-ui.js";
import { dashboardClient } from "../../src/server/dashboard-client.js";
import { dashboardFixture } from "../helpers/dashboard-fixture.js";

const windows: Window[] = [];
afterEach(async () => {
  for (const window of windows.splice(0)) await window.happyDOM.close();
});

async function openDashboard(
  hash = "#/reviews",
  configure?: (
    fixture: ReturnType<typeof dashboardFixture>,
    window: Window,
  ) => void,
) {
  const window = new Window({
    url: `http://localhost:3000/${hash}`,
    settings: {
      enableJavaScriptEvaluation: true,
      suppressInsecureJavaScriptEnvironmentWarning: true,
      disableJavaScriptFileLoading: true,
    },
  });
  windows.push(window);
  const fixture = dashboardFixture();
  configure?.(fixture, window);
  const streamListeners = new Map<string, () => void>();
  const response = (data: unknown) =>
    new window.Response(JSON.stringify(data), {
      headers: { "Content-Type": "application/json" },
    });
  window.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/api/snapshot")) return response(fixture.snapshot);
    const match = /\/api\/runs\/([^/]+)(?:\/reviewers\/(.+))?$/.exec(url);
    if (match?.[2]) {
      const reviewer = fixture.reviewers.find(
        (r) => r.reviewer_id === decodeURIComponent(match[2]!),
      );
      return response(reviewer ?? {});
    }
    return response(fixture.runs[decodeURIComponent(match?.[1] ?? "")] ?? {});
  };
  Object.defineProperty(window, "EventSource", {
    value: class {
      onopen?: () => void;
      onerror?: () => void;
      onmessage?: () => void;
      constructor() {
        queueMicrotask(() => this.onopen?.());
      }
      addEventListener(name: string, fn: () => void) {
        streamListeners.set(name, fn);
      }
      close() {}
    },
  });
  window.document.write(
    dashboardHtml.replace(/<script>[\s\S]*?<\/script>/gu, ""),
  );
  window.eval(dashboardClient);
  await settle();
  return {
    window,
    document: window.document,
    fixture,
    invalidate: () => streamListeners.get("invalidate")?.(),
  };
}
async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 35));
}

describe("dashboard user workflows", () => {
  it("does not mark stages complete when a review terminates before context and reviewer selection", async () => {
    const { document } = await openDashboard(
      "#/reviews/run-complete",
      (fixture) => {
        fixture.runs["run-complete"] = {
          run_id: "run-complete",
          active: false,
          status: "inconclusive",
          run_outcome: "inconclusive",
          stage: "complete",
          reviewers: [],
          events: [
            {
              event: "run.started",
              seq: 1,
              timestamp: "2026-09-05T08:30:00.000Z",
              data: {},
            },
            {
              event: "run.completed",
              seq: 2,
              timestamp: "2026-09-05T08:30:01.000Z",
              data: { run_outcome: "inconclusive" },
            },
          ],
        };
      },
    );
    const stages = document.querySelectorAll(".timeline-milestones .milestone");
    expect(stages.length).toBe(5);
    expect(stages[1]!.getAttribute("aria-label")).not.toContain(": complete");
    expect(stages[2]!.getAttribute("aria-label")).not.toContain(": complete");
    expect(stages[3]!.getAttribute("aria-label")).not.toContain(": complete");
  });
  it("skips navigation without changing the current review route", async () => {
    const { document, window } = await openDashboard("#/reviews/run-active");
    document
      .querySelector(".skip-link")
      ?.dispatchEvent(
        new window.MouseEvent("click", { bubbles: true, cancelable: true }),
      );
    await settle();
    expect(window.location.hash).toBe("#/reviews/run-active");
    expect(document.activeElement?.id).toBe("main-content");
  });

  it("retains keyboard focus on an assigned reviewer link during refresh", async () => {
    const { document, window, invalidate } = await openDashboard("#/projects");
    document
      .querySelector("[data-select-project]")
      ?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await settle();
    const link = document.querySelector(".assigned-reviewer") as InstanceType<
      typeof window.HTMLAnchorElement
    >;
    link.focus();
    const href = link.getAttribute("href");
    invalidate();
    await new Promise((resolve) => setTimeout(resolve, 180));
    expect(document.activeElement?.getAttribute("href")).toBe(href);
  });
  it("drains a final invalidation that arrives while a reviewer refresh is pending", async () => {
    const { document, window, fixture, invalidate } = await openDashboard(
      "#/reviews/run-active",
    );
    document
      .querySelector('[data-open-reviewer="security::primary"]')
      ?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await settle();
    const fetch = window.fetch;
    let release: () => void = () => {};
    let started: () => void = () => {};
    const waiting = new Promise<void>((resolve) => {
      started = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let hold = true;
    window.fetch = async (input, init) => {
      const result = await fetch(input, init);
      if (hold && String(input).includes("/reviewers/")) {
        hold = false;
        started();
        await blocked;
      }
      return result;
    };
    invalidate();
    await waiting;
    fixture.reviewers[0]!.activity = [
      {
        timestamp: "2026-09-05T08:32:00.000Z",
        summary: "Final completion arrived during refresh",
      },
    ];
    invalidate();
    release();
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(document.querySelector(".dock-panel")?.textContent).toContain(
      "Final completion arrived during refresh",
    );
  });
  it("keeps the complete lens roster visible and inspects a reviewer without hiding the timeline", async () => {
    const { document } = await openDashboard("#/reviews/run-active");
    const button = document.querySelector(
      '[data-open-reviewer="security::primary"]',
    );
    expect(button, "a live reviewer is selectable").not.toBeNull();
    button?.dispatchEvent(
      new document.defaultView!.MouseEvent("click", { bubbles: true }),
    );
    await settle();
    expect(document.querySelector(".dock-panel")?.textContent).toContain(
      "Security",
    );
    expect(document.querySelector(".dock-panel")?.textContent).toContain(
      "Inspecting changed authentication code",
    );
    expect(document.querySelector(".shell")?.getAttribute("inert")).toBeNull();
    expect(document.querySelectorAll("[data-toggle-lens]").length).toBe(3);
    expect(document.body.textContent).toContain("performance");
  });

  it("filters reviews while preserving the typed query and focus during a live refresh", async () => {
    const { document, window, invalidate } = await openDashboard();
    expect(document.querySelector("tbody td")?.getAttribute("data-label")).toBe(
      "Project",
    );
    const input = document.querySelector(
      'input[type="search"]',
    ) as InstanceType<typeof window.HTMLInputElement>;
    expect(input).not.toBeNull();
    input.focus();
    input.value = "no-such-project";
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
    await settle();
    invalidate();
    await new Promise((resolve) => setTimeout(resolve, 180));
    const refreshed = document.querySelector(
      'input[type="search"]',
    ) as InstanceType<typeof window.HTMLInputElement>;
    expect(refreshed.value).toBe("no-such-project");
    expect(document.activeElement).toBe(refreshed);
    expect(document.querySelectorAll("[data-select-run]").length).toBe(0);
  });

  it("supports a persistent color-theme selection and keyboard inspector resizing", async () => {
    const { document, window } = await openDashboard("#/projects");
    const light = document.querySelector('[data-theme-option="light"]')!;
    const dark = document.querySelector('[data-theme-option="dark"]')!;
    expect(light).not.toBeNull();
    light.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(light.getAttribute("aria-pressed")).toBe("true");
    dark.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(dark.getAttribute("aria-pressed")).toBe("true");
    expect(light.getAttribute("aria-pressed")).toBe("false");
    expect(window.localStorage.getItem("review-mesh.theme")).toBe("dark");
    document
      .querySelector("[data-select-project]")
      ?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await settle();
    const handle = document.querySelector(".dock-resizer")!;
    const before = Number(handle.getAttribute("aria-valuenow"));
    handle.dispatchEvent(
      new window.KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }),
    );
    expect(
      Number(
        document.querySelector(".dock-resizer")?.getAttribute("aria-valuenow"),
      ),
    ).toBeGreaterThan(before);
  });

  it("honors a saved light theme at startup", async () => {
    const { document } = await openDashboard("#/reviews", (_, window) =>
      window.localStorage.setItem("review-mesh.theme", "light"),
    );
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("escapes hostile finding content while preserving its readable evidence", async () => {
    const hostile = '<img src=x onerror="window.injected=true">';
    const { document, window } = await openDashboard(
      "#/reviews/run-complete?tab=findings",
      (fixture) => {
        fixture.finding.title = hostile;
        fixture.finding.evidence[0]!.detail = hostile;
      },
    );
    document
      .querySelector("[data-select-finding]")
      ?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await settle();
    document
      .querySelector('[data-inspector-tab="evidence"]')
      ?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    expect(document.querySelector(".dock-panel")?.textContent).toContain(
      hostile,
    );
    expect(document.querySelector("#app img")).toBeNull();
    expect(document.querySelector("[onerror]")).toBeNull();
  });

  it("refreshes the selected reviewer's activity and result without closing its inspector", async () => {
    const { document, window, fixture, invalidate } = await openDashboard(
      "#/reviews/run-active",
    );
    document
      .querySelector('[data-open-reviewer="security::primary"]')
      ?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await settle();
    fixture.reviewers[0]!.activity = [
      {
        timestamp: "2026-09-05T08:31:00.000Z",
        summary: "Review finished successfully",
      },
    ];
    fixture.reviewers[0]!.state = "completed";
    fixture.reviewers[0]!.phase = "terminal";
    invalidate();
    await new Promise((resolve) => setTimeout(resolve, 180));
    expect(document.querySelector(".dock-panel")?.textContent).toContain(
      "Review finished successfully",
    );
    expect(document.querySelector(".dock-panel")?.textContent).toContain(
      "Security",
    );
  });

  it("selects a finding and shows recorded evidence without executing markup", async () => {
    const { document, window } = await openDashboard(
      "#/reviews/run-complete?tab=findings",
    );
    const finding = document.querySelector("[data-select-finding]");
    expect(finding).not.toBeNull();
    finding?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await settle();
    expect(document.querySelector(".dock-panel")?.textContent).toContain(
      "Retry can submit a payment twice",
    );
    const evidence = document.querySelector('[data-inspector-tab="evidence"]');
    evidence?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await settle();
    expect(document.querySelector(".dock-panel")?.textContent).toContain(
      "src/payment.ts",
    );
  });

  it.each([
    ["agents", "agent"],
    ["projects", "project"],
    ["system", "adapter"],
  ])("opens the %s selection in the bottom inspector", async (route, kind) => {
    const { document, window } = await openDashboard(`#/${route}`);
    const selection = document.querySelector(`[data-select-${kind}]`);
    expect(selection).not.toBeNull();
    selection?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await settle();
    expect(document.querySelector(".dock-panel")).not.toBeNull();
    expect(document.querySelector(".dock-resizer")?.getAttribute("role")).toBe(
      "separator",
    );
  });

  it("filters event history and opens a recorded event in the inspector", async () => {
    const { document, window } = await openDashboard(
      "#/reviews/run-active?tab=events",
    );
    const selection = document.querySelector("[data-select-event]");
    expect(selection).not.toBeNull();
    selection?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await settle();
    expect(document.querySelector(".dock-panel")).not.toBeNull();
    expect(document.body.textContent).toContain("heartbeat");
  });
});
