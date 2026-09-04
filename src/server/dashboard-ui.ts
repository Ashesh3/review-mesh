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
  <meta name="color-scheme" content="dark">
  <meta name="theme-color" content="#090b0f">
  <title>Review Mesh Observer</title>
  <style>
    :root {
      --surface-canvas: #18181b;
      --surface-sidebar: #1b1b1f;
      --surface-raised: #202024;
      --surface-overlay: #26262b;
      --surface-hover: #2b2b31;
      --surface-selected: #303038;
      --border-subtle: #323239;
      --border-strong: #4a4a53;
      --text-primary: #f5f5f6;
      --text-secondary: #b8b8c1;
      --text-tertiary: #8e8e99;
      --accent: #78a9ff;
      --accent-soft: #202d45;
      --positive: #8acb70;
      --positive-soft: #213527;
      --warning: #efc160;
      --warning-soft: #3b301d;
      --negative: #f07c78;
      --negative-soft: #402424;
      --violet: #b49bff;
      --violet-soft: #302946;
      --space-1: 4px;
      --space-2: 8px;
      --space-3: 12px;
      --space-4: 16px;
      --space-5: 20px;
      --space-6: 24px;
      --space-8: 32px;
      --radius-sm: 8px;
      --radius-md: 12px;
      --radius-lg: 16px;
      --font-size-body: 14px;
      --control-size: 44px;
      --motion-fast: 175ms;
      --motion-spatial: 410ms;
      --ease-out: cubic-bezier(.24, 1, .4, 1);
      --shadow: 0 24px 70px rgb(0 0 0 / 48%);
      --bg: var(--surface-canvas);
      --bg-raised: var(--surface-raised);
      --panel: var(--surface-raised);
      --panel-2: var(--surface-overlay);
      --panel-3: var(--surface-hover);
      --line: var(--border-subtle);
      --line-strong: var(--border-strong);
      --text: var(--text-primary);
      --muted: var(--text-secondary);
      --faint: var(--text-tertiary);
      --cyan: var(--accent);
      --cyan-dim: var(--accent-soft);
      --blue: var(--accent);
      --green: var(--positive);
      --green-dim: var(--positive-soft);
      --amber: var(--warning);
      --amber-dim: var(--warning-soft);
      --red: var(--negative);
      --red-dim: var(--negative-soft);
      --radius: var(--radius-md);
      font-family: "Segoe UI Variable Text", "Segoe UI", ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
      font-synthesis: none;
    }

    * { box-sizing: border-box; }
    html { min-width: 320px; background: var(--bg); scroll-behavior: smooth; }
    body { margin: 0; min-height: 100vh; overflow-x: clip; color: var(--text); background: var(--bg); font-size: var(--font-size-body); line-height: 1.5; }
    button, input, select { font: inherit; }
    button, a { -webkit-tap-highlight-color: transparent; touch-action: manipulation; }
    a { color: inherit; }
    ::selection { background: rgb(120 169 255 / 28%); }
    :focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }
    .icon { width: 18px; height: 18px; flex: 0 0 auto; fill: none; stroke: currentColor; stroke-width: 1.75; stroke-linecap: round; stroke-linejoin: round; }

    .skip-link {
      position: fixed; left: 12px; top: -60px; z-index: 100;
      min-height: var(--control-size); display: flex; align-items: center; padding: 9px 14px;
      color: #12141a; background: var(--accent); border-radius: var(--radius-sm);
      font-size: 13px; font-weight: 700; text-decoration: none;
    }
    .skip-link:focus { top: 12px; }

    .shell { min-height: 100dvh; display: grid; grid-template-columns: 248px minmax(0, 1fr); }
    .sidebar {
      position: sticky; top: 0; z-index: 20; height: 100vh; overflow: auto;
      display: flex; flex-direction: column; padding: 18px 12px 16px;
      border-right: 1px solid var(--line); background: var(--surface-sidebar);
    }
    .brand { min-height: 52px; display: flex; align-items: center; gap: 12px; padding: 0 10px 18px; }
    .brand-mark {
      width: 34px; height: 34px; display: grid; place-items: center; border: 1px solid #3b5279;
      border-radius: 10px; color: var(--accent); background: var(--accent-soft);
    }
    .brand-mark .icon { width: 22px; height: 22px; }
    .brand-copy strong { display: block; font-size: 14px; line-height: 1.2; letter-spacing: -.01em; }
    .brand-copy span { color: var(--faint); font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 11px; }

    .nav-label, .eyebrow {
      color: var(--faint); font-size: 11px; font-weight: 700; letter-spacing: .1em; text-transform: uppercase;
    }
    .nav-label { padding: 0 10px 8px; }
    .nav { display: grid; gap: 3px; }
    .nav a {
      min-height: var(--control-size); display: flex; align-items: center; gap: 12px; padding: 9px 11px;
      border: 1px solid transparent; border-radius: 10px; color: var(--muted);
      font-size: 14px; font-weight: 600; text-decoration: none;
      transition: color var(--motion-fast), background var(--motion-fast), border-color var(--motion-fast);
    }
    .nav a:hover { color: var(--text); background: var(--surface-hover); }
    .nav a[aria-current="page"] { color: var(--text); border-color: transparent; background: var(--surface-selected); }
    .nav-glyph { width: 20px; display: grid; place-items: center; color: var(--faint); }
    .nav a[aria-current="page"] .nav-glyph { color: var(--cyan); }
    .sidebar-foot { margin-top: auto; padding: 18px 9px 2px; }
    .read-only {
      display: flex; align-items: center; gap: 8px; color: var(--faint); font-size: 12px;
    }
    .lock-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--green); box-shadow: 0 0 10px rgb(121 217 149 / 35%); }

    .workspace { min-width: 0; }
    .topbar {
      position: sticky; top: 0; z-index: 15; height: 64px; display: flex; align-items: center;
      justify-content: space-between; gap: 16px; padding: 0 28px; border-bottom: 1px solid var(--line);
      background: rgb(24 24 27 / 88%); backdrop-filter: blur(18px);
    }
    .crumbs { min-width: 0; display: flex; align-items: center; gap: 8px; color: var(--muted); font-size: 13px; }
    .crumbs a { color: var(--muted); text-decoration: none; }
    .crumbs a:hover { color: var(--text); }
    .crumb-sep { display: inline-flex; color: var(--faint); }
    .crumb-sep .icon { width: 14px; height: 14px; }
    .crumb-current { overflow: hidden; color: var(--text); text-overflow: ellipsis; white-space: nowrap; }
    .top-actions { display: flex; align-items: center; gap: 10px; }
    .connection {
      min-height: 32px; display: inline-flex; align-items: center; gap: 8px; padding: 5px 10px; border: 1px solid var(--line);
      border-radius: 999px; color: var(--muted); background: var(--panel); font-size: 11px; font-weight: 700;
      letter-spacing: .03em; text-transform: uppercase;
    }
    .connection-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--faint); }
    .connection[data-state="live"] .connection-dot { background: var(--green); box-shadow: 0 0 9px rgb(121 217 149 / 45%); }
    .connection[data-state="polling"] .connection-dot { background: var(--amber); }
    .connection[data-state="offline"] .connection-dot { background: var(--red); }
    .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
    .icon-button, .button {
      border: 1px solid var(--line); color: var(--muted); background: var(--panel-2); cursor: pointer;
      transition: border-color var(--motion-fast), color var(--motion-fast), background var(--motion-fast);
    }
    .icon-button:hover, .button:hover { border-color: var(--line-strong); color: var(--text); background: var(--panel-3); }
    .icon-button { width: var(--control-size); height: var(--control-size); display: grid; place-items: center; border-radius: 10px; }
    .icon-button[disabled] { cursor: wait; opacity: .55; }
    .button { min-height: var(--control-size); padding: 8px 14px; border-radius: 10px; font-size: 13px; font-weight: 650; }

    main { width: 100%; max-width: 1500px; margin: 0 auto; padding: 32px; }
    .page-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 24px; margin-bottom: 26px; }
    .page-head h1 { margin: 6px 0 0; font-size: clamp(28px, 2.2vw, 36px); line-height: 1.1; letter-spacing: -.04em; }
    .page-head p { max-width: 740px; margin: 9px 0 0; color: var(--muted); font-size: 14px; line-height: 1.6; }
    .page-meta { padding-top: 25px; color: var(--faint); font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 11px; white-space: nowrap; }

    .metric-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin-bottom: 28px; }
    .metric { min-width: 0; padding: 18px; border: 1px solid var(--line); border-radius: var(--radius-lg); background: var(--panel); }
    .metric-label { color: var(--faint); font-size: 11px; font-weight: 700; letter-spacing: .07em; text-transform: uppercase; }
    .metric-value { margin-top: 7px; overflow-wrap: anywhere; font-size: 28px; font-weight: 720; font-variant-numeric: tabular-nums; line-height: 1.12; letter-spacing: -.04em; }
    .metric-note { overflow: hidden; margin-top: 5px; color: var(--muted); font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }

    .section { margin-top: 30px; }
    .section:first-child { margin-top: 0; }
    .section-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
    .section-title { display: flex; align-items: center; gap: 8px; margin: 0; font-size: 15px; letter-spacing: -.01em; }
    .section-count {
      min-width: 24px; padding: 2px 7px; border: 1px solid var(--line); border-radius: 999px;
      color: var(--faint); background: var(--panel); font-family: ui-monospace, monospace; font-size: 10px; text-align: center;
    }
    .section-hint { color: var(--faint); font-size: 12px; }

    .stack { display: grid; gap: 12px; }
    .panel { border: 1px solid var(--line); border-radius: var(--radius-md); background: var(--panel); }
    .run-card { overflow: hidden; }
    .run-card-top { display: grid; grid-template-columns: minmax(190px, 1.25fr) minmax(300px, 2fr) minmax(140px, auto); gap: 24px; align-items: center; padding: 20px; }
    .run-identity { min-width: 0; }
    .run-title-row { display: flex; align-items: center; gap: 8px; min-width: 0; }
    .run-link { overflow: hidden; color: var(--text); font-size: 15px; font-weight: 700; text-decoration: none; text-overflow: ellipsis; white-space: nowrap; }
    .run-link:hover { color: var(--cyan); }
    .run-id { overflow: hidden; margin-top: 6px; color: var(--faint); font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
    .run-context { display: flex; flex-wrap: wrap; gap: 5px 12px; margin-top: 9px; color: var(--muted); font-size: 12px; }
    .run-context span { overflow: hidden; max-width: 100%; text-overflow: ellipsis; white-space: nowrap; }

    .badge {
      display: inline-flex; align-items: center; gap: 6px; width: fit-content; min-height: 24px; padding: 3px 8px;
      border: 1px solid var(--line); border-radius: 999px; color: var(--muted); background: var(--panel-2);
      font-size: 10px; font-weight: 750; letter-spacing: .04em; line-height: 1.2; text-transform: uppercase;
    }
    .badge::before { width: 6px; height: 6px; border-radius: 50%; background: currentColor; content: ""; }
    .badge.running, .badge.reviewing, .badge.starting, .badge.probing, .badge.validating { color: var(--cyan); border-color: #3b5279; background: var(--cyan-dim); }
    .badge.passed, .badge.pass, .badge.completed, .badge.complete, .badge.no_findings { color: var(--green); border-color: #35523d; background: var(--green-dim); }
    .badge.findings, .badge.fail, .badge.failed { color: var(--amber); border-color: #5a4828; background: var(--amber-dim); }
    .badge.incomplete, .badge.error { color: var(--red); border-color: #643736; background: var(--red-dim); }
    .badge.skipped, .badge.deferred, .badge.queued, .badge.pending, .badge.unknown { color: var(--muted); }
    .badge.adjudication { color: var(--violet); border-color: #514571; background: var(--violet-soft); }

    .stage-wrap { min-width: 0; }
    .stage-caption { display: flex; justify-content: space-between; gap: 10px; margin-bottom: 10px; color: var(--muted); font-size: 12px; }
    .stage-caption strong { overflow: hidden; color: var(--text); font-weight: 650; text-overflow: ellipsis; white-space: nowrap; }
    .stage-rail { display: grid; grid-template-columns: repeat(5, 1fr); gap: 4px; }
    .stage-step { min-width: 0; }
    .stage-line { height: 5px; border-radius: 999px; background: var(--line); }
    .stage-step.done .stage-line { background: #526f9d; }
    .stage-step.current .stage-line { background: var(--cyan); }
    .stage-name { overflow: hidden; margin-top: 6px; color: var(--faint); font-size: 10px; letter-spacing: .01em; text-overflow: ellipsis; white-space: nowrap; }
    .stage-step.current .stage-name { color: var(--cyan); }
    .stage-step.done .stage-name { color: var(--muted); }

    .run-stats { min-width: 140px; display: grid; gap: 8px; }
    .mini-stat { display: flex; align-items: center; justify-content: space-between; gap: 18px; color: var(--faint); font-size: 11px; }
    .mini-stat strong { color: var(--text); font-family: ui-monospace, monospace; font-size: 12px; font-weight: 650; font-variant-numeric: tabular-nums; }
    .reviewer-strip { display: flex; flex-wrap: wrap; gap: 8px; padding: 12px 20px 16px; border-top: 1px solid var(--line); background: rgb(255 255 255 / 1%); }
    .reviewer-chip {
      min-height: var(--control-size); max-width: 320px; display: inline-flex; align-items: center; gap: 8px; padding: 8px 11px;
      border: 1px solid var(--line); border-radius: 10px; color: var(--muted); background: var(--panel); cursor: pointer; font-size: 12px;
      transition: border-color var(--motion-fast), color var(--motion-fast), background var(--motion-fast);
    }
    .reviewer-chip:hover { border-color: var(--line-strong); color: var(--text); }
    .reviewer-chip-state { width: 7px; height: 7px; flex: 0 0 auto; border-radius: 50%; background: var(--faint); }
    .reviewer-chip-state.running, .reviewer-chip-state.reviewing, .reviewer-chip-state.starting, .reviewer-chip-state.probing, .reviewer-chip-state.validating { background: var(--cyan); }
    .reviewer-chip-state.completed, .reviewer-chip-state.passed, .reviewer-chip-state.pass { background: var(--green); }
    .reviewer-chip-state.findings, .reviewer-chip-state.fail { background: var(--amber); }
    .reviewer-chip-state.incomplete { background: var(--red); }
    .reviewer-chip span:last-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

    .table-wrap { max-width: 100%; overflow: auto; overscroll-behavior-inline: contain; border: 1px solid var(--line); border-radius: var(--radius-md); background: var(--panel); }
    table { width: 100%; border-collapse: collapse; font-size: 12px; }
    th { padding: 11px 14px; color: var(--faint); background: rgb(255 255 255 / 1%); font-size: 10px; font-weight: 700; letter-spacing: .07em; text-align: left; text-transform: uppercase; white-space: nowrap; }
    td { min-height: 50px; padding: 13px 14px; border-top: 1px solid var(--line); color: var(--muted); vertical-align: middle; }
    tbody tr { transition: background var(--motion-fast); }
    tbody tr:hover { background: rgb(255 255 255 / 2.4%); }
    td a { color: var(--text); font-weight: 650; text-decoration: none; }
    td a:hover { color: var(--cyan); }
    .mono { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; }
    .truncate { display: block; overflow: hidden; max-width: 360px; text-overflow: ellipsis; white-space: nowrap; }

    .empty, .error-state {
      min-height: 170px; display: grid; place-items: center; padding: 32px; border: 1px solid var(--line);
      border-radius: var(--radius-md); color: var(--muted); background: var(--panel); text-align: center;
    }
    .empty-icon { width: 42px; height: 42px; display: grid; place-items: center; margin: 0 auto 14px; border: 1px solid var(--line); border-radius: 12px; color: var(--faint); background: var(--panel-2); }
    .empty-icon .icon { width: 22px; height: 22px; }
    .empty strong, .error-state strong { display: block; margin-bottom: 6px; color: var(--text); font-size: 15px; }
    .empty span, .error-state span { display: block; max-width: 560px; font-size: 13px; line-height: 1.55; }
    .error-state { border-color: #563232; background: var(--negative-soft); }
    .skeleton { overflow: hidden; position: relative; height: 96px; border: 1px solid var(--line); border-radius: var(--radius-md); background: var(--panel); }
    .skeleton::after { position: absolute; inset: 0; background: linear-gradient(100deg, transparent 15%, rgb(255 255 255 / 4%) 45%, transparent 75%); content: ""; animation: shimmer 1.5s infinite var(--ease-out); }
    @keyframes shimmer { from { transform: translateX(-100%); } to { transform: translateX(100%); } }

    .detail-head { margin-bottom: 18px; }
    .back-link { min-height: var(--control-size); display: inline-flex; align-items: center; gap: 8px; margin: -8px 0 10px; color: var(--muted); font-size: 13px; font-weight: 600; text-decoration: none; }
    .back-link .icon { width: 16px; height: 16px; }
    .back-link:hover { color: var(--text); }
    .detail-title { display: flex; align-items: center; flex-wrap: wrap; gap: 9px; }
    .detail-title h1 { margin: 0; font-size: clamp(26px, 2.2vw, 34px); letter-spacing: -.04em; }
    .detail-id { margin-top: 7px; overflow-wrap: anywhere; color: var(--faint); font-family: ui-monospace, monospace; font-size: 12px; }
    .fact-grid { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 1px; overflow: hidden; margin: 18px 0; border: 1px solid var(--line); border-radius: var(--radius-md); background: var(--line); }
    .fact { min-width: 0; padding: 14px; background: var(--panel); }
    .fact dt { color: var(--faint); font-size: 10px; font-weight: 700; letter-spacing: .07em; text-transform: uppercase; }
    .fact dd { overflow: hidden; margin: 7px 0 0; color: var(--text); font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }

    .tabs { display: flex; gap: 4px; margin: 22px 0 14px; overflow-x: auto; border-bottom: 1px solid var(--line); }
    .tab {
      position: relative; min-height: var(--control-size); flex: 0 0 auto; padding: 9px 13px; border: 0; color: var(--muted); background: transparent; cursor: pointer; font-size: 13px; font-weight: 650;
      transition: color var(--motion-fast), background var(--motion-fast);
    }
    .tab:hover { color: var(--text); }
    .tab[aria-selected="true"] { color: var(--text); }
    .tab[aria-selected="true"]::after { position: absolute; right: 8px; bottom: -1px; left: 8px; height: 2px; background: var(--cyan); content: ""; }

    .detail-layout { display: grid; grid-template-columns: minmax(0, 1fr) 320px; gap: 16px; align-items: start; }
    .timeline { padding: 6px 18px 16px; }
    .timeline-row { position: relative; display: grid; grid-template-columns: 88px 14px minmax(0, 1fr); gap: 12px; min-height: 62px; }
    .timeline-row:not(:last-child)::after { position: absolute; top: 24px; bottom: -2px; left: 106px; width: 1px; background: var(--line); content: ""; }
    .timeline-time { padding-top: 14px; color: var(--faint); font-family: ui-monospace, monospace; font-size: 10px; text-align: right; }
    .timeline-dot { position: relative; z-index: 1; width: 9px; height: 9px; margin-top: 17px; border: 2px solid var(--panel); border-radius: 50%; background: var(--faint); box-shadow: 0 0 0 1px var(--line-strong); }
    .timeline-dot.active { background: var(--cyan); }
    .timeline-dot.good { background: var(--green); }
    .timeline-dot.warn { background: var(--amber); }
    .timeline-dot.bad { background: var(--red); }
    .timeline-body { min-width: 0; padding: 11px 0 15px; }
    .timeline-body strong { display: block; color: var(--text); font-size: 13px; font-weight: 650; }
    .timeline-body p { margin: 5px 0 0; color: var(--muted); font-size: 12px; line-height: 1.5; }
    .timeline-meta { display: flex; flex-wrap: wrap; gap: 5px 10px; margin-top: 7px; color: var(--faint); font-family: ui-monospace, monospace; font-size: 10px; }

    .lens-list { display: grid; gap: 12px; }
    .lens { overflow: hidden; border: 1px solid var(--line); border-radius: var(--radius); background: var(--panel); }
    .lens-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 14px; padding: 15px 16px; border-bottom: 1px solid var(--line); }
    .lens-head strong { display: block; font-size: 14px; }
    .lens-purpose { margin-top: 4px; color: var(--muted); font-size: 12px; line-height: 1.45; }
    .reviewer-row { display: grid; grid-template-columns: minmax(180px, 1.2fr) minmax(180px, 1fr) auto auto; gap: 14px; align-items: center; padding: 8px 16px; border-top: 1px solid var(--line); }
    .reviewer-row:first-child { border-top: 0; }
    .reviewer-button { min-width: 0; min-height: var(--control-size); padding: 6px 0; border: 0; color: var(--text); background: transparent; cursor: pointer; text-align: left; }
    .reviewer-button strong { display: block; overflow: hidden; font-size: 13px; text-overflow: ellipsis; white-space: nowrap; }
    .reviewer-button span { display: block; overflow: hidden; margin-top: 3px; color: var(--faint); font-family: ui-monospace, monospace; font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
    .reviewer-button:hover strong { color: var(--cyan); }
    .activity { overflow: hidden; color: var(--muted); font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
    .phase-mini { display: grid; grid-template-columns: repeat(6, 1fr); gap: 2px; margin-top: 6px; }
    .phase-mini i { height: 2px; border-radius: 1px; background: var(--line-strong); }
    .phase-mini i.done { background: #33717a; }
    .phase-mini i.current { background: var(--cyan); box-shadow: 0 0 5px rgb(89 217 232 / 30%); }

    .side-card { padding: 16px; }
    .side-card + .side-card { margin-top: 9px; }
    .side-card h3 { margin: 0 0 12px; font-size: 13px; }
    .definition-list { display: grid; grid-template-columns: minmax(90px, auto) minmax(0, 1fr); gap: 7px 12px; margin: 0; }
    .definition-list dt { color: var(--faint); font-size: 11px; }
    .definition-list dd { overflow-wrap: anywhere; margin: 0; color: var(--muted); font-family: ui-monospace, monospace; font-size: 10px; text-align: right; }
    .notice { padding: 13px 14px; border: 1px solid #3b5279; border-radius: var(--radius-sm); color: #c8d4e8; background: var(--accent-soft); font-size: 12px; line-height: 1.55; }
    .notice strong { color: var(--cyan); }

    .finding-list { display: grid; gap: 12px; }
    .finding { padding: 16px; border: 1px solid var(--line); border-left: 3px solid var(--amber); border-radius: var(--radius-md); background: var(--panel); }
    .finding[data-severity="critical"], .finding[data-severity="high"] { border-left-color: var(--red); }
    .finding[data-severity="low"] { border-left-color: var(--blue); }
    .finding-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 18px; }
    .finding-title { margin: 0; font-size: 14px; line-height: 1.4; }
    .finding p { margin: 8px 0 0; color: var(--muted); font-size: 12px; line-height: 1.6; white-space: pre-wrap; }
    .finding-meta { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 9px; }
    .evidence { margin-top: 12px; padding: 11px 12px; border: 1px solid var(--line); border-radius: var(--radius-sm); background: rgb(0 0 0 / 13%); }
    .evidence-path { color: var(--blue); font-family: ui-monospace, monospace; font-size: 10px; }

    .event-list { overflow: hidden; border: 1px solid var(--line); border-radius: var(--radius-md); background: var(--panel); }
    .event { display: grid; grid-template-columns: 56px 170px 170px minmax(0, 1fr); gap: 12px; padding: 12px 14px; border-top: 1px solid var(--line); font-size: 11px; }
    .event:first-child { border-top: 0; }
    .event-seq, .event-time { color: var(--faint); font-family: ui-monospace, monospace; }
    .event-name { overflow: hidden; color: var(--text); font-family: ui-monospace, monospace; font-weight: 650; text-overflow: ellipsis; white-space: nowrap; }
    .event-summary { overflow-wrap: anywhere; color: var(--muted); }
    details.raw { margin-top: 7px; }
    details.raw summary { min-height: 32px; display: flex; align-items: center; width: fit-content; color: var(--faint); cursor: pointer; font-size: 11px; }
    pre { overflow: auto; max-height: 420px; margin: 8px 0 0; padding: 13px; border: 1px solid var(--line); border-radius: var(--radius-sm); color: #c3c3cb; background: #151518; font: 10px/1.6 ui-monospace, SFMono-Regular, Consolas, monospace; tab-size: 2; white-space: pre-wrap; }

    .catalog-grid { display: grid; grid-template-columns: 1fr; gap: 0; overflow: hidden; border: 1px solid var(--line); border-radius: var(--radius-md); background: var(--panel); }
    .catalog-card { overflow: hidden; border-top: 1px solid var(--line); background: var(--panel); }
    .catalog-card:first-child { border-top: 0; }
    .catalog-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; padding: 17px 18px; border-bottom: 1px solid var(--line); }
    .catalog-head h2 { margin: 0; font-size: 15px; }
    .catalog-subtitle { max-width: 760px; margin-top: 5px; color: var(--faint); font-size: 12px; line-height: 1.5; }
    .catalog-body { padding: 16px 18px; }
    .chain { display: grid; gap: 0; margin: 2px 0; }
    .chain-row { position: relative; display: grid; grid-template-columns: 24px minmax(0, 1fr) auto; gap: 11px; min-height: 50px; }
    .chain-row:not(:last-child)::after { position: absolute; top: 25px; bottom: 0; left: 9px; width: 1px; background: var(--line-strong); content: ""; }
    .chain-index { position: relative; z-index: 1; width: 20px; height: 20px; display: grid; place-items: center; margin-top: 1px; border: 1px solid var(--line-strong); border-radius: 50%; color: var(--faint); background: var(--panel); font-family: ui-monospace, monospace; font-size: 9px; }
    .chain-main { min-width: 0; }
    .chain-main strong { display: block; overflow: hidden; font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
    .chain-main span { display: block; overflow: hidden; margin-top: 3px; color: var(--faint); font-family: ui-monospace, monospace; font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
    .pill-list { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 10px; }
    .pill { padding: 4px 8px; border: 1px solid var(--line); border-radius: 999px; color: var(--muted); background: var(--panel-2); font-size: 10px; }
    .truth-state { display: inline-flex; align-items: center; gap: 5px; }
    .truth-state::before { width: 6px; height: 6px; border-radius: 50%; background: var(--faint); content: ""; }
    .truth-state.present::before, .truth-state.available::before, .truth-state.enabled::before { background: var(--green); }
    .truth-state.missing::before, .truth-state.unavailable::before, .truth-state.disabled::before { background: var(--red); }

    .config-section { margin-top: 14px; }
    .config-block { padding: 17px 18px; border: 1px solid var(--line); border-radius: var(--radius-md); background: var(--panel); }
    .config-block h2 { margin: 0 0 13px; font-size: 14px; }
    .config-block + .config-block { margin-top: 12px; }
    .adapter-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 7px; }
    .adapter-card { min-width: 0; padding: 13px; border: 1px solid var(--line); border-radius: var(--radius-sm); background: rgb(255 255 255 / 1%); }
    .adapter-card-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
    .adapter-card-head strong { overflow: hidden; font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
    .key-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 1px; overflow: hidden; border: 1px solid var(--line); border-radius: 6px; background: var(--line); }
    .key-value { min-width: 0; padding: 13px; background: rgb(255 255 255 / 1%); }
    .key-value span { display: block; color: var(--faint); font-size: 10px; letter-spacing: .05em; text-transform: uppercase; }
    .key-value strong { display: block; overflow-wrap: anywhere; margin-top: 6px; color: var(--muted); font-family: ui-monospace, monospace; font-size: 10px; font-weight: 500; }

    .drawer-scrim { position: fixed; inset: 0; z-index: 40; visibility: hidden; background: rgb(0 0 0 / 58%); opacity: 0; transition: opacity var(--motion-fast), visibility var(--motion-fast); }
    .drawer-scrim.open { visibility: visible; opacity: 1; }
    .drawer {
      position: absolute; top: 0; right: 0; width: min(580px, 96vw); height: 100%; overflow: auto;
      border-left: 1px solid var(--line-strong); border-radius: var(--radius-lg) 0 0 var(--radius-lg); background: var(--bg-raised); box-shadow: var(--shadow); transform: translateX(100%); transition: transform var(--motion-spatial) var(--ease-out);
    }
    .drawer-scrim.open .drawer { transform: translateX(0); }
    .drawer-head { position: sticky; top: 0; z-index: 2; display: flex; align-items: flex-start; justify-content: space-between; gap: 15px; padding: 19px 20px; border-bottom: 1px solid var(--line); background: rgb(32 32 36 / 94%); backdrop-filter: blur(16px); }
    .drawer-head h2 { margin: 4px 0 0; font-size: 19px; }
    .drawer-id { overflow: hidden; max-width: 450px; margin-top: 6px; color: var(--faint); font-family: ui-monospace, monospace; font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
    .drawer-content { padding: 0 20px 28px; }
    .drawer .tabs { position: sticky; top: 76px; z-index: 1; margin-top: 0; padding-top: 6px; background: var(--bg-raised); }
    .drawer-section { margin-top: 15px; }
    .drawer-section h3 { margin: 0 0 10px; color: var(--muted); font-size: 11px; letter-spacing: .07em; text-transform: uppercase; }
    .summary-copy { color: var(--muted); font-size: 13px; line-height: 1.6; white-space: pre-wrap; }
    .review-markdown { overflow-wrap: anywhere; color: var(--muted); font-family: inherit; font-size: 13px; line-height: 1.65; white-space: pre-wrap; }

    .toast { position: fixed; right: 20px; bottom: 20px; z-index: 80; max-width: 380px; padding: 12px 14px; border: 1px solid var(--line-strong); border-radius: var(--radius-md); color: var(--text); background: var(--panel-3); box-shadow: var(--shadow); font-size: 13px; transform: translateY(20px); visibility: hidden; opacity: 0; transition: transform var(--motion-fast), opacity var(--motion-fast), visibility var(--motion-fast); }
    .toast.show { visibility: visible; opacity: 1; transform: translateY(0); }

    @media (max-width: 1050px) {
      .run-card-top { grid-template-columns: minmax(150px, 1fr) minmax(250px, 1.8fr); }
      .run-stats { grid-column: 1 / -1; grid-template-columns: repeat(3, 1fr); border-top: 1px solid var(--line); padding-top: 9px; }
      .fact-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
      .detail-layout { grid-template-columns: minmax(0, 1fr); }
      .detail-side { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 9px; }
      .side-card + .side-card { margin-top: 0; }
    }
    @media (max-width: 820px) {
      .shell { display: block; }
      .sidebar { position: sticky; top: 0; height: auto; padding: 8px 12px; overflow: visible; border-right: 0; border-bottom: 1px solid var(--line); }
      .brand { display: none; }
      .nav-label, .sidebar-foot { display: none; }
      .nav { grid-template-columns: repeat(4, 1fr); gap: 6px; }
      .nav a { min-height: var(--control-size); justify-content: center; gap: 7px; padding: 7px; font-size: 12px; }
      .nav-glyph { width: 18px; }
      .nav-glyph .icon { width: 17px; height: 17px; }
      .topbar { top: 61px; height: 56px; padding: 0 18px; }
      main { padding: 24px 18px 30px; }
      .metric-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .catalog-grid { grid-template-columns: 1fr; }
      .key-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .event { grid-template-columns: 42px 130px minmax(0, 1fr); }
      .event-time { display: none; }
    }
    @media (max-width: 620px) {
      .topbar { padding: 0 12px; }
      .crumbs { max-width: 38vw; font-size: 12px; }
      .connection { padding: 5px 7px; }
      main { padding: 20px 12px 28px; }
      .page-head { align-items: flex-start; flex-direction: column; gap: 8px; }
      .page-meta { padding-top: 0; white-space: normal; }
      .metric-grid { gap: 6px; }
      .metric { padding: 15px; }
      .metric-value { font-size: 24px; }
      .run-card-top { grid-template-columns: 1fr; gap: 18px; padding: 16px; }
      .run-stats { grid-column: auto; }
      .reviewer-strip { padding: 12px 16px 16px; }
      .fact-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .reviewer-row { grid-template-columns: minmax(0, 1fr) auto; gap: 8px 12px; }
      .reviewer-row .activity { grid-column: 1 / -1; white-space: normal; }
      .reviewer-row > .mono { display: none; }
      .timeline-row { grid-template-columns: 54px 12px minmax(0, 1fr); gap: 7px; }
      .timeline-row:not(:last-child)::after { left: 72px; }
      .detail-side { grid-template-columns: 1fr; }
      .event { grid-template-columns: 34px minmax(100px, .7fr) minmax(0, 1fr); gap: 7px; }
      .key-grid { grid-template-columns: 1fr; }
      .adapter-grid { grid-template-columns: 1fr; }
      .drawer-content { padding-right: 13px; padding-left: 13px; }
      .drawer { width: 100vw; border-left: 0; border-radius: 0; }
    }
    @media (max-width: 480px) {
      .nav a { flex-direction: column; gap: 2px; min-height: 54px; font-size: 10px; }
      .topbar { top: 71px; }
      .crumbs { display: none; }
      .top-actions { width: 100%; justify-content: space-between; }
      .metric-grid { grid-template-columns: 1fr; }
      .metric-note { white-space: normal; }
      .section-head { align-items: flex-start; flex-direction: column; }
      .table-wrap { overflow: visible; border: 0; background: transparent; }
      table, tbody { display: block; }
      thead { display: none; }
      tbody { display: grid; gap: 10px; }
      tbody tr { display: grid; grid-template-columns: 1fr 1fr; overflow: hidden; border: 1px solid var(--line); border-radius: var(--radius-md); background: var(--panel); }
      tbody tr:hover { background: var(--panel); }
      td { min-width: 0; min-height: 0; display: grid; gap: 4px; padding: 11px 12px; border-top: 1px solid var(--line); }
      td:first-child { grid-column: 1 / -1; border-top: 0; }
      td::before { color: var(--faint); font-size: 9px; font-weight: 700; letter-spacing: .07em; text-transform: uppercase; content: attr(data-label); }
      .truncate { max-width: 100%; }
      .fact-grid { grid-template-columns: 1fr; }
      .event { grid-template-columns: 42px minmax(0, 1fr); }
      .event-summary { grid-column: 1 / -1; }
      .connection { font-size: 10px; }
    }
    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after { scroll-behavior: auto !important; animation: none !important; transition: none !important; }
    }
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
        <div class="brand-copy"><strong>Review Mesh</strong><span>observer</span></div>
      </div>
      <div class="nav-label">Observe</div>
      <nav class="nav">
        <a href="#/reviews" data-nav="reviews"><span class="nav-glyph"><svg class="icon" aria-hidden="true" viewBox="0 0 24 24"><path d="M4 7h16M4 12h10M4 17h7"></path><circle cx="18" cy="14" r="3"></circle><path d="m20.2 16.2 1.8 1.8"></path></svg></span><span>Reviews</span></a>
        <a href="#/agents" data-nav="agents"><span class="nav-glyph"><svg class="icon" aria-hidden="true" viewBox="0 0 24 24"><circle cx="9" cy="8" r="3"></circle><circle cx="17" cy="10" r="2.5"></circle><path d="M3.5 19c.5-3.4 2.4-5 5.5-5s5 1.6 5.5 5M14 15c2.9-.4 5 .9 6 4"></path></svg></span><span>Agents</span></a>
        <a href="#/projects" data-nav="projects"><span class="nav-glyph"><svg class="icon" aria-hidden="true" viewBox="0 0 24 24"><path d="M3.5 6.5h6l2 2H20.5v9.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"></path><path d="M3.5 10.5h17"></path></svg></span><span>Projects</span></a>
        <a href="#/system" data-nav="system"><span class="nav-glyph"><svg class="icon" aria-hidden="true" viewBox="0 0 24 24"><path d="M4 7h7M15 7h5M4 17h3M11 17h9M9 4v6M9 14v6M15 4v6M7 14v6"></path></svg></span><span>System</span></a>
      </nav>
      <div class="sidebar-foot">
        <div class="read-only"><span class="lock-dot"></span><span>Read-only local observer</span></div>
      </div>
    </aside>

    <div class="workspace">
      <header class="topbar">
        <div class="crumbs" id="crumbs" aria-label="Breadcrumb"></div>
        <div class="top-actions">
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

  <div class="drawer-scrim" id="drawer-scrim" aria-hidden="true">
    <aside class="drawer" id="reviewer-drawer" role="dialog" aria-modal="true" aria-labelledby="drawer-title"></aside>
  </div>
  <div class="toast" id="toast" role="status" aria-live="polite"></div>

  <script>
  (function () {
    "use strict";

    var API = {
      snapshot: "/api/snapshot",
      stream: "/api/stream",
      run: function (id) { return "/api/runs/" + encodeURIComponent(id); },
      reviewer: function (runId, reviewerId) {
        return "/api/runs/" + encodeURIComponent(runId) + "/reviewers/" + encodeURIComponent(reviewerId);
      }
    };
    var POLL_INTERVAL = 2000;
    var STREAM_RETRY = 5000;
    var STAGES = ["Resolve context", "Resolve suite", "Execute lenses", "Consolidate", "Complete"];
    var ACTIVE_STATES = ["running", "probing", "starting", "reviewing", "validating"];
    var TERMINAL_STATES = ["passed", "findings", "incomplete", "completed", "skipped", "failed"];
    var state = {
      snapshot: null,
      snapshotError: null,
      snapshotLoading: true,
      runDetail: null,
      runError: null,
      runLoading: false,
      reviewerDetail: null,
      reviewerError: null,
      reviewerLoading: false,
      drawerTab: "activity",
      eventSource: null,
      pollTimer: null,
      streamRetryTimer: null,
      refreshTimer: null,
      connection: "connecting",
      route: null,
      requestGeneration: 0,
      lastFocused: null
    };

    var app = document.getElementById("app");
    var crumbs = document.getElementById("crumbs");
    var connection = document.getElementById("connection");
    var refreshButton = document.getElementById("refresh-button");
    var drawerScrim = document.getElementById("drawer-scrim");
    var drawer = document.getElementById("reviewer-drawer");
    var toast = document.getElementById("toast");

    var ICONS = {
      arrowLeft: '<svg class="icon" aria-hidden="true" viewBox="0 0 24 24"><path d="m14.5 5-7 7 7 7"></path><path d="M8 12h12"></path></svg>',
      chevronRight: '<svg class="icon" aria-hidden="true" viewBox="0 0 24 24"><path d="m9 5 7 7-7 7"></path></svg>',
      close: '<svg class="icon" aria-hidden="true" viewBox="0 0 24 24"><path d="m6 6 12 12M18 6 6 18"></path></svg>',
      inbox: '<svg class="icon" aria-hidden="true" viewBox="0 0 24 24"><path d="M4 5h16l2 10h-6l-2 3h-4l-2-3H2z"></path><path d="M8 10h8"></path></svg>',
      alert: '<svg class="icon" aria-hidden="true" viewBox="0 0 24 24"><path d="M12 3 2.5 20h19z"></path><path d="M12 9v4M12 17h.01"></path></svg>'
    };

    function icon(name) {
      return ICONS[name] || "";
    }

    function isObject(value) {
      return value !== null && typeof value === "object" && !Array.isArray(value);
    }

    function array(value) {
      return Array.isArray(value) ? value : [];
    }

    function firstDefined() {
      for (var i = 0; i < arguments.length; i += 1) {
        if (arguments[i] !== undefined && arguments[i] !== null) return arguments[i];
      }
      return undefined;
    }

    function text(value, fallback) {
      if (typeof value === "string" && value.trim()) return value;
      if (typeof value === "number" || typeof value === "boolean") return String(value);
      return fallback === undefined ? "" : fallback;
    }

    function number(value) {
      return typeof value === "number" && Number.isFinite(value) ? value : undefined;
    }

    function escapeHtml(value) {
      return text(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;").replace(/'/g, "&#039;");
    }

    function escapeAttr(value) {
      return escapeHtml(value).replace(/\n/g, "&#10;").replace(/\r/g, "&#13;");
    }

    function slug(value) {
      return text(value, "unknown").toLowerCase().replace(/[^a-z0-9_-]+/g, "_");
    }

    function safeDecode(value) {
      try { return decodeURIComponent(value); } catch (_) { return value; }
    }

    function safeJson(value) {
      try { return JSON.stringify(value, null, 2); } catch (_) { return "Value could not be serialized."; }
    }

    function get(object, path) {
      var current = object;
      for (var i = 0; i < path.length; i += 1) {
        if (!isObject(current) && !Array.isArray(current)) return undefined;
        current = current[path[i]];
      }
      return current;
    }

    function pick(object, paths) {
      for (var i = 0; i < paths.length; i += 1) {
        var value = get(object, paths[i]);
        if (value !== undefined && value !== null) return value;
      }
      return undefined;
    }

    function namedList(value) {
      if (Array.isArray(value)) return value.filter(isObject);
      if (!isObject(value)) return [];
      return Object.keys(value).map(function (key) {
        var item = value[key];
        if (isObject(item)) return Object.assign({ id: key }, item);
        return { id: key, value: item };
      });
    }

    function uniqueBy(items, keyFunction) {
      var map = new Map();
      items.forEach(function (item) {
        var key = keyFunction(item);
        if (key && !map.has(key)) map.set(key, item);
      });
      return Array.from(map.values());
    }

    function formatDuration(value) {
      var ms = number(value);
      if (ms === undefined || ms < 0) return "Not recorded";
      if (ms < 1000) return Math.round(ms) + " ms";
      var seconds = Math.floor(ms / 1000);
      if (seconds < 60) return seconds + "s";
      var minutes = Math.floor(seconds / 60);
      var remainingSeconds = seconds % 60;
      if (minutes < 60) return minutes + "m " + remainingSeconds + "s";
      var hours = Math.floor(minutes / 60);
      return hours + "h " + (minutes % 60) + "m";
    }

    function parseDate(value) {
      if (typeof value !== "string" && typeof value !== "number") return null;
      var date = new Date(value);
      return Number.isNaN(date.getTime()) ? null : date;
    }

    function formatDate(value, withDate) {
      var date = parseDate(value);
      if (!date) return "Not recorded";
      var options = withDate
        ? { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" }
        : { hour: "2-digit", minute: "2-digit", second: "2-digit" };
      return new Intl.DateTimeFormat(undefined, options).format(date);
    }

    function relativeTime(value) {
      var date = parseDate(value);
      if (!date) return "Not recorded";
      var delta = date.getTime() - Date.now();
      var absolute = Math.abs(delta);
      var unit = "second";
      var divisor = 1000;
      if (absolute >= 86400000) { unit = "day"; divisor = 86400000; }
      else if (absolute >= 3600000) { unit = "hour"; divisor = 3600000; }
      else if (absolute >= 60000) { unit = "minute"; divisor = 60000; }
      var amount = Math.round(delta / divisor);
      try { return new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }).format(amount, unit); }
      catch (_) { return formatDate(value, true); }
    }

    function runId(run) {
      return text(firstDefined(run && run.run_id, run && run.id, run && run.runId));
    }

    function runStatus(run) {
      if (!isObject(run)) return "unknown";
      if (run.active === true) return text(firstDefined(run.stage, run.phase, run.status), "running").toLowerCase();
      return text(firstDefined(run.status, run.outcome, run.state, run.gate_outcome), "unknown").toLowerCase();
    }

    function isActiveRun(run) {
      return isObject(run) && (run.active === true || ACTIVE_STATES.indexOf(runStatus(run)) >= 0);
    }

    function reviewersOf(source) {
      if (!isObject(source)) return [];
      var candidates = firstDefined(source.reviewers, source.model_runs_detail, source.reviewer_runs, get(source, ["suite", "reviewers"]), get(source, ["run", "reviewers"]));
      if (!candidates && Array.isArray(source.lenses)) {
        candidates = source.lenses.flatMap(function (lens) { return isObject(lens) ? array(lens.reviewers) : []; });
      }
      return namedList(candidates);
    }

    function reviewerId(reviewer) {
      return text(firstDefined(reviewer && reviewer.reviewer_id, reviewer && reviewer.id, reviewer && reviewer.name));
    }

    function reviewerState(reviewer) {
      if (!isObject(reviewer)) return "unknown";
      var direct = text(firstDefined(reviewer.state, reviewer.status, reviewer.phase), "unknown").toLowerCase();
      var result = isObject(reviewer.result) ? reviewer.result : {};
      var actionable = firstDefined(result.actionable_findings, reviewer.actionable_findings);
      var findingCount = Array.isArray(actionable) ? actionable.length : number(actionable) || 0;
      var verdict = text(firstDefined(result.verdict, reviewer.verdict)).toLowerCase();
      if (direct === "completed" && (verdict === "fail" || verdict === "findings" || findingCount > 0)) return "findings";
      if (direct === "completed") return "passed";
      return direct;
    }

    function renderReviewerPhase(stateValue) {
      var phases = ["queued", "probing", "starting", "reviewing", "validating", "terminal"];
      var value = text(stateValue, "unknown").toLowerCase();
      var current = phases.indexOf(value);
      if (["completed", "findings", "incomplete", "skipped", "failed"].indexOf(value) >= 0) current = 5;
      if (value === "deferred") current = -1;
      return '<div class="phase-mini" aria-label="Reviewer state: ' + escapeAttr(value.replace(/_/g, " ")) + '">' + phases.map(function (_, index) {
        return '<i class="' + (current < 0 ? "" : index < current ? "done" : index === current ? "current" : "") + '"></i>';
      }).join("") + "</div>";
    }

    function snapshotRuns(snapshot) {
      if (!isObject(snapshot)) return [];
      var groups = [
        snapshot.runs,
        snapshot.active_runs,
        snapshot.recent_runs,
        get(snapshot, ["reviews", "active"]),
        get(snapshot, ["reviews", "recent"]),
        get(snapshot, ["reviews", "runs"])
      ];
      var all = [];
      groups.forEach(function (group) { all = all.concat(namedList(group)); });
      return uniqueBy(all, runId);
    }

    function snapshotAgents(snapshot) {
      return namedList(firstDefined(
        snapshot && snapshot.agents,
        get(snapshot, ["configuration", "agents"]),
        get(snapshot, ["config", "agents"]),
        get(snapshot, ["catalog", "agents"])
      ));
    }

    function snapshotProjects(snapshot) {
      return namedList(firstDefined(
        snapshot && snapshot.projects,
        get(snapshot, ["configuration", "projects"]),
        get(snapshot, ["config", "projects"]),
        get(snapshot, ["catalog", "projects"])
      ));
    }

    function snapshotSystem(snapshot) {
      var system = firstDefined(snapshot && snapshot.system, snapshot && snapshot.runtime, get(snapshot, ["configuration", "system"]));
      return isObject(system) ? system : {};
    }

    function countReviewers(runs, predicate) {
      var count = 0;
      runs.forEach(function (run) {
        reviewersOf(run).forEach(function (reviewer) {
          if (predicate(reviewer)) count += 1;
        });
      });
      return count;
    }

    function findingsCount(source) {
      if (!isObject(source)) return undefined;
      var direct = number(firstDefined(source.unique_findings, source.findings_count, source.actionable_findings, get(source, ["counts", "findings"]), get(source, ["result", "actionable_findings_count"]), get(source, ["result", "actionable_findings"]))) ;
      if (direct !== undefined) return direct;
      var consolidated = get(source, ["findings", "consolidated"]);
      if (Array.isArray(consolidated)) return consolidated.length;
      var raw = get(source, ["findings", "raw"]);
      if (Array.isArray(raw)) return raw.length;
      var findings = firstDefined(source.findings, get(source, ["result", "actionable_findings"]));
      if (Array.isArray(findings)) return findings.length;
      var total = 0;
      var saw = false;
      reviewersOf(source).forEach(function (reviewer) {
        var value = firstDefined(get(reviewer, ["result", "actionable_findings"]), reviewer.actionable_findings);
        if (Array.isArray(value)) { total += value.length; saw = true; }
        else if (number(value) !== undefined) { total += number(value); saw = true; }
      });
      return saw ? total : undefined;
    }

    function badge(value, label) {
      var status = slug(value);
      return '<span class="badge ' + status + '">' + escapeHtml(label || text(value, "Unknown").replace(/_/g, " ")) + "</span>";
    }

    function runProject(run) {
      return text(firstDefined(run && run.project_name, get(run, ["context", "project_name"]), get(run, ["request", "project_name"]), run && run.project), "Unassigned project");
    }

    function runWorkspace(run) {
      return text(firstDefined(run && run.workspace, get(run, ["context", "workspace"]), get(run, ["request", "workspace"])));
    }

    function runModelCounts(run) {
      var counts = firstDefined(run && run.model_runs, run && run.suite, get(run, ["counts", "model_runs"]));
      return isObject(counts) ? counts : {};
    }

    function runStartedAt(run) {
      return firstDefined(run && run.started_at, run && run.created_at, get(run, ["timestamps", "started_at"]), run && run.timestamp);
    }

    function runUpdatedAt(run) {
      return firstDefined(run && run.updated_at, run && run.completed_at, get(run, ["timestamps", "updated_at"]), runStartedAt(run));
    }

    function runElapsed(run) {
      return firstDefined(run && run.total_elapsed_ms, run && run.elapsed_ms, get(run, ["timing", "elapsed_ms"]));
    }

    function stageIndex(run) {
      var status = runStatus(run);
      if (!isActiveRun(run) && TERMINAL_STATES.indexOf(status) >= 0) return 4;
      var raw = text(firstDefined(run && run.current_stage, run && run.stage, run && run.phase), "").toLowerCase();
      if (raw === "starting") return 0;
      if (/complete|terminal|done/.test(raw)) return 4;
      if (/consolid|report|final/.test(raw)) return 3;
      if (/execute|review|validat|probe|start|lens|agent/.test(raw)) return 2;
      if (/suite|roster|select/.test(raw)) return 1;
      if (/context|resolve|git|request/.test(raw)) return 0;
      var events = eventsOf(run);
      if (events.some(function (event) { return eventName(event) === "run.completed"; })) return 4;
      if (events.some(function (event) { return /^reviewer\./.test(eventName(event)); })) return 2;
      if (events.some(function (event) { return eventName(event) === "suite.resolved"; })) return 1;
      if (events.some(function (event) { return eventName(event) === "context.resolved"; })) return 0;
      var counts = runModelCounts(run);
      var knownModelRuns = ["total", "running", "queued", "deferred", "completed", "incomplete", "skipped"].some(function (key) {
        return (number(counts[key]) || 0) > 0;
      });
      if (isActiveRun(run) && knownModelRuns) return 2;
      if (isActiveRun(run) && (runWorkspace(run) || run && run.scope)) return 1;
      if (isActiveRun(run)) return 0;
      return -1;
    }

    function stageLabel(run) {
      var index = stageIndex(run);
      if (index < 0) return "Stage not recorded";
      return STAGES[index];
    }

    function renderStageRail(run) {
      var current = stageIndex(run);
      var steps = STAGES.map(function (name, index) {
        var stateClass = current < 0 ? "" : index < current ? "done" : index === current ? "current" : "";
        return '<div class="stage-step ' + stateClass + '"' + (index === current ? ' aria-current="step"' : "") + ' aria-label="' + escapeAttr(name + (index < current ? ": complete" : index === current ? ": current" : ": pending")) + '"><div class="stage-line"></div><div class="stage-name">' + escapeHtml(name) + "</div></div>";
      }).join("");
      return '<div class="stage-wrap"><div class="stage-caption"><span>Current stage</span><strong>' + escapeHtml(stageLabel(run)) + '</strong></div><div class="stage-rail" aria-label="Run stages">' + steps + "</div></div>";
    }

    function renderReviewerStrip(run) {
      var reviewers = reviewersOf(run);
      if (!reviewers.length) return "";
      return '<div class="reviewer-strip" aria-label="Reviewers">' + reviewers.slice(0, 12).map(function (reviewer) {
        var id = reviewerId(reviewer);
        var status = reviewerState(reviewer);
        return '<button class="reviewer-chip" type="button" data-open-reviewer="' + escapeAttr(id) + '" data-run-id="' + escapeAttr(runId(run)) + '" title="Inspect ' + escapeAttr(id) + '"><span class="reviewer-chip-state ' + slug(status) + '"></span><span>' + escapeHtml(id || "Unnamed reviewer") + " · " + escapeHtml(status.replace(/_/g, " ")) + "</span></button>";
      }).join("") + (reviewers.length > 12 ? '<span class="pill">+' + (reviewers.length - 12) + " more</span>" : "") + "</div>";
    }

    function renderRunCard(run) {
      var id = runId(run);
      var status = runStatus(run);
      var reviewers = reviewersOf(run);
      var modelCounts = runModelCounts(run);
      var reviewerTotal = reviewers.length || number(modelCounts.total) || 0;
      var activeReviewers = reviewers.length
        ? reviewers.filter(function (reviewer) { return ACTIVE_STATES.indexOf(reviewerState(reviewer)) >= 0; }).length
        : number(modelCounts.running) || 0;
      var findings = findingsCount(run);
      var scope = text(firstDefined(run.scope, get(run, ["review_scope", "mode"]), get(run, ["context", "review_scope", "mode"]), get(run, ["request", "review_scope", "mode"])), "Not recorded");
      return '<article class="panel run-card">' +
        '<div class="run-card-top">' +
          '<div class="run-identity"><div class="run-title-row"><a class="run-link" href="#/reviews/' + encodeURIComponent(id) + '">' + escapeHtml(runProject(run)) + "</a>" + badge(status) + '</div><div class="run-id">' + escapeHtml(id || "Run id unavailable") + '</div><div class="run-context"><span>' + escapeHtml(scope + " scope") + '</span><span>' + escapeHtml(relativeTime(runUpdatedAt(run))) + "</span></div></div>" +
          renderStageRail(run) +
          '<div class="run-stats"><div class="mini-stat"><span>Reviewers</span><strong>' + reviewerTotal + '</strong></div><div class="mini-stat"><span>Active</span><strong>' + activeReviewers + '</strong></div><div class="mini-stat"><span>Findings</span><strong>' + (findings === undefined ? "—" : findings) + "</strong></div></div>" +
        "</div>" + renderReviewerStrip(run) +
      "</article>";
    }

    function compactMetricValue(value) {
      var raw = value === undefined || value === null ? "" : String(value);
      return raw.length > 24 ? raw.slice(0, 12) + "…" + raw.slice(-8) : raw;
    }

    function renderMetric(label, value, note) {
      var rawValue = text(value);
      return '<div class="metric"><div class="metric-label">' + escapeHtml(label) + '</div><div class="metric-value" title="' + escapeAttr(rawValue) + '">' + escapeHtml(compactMetricValue(rawValue)) + '</div><div class="metric-note">' + escapeHtml(note) + "</div></div>";
    }

    function renderEmpty(title, copy) {
      return '<div class="empty"><div><div class="empty-icon">' + icon("inbox") + '</div><strong>' + escapeHtml(title) + '</strong><span>' + escapeHtml(copy) + "</span></div></div>";
    }

    function renderError(title, copy) {
      return '<div class="error-state"><div><div class="empty-icon">' + icon("alert") + '</div><strong>' + escapeHtml(title) + '</strong><span>' + escapeHtml(copy) + "</span></div></div>";
    }

    function generatedAt(snapshot) {
      return firstDefined(snapshot && snapshot.generated_at, snapshot && snapshot.timestamp, snapshot && snapshot.observed_at);
    }

    function renderReviews() {
      var snapshot = state.snapshot || {};
      var runs = snapshotRuns(snapshot);
      var active = runs.filter(isActiveRun);
      var recent = runs.filter(function (run) { return !isActiveRun(run); });
      var liveReviewers = number(get(snapshot, ["counts", "running_reviewers"]));
      if (liveReviewers === undefined) liveReviewers = countReviewers(active, function (reviewer) { return ACTIVE_STATES.indexOf(reviewerState(reviewer)) >= 0; });
      var findingRuns = runs.filter(function (run) { return runStatus(run) === "findings" || (findingsCount(run) || 0) > 0; }).length;
      var visibility = firstDefined(snapshot.visibility, get(snapshot, ["diagnostics", "visibility"]), get(snapshot, ["system", "visibility"]), get(snapshot, ["configuration", "diagnostics", "persist_runs"]));
      var html = '<div class="page-head"><div><div class="eyebrow">Operations console</div><h1>Review activity</h1><p>Live and retained review runs, factual lifecycle stages, logical lenses, and concrete model executions.</p></div><div class="page-meta">Observed ' + escapeHtml(formatDate(generatedAt(snapshot), true)) + "</div></div>";
      html += '<div class="metric-grid">' +
        renderMetric("Active runs", String(active.length), active.length ? "Currently retained as active" : "No active record observed") +
        renderMetric("Active reviewers", String(liveReviewers), "Concrete reviewer/model runs") +
        renderMetric("Runs with findings", String(findingRuns), "Across the visible run set") +
        renderMetric("Recent runs", String(recent.length), "Completed records retained locally") +
      "</div>";
      if (visibility === false || (isObject(visibility) && visibility.enabled === false)) {
        html += '<div class="notice"><strong>Live diagnostics are disabled.</strong> This observer can show retained records, but another Review Mesh process will not expose new in-progress activity until run diagnostics are enabled.</div>';
      }
      html += '<section class="section"><div class="section-head"><h2 class="section-title">Active reviews <span class="section-count">' + active.length + '</span></h2><span class="section-hint">Updates arrive by local event stream</span></div>';
      html += active.length ? '<div class="stack">' + active.map(renderRunCard).join("") + "</div>" : renderEmpty("No active reviews", "New reviews appear here when a persisted active run record is visible.");
      html += "</section>";
      html += '<section class="section"><div class="section-head"><h2 class="section-title">Recent reviews <span class="section-count">' + recent.length + "</span></h2></div>";
      if (!recent.length) html += renderEmpty("No completed reviews", "Completed run records will be listed here.");
      else html += '<div class="table-wrap"><table><thead><tr><th>Review</th><th>Status</th><th>Scope</th><th>Reviewers</th><th>Findings</th><th>Elapsed</th><th>Updated</th></tr></thead><tbody>' + recent.map(function (run) {
        var id = runId(run);
        var scope = text(firstDefined(run.scope, get(run, ["review_scope", "mode"]), get(run, ["context", "review_scope", "mode"]), get(run, ["request", "review_scope", "mode"])), "—");
        var findingCount = findingsCount(run);
        return '<tr><td data-label="Review"><a class="truncate" href="#/reviews/' + encodeURIComponent(id) + '">' + escapeHtml(runProject(run)) + '</a><span class="run-id">' + escapeHtml(id) + '</span></td><td data-label="Status">' + badge(runStatus(run)) + '</td><td data-label="Scope">' + escapeHtml(scope) + '</td><td class="mono" data-label="Reviewers">' + (reviewersOf(run).length || number(runModelCounts(run).total) || 0) + '</td><td class="mono" data-label="Findings">' + (findingCount === undefined ? "—" : findingCount) + '</td><td class="mono" data-label="Elapsed">' + escapeHtml(formatDuration(runElapsed(run))) + '</td><td data-label="Updated" title="' + escapeAttr(formatDate(runUpdatedAt(run), true)) + '">' + escapeHtml(relativeTime(runUpdatedAt(run))) + "</td></tr>";
      }).join("") + "</tbody></table></div>";
      html += "</section>";
      return html;
    }

    function eventsOf(source) {
      if (!isObject(source)) return [];
      var value = firstDefined(source.events, get(source, ["timeline", "events"]), get(source, ["run", "events"]), source.activity);
      return array(value).filter(isObject);
    }

    function eventName(event) {
      return text(firstDefined(event && event.event, event && event.type, event && event.name, event && event.kind, event && event.phase), "event");
    }

    function eventTime(event) {
      return firstDefined(event && event.timestamp, event && event.at, event && event.time, event && event.created_at);
    }

    function eventSummary(event) {
      var data = isObject(event && event.data) ? event.data : {};
      return text(firstDefined(event && event.summary, event && event.message, data.message, data.summary, data.phase, data.reason), "No activity summary recorded.");
    }

    function eventTone(event) {
      var name = eventName(event);
      if (/incomplete|error|failed/.test(name)) return "bad";
      if (/skipped|finding/.test(name)) return "warn";
      if (/completed/.test(name)) return "good";
      if (/progress|heartbeat|started/.test(name)) return "active";
      return "";
    }

    function normalizeRunDetail() {
      var detail = state.runDetail;
      if (!isObject(detail)) return null;
      if (isObject(detail.run)) return Object.assign({}, detail.run, detail);
      return detail;
    }

    function renderTimeline(detail) {
      var events = eventsOf(detail);
      if (!events.length) return renderEmpty("No persisted timeline events", "The run record does not contain event-level activity for this view.");
      return '<div class="panel timeline">' + events.map(function (event) {
        var reviewer = text(firstDefined(event.reviewer_id, get(event, ["data", "reviewer_id"]), get(event, ["data", "lens_id"])));
        return '<div class="timeline-row"><div class="timeline-time">' + escapeHtml(formatDate(eventTime(event), false)) + '</div><div class="timeline-dot ' + eventTone(event) + '"></div><div class="timeline-body"><strong>' + escapeHtml(eventName(event).replace(/\./g, " · ")) + '</strong><p>' + escapeHtml(eventSummary(event)) + '</p><div class="timeline-meta">' + (reviewer ? "<span>" + escapeHtml(reviewer) + "</span>" : "") + (number(event.seq) !== undefined ? "<span>seq " + event.seq + "</span>" : "") + "</div></div></div>";
      }).join("") + "</div>";
    }

    function groupReviewers(reviewers) {
      var groups = new Map();
      reviewers.forEach(function (reviewer) {
        var lens = text(firstDefined(reviewer.lens_id, reviewer.agent_id, reviewer.logical_lens, reviewer.lens), "Ungrouped");
        if (!groups.has(lens)) groups.set(lens, []);
        groups.get(lens).push(reviewer);
      });
      return Array.from(groups.entries());
    }

    function resultFindingCount(reviewer) {
      var value = firstDefined(get(reviewer, ["result", "actionable_findings"]), reviewer.actionable_findings);
      if (Array.isArray(value)) return value.length;
      return number(value);
    }

    function renderLensList(detail) {
      var reviewers = reviewersOf(detail);
      if (!reviewers.length) return renderEmpty("No reviewer roster", "This run record does not expose concrete reviewer/model rows.");
      return '<div class="lens-list">' + groupReviewers(reviewers).map(function (entry) {
        var lensId = entry[0];
        var lensReviewers = entry[1];
        var purpose = text(firstDefined(lensReviewers[0] && lensReviewers[0].purpose, lensReviewers[0] && lensReviewers[0].lens_purpose));
        var active = lensReviewers.filter(function (reviewer) { return ACTIVE_STATES.indexOf(reviewerState(reviewer)) >= 0; }).length;
        return '<section class="lens"><div class="lens-head"><div><strong>' + escapeHtml(lensId) + '</strong>' + (purpose ? '<div class="lens-purpose">' + escapeHtml(purpose) + "</div>" : "") + '</div><span class="pill">' + lensReviewers.length + " model run" + (lensReviewers.length === 1 ? "" : "s") + (active ? " · " + active + " active" : "") + "</span></div><div>" + lensReviewers.map(function (reviewer) {
          var id = reviewerId(reviewer);
          var adapter = text(reviewer.adapter, "Adapter not recorded");
          var model = text(reviewer.model, "Model not recorded");
          var status = reviewerState(reviewer);
          var activity = text(firstDefined(reviewer.last_activity_message, reviewer.activity_summary, get(reviewer, ["activity", "message"])), "No activity summary recorded");
          var count = resultFindingCount(reviewer);
          return '<div class="reviewer-row"><button class="reviewer-button" type="button" data-open-reviewer="' + escapeAttr(id) + '" data-run-id="' + escapeAttr(runId(detail)) + '"><strong>' + escapeHtml(id || "Unnamed reviewer") + '</strong><span>' + escapeHtml(adapter + " / " + model) + '</span></button><div class="activity" title="' + escapeAttr(activity) + '"><span>' + escapeHtml(activity) + "</span>" + renderReviewerPhase(status) + '</div><span class="mono">' + escapeHtml(formatDuration(firstDefined(reviewer.elapsed_ms, get(reviewer, ["timing", "elapsed_ms"])))) + "</span>" + badge(status, count !== undefined && count > 0 ? status + " · " + count : status) + "</div>";
        }).join("") + "</div></section>";
      }).join("") + "</div>";
    }

    function findingsOf(detail) {
      if (!isObject(detail)) return [];
      var direct = firstDefined(get(detail, ["findings", "consolidated"]), get(detail, ["findings", "raw"]), Array.isArray(detail.findings) ? detail.findings : undefined, detail.actionable_findings, get(detail, ["result", "actionable_findings"]));
      var collected = array(direct).filter(isObject);
      reviewersOf(detail).forEach(function (reviewer) {
        var items = firstDefined(get(reviewer, ["result", "actionable_findings"]), reviewer.findings);
        array(items).forEach(function (finding) {
          if (isObject(finding)) collected.push(Object.assign({ reviewer_id: reviewerId(reviewer) }, finding));
        });
      });
      return uniqueBy(collected, function (finding) {
        return text(firstDefined(finding.id, finding.finding_id)) || safeJson(finding);
      });
    }

    function renderFinding(finding) {
      var title = text(firstDefined(finding.title, finding.summary), "Untitled finding");
      var description = text(firstDefined(finding.description, finding.detail));
      var severity = text(finding.severity, "unspecified");
      var evidence = array(finding.evidence).filter(isObject);
      return '<article class="finding" data-severity="' + escapeAttr(slug(severity)) + '"><div class="finding-head"><h3 class="finding-title">' + escapeHtml(title) + '</h3>' + badge(severity) + '</div>' + (description ? '<p>' + escapeHtml(description) + "</p>" : "") + '<div class="finding-meta">' + (finding.reviewer_id ? '<span class="pill">' + escapeHtml(finding.reviewer_id) + "</span>" : "") + (finding.confidence ? '<span class="pill">confidence: ' + escapeHtml(finding.confidence) + "</span>" : "") + (finding.classification ? '<span class="pill">' + escapeHtml(finding.classification) + "</span>" : "") + '</div>' + evidence.map(function (item) {
        var path = text(item.path, "Location not recorded");
        var range = number(item.start_line) !== undefined ? ":" + item.start_line + (number(item.end_line) !== undefined && item.end_line !== item.start_line ? "–" + item.end_line : "") : "";
        return '<div class="evidence"><div class="evidence-path">' + escapeHtml(path + range) + '</div><p>' + escapeHtml(text(item.detail, "No evidence detail recorded.")) + "</p></div>";
      }).join("") + (finding.suggested_direction ? '<p><strong>Suggested direction:</strong> ' + escapeHtml(finding.suggested_direction) + "</p>" : "") + "</article>";
    }

    function renderFindings(detail) {
      var findings = findingsOf(detail);
      if (!findings.length) {
        var count = findingsCount(detail);
        if (count !== undefined && count > 0) return renderEmpty(count + " finding" + (count === 1 ? "" : "s") + " reported", "Structured finding details were not included in this API response.");
        return renderEmpty("No structured findings", "No actionable finding records are available for this run.");
      }
      return '<div class="finding-list">' + findings.map(renderFinding).join("") + "</div>";
    }

    function renderEvents(detail) {
      var events = eventsOf(detail);
      if (!events.length) return renderEmpty("No persisted events", "No event envelopes are available for this run.");
      return '<div class="event-list">' + events.map(function (event) {
        return '<div class="event"><div class="event-seq">' + (number(event.seq) === undefined ? "—" : "#" + event.seq) + '</div><div class="event-name">' + escapeHtml(eventName(event)) + '</div><div class="event-time">' + escapeHtml(formatDate(eventTime(event), true)) + '</div><div class="event-summary">' + escapeHtml(eventSummary(event)) + '<details class="raw"><summary>Sanitized record</summary><pre>' + escapeHtml(safeJson(event)) + "</pre></details></div></div>";
      }).join("") + "</div>";
    }

    function renderDefinitionList(entries) {
      var filtered = entries.filter(function (entry) { return entry[1] !== undefined && entry[1] !== null && entry[1] !== ""; });
      if (!filtered.length) return '<div class="section-hint">No metadata recorded.</div>';
      return '<dl class="definition-list">' + filtered.map(function (entry) {
        var value = isObject(entry[1]) || Array.isArray(entry[1]) ? safeJson(entry[1]) : text(entry[1]);
        return '<dt>' + escapeHtml(entry[0]) + '</dt><dd title="' + escapeAttr(value) + '">' + escapeHtml(value) + "</dd>";
      }).join("") + "</dl>";
    }

    function renderRunSide(detail) {
      var context = isObject(detail.context) ? detail.context : {};
      var request = isObject(detail.request) ? detail.request : {};
      var git = firstDefined(detail.git, context.git, get(detail, ["context", "git"]));
      var counts = firstDefined(detail.model_runs, detail.suite, detail.counts);
      return '<aside class="detail-side"><div class="panel side-card"><h3>Run context</h3>' + renderDefinitionList([
        ["Project", runProject(detail)],
        ["Workspace", runWorkspace(detail)],
        ["Scope", firstDefined(get(detail, ["review_scope", "mode"]), get(context, ["review_scope", "mode"]), get(request, ["review_scope", "mode"]))],
        ["Branch", get(git, ["branch"])],
        ["Head", get(git, ["head"])],
        ["Changed files", get(git, ["changed_files_count"])]
      ]) + '</div><div class="panel side-card"><h3>Execution counts</h3>' + renderDefinitionList(isObject(counts) ? Object.keys(counts).filter(function (key) { return !isObject(counts[key]) && !Array.isArray(counts[key]); }).map(function (key) { return [key.replace(/_/g, " "), counts[key]]; }) : []) + '</div><div class="notice"><strong>Activity, not chat.</strong> Review Mesh persists sanitized phase and activity summaries plus structured terminal results. These views are not full provider conversations or hidden reasoning.</div></aside>';
    }

    function renderRunDetail() {
      if (state.runLoading && !state.runDetail) return '<div class="stack"><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div></div>';
      if (state.runError) return '<a class="back-link" href="#/reviews">' + icon("arrowLeft") + "<span>All reviews</span></a>" + renderError("Run unavailable", state.runError);
      var detail = normalizeRunDetail();
      if (!detail) return renderEmpty("Run unavailable", "No detail response was returned.");
      var route = state.route;
      var tab = route.tab || "timeline";
      var id = runId(detail) || route.runId;
      var status = runStatus(detail);
      var reviewers = reviewersOf(detail);
      var findings = findingsCount(detail);
      var gateLabel = isActiveRun(detail) ? ((findings || 0) > 0 ? "Findings observed" : "No findings yet") : text(detail.gate_outcome, "Not recorded");
      var coverageLabel = isActiveRun(detail) ? "In progress" : text(detail.coverage_outcome, "Not recorded");
      var stages = renderStageRail(detail);
      var html = '<div class="detail-head"><a class="back-link" href="#/reviews">' + icon("arrowLeft") + '<span>All reviews</span></a><div class="detail-title"><h1>' + escapeHtml(runProject(detail)) + "</h1>" + badge(status) + '</div><div class="detail-id">' + escapeHtml(id) + "</div></div>";
      if (state.runLoading) html += '<div class="sr-only" role="status">Refreshing run detail</div>';
      html += '<div class="panel" style="padding:13px 14px">' + stages + "</div>";
      html += '<dl class="fact-grid"><div class="fact"><dt>Started</dt><dd>' + escapeHtml(formatDate(runStartedAt(detail), true)) + '</dd></div><div class="fact"><dt>Elapsed</dt><dd>' + escapeHtml(formatDuration(runElapsed(detail))) + '</dd></div><div class="fact"><dt>Reviewers</dt><dd>' + reviewers.length + '</dd></div><div class="fact"><dt>Findings</dt><dd>' + (findings === undefined ? "Not recorded" : findings) + '</dd></div><div class="fact"><dt>Gate</dt><dd>' + escapeHtml(gateLabel) + '</dd></div><div class="fact"><dt>Coverage</dt><dd>' + escapeHtml(coverageLabel) + "</dd></div></dl>";
      html += '<div class="tabs" role="tablist" aria-label="Run detail"><button id="run-tab-timeline" aria-controls="run-panel" tabindex="' + (tab === "timeline" ? "0" : "-1") + '" class="tab" type="button" role="tab" data-run-tab="timeline" aria-selected="' + (tab === "timeline") + '">Timeline</button><button id="run-tab-findings" aria-controls="run-panel" tabindex="' + (tab === "findings" ? "0" : "-1") + '" class="tab" type="button" role="tab" data-run-tab="findings" aria-selected="' + (tab === "findings") + '">Findings' + (findings !== undefined ? " · " + findings : "") + '</button><button id="run-tab-events" aria-controls="run-panel" tabindex="' + (tab === "events" ? "0" : "-1") + '" class="tab" type="button" role="tab" data-run-tab="events" aria-selected="' + (tab === "events") + '">Events · ' + eventsOf(detail).length + "</button></div>";
      html += '<div id="run-panel" role="tabpanel" aria-labelledby="run-tab-' + tab + '">';
      if (tab === "findings") html += renderFindings(detail);
      else if (tab === "events") html += renderEvents(detail);
      else html += '<div class="detail-layout"><div><section class="section"><div class="section-head"><h2 class="section-title">Run activity</h2></div>' + renderTimeline(detail) + '</section><section class="section"><div class="section-head"><h2 class="section-title">Lens execution <span class="section-count">' + groupReviewers(reviewers).length + "</span></h2></div>" + renderLensList(detail) + "</section></div>" + renderRunSide(detail) + "</div>";
      html += "</div>";
      return html;
    }

    function modelRunsOf(agent) {
      var value = firstDefined(agent && agent.model_runs, agent && agent.models, agent && agent.runs, agent && agent.reviewers);
      var runs = namedList(value);
      if (!runs.length && (agent.model || agent.adapter)) runs = [{ id: agent.id || "primary", model: agent.model, adapter: agent.adapter, effort: agent.effort }];
      return runs;
    }

    function renderAgentCard(agent) {
      var id = text(firstDefined(agent.id, agent.agent_id, agent.name), "Unnamed agent");
      var purpose = text(agent.purpose, "Purpose not exposed in the safe configuration view.");
      var runs = modelRunsOf(agent);
      var quorum = firstDefined(agent.pass_quorum, get(agent, ["policy", "pass_quorum"]));
      var providerGroups = firstDefined(agent.minimum_provider_groups, get(agent, ["policy", "minimum_provider_groups"]));
      var adjudication = firstDefined(agent.adjudication, get(agent, ["policy", "adjudication"]));
      var metadata = [
        ["Default", agent.default === true ? "yes" : undefined],
        ["Isolation", agent.isolation],
        ["Timeout", number(agent.timeout_ms) === undefined ? undefined : formatDuration(agent.timeout_ms)],
        ["Instructions", agent.has_instructions === true ? text(agent.instruction_source, "configured") : undefined],
        ["Gate severity", agent.gate_minimum_severity],
        ["Gate confidence", agent.gate_minimum_confidence]
      ];
      return '<article class="catalog-card"><div class="catalog-head"><div><h2>' + escapeHtml(id) + '</h2><div class="catalog-subtitle">' + escapeHtml(purpose) + '</div></div><span class="pill">' + runs.length + " run" + (runs.length === 1 ? "" : "s") + '</span></div><div class="catalog-body">' + (runs.length ? '<div class="chain">' + runs.map(function (run, index) {
        var runName = text(firstDefined(run.id, run.run_id, run.name), "run-" + (index + 1));
        var adapter = text(run.adapter, text(agent.adapter, "adapter inherited"));
        var model = text(run.model, text(agent.model, "model inherited"));
        var runMeta = [text(run.activation), text(run.provider_group), number(run.timeout_ms) === undefined ? "" : formatDuration(run.timeout_ms)].filter(Boolean).join(" · ");
        return '<div class="chain-row"><div class="chain-index">' + (index + 1) + '</div><div class="chain-main"><strong>' + escapeHtml(runName) + '</strong><span>' + escapeHtml(adapter + " / " + model + (runMeta ? " · " + runMeta : "")) + '</span></div>' + (run.effort ? '<span class="pill">' + escapeHtml(run.effort) + "</span>" : "") + "</div>";
      }).join("") + "</div>" : '<div class="section-hint">No model chain exposed.</div>') + '<div class="pill-list">' + (quorum !== undefined ? '<span class="pill">pass quorum ' + escapeHtml(quorum) + "</span>" : "") + (providerGroups !== undefined ? '<span class="pill">provider groups ' + escapeHtml(providerGroups) + "</span>" : "") + (adjudication !== undefined ? '<span class="pill">adjudication ' + escapeHtml(adjudication) + "</span>" : "") + array(agent.projects).map(function (project) { return '<span class="pill">project: ' + escapeHtml(project) + "</span>"; }).join("") + array(agent.required_context).map(function (key) { return '<span class="pill">context: ' + escapeHtml(key) + "</span>"; }).join("") + '</div><div style="margin-top:12px">' + renderDefinitionList(metadata) + "</div>" + (agent.applicability ? '<details class="raw"><summary>Applicability policy</summary><pre>' + escapeHtml(safeJson(agent.applicability)) + "</pre></details>" : "") + "</div></article>";
    }

    function renderAgents() {
      var agents = snapshotAgents(state.snapshot || {});
      var modelRuns = agents.reduce(function (sum, agent) { return sum + modelRunsOf(agent).length; }, 0);
      return '<div class="page-head"><div><div class="eyebrow">Configuration catalog</div><h1>Agents</h1><p>Configured logical review lenses and their ordered model chains. Successors run according to the configured lens policy.</p></div><div class="page-meta">Safe effective view</div></div>' +
        '<div class="metric-grid">' + renderMetric("Logical agents", String(agents.length), "Configured review lenses") + renderMetric("Model runs", String(modelRuns), "Concrete configured executions") + renderMetric("Configuration", text(firstDefined(get(state.snapshot, ["configuration", "revision"]), state.snapshot && state.snapshot.config_revision), "—"), "Effective revision") + renderMetric("Mode", "Read only", "Instructions and secrets omitted") + "</div>" +
        '<div class="notice"><strong>Sanitized configuration.</strong> Instruction bodies, credential values, adapter command arguments, and endpoint values are intentionally omitted by the server.</div>' +
        '<section class="section"><div class="section-head"><h2 class="section-title">Configured agents <span class="section-count">' + agents.length + "</span></h2></div>" + (agents.length ? '<div class="catalog-grid">' + agents.map(renderAgentCard).join("") + "</div>" : renderEmpty("No configured agents", "The safe configuration snapshot did not include an agent catalog.")) + "</section>";
    }

    function projectAgents(project) {
      var value = firstDefined(project && project.agents, project && project.agent_ids, project && project.reviewers, get(project, ["selection", "agents"]));
      if (Array.isArray(value)) return value.map(function (item) { return text(isObject(item) ? firstDefined(item.id, item.name) : item); }).filter(Boolean);
      return [];
    }

    function renderProjectCard(project) {
      var name = text(firstDefined(project.project_name, project.name, project.id), "Unnamed project");
      var agents = projectAgents(project);
      var source = text(firstDefined(project.source, project.project_name_source, get(project, ["selection", "source"])), "Configured mapping");
      var settings = [];
      ["review_scope", "max_concurrency", "timeout_ms", "isolation", "enabled"].forEach(function (key) {
        if (project[key] !== undefined) settings.push([key.replace(/_/g, " "), project[key]]);
      });
      if (isObject(project.settings)) Object.keys(project.settings).forEach(function (key) {
        var value = project.settings[key];
        if (!isObject(value) && !Array.isArray(value)) settings.push([key.replace(/_/g, " "), value]);
      });
      settings.push(["Guidance", project.has_guidance === true ? text(project.guidance_source, "configured") : "none"]);
      settings.push(["Context", project.has_context === true ? "configured" : "none"]);
      return '<article class="catalog-card"><div class="catalog-head"><div><h2>' + escapeHtml(name) + '</h2><div class="catalog-subtitle">' + escapeHtml(source.replace(/_/g, " ")) + '</div></div><span class="pill">' + agents.length + " agent" + (agents.length === 1 ? "" : "s") + '</span></div><div class="catalog-body">' + (agents.length ? '<div class="pill-list" style="margin-top:0">' + agents.map(function (agent) { return '<span class="pill">' + escapeHtml(agent) + "</span>"; }).join("") + "</div>" : '<div class="section-hint">Uses the effective default agent selection.</div>') + (settings.length ? '<div style="margin-top:13px">' + renderDefinitionList(settings) + "</div>" : "") + "</div></article>";
    }

    function renderProjects() {
      var projects = snapshotProjects(state.snapshot || {});
      var defaults = array(get(state.snapshot, ["configuration", "defaults", "agents"]));
      var visibleProjects = [{ name: "Defaults", agents: defaults, source: "Fallback selection", has_guidance: false, has_context: false }].concat(projects);
      var assigned = projects.reduce(function (sum, project) { return sum + projectAgents(project).length; }, 0);
      return '<div class="page-head"><div><div class="eyebrow">Configuration catalog</div><h1>Projects</h1><p>Project-name mappings, effective reviewer selections, and safe execution overrides.</p></div><div class="page-meta">Global managed configuration</div></div>' +
        '<div class="metric-grid">' + renderMetric("Projects", String(projects.length), "Named configuration mappings") + renderMetric("Agent assignments", String(assigned), "Explicit project selections") + renderMetric("Workspace config", "Ignored", "Global configuration is authoritative") + renderMetric("Access", "Read only", "No settings can be changed here") + "</div>" +
        '<section class="section"><div class="section-head"><h2 class="section-title">Configured projects <span class="section-count">' + projects.length + "</span></h2></div>" + '<div class="catalog-grid">' + visibleProjects.map(renderProjectCard).join("") + "</div></section>";
    }

    function scalarEntries(value) {
      if (!isObject(value)) return [];
      return Object.keys(value).filter(function (key) {
        return !isObject(value[key]) && !Array.isArray(value[key]);
      }).map(function (key) { return [key.replace(/_/g, " "), value[key]]; });
    }

    function renderKeyGrid(value) {
      var entries = scalarEntries(value);
      if (!entries.length) return '<div class="section-hint">No values exposed.</div>';
      return '<div class="key-grid">' + entries.map(function (entry) {
        return '<div class="key-value"><span>' + escapeHtml(entry[0]) + '</span><strong>' + escapeHtml(text(entry[1])) + "</strong></div>";
      }).join("") + "</div>";
    }

    function renderObjectSection(title, value) {
      if (value === undefined || value === null) return "";
      if (Array.isArray(value)) {
        return '<section class="config-block"><h2>' + escapeHtml(title) + '</h2><div class="pill-list">' + value.map(function (item) {
          if (isObject(item)) {
            var label = text(firstDefined(item.id, item.name, item.adapter, item.variable), "Item");
            var presence = typeof item.present === "boolean" ? (item.present ? "present" : "missing") : "";
            return '<span class="pill truth-state ' + presence + '" title="' + escapeAttr(safeJson(item)) + '">' + escapeHtml(label + (presence ? " · " + presence : "")) + "</span>";
          }
          return '<span class="pill">' + escapeHtml(item) + "</span>";
        }).join("") + "</div></section>";
      }
      if (isObject(value)) {
        var scalars = renderKeyGrid(value);
        var nested = Object.keys(value).filter(function (key) { return isObject(value[key]) || Array.isArray(value[key]); }).map(function (key) {
          var nestedValue = value[key];
          return '<details class="raw"><summary>' + escapeHtml(key.replace(/_/g, " ")) + '</summary><pre>' + escapeHtml(safeJson(nestedValue)) + "</pre></details>";
        }).join("");
        return '<section class="config-block"><h2>' + escapeHtml(title) + "</h2>" + scalars + nested + "</section>";
      }
      return '<section class="config-block"><h2>' + escapeHtml(title) + '</h2><div class="pill">' + escapeHtml(value) + "</div></section>";
    }

    function renderAdaptersSection(value) {
      var adapters = namedList(value);
      if (!adapters.length) return renderObjectSection("Adapters", value);
      return '<section class="config-block"><h2>Adapters</h2><div class="adapter-grid">' + adapters.map(function (adapter) {
        var id = text(firstDefined(adapter.id, adapter.name), "Unnamed adapter");
        var type = text(adapter.type, "type not recorded");
        var environment = array(adapter.credential_environment);
        return '<div class="adapter-card"><div class="adapter-card-head"><strong>' + escapeHtml(id) + '</strong><span class="pill">' + escapeHtml(type.replace(/_/g, " ")) + '</span></div>' + (environment.length ? '<div class="pill-list">' + environment.map(function (entry) {
          if (!isObject(entry)) return '<span class="pill">' + escapeHtml(entry) + "</span>";
          var status = entry.present === true ? "present" : "missing";
          return '<span class="pill truth-state ' + status + '">' + escapeHtml(text(entry.name, "environment") + " · " + status) + "</span>";
        }).join("") + "</div>" : '<div class="section-hint" style="margin-top:8px">No credential environment variables required or exposed.</div>') + "</div>";
      }).join("") + "</div></section>";
    }

    function renderSystem() {
      var snapshot = state.snapshot || {};
      var system = snapshotSystem(snapshot);
      var configuration = isObject(snapshot.configuration) ? snapshot.configuration : isObject(snapshot.config) ? snapshot.config : {};
      var execution = firstDefined(snapshot.execution, configuration.execution, system.execution);
      var diagnostics = firstDefined(snapshot.diagnostics, configuration.diagnostics, system.diagnostics);
      var adapters = firstDefined(snapshot.adapters, configuration.adapters, system.adapters);
      var credentials = firstDefined(snapshot.credential_variables, configuration.credential_variables, system.credential_variables, system.credentials);
      if (Array.isArray(adapters)) {
        var adapterCredentials = adapters.flatMap(function (adapter) {
          return isObject(adapter) && Array.isArray(adapter.credential_environment) ? adapter.credential_environment.map(function (entry) {
            return isObject(entry) ? Object.assign({ adapter: adapter.id }, entry) : entry;
          }) : [];
        });
        if (credentials === undefined && adapterCredentials.length) credentials = adapterCredentials;
      }
      var locations = firstDefined(snapshot.locations, system.locations, configuration.locations, { config_path: configuration.config_path, runs_directory: configuration.runs_directory });
      var server = firstDefined(snapshot.server, system.server);
      return '<div class="page-head"><div><div class="eyebrow">Observer state</div><h1>System</h1><p>Safe execution policy, adapter availability, diagnostics visibility, credential-variable presence, and local data locations.</p></div><div class="page-meta">Secrets and command arguments omitted</div></div>' +
        '<div class="metric-grid">' + renderMetric("Connection", state.connection === "live" ? "Live stream" : state.connection, "Same-origin local API") + renderMetric("Snapshot revision", text(firstDefined(snapshot.revision, snapshot.snapshot_revision), "—"), "Observer invalidation token") + renderMetric("Server", text(firstDefined(get(server, ["version"]), system.version, snapshot.version), "—"), "Review Mesh version") + renderMetric("Access", "Local only", "Read-only HTTP surface") + "</div>" +
        '<div class="notice"><strong>Safe observer surface.</strong> This dashboard displays only the sanitized server response. Credential values, prompts, instruction bodies, endpoint values, and adapter command lines are not available here.</div>' +
        '<div class="config-section">' + renderObjectSection("Configuration", Object.fromEntries(Object.entries(configuration).filter(function (entry) { return ["execution", "diagnostics", "adapters", "defaults"].indexOf(entry[0]) < 0; }))) + renderObjectSection("Defaults", configuration.defaults) + renderObjectSection("Execution", execution) + renderObjectSection("Diagnostics", diagnostics) + renderAdaptersSection(adapters) + renderObjectSection("Credential variables", credentials) + renderObjectSection("Data locations", locations) + renderObjectSection("Server", server) + (!Object.keys(system).length && !Object.keys(configuration).length ? renderEmpty("No system catalog", "The snapshot did not include sanitized system configuration.") : "") + "</div>";
    }

    function parseRoute() {
      var raw = location.hash || "#/reviews";
      if (raw.charAt(0) === "#") raw = raw.slice(1);
      var split = raw.split("?");
      var path = split[0] || "/reviews";
      var params = new URLSearchParams(split[1] || "");
      var parts = path.split("/").filter(Boolean).map(safeDecode);
      var view = ["reviews", "agents", "projects", "system"].indexOf(parts[0]) >= 0 ? parts[0] : "reviews";
      return {
        view: view,
        runId: view === "reviews" && parts.length > 1 ? parts.slice(1).join("/") : "",
        tab: ["timeline", "findings", "events"].indexOf(params.get("tab")) >= 0 ? params.get("tab") : "timeline",
        reviewerId: params.get("reviewer") || ""
      };
    }

    function routeHash(route) {
      var hash = "#/" + route.view;
      if (route.runId) hash += "/" + encodeURIComponent(route.runId);
      var params = new URLSearchParams();
      if (route.runId && route.tab && route.tab !== "timeline") params.set("tab", route.tab);
      if (route.runId && route.reviewerId) params.set("reviewer", route.reviewerId);
      var query = params.toString();
      return hash + (query ? "?" + query : "");
    }

    function setRoute(patch, replace) {
      var next = Object.assign({}, state.route || parseRoute(), patch);
      var hash = routeHash(next);
      if (replace) history.replaceState(null, "", hash);
      else location.hash = hash;
      if (replace) handleRouteChange();
    }

    function setConnection(value) {
      state.connection = value;
      connection.dataset.state = value;
      var labels = { connecting: "Connecting", live: "Live stream", polling: "Polling", offline: "Offline" };
      connection.querySelector(".connection-label").textContent = labels[value] || value;
      connection.title = value === "live" ? "Receiving local invalidations over Server-Sent Events" : value === "polling" ? "Event stream unavailable; refreshing every two seconds" : labels[value] || value;
    }

    function setCrumbs() {
      var route = state.route;
      var separator = '<span class="crumb-sep" aria-hidden="true">' + icon("chevronRight") + "</span>";
      var html = '<a href="#/' + route.view + '">Review Mesh</a>' + separator + '<span class="crumb-current">' + escapeHtml(route.view.charAt(0).toUpperCase() + route.view.slice(1)) + "</span>";
      if (route.runId) html += separator + '<span class="crumb-current">' + escapeHtml(route.runId) + "</span>";
      crumbs.innerHTML = html;
      document.querySelectorAll("[data-nav]").forEach(function (link) {
        if (link.dataset.nav === route.view) link.setAttribute("aria-current", "page");
        else link.removeAttribute("aria-current");
      });
    }

    function render() {
      if (state.snapshotLoading && !state.snapshot) {
        app.innerHTML = '<div class="stack" aria-label="Loading dashboard"><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div></div>';
        return;
      }
      if (state.snapshotError && !state.snapshot) {
        app.innerHTML = renderError("Dashboard snapshot unavailable", state.snapshotError);
        return;
      }
      var route = state.route || parseRoute();
      if (route.view === "agents") app.innerHTML = renderAgents();
      else if (route.view === "projects") app.innerHTML = renderProjects();
      else if (route.view === "system") app.innerHTML = renderSystem();
      else if (route.runId) app.innerHTML = renderRunDetail();
      else app.innerHTML = renderReviews();
      setCrumbs();
    }

    async function fetchJson(url) {
      var response = await fetch(url, { headers: { Accept: "application/json" }, cache: "no-store" });
      if (!response.ok) {
        var message = "Request failed with HTTP " + response.status + ".";
        try {
          var body = await response.json();
          message = text(firstDefined(body.message, body.error), message);
        } catch (_) {}
        throw new Error(message);
      }
      return response.json();
    }

    async function refreshSnapshot(options) {
      options = options || {};
      if (!state.snapshot) state.snapshotLoading = true;
      refreshButton.disabled = true;
      try {
        var snapshot = await fetchJson(API.snapshot);
        state.snapshot = isObject(snapshot) ? snapshot : {};
        state.snapshotError = null;
        render();
        if (state.route && state.route.runId && options.includeDetail !== false) await loadRun(state.route.runId, true);
        render();
        if (options.announce) showToast("Dashboard refreshed.");
      } catch (error) {
        state.snapshotError = error instanceof Error ? error.message : String(error);
        if (state.connection !== "polling") setConnection("offline");
        render();
      } finally {
        state.snapshotLoading = false;
        refreshButton.disabled = false;
      }
    }

    async function loadRun(id, shouldRender) {
      var generation = ++state.requestGeneration;
      state.runLoading = true;
      state.runError = null;
      if (shouldRender !== false && !state.runDetail) render();
      try {
        var detail = await fetchJson(API.run(id));
        if (generation !== state.requestGeneration || !state.route || state.route.runId !== id) return;
        state.runDetail = isObject(detail) ? detail : {};
      } catch (error) {
        if (generation !== state.requestGeneration) return;
        state.runDetail = null;
        state.runError = error instanceof Error ? error.message : String(error);
      } finally {
        if (generation === state.requestGeneration) {
          state.runLoading = false;
          if (shouldRender !== false) render();
        }
      }
    }

    async function loadReviewer(run, reviewer) {
      state.reviewerLoading = true;
      state.reviewerError = null;
      state.reviewerDetail = null;
      renderDrawer();
      try {
        var detail = await fetchJson(API.reviewer(run, reviewer));
        if (!state.route || state.route.runId !== run || state.route.reviewerId !== reviewer) return;
        state.reviewerDetail = isObject(detail) ? detail : {};
      } catch (error) {
        state.reviewerError = error instanceof Error ? error.message : String(error);
      } finally {
        state.reviewerLoading = false;
        renderDrawer();
      }
    }

    function reviewerObject() {
      if (!isObject(state.reviewerDetail)) return {};
      return isObject(state.reviewerDetail.reviewer) ? Object.assign({}, state.reviewerDetail.reviewer, state.reviewerDetail) : state.reviewerDetail;
    }

    function reviewerEvents(detail) {
      var events = eventsOf(detail);
      if (events.length) return events;
      var activity = firstDefined(detail.activity, detail.activities, detail.progress);
      return array(activity).filter(isObject);
    }

    function renderReviewerActivity(detail) {
      var events = reviewerEvents(detail);
      var summary = text(firstDefined(detail.last_activity_message, detail.activity_summary, get(detail, ["activity", "summary"])));
      if (!summary && events.length) summary = eventSummary(events[events.length - 1]);
      var html = '<div class="notice"><strong>Sanitized activity only.</strong> These are persisted phase and activity summaries, not a full provider chat transcript or hidden reasoning.</div>';
      if (summary) html += '<section class="drawer-section"><h3>Latest activity</h3><div class="panel side-card summary-copy">' + escapeHtml(summary) + "</div></section>";
      html += '<section class="drawer-section"><h3>Activity history</h3>' + (events.length ? '<div class="panel timeline">' + events.map(function (event) {
        return '<div class="timeline-row"><div class="timeline-time">' + escapeHtml(formatDate(eventTime(event), false)) + '</div><div class="timeline-dot ' + eventTone(event) + '"></div><div class="timeline-body"><strong>' + escapeHtml(eventName(event).replace(/\./g, " · ")) + '</strong><p>' + escapeHtml(eventSummary(event)) + "</p></div></div>";
      }).join("") + "</div>" : renderEmpty("No activity history", "No persisted reviewer activity events were returned.")) + "</section>";
      return html;
    }

    function renderReviewerResult(detail) {
      var result = isObject(detail.result) ? detail.result : isObject(get(detail, ["terminal", "result"])) ? get(detail, ["terminal", "result"]) : {};
      var status = reviewerState(detail);
      var summary = text(firstDefined(result.summary, detail.summary, get(detail, ["failure", "message"]), get(detail, ["skipped", "reason"])), "No terminal summary recorded.");
      var findings = array(firstDefined(result.actionable_findings, detail.findings)).filter(isObject);
      var notes = array(result.informational_notes).filter(isObject);
      var reviewMarkdown = text(result.review_markdown);
      var html = '<section class="drawer-section"><h3>Terminal result</h3><div class="panel side-card"><div style="margin-bottom:10px">' + badge(firstDefined(result.verdict, status)) + '</div><div class="summary-copy">' + escapeHtml(summary) + "</div></div></section>";
      if (reviewMarkdown) html += '<section class="drawer-section"><h3>Complete review</h3><div class="panel side-card review-markdown">' + escapeHtml(reviewMarkdown) + "</div></section>";
      html += '<section class="drawer-section"><h3>Actionable findings · ' + findings.length + "</h3>" + (findings.length ? '<div class="finding-list">' + findings.map(renderFinding).join("") + "</div>" : renderEmpty("No structured findings", "No actionable finding details were returned for this reviewer.")) + "</section>";
      if (notes.length) html += '<section class="drawer-section"><h3>Informational notes · ' + notes.length + '</h3><div class="stack">' + notes.map(function (note) { return '<div class="panel side-card"><strong style="font-size:11px">' + escapeHtml(text(note.title, "Note")) + '</strong><div class="summary-copy" style="margin-top:5px">' + escapeHtml(text(note.description)) + "</div></div>"; }).join("") + "</div></section>";
      return html;
    }

    function renderReviewerRuntime(detail) {
      var timing = isObject(detail.timing) ? detail.timing : {};
      var diagnostics = firstDefined(detail.diagnostics, get(detail, ["failure", "diagnostics"]), get(detail, ["runtime", "diagnostics"]));
      var entries = [
        ["State", reviewerState(detail)],
        ["Lens", firstDefined(detail.lens_id, detail.agent_id)],
        ["Mode", detail.mode],
        ["Adapter", detail.adapter],
        ["Model", detail.model],
        ["Provider group", detail.provider_group],
        ["Effort", detail.effort],
        ["Isolation", detail.isolation],
        ["Attempt", detail.attempt],
        ["Elapsed", formatDuration(firstDefined(detail.elapsed_ms, timing.elapsed_ms))],
        ["Last event", firstDefined(detail.last_event_seq, detail.seq)],
        ["Last activity", formatDate(firstDefined(detail.last_event_at, detail.last_activity_at), true)]
      ];
      var attempts = array(detail.attempts).filter(isObject);
      var attemptSection = attempts.length ? '<section class="drawer-section"><h3>Retry attempts · ' + attempts.length + '</h3><div class="panel timeline">' + attempts.map(function (attempt) {
        var failure = isObject(attempt.failure) ? attempt.failure : {};
        return '<div class="timeline-row"><div class="timeline-time">#' + escapeHtml(firstDefined(attempt.attempt, "?")) + '</div><div class="timeline-dot bad"></div><div class="timeline-body"><strong>' + escapeHtml(text(firstDefined(failure.reason, "attempt failed")).replace(/_/g, " ")) + '</strong><p>' + escapeHtml(text(failure.message, "No failure detail recorded.")) + '</p><div class="timeline-meta"><span>' + escapeHtml(formatDuration(attempt.elapsed_ms)) + '</span><span>' + escapeHtml(formatDate(attempt.started_at, true)) + '</span></div></div></div>';
      }).join("") + "</div></section>" : "";
      return '<section class="drawer-section"><h3>Runtime metadata</h3><div class="panel side-card">' + renderDefinitionList(entries) + "</div></section>" + attemptSection + (diagnostics ? '<section class="drawer-section"><h3>Sanitized diagnostics</h3><pre>' + escapeHtml(safeJson(diagnostics)) + "</pre></section>" : "") + '<section class="drawer-section"><h3>API record</h3><details class="raw"><summary>Show sanitized reviewer payload</summary><pre>' + escapeHtml(safeJson(detail)) + "</pre></details></section>";
    }

    function renderDrawer() {
      var route = state.route || parseRoute();
      if (!route.reviewerId || !route.runId) {
        drawerScrim.classList.remove("open");
        drawerScrim.setAttribute("aria-hidden", "true");
        drawer.innerHTML = "";
        document.querySelector(".shell").inert = false;
        document.body.style.overflow = "";
        return;
      }
      drawerScrim.classList.add("open");
      drawerScrim.setAttribute("aria-hidden", "false");
      document.querySelector(".shell").inert = true;
      document.body.style.overflow = "hidden";
      if (state.reviewerLoading) {
        drawer.innerHTML = '<div class="drawer-head"><div><div class="eyebrow">Reviewer inspector</div><h2 id="drawer-title">' + escapeHtml(route.reviewerId) + '</h2></div><button class="icon-button" type="button" data-close-drawer aria-label="Close reviewer inspector">' + icon("close") + '</button></div><div class="drawer-content"><div class="stack" style="margin-top:18px"><div class="skeleton"></div><div class="skeleton"></div></div></div>';
        window.setTimeout(function () { var close = drawer.querySelector("[data-close-drawer]"); if (close) close.focus(); }, 0);
        return;
      }
      if (state.reviewerError) {
        drawer.innerHTML = '<div class="drawer-head"><div><div class="eyebrow">Reviewer inspector</div><h2 id="drawer-title">' + escapeHtml(route.reviewerId) + '</h2></div><button class="icon-button" type="button" data-close-drawer aria-label="Close reviewer inspector">' + icon("close") + '</button></div><div class="drawer-content" style="padding-top:18px">' + renderError("Reviewer unavailable", state.reviewerError) + "</div>";
        window.setTimeout(function () { var close = drawer.querySelector("[data-close-drawer]"); if (close) close.focus(); }, 0);
        return;
      }
      var detail = reviewerObject();
      var id = reviewerId(detail) || route.reviewerId;
      var tab = state.drawerTab;
      drawer.innerHTML = '<div class="drawer-head"><div><div class="eyebrow">Reviewer inspector</div><h2 id="drawer-title">' + escapeHtml(text(firstDefined(detail.lens_id, detail.agent_id), "Reviewer")) + '</h2><div class="drawer-id">' + escapeHtml(id) + '</div></div><button class="icon-button" type="button" data-close-drawer aria-label="Close reviewer inspector">' + icon("close") + '</button></div><div class="drawer-content"><div class="tabs" role="tablist" aria-label="Reviewer detail"><button id="drawer-tab-activity" aria-controls="drawer-panel" tabindex="' + (tab === "activity" ? "0" : "-1") + '" class="tab" type="button" role="tab" data-drawer-tab="activity" aria-selected="' + (tab === "activity") + '">Activity</button><button id="drawer-tab-result" aria-controls="drawer-panel" tabindex="' + (tab === "result" ? "0" : "-1") + '" class="tab" type="button" role="tab" data-drawer-tab="result" aria-selected="' + (tab === "result") + '">Result</button><button id="drawer-tab-runtime" aria-controls="drawer-panel" tabindex="' + (tab === "runtime" ? "0" : "-1") + '" class="tab" type="button" role="tab" data-drawer-tab="runtime" aria-selected="' + (tab === "runtime") + '">Runtime</button></div><div id="drawer-panel" role="tabpanel" aria-labelledby="drawer-tab-' + tab + '">' + (tab === "result" ? renderReviewerResult(detail) : tab === "runtime" ? renderReviewerRuntime(detail) : renderReviewerActivity(detail)) + "</div></div>";
      window.setTimeout(function () { var close = drawer.querySelector("[data-close-drawer]"); if (close && !drawer.contains(document.activeElement)) close.focus(); }, 0);
    }

    function closeDrawer() {
      document.querySelector(".shell").inert = false;
      document.body.style.overflow = "";
      setRoute({ reviewerId: "" });
      if (state.lastFocused && document.contains(state.lastFocused)) state.lastFocused.focus();
    }

    function showToast(message) {
      toast.textContent = message;
      toast.classList.add("show");
      window.setTimeout(function () { toast.classList.remove("show"); }, 2500);
    }

    function scheduleRefresh() {
      if (state.refreshTimer) return;
      state.refreshTimer = window.setTimeout(function () {
        state.refreshTimer = null;
        refreshSnapshot({ includeDetail: true });
      }, 120);
    }

    function stopPolling() {
      if (state.pollTimer) window.clearInterval(state.pollTimer);
      state.pollTimer = null;
    }

    function startPolling() {
      if (state.pollTimer) return;
      setConnection("polling");
      state.pollTimer = window.setInterval(function () {
        if (!document.hidden) refreshSnapshot({ includeDetail: true });
      }, POLL_INTERVAL);
    }

    function connectStream() {
      if (!("EventSource" in window)) { startPolling(); return; }
      if (state.eventSource) state.eventSource.close();
      setConnection("connecting");
      var source = new EventSource(API.stream);
      state.eventSource = source;
      source.onopen = function () {
        if (state.eventSource !== source) return;
        stopPolling();
        setConnection("live");
      };
      var invalidate = function () { scheduleRefresh(); };
      source.onmessage = invalidate;
      ["invalidate", "invalidated", "snapshot", "revision", "update"].forEach(function (name) { source.addEventListener(name, invalidate); });
      source.onerror = function () {
        if (state.eventSource !== source) return;
        source.close();
        state.eventSource = null;
        startPolling();
        if (state.streamRetryTimer) window.clearTimeout(state.streamRetryTimer);
        state.streamRetryTimer = window.setTimeout(connectStream, STREAM_RETRY);
      };
    }

    async function handleRouteChange() {
      var previous = state.route;
      state.route = parseRoute();
      setCrumbs();
      if (state.route.runId && (!previous || previous.runId !== state.route.runId || !state.runDetail)) {
        state.runDetail = null;
        state.runError = null;
        await loadRun(state.route.runId, true);
      } else render();
      if (state.route.reviewerId) {
        if (!previous || previous.reviewerId !== state.route.reviewerId || previous.runId !== state.route.runId) {
          state.drawerTab = "activity";
          await loadReviewer(state.route.runId, state.route.reviewerId);
        } else renderDrawer();
      } else renderDrawer();
      document.title = state.route.runId ? state.route.runId + " · Review Mesh" : state.route.view.charAt(0).toUpperCase() + state.route.view.slice(1) + " · Review Mesh";
    }

    document.addEventListener("click", function (event) {
      var target = event.target instanceof Element ? event.target : null;
      if (!target) return;
      var reviewerButton = target.closest("[data-open-reviewer]");
      if (reviewerButton) {
        state.lastFocused = reviewerButton;
        setRoute({ view: "reviews", runId: reviewerButton.getAttribute("data-run-id") || "", reviewerId: reviewerButton.getAttribute("data-open-reviewer") || "" });
        return;
      }
      var runTab = target.closest("[data-run-tab]");
      if (runTab) { setRoute({ tab: runTab.getAttribute("data-run-tab") || "timeline" }); return; }
      var drawerTab = target.closest("[data-drawer-tab]");
      if (drawerTab) { state.drawerTab = drawerTab.getAttribute("data-drawer-tab") || "activity"; renderDrawer(); return; }
      if (target.closest("[data-close-drawer]")) { closeDrawer(); return; }
      if (target === drawerScrim) closeDrawer();
    });

    document.addEventListener("keydown", function (event) {
      var tab = event.target instanceof Element ? event.target.closest('[role="tab"]') : null;
      if (tab && ["ArrowLeft", "ArrowRight", "Home", "End"].indexOf(event.key) >= 0) {
        var list = tab.closest('[role="tablist"]');
        var tabs = list ? Array.from(list.querySelectorAll('[role="tab"]')) : [];
        var current = tabs.indexOf(tab);
        if (current >= 0 && tabs.length) {
          event.preventDefault();
          var next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (current + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
          tabs[next].focus();
          tabs[next].click();
          return;
        }
      }
      if (event.key === "Escape" && state.route && state.route.reviewerId) {
        closeDrawer();
        return;
      }
      if (event.key === "Tab" && state.route && state.route.reviewerId && drawerScrim.classList.contains("open")) {
        var focusable = Array.from(drawer.querySelectorAll('button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'));
        if (!focusable.length) return;
        var first = focusable[0];
        var last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    });

    refreshButton.addEventListener("click", function () { refreshSnapshot({ announce: true, includeDetail: true }); });
    window.addEventListener("hashchange", handleRouteChange);
    document.addEventListener("visibilitychange", function () {
      if (!document.hidden && state.connection === "polling") refreshSnapshot({ includeDetail: true });
    });

    state.route = parseRoute();
    if (!location.hash) history.replaceState(null, "", "#/reviews");
    setCrumbs();
    refreshSnapshot({ includeDetail: true }).then(function () {
      handleRouteChange();
      connectStream();
    });
  }());
  </script>
</body>
</html>`;

export const DASHBOARD_HTML = dashboardHtml;

export function renderDashboardHtml(): string {
  return dashboardHtml;
}

export default dashboardHtml;
