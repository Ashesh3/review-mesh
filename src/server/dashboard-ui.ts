import { dashboardStyles } from "./dashboard-styles.js";
import { dashboardClient } from "./dashboard-client.js";

/**
 * Embedded, dependency-free observer UI for `review-mesh serve`.
 *
 * Keep this document self-contained: the portable build and Bun standalone
 * executable serve it directly without a runtime asset directory.
 */
export const dashboardHtml = String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
  <meta name="color-scheme" content="dark light">
  <meta name="theme-color" content="#14181d">
  <title>Review Mesh Observer</title>
  <script>
  (function () {
    var preference = "system";
    try { preference = localStorage.getItem("review-mesh.theme") || "system"; } catch (_) {}
    var theme = preference === "dark" || preference === "light" ? preference : (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
  }());
  </script>
  <style>
${dashboardStyles}
  </style>
</head>
<body>
  <a class="skip-link" href="#main-content">Skip to dashboard</a>
  <div class="shell">
    <aside class="sidebar" aria-label="Primary navigation">
      <div class="brand">
        <div class="brand-mark" aria-hidden="true">
          <svg class="icon" aria-hidden="true" viewBox="0 0 24 24"><circle cx="6" cy="6" r="2"></circle><circle cx="18" cy="6" r="2"></circle><circle cx="6" cy="18" r="2"></circle><circle cx="18" cy="18" r="2"></circle><circle cx="12" cy="12" r="2"></circle><path d="M7.7 7.7 10.3 10.3M16.3 7.7 13.7 10.3M7.7 16.3 10.3 13.7M16.3 16.3 13.7 13.7"></path></svg>
        </div>
        <div class="brand-copy"><strong>Review Mesh</strong></div>
      </div>

      <nav class="nav">
        <a href="#/reviews" data-nav="reviews"><span class="nav-glyph"><svg class="icon" aria-hidden="true" viewBox="0 0 24 24"><path d="M4 7h16M4 12h10M4 17h7"></path><circle cx="18" cy="14" r="3"></circle><path d="m20.2 16.2 1.8 1.8"></path></svg></span><span>Reviews</span></a>
        <a href="#/agents" data-nav="agents"><span class="nav-glyph"><svg class="icon" aria-hidden="true" viewBox="0 0 24 24"><circle cx="9" cy="8" r="3"></circle><circle cx="17" cy="10" r="2.5"></circle><path d="M3.5 19c.5-3.4 2.4-5 5.5-5s5 1.6 5.5 5M14 15c2.9-.4 5 .9 6 4"></path></svg></span><span>Reviewers</span></a>
        <a href="#/projects" data-nav="projects"><span class="nav-glyph"><svg class="icon" aria-hidden="true" viewBox="0 0 24 24"><path d="M3.5 6.5h6l2 2H20.5v9.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"></path><path d="M3.5 10.5h17"></path></svg></span><span>Projects</span></a>
        <a href="#/system" data-nav="system"><span class="nav-glyph"><svg class="icon" aria-hidden="true" viewBox="0 0 24 24"><path d="M4 7h7M15 7h5M4 17h3M11 17h9M9 4v6M9 14v6M15 4v6M7 14v6"></path></svg></span><span>System</span></a>
      </nav>
      <div class="sidebar-foot">
        <div class="read-only"><span class="lock-dot"></span><span>Local · Read only</span></div>
      </div>
    </aside>

    <div class="workspace">
      <header class="topbar">
        <div class="crumbs" id="crumbs" aria-label="Breadcrumb"></div>
        <div class="top-actions">
          <div class="theme-switch" role="group" aria-label="Color theme">
            <button class="theme-option" type="button" data-theme-option="light" aria-label="Light theme" aria-pressed="false" title="Light theme"><svg class="icon" aria-hidden="true" viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"></circle><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"></path></svg></button>
            <button class="theme-option" type="button" data-theme-option="dark" aria-label="Dark theme" aria-pressed="false" title="Dark theme"><svg class="icon" aria-hidden="true" viewBox="0 0 24 24"><path d="M20.8 13A9 9 0 0 1 11 3.2 9 9 0 1 0 20.8 13z"></path></svg></button>
            <button class="theme-option" type="button" data-theme-option="system" aria-label="Use system theme" aria-pressed="true" title="Use system theme"><svg class="icon" aria-hidden="true" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="12" rx="2"></rect><path d="M8 20h8M12 16v4"></path></svg></button>
          </div>
          <div class="connection" id="connection" data-state="connecting" role="status" aria-live="polite">
            <span class="connection-dot"></span><span class="connection-label">Connecting</span>
          </div>
          <button class="icon-button" id="refresh-button" type="button" aria-label="Refresh dashboard" title="Refresh dashboard"><svg class="icon" aria-hidden="true" viewBox="0 0 24 24"><path d="M20 7v5h-5"></path><path d="M19 12a7 7 0 1 0-2 5"></path></svg></button>
        </div>
      </header>
      <main id="main-content" tabindex="-1">
        <div id="app"><div class="stack" aria-label="Loading dashboard"><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div></div></div>
      </main>
    </div>
  </div>


  <div class="toast" id="toast" role="status" aria-live="polite"></div>

  <script>
${dashboardClient}
  </script>
</body>
</html>`;

export const DASHBOARD_HTML = dashboardHtml;

export function renderDashboardHtml(): string {
  return dashboardHtml;
}

export default dashboardHtml;
