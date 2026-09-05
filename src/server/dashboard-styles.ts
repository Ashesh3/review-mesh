export const dashboardStyles = String.raw`
    :root {
      --surface-canvas: #14181d;
      --surface-sidebar: #13171b;
      --surface-raised: #191e24;
      --surface-overlay: #22282f;
      --surface-hover: #282f37;
      --surface-selected: #213247;
      --border-subtle: #343b44;
      --border-strong: #586574;
      --text-primary: #edf0f3;
      --text-secondary: #aab2bc;
      --text-tertiary: #a0aab6;
      --accent: #80ade5;
      --accent-soft: #213247;
      --positive: #79c799;
      --positive-soft: #1e352b;
      --warning: #e4b765;
      --warning-soft: #362e20;
      --negative: #e77f84;
      --negative-soft: #382328;
      --violet: #b6a7dc;
      --violet-soft: #302b3c;
      --accent-border: #405c7b;
      --selected-border: #52749c;
      --positive-border: #375844;
      --warning-border: #5b4b2d;
      --negative-border: #694147;
      --violet-border: #514769;
      --selection-fill: #345479;
      --row-hover: #202831;
      --subtle-fill: rgb(255 255 255 / 2%);
      --nested-fill: rgb(0 0 0 / 9%);
      --hover-fill: rgb(255 255 255 / 4%);
      --code-text: #c7d6e6;
      --milestone-complete: #97b4d8;
      --milestone-pending: #454c55;
      --phase-track: #343e49;
      --phase-complete: #527760;
      --on-status: #14181d;
      --radius-sm: 5px;
      --radius-md: 7px;
      --radius-lg: 7px;
      --control-size: 44px;
      --motion-fast: 140ms;
      --shadow: 0 12px 36px rgb(0 0 0 / 28%);
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
      --font-mono: "JetBrains Mono", "Cascadia Code", Consolas, ui-monospace, monospace;
      font-family: Inter, "Segoe UI Variable Text", "Segoe UI", ui-sans-serif, system-ui, sans-serif;
      font-synthesis: none;
      color-scheme: dark;
    }

    :root[data-theme="light"] {
      --surface-canvas: #f5f7fa;
      --surface-sidebar: #eef1f5;
      --surface-raised: #ffffff;
      --surface-overlay: #f0f3f7;
      --surface-hover: #e6ebf1;
      --surface-selected: #e8f0fa;
      --border-subtle: #cdd4de;
      --border-strong: #8091a3;
      --text-primary: #1b2530;
      --text-secondary: #526171;
      --text-tertiary: #5e6e7e;
      --accent: #285d9b;
      --accent-soft: #e8f0fa;
      --positive: #26704a;
      --positive-soft: #e7f3ec;
      --warning: #885c0d;
      --warning-soft: #fbf0d9;
      --negative: #ae3c46;
      --negative-soft: #fce9ec;
      --violet: #66508d;
      --violet-soft: #f0eafa;
      --accent-border: #a9bfda;
      --selected-border: #577faf;
      --positive-border: #a4ccb4;
      --warning-border: #d6be87;
      --negative-border: #dba6ad;
      --violet-border: #beadd7;
      --selection-fill: #cbdef7;
      --row-hover: #eff4fa;
      --subtle-fill: rgb(31 54 79 / 2%);
      --nested-fill: rgb(31 54 79 / 3%);
      --hover-fill: rgb(31 54 79 / 5%);
      --code-text: #284566;
      --milestone-complete: #4a6f9d;
      --milestone-pending: #b8c4d1;
      --phase-track: #cdd6e2;
      --phase-complete: #34815b;
      --on-status: #ffffff;
      --shadow: 0 12px 36px rgb(25 43 62 / 14%);
      color-scheme: light;
    }

    * { box-sizing: border-box; }
    html { height: 100%; min-width: 320px; background: var(--bg); }
    body { margin: 0; height: 100dvh; min-height: 100dvh; overflow-x: clip; overflow-y: hidden; color: var(--text); background: var(--bg); font-size: 14px; line-height: 1.45; }
    button, input, select, textarea { font: inherit; }
    button, a { -webkit-tap-highlight-color: transparent; touch-action: manipulation; }
    button, select, summary { cursor: pointer; }
    button:disabled { cursor: default; opacity: .55; }
    a { color: inherit; }
    button { color: inherit; }
    input, select { color: var(--text); }
    ::selection { background: var(--selection-fill); color: var(--text); }
    :focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
    [hidden] { display: none !important; }
    .icon { width: 18px; height: 18px; flex: 0 0 auto; fill: none; stroke: currentColor; stroke-width: 1.75; stroke-linecap: round; stroke-linejoin: round; }
    .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
    .skip-link { position: fixed; left: 12px; top: -60px; z-index: 100; min-height: var(--control-size); display: flex; align-items: center; padding: 9px 14px; border-radius: var(--radius-sm); color: var(--on-status); background: var(--accent); font-weight: 700; text-decoration: none; }
    .skip-link:focus { top: 12px; }
    .mono { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
    .muted, .secondary { color: var(--muted); }
    .secondary { display: block; margin-top: 3px; font-size: 12px; line-height: 1.4; }
    .truncate { display: block; max-width: 360px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .eyebrow, .nav-label { color: var(--faint); font-size: 11px; letter-spacing: .08em; text-transform: uppercase; }
    .good, .positive { color: var(--green); }
    .warn, .warning { color: var(--amber); }
    .bad, .negative { color: var(--red); }

    .shell { display: grid; grid-template-columns: 224px minmax(0, 1fr); min-height: 100dvh; height: 100dvh; }
    .sidebar { display: flex; flex-direction: column; min-width: 0; min-height: 0; overflow-y: auto; padding: 24px 12px 16px; border-right: 1px solid var(--line); background: var(--surface-sidebar); }
    .brand { display: flex; align-items: center; gap: 9px; min-height: 28px; margin-bottom: 28px; padding: 0 10px; }
    .brand-mark { display: grid; place-items: center; width: 23px; height: 26px; flex: 0 0 auto; color: var(--accent); }
    .brand-mark .icon { width: 22px; height: 22px; }
    .brand-copy strong { display: block; font-size: 16px; font-weight: 600; line-height: 1.3; letter-spacing: -.02em; }
    .brand-copy span { color: var(--muted); font-size: 11px; }
    .nav-label { padding: 0 10px 10px; }
    .nav { display: grid; gap: 4px; }
    .nav a { min-height: var(--control-size); display: flex; align-items: center; gap: 11px; padding: 9px 11px; border: 1px solid transparent; border-radius: var(--radius-sm); color: var(--muted); font-size: 14px; font-weight: 500; text-decoration: none; transition: color var(--motion-fast), background var(--motion-fast); }
    .nav a:hover { color: var(--text); background: var(--surface-overlay); }
    .nav a[aria-current="page"] { color: var(--text); background: var(--surface-hover); }
    .nav-glyph { display: grid; place-items: center; width: 18px; flex: 0 0 auto; color: var(--muted); }
    .nav a[aria-current="page"] .nav-glyph { color: var(--accent); }
    .sidebar-foot { margin-top: auto; padding: 18px 10px 0; }
    .read-only { display: flex; align-items: center; gap: 8px; color: var(--muted); font-size: 12px; }
    .lock-dot, .connection-dot { width: 6px; height: 6px; flex: 0 0 auto; border-radius: 50%; background: var(--green); }
    .workspace { display: flex; flex-direction: column; min-width: 0; min-height: 0; overflow: hidden; }
    .topbar { flex: 0 0 48px; display: flex; align-items: center; justify-content: space-between; gap: 16px; min-width: 0; padding: 6px 28px 0; background: var(--bg); }
    .crumbs { display: flex; align-items: center; gap: 8px; min-width: 0; color: var(--muted); font-size: 13px; }
    .crumbs a { color: var(--muted); text-decoration: none; }
    .crumbs a:hover { color: var(--text); }
    .crumb-sep { display: inline-flex; color: var(--faint); }
    .crumb-sep .icon { width: 12px; height: 12px; }
    .crumb-current { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .top-actions { display: flex; align-items: center; gap: 8px; flex: 0 0 auto; }
    .connection { display: inline-flex; align-items: center; gap: 7px; min-height: 27px; padding: 4px 8px; border-radius: var(--radius-sm); color: var(--muted); background: var(--panel-2); font-size: 12px; white-space: nowrap; }
    .connection-dot { background: var(--muted); }
    .connection[data-state="live"] .connection-dot { background: var(--green); }
    .connection[data-state="polling"] .connection-dot { background: var(--amber); }
    .connection[data-state="offline"] .connection-dot { background: var(--red); }
    .freshness, .updated-at { color: var(--muted); font-size: 12px; white-space: nowrap; }
    .theme-switch { display: inline-flex; align-items: center; flex: 0 0 auto; gap: 2px; padding: 3px; border: 1px solid var(--line); border-radius: var(--radius-md); background: var(--surface-sidebar); }
    .theme-option { display: grid; place-items: center; width: 32px; height: 32px; flex: 0 0 auto; padding: 0; border: 1px solid transparent; border-radius: 4px; color: var(--muted); background: transparent; transition: color var(--motion-fast), border-color var(--motion-fast), background var(--motion-fast); }
    .theme-option .icon { width: 16px; height: 16px; }
    .theme-option:hover { color: var(--text); background: var(--surface-hover); }
    .theme-option[aria-pressed="true"] { color: var(--accent); border-color: var(--selected-border); background: var(--surface-selected); }
    .theme-option:focus-visible { position: relative; z-index: 1; outline-offset: 2px; }
    .icon-button, .button { border: 1px solid var(--line); border-radius: var(--radius-sm); color: var(--muted); background: var(--panel); cursor: pointer; transition: border-color var(--motion-fast), color var(--motion-fast), background var(--motion-fast); }
    .icon-button:hover, .button:hover { border-color: var(--line-strong); color: var(--text); background: var(--panel-2); }
    .icon-button { width: var(--control-size); height: var(--control-size); display: grid; place-items: center; flex: 0 0 auto; }
    .topbar .icon-button { border-color: transparent; background: transparent; }
    .button { display: inline-flex; align-items: center; justify-content: center; gap: 8px; min-height: var(--control-size); padding: 8px 12px; font-size: 13px; font-weight: 500; text-decoration: none; }
    .button.primary { color: var(--text); border-color: var(--selected-border); background: var(--accent-soft); }
    main { display: flex; flex: 1 1 auto; width: 100%; min-width: 0; min-height: 0; }
    #app { flex: 1 1 auto; min-width: 0; min-height: 0; }
    #app > .stack, #app > .error-state, #app > .empty { margin: 20px 28px; }
    .workspace-view { display: flex; flex-direction: column; height: 100%; min-width: 0; min-height: 0; overflow: hidden; }
    .view-scroll { flex: 1 1 auto; min-width: 0; min-height: 140px; overflow: auto; padding: 8px 28px 16px; scrollbar-width: thin; overscroll-behavior: contain; }
    .view-heading, .page-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; margin-bottom: 18px; }
    .heading-copy, .view-heading > div { min-width: 0; }
    .view-heading h1, .page-head h1 { margin: 0; color: var(--text); font-size: 32px; font-weight: 600; line-height: 1.25; letter-spacing: -.035em; }
    .view-heading p, .page-head p { display: flex; flex-wrap: wrap; align-items: center; gap: 7px; max-width: 850px; margin: 7px 0 0; color: var(--muted); font-size: 14px; line-height: 1.45; overflow-wrap: anywhere; }
    .heading-actions { display: flex; align-items: center; flex-wrap: wrap; justify-content: flex-end; gap: 8px; }
    .page-meta { color: var(--muted); font-family: var(--font-mono); font-size: 12px; }

    .filter-bar { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; min-width: 0; margin: 0 0 16px; }
    .search-field { position: relative; display: flex; align-items: center; gap: 8px; min-width: 160px; width: 280px; max-width: 100%; min-height: var(--control-size); padding: 0 11px; border: 1px solid var(--line); border-radius: var(--radius-sm); background: var(--panel); color: var(--muted); }
    .search-field:focus-within { border-color: var(--accent); outline: 2px solid var(--accent); outline-offset: 2px; }
    .search-field input { width: 100%; min-width: 0; min-height: 40px; padding: 0; border: 0; outline: 0; background: transparent; font-size: 13px; }
    .search-field input::placeholder { color: var(--muted); opacity: 1; }
    .filter-select { max-width: 260px; min-height: var(--control-size); padding: 8px 32px 8px 11px; border: 1px solid var(--line); border-radius: var(--radius-sm); color: var(--muted); background: var(--panel); font-size: 13px; }
    .filter-label { display: block; min-width: 0; }
    .filter-toggle { display: inline-flex; align-items: center; gap: 8px; min-height: var(--control-size); padding: 8px 10px; border: 1px solid var(--line); border-radius: var(--radius-sm); color: var(--muted); background: var(--panel); font-size: 13px; }
    .filter-toggle input { width: 16px; height: 16px; margin: 0; accent-color: var(--accent); }
    .filter-toggle[aria-pressed="true"] { color: var(--accent); border-color: var(--selected-border); background: var(--accent-soft); }
    .filter-result-count { margin-left: auto; color: var(--muted); font-size: 12px; }
    .stack { display: grid; gap: 12px; }
    .section { margin-top: 22px; }
    .section:first-child { margin-top: 0; }
    .section-head, .panel-header { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
    .section-head { margin-bottom: 10px; }
    .section-title { display: flex; align-items: center; gap: 8px; margin: 0; font-size: 15px; font-weight: 600; }
    .section-count { min-width: 23px; padding: 1px 6px; border: 1px solid var(--line); border-radius: 4px; color: var(--muted); background: var(--panel); font-size: 11px; text-align: center; }
    .section-hint { color: var(--muted); font-size: 12px; }
    .panel { min-width: 0; border: 1px solid var(--line); border-radius: var(--radius); background: var(--panel); }
    .panel + .panel { margin-top: 16px; }
    .panel-header { min-height: 44px; padding: 10px 12px; border-bottom: 1px solid var(--line); border-radius: var(--radius) var(--radius) 0 0; background: var(--panel-2); }
    .panel-header h2, .panel-header h3 { margin: 0; font-size: 14px; font-weight: 500; }
    .panel-header p { margin: 3px 0 0; color: var(--muted); font-size: 12px; }
    .panel-header .section-hint { display: flex; flex-wrap: wrap; gap: 12px; }
    .status-count.active { color: var(--accent); }
    .status-count.waiting { color: var(--amber); }
    .status-count.finished { color: var(--green); }
    .panel-body { padding: 14px; }
    .table-wrap { max-width: 100%; overflow: auto; overscroll-behavior: contain; border: 1px solid var(--line); border-radius: var(--radius); background: var(--panel); }
    .panel > .table-wrap { border: 0; border-radius: 0 0 var(--radius) var(--radius); }
    table { width: 100%; border-collapse: separate; border-spacing: 0; font-size: 14px; line-height: 1.35; }
    .data-table { min-width: 650px; }
    th { padding: 9px 12px; color: var(--muted); background: var(--panel-2); font-size: 12px; font-weight: 500; text-align: left; white-space: nowrap; }
    th:has(.table-sort) { padding-top: 0; padding-bottom: 0; }
    .table-sort { display: inline-flex; align-items: center; min-height: var(--control-size); padding: 7px 0; border: 0; color: var(--muted); background: transparent; text-align: left; }
    .table-sort:hover { color: var(--text); }
    td { min-width: 0; padding: 8px 12px; border-top: 1px solid var(--line); color: var(--text); vertical-align: middle; overflow-wrap: anywhere; }
    td.secondary { display: table-cell; margin: 0; }
    tbody tr:first-child td { border-top: 0; }
    tbody tr { transition: background var(--motion-fast); }
    tbody tr:hover { background: var(--row-hover); }
    tbody tr.is-selected { background: var(--surface-selected); }
    tbody tr.is-selected td { box-shadow: inset 0 1px var(--selected-border), inset 0 -1px var(--selected-border); }
    tbody tr.is-selected td:first-child { box-shadow: inset 1px 0 var(--selected-border), inset 0 1px var(--selected-border), inset 0 -1px var(--selected-border); }
    tbody tr.is-selected td:last-child { box-shadow: inset -1px 0 var(--selected-border), inset 0 1px var(--selected-border), inset 0 -1px var(--selected-border); }
    td:has(.row-button) { padding-top: 0; padding-bottom: 0; }
    td a { color: var(--text); font-weight: 500; text-decoration: none; }
    td a:hover { color: var(--accent); text-decoration: underline; }
    .row-button { display: inline-flex; flex-direction: column; justify-content: center; align-items: flex-start; gap: 3px; min-height: var(--control-size); max-width: 100%; padding: 6px 0; border: 0; color: var(--text); background: transparent; font: inherit; text-align: left; cursor: pointer; overflow-wrap: anywhere; }
    .row-button:hover { color: var(--accent); }
    .row-button > strong { font-weight: 500; }
    .row-button .secondary { margin: 0; }
    .table-footer { padding: 9px 12px; border-top: 1px solid var(--line); color: var(--muted); font-size: 12px; }

    .badge { display: inline-flex; align-items: center; gap: 5px; width: fit-content; min-height: 22px; max-width: 100%; padding: 2px 6px; border: 1px solid var(--line); border-radius: 4px; color: var(--muted); background: var(--panel-2); font-size: 11px; font-weight: 500; line-height: 1.25; white-space: nowrap; }
    .badge::before { width: 5px; height: 5px; flex: 0 0 auto; border-radius: 50%; background: currentColor; content: ""; }
    .badge.running, .badge.reviewing, .badge.starting, .badge.probing, .badge.validating, .badge.live { color: var(--accent); border-color: var(--accent-border); background: var(--accent-soft); }
    .badge.passed, .badge.pass, .badge.completed, .badge.complete, .badge.no_findings, .badge.clear, .badge.no_gate_findings, .badge.ready, .badge.present { color: var(--green); border-color: var(--positive-border); background: var(--green-dim); }
    .badge.findings, .badge.fail, .badge.failed, .badge.inconclusive, .badge.cancelled, .badge.queued, .badge.pending { color: var(--amber); border-color: var(--warning-border); background: var(--amber-dim); }
    .badge.incomplete, .badge.error, .badge.gate_findings, .badge.high, .badge.critical, .badge.blocking, .badge.missing { color: var(--red); border-color: var(--negative-border); background: var(--red-dim); }
    .badge.medium { color: var(--amber); border-color: var(--warning-border); background: var(--amber-dim); }
    .badge.low { color: var(--muted); }
    .badge.adjudication { color: var(--violet); border-color: var(--violet-border); background: var(--violet-soft); }
    .pill-list { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
    .pill { padding: 3px 7px; border: 1px solid var(--line); border-radius: 4px; color: var(--muted); background: var(--panel-2); font-size: 12px; }
    .truth-state { display: inline-flex; align-items: center; gap: 6px; }
    .truth-state::before { width: 6px; height: 6px; border-radius: 50%; background: var(--muted); content: ""; }
    .truth-state.present::before, .truth-state.available::before, .truth-state.enabled::before { background: var(--green); }
    .truth-state.missing::before, .truth-state.unavailable::before, .truth-state.disabled::before { background: var(--red); }

    .timeline-milestones { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); min-width: 0; min-height: 82px; margin: 10px 0 16px; padding: 0; list-style: none; }
    .milestone { position: relative; display: flex; flex-direction: column; align-items: center; gap: 8px; min-width: 0; color: var(--muted); text-align: center; }
    .milestone:not(:last-child)::after { position: absolute; top: 17px; left: calc(50% + 18px); width: calc(100% - 36px); height: 2px; background: var(--milestone-pending); content: ""; }
    .milestone.is-complete:not(:last-child)::after { background: var(--milestone-complete); }
    .milestone-circle { position: relative; z-index: 1; display: grid; place-items: center; width: 36px; height: 36px; flex: 0 0 auto; border: 2px solid var(--border-strong); border-radius: 50%; color: var(--muted); background: var(--bg); font-size: 13px; }
    .milestone-circle .icon { width: 19px; height: 19px; }
    .milestone.is-complete .milestone-circle { border-color: var(--milestone-complete); color: var(--on-status); background: var(--milestone-complete); }
    .milestone.is-current .milestone-circle { border: 3px solid var(--accent); color: var(--accent); }
    .milestone.is-current .milestone-circle:empty::after { width: 10px; height: 10px; border-radius: 50%; background: currentColor; content: ""; }
    .milestone.is-current .milestone-label { color: var(--accent); }
    .milestone-label { max-width: 100%; font-size: 14px; line-height: 1.35; overflow-wrap: anywhere; }
    .milestone-time { margin-top: -4px; color: var(--muted); font-family: var(--font-mono); font-size: 11px; line-height: 1.3; }
    .timeline-milestones.is-finished .milestone.is-complete .milestone-circle { border-color: var(--green); background: var(--green); }
    .timeline-milestones.is-finished .milestone.is-complete::after { background: var(--phase-complete); }
    .timeline-milestones.is-compact { min-height: 66px; margin: 0; }
    .timeline-milestones.is-compact .milestone-circle { width: 28px; height: 28px; }
    .timeline-milestones.is-compact .milestone:not(:last-child)::after { top: 13px; left: calc(50% + 14px); width: calc(100% - 28px); }
    .timeline-milestones.is-compact .milestone-label { font-size: 12px; }

    .run-header { min-width: 0; margin-bottom: 4px; }
    .run-header .view-heading { flex-direction: row; align-items: flex-start; gap: 12px; margin-bottom: 6px; }
    .run-header .view-heading h1 { font-size: 22px; line-height: 1.2; letter-spacing: -.025em; }
    .run-header .view-heading p { gap: 5px; margin-top: 3px; font-size: 12px; }
    .run-header .heading-actions { flex: 0 0 auto; width: auto; padding-top: 2px; }
    .run-header .timeline-milestones { min-height: 42px; margin: 0; }
    .run-header .milestone { gap: 4px; }
    .run-header .milestone-circle { width: 22px; height: 22px; border-width: 1px; font-size: 11px; line-height: 1; }
    .run-header .milestone-circle .icon { width: 12px; height: 12px; }
    .run-header .milestone:not(:last-child)::after { top: 10px; left: calc(50% + 11px); width: calc(100% - 22px); }
    .run-header .milestone.is-current .milestone-circle { border-width: 2px; }
    .run-header .milestone.is-current .milestone-label { font-weight: 600; }
    .run-header .milestone-label { padding: 0 2px; font-size: 11px; line-height: 1.3; }
    .run-header .milestone-time { display: none; }

    .live-reviews, .live-run-list { display: grid; gap: 10px; }
    .active-runs { display: grid; gap: 0; }
    .active-run-card { display: grid; grid-template-columns: minmax(180px, .75fr) minmax(0, 1.7fr); gap: 0 20px; min-width: 0; padding: 15px 16px; border-bottom: 1px solid var(--line); }
    .active-run-card:last-child { border-bottom: 0; }
    .active-run-head { display: flex; flex-direction: column; justify-content: space-between; gap: 8px; min-width: 0; grid-row: span 2; }
    .active-run-head h3 { margin: 0; color: var(--text); font-size: 16px; font-weight: 500; line-height: 1.4; }
    .active-run-head h3 a { color: inherit; text-decoration: none; overflow-wrap: anywhere; }
    .active-run-head h3 a:hover { color: var(--accent); }
    .active-run-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 12px; color: var(--muted); font-size: 12px; }
    .run-summary { margin-top: 4px; color: var(--muted); font-size: 12px; }
    .text-link { display: inline-flex; align-items: center; gap: 6px; min-height: var(--control-size); color: var(--accent); font-size: 13px; text-decoration: none; }
    .text-link:hover { color: var(--text); text-decoration: underline; }
    .live-reviewer-pills { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-top: 4px; }
    .live-reviewer-pills .row-button { flex-direction: row; align-items: center; gap: 6px; min-height: var(--control-size); padding: 5px 8px; border: 1px solid var(--line); border-radius: 4px; color: var(--accent); background: var(--accent-soft); font-size: 12px; }
    .status-dot { width: 6px; height: 6px; flex: 0 0 auto; border-radius: 50%; background: currentColor; }
    .run-card { overflow: hidden; }
    .run-card-top, .live-run-card { display: grid; grid-template-columns: minmax(190px, .8fr) minmax(0, 2fr); align-items: center; gap: 24px; padding: 14px 16px; }
    .run-identity { min-width: 0; }
    .run-title-row { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; min-width: 0; }
    .run-link { color: var(--text); font-size: 16px; font-weight: 500; text-decoration: none; overflow-wrap: anywhere; }
    .run-link:hover { color: var(--accent); }
    .run-id { margin-top: 4px; color: var(--muted); font-family: var(--font-mono); font-size: 12px; overflow-wrap: anywhere; }
    .run-context { display: flex; flex-wrap: wrap; gap: 3px 10px; margin-top: 6px; color: var(--muted); font-size: 12px; }
    .run-stats { display: flex; flex-wrap: wrap; gap: 10px; color: var(--muted); font-size: 12px; }
    .mini-stat { display: flex; align-items: center; gap: 8px; }
    .mini-stat strong { color: var(--text); font-weight: 500; }
    .reviewer-strip { display: flex; flex-wrap: wrap; gap: 8px; padding: 0 16px 12px; }
    .reviewer-chip { min-height: var(--control-size); display: inline-flex; align-items: center; gap: 7px; max-width: 100%; padding: 7px 9px; border: 1px solid var(--line); border-radius: 4px; color: var(--muted); background: var(--panel-2); font-size: 12px; }
    .reviewer-chip:hover { color: var(--text); border-color: var(--line-strong); }
    .reviewer-chip-state { width: 6px; height: 6px; flex: 0 0 auto; border-radius: 50%; background: var(--muted); }
    .reviewer-chip-state.running, .reviewer-chip-state.reviewing, .reviewer-chip-state.probing, .reviewer-chip-state.validating { background: var(--accent); }
    .reviewer-chip-state.completed, .reviewer-chip-state.passed, .reviewer-chip-state.pass { background: var(--green); }
    .reviewer-chip-state.findings, .reviewer-chip-state.fail, .reviewer-chip-state.queued { background: var(--amber); }
    .reviewer-chip-state.incomplete { background: var(--red); }
    .reviewer-button { min-height: var(--control-size); min-width: 0; padding: 6px 0; border: 0; color: var(--text); background: transparent; text-align: left; cursor: pointer; }
    .reviewer-button strong { display: block; font-size: 14px; font-weight: 500; }
    .reviewer-button span { display: block; margin-top: 3px; color: var(--muted); font-size: 12px; }
    .reviewer-button:hover strong { color: var(--accent); }
    .reviewer-lane td { padding-top: 0; padding-bottom: 0; }
    .reviewer-lane td:first-child { min-width: 220px; }
    .model-lane td { background: var(--nested-fill); color: var(--muted); font-size: 13px; }
    .model-lane td:first-child { padding-left: 30px; }
    .lens-identity { display: flex; align-items: center; gap: 2px; min-width: 0; }
    .lens-identity .row-button { flex: 1 1 auto; }
    .logical-lane .row-button { flex-direction: row; align-items: center; justify-content: flex-start; gap: 10px; }
    .logical-lane .row-button .secondary { font-size: 12px; }
    .expand-button { display: grid; place-items: center; width: var(--control-size); height: var(--control-size); flex: 0 0 auto; margin-left: -8px; border: 0; border-radius: var(--radius-sm); color: var(--muted); background: transparent; font-size: 22px; }
    .expand-button:hover { color: var(--text); background: var(--hover-fill); }
    .model-lane .row-button { flex-direction: row; align-items: center; gap: 8px; }
    .model-index { display: inline-grid; place-items: center; width: 22px; height: 22px; flex: 0 0 auto; border: 1px solid var(--line-strong); border-radius: 50%; color: var(--muted); background: var(--panel); font-size: 11px; }
    .phase-cell { width: 60%; }
    .phase-track, .phase-headings { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); min-width: 510px; }
    .phase-headings { color: var(--muted); font-size: 12px; text-align: center; }
    .phase-track { min-height: 44px; align-items: center; }
    .phase-marker { position: relative; display: flex; align-items: center; justify-content: center; gap: 4px; min-width: 0; min-height: 32px; color: var(--muted); }
    .phase-marker:not(:last-child)::after { position: absolute; top: 15px; left: 50%; width: 100%; height: 2px; background: var(--phase-track); content: ""; }
    .phase-marker.is-complete:not(:last-child)::after { background: var(--phase-complete); }
    .phase-circle { position: relative; z-index: 1; display: grid; place-items: center; width: 10px; height: 10px; flex: 0 0 auto; border: 1px solid var(--border-strong); border-radius: 50%; color: var(--bg); background: var(--panel); font-size: 8px; }
    .phase-circle .icon { width: 8px; height: 8px; }
    .phase-marker.is-complete .phase-circle { color: var(--on-status); border-color: var(--phase-complete); background: var(--phase-complete); }
    .phase-marker.is-current .phase-circle { border-color: var(--accent); color: var(--on-status); background: var(--accent); }
    .phase-marker.is-current.phase-queued .phase-circle, .phase-marker.is-current.phase-runtime .phase-circle, .phase-marker.is-current.phase-probing .phase-circle, .phase-marker.is-current.phase-validating .phase-circle { border-color: var(--amber); background: var(--amber); }
    .phase-marker.is-current.phase-finished .phase-circle { border-color: var(--green); background: var(--green); }
    .phase-label { position: relative; z-index: 1; padding: 2px 3px; color: var(--muted); background: var(--panel); font-size: 11px; line-height: 1.2; white-space: nowrap; }
    .phase-marker.is-current .phase-label { color: var(--accent); }
    .phase-marker.is-current.phase-queued .phase-label, .phase-marker.is-current.phase-runtime .phase-label, .phase-marker.is-current.phase-probing .phase-label, .phase-marker.is-current.phase-validating .phase-label { color: var(--amber); }
    .phase-marker.is-current.phase-finished .phase-label { color: var(--green); }
    .phase-marker:not(.is-current) .phase-label { display: none; }
    .is-selected .phase-label, .is-selected .phase-circle { background: var(--surface-selected); }
    .is-selected .phase-marker.is-current .phase-circle { background: var(--accent); }
    .is-selected .phase-marker.is-complete .phase-circle { background: var(--phase-complete); }
    .reviewer-lane[data-state="incomplete"] .phase-marker.is-current .phase-circle, .reviewer-lane[data-state="failed"] .phase-marker.is-current .phase-circle, .reviewer-lane[data-state="error"] .phase-marker.is-current .phase-circle { border-color: var(--red); background: var(--red); }
    .reviewer-lane[data-state="incomplete"] .phase-marker.is-current .phase-label, .reviewer-lane[data-state="failed"] .phase-marker.is-current .phase-label, .reviewer-lane[data-state="error"] .phase-marker.is-current .phase-label { color: var(--red); }
    .reviewer-lane[data-state="findings"] .phase-marker.is-current .phase-circle, .reviewer-lane[data-state="cancelled"] .phase-marker.is-current .phase-circle { border-color: var(--amber); background: var(--amber); }
    .reviewer-lane[data-state="findings"] .phase-marker.is-current .phase-label, .reviewer-lane[data-state="cancelled"] .phase-marker.is-current .phase-label { color: var(--amber); }
    .reviewer-lane[data-state="skipped"] .phase-marker.is-current .phase-circle { border-color: var(--muted); background: var(--muted); }
    .reviewer-lane[data-state="skipped"] .phase-marker.is-current .phase-label { color: var(--muted); }

    .tabs { display: flex; gap: 8px; min-width: 0; margin: 10px 0 14px; overflow-x: auto; border-bottom: 1px solid var(--line); scrollbar-width: thin; }
    .tab { position: relative; min-height: var(--control-size); flex: 0 0 auto; display: inline-flex; align-items: center; justify-content: center; gap: 6px; padding: 8px 10px; border: 0; color: var(--muted); background: transparent; font-size: 14px; font-weight: 400; text-decoration: none; cursor: pointer; transition: color var(--motion-fast), background var(--motion-fast); }
    .tab:hover { color: var(--text); background: var(--subtle-fill); }
    .tab[aria-selected="true"], .tab.is-active { color: var(--text); }
    .tab[aria-selected="true"]::after, .tab.is-active::after { position: absolute; right: 9px; bottom: 0; left: 9px; height: 2px; background: var(--accent); content: ""; }
    .run-tabs { margin: 0 0 12px; }
    .tab-count { min-width: 18px; padding: 0 5px; border-radius: 4px; color: var(--muted); background: var(--panel-2); font-size: 11px; text-align: center; }
    .dock-panel { position: relative; display: flex; flex: 0 0 auto; flex-direction: column; min-width: 0; min-height: 160px; max-height: calc(100% - 164px); margin: 0 28px 24px; border: 1px solid var(--line); border-radius: var(--radius); background: var(--bg); overflow: hidden; }
    .dock-resizer { display: flex; flex: 0 0 12px; align-items: center; justify-content: center; min-height: 12px; cursor: ns-resize; touch-action: none; }
    .dock-resizer::before { width: 44px; height: 3px; border-radius: 2px; background: var(--line-strong); content: ""; }
    .dock-resizer:hover::before, .dock-resizer:focus-visible::before { background: var(--accent); }
    .dock-resizer:focus-visible { outline-offset: -2px; }
    .dock-header { display: flex; flex: 0 0 auto; align-items: center; justify-content: space-between; gap: 12px; min-height: 38px; padding: 0 14px; }
    .dock-header > div { min-width: 0; }
    .dock-title { display: block; margin: 0; font-size: 18px; font-weight: 600; line-height: 1.3; overflow-wrap: anywhere; }
    .dock-subtitle { margin: 3px 0 0; color: var(--muted); font-size: 12px; overflow-wrap: anywhere; }
    .dock-header .icon-button { margin-right: -8px; border-color: transparent; background: transparent; }
    .dock-tabs { flex: 0 0 auto; gap: 6px; margin: 0 14px; }
    .dock-tabs .tab { font-size: 14px; }
    .dock-content { flex: 1 1 auto; min-height: 0; min-width: 0; padding: 12px 14px 14px; overflow: auto; overscroll-behavior: contain; scrollbar-width: thin; }
    .inspector-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(240px, .46fr); gap: 20px; min-width: 0; align-items: start; }
    .inspector-grid > :nth-child(2) { padding-left: 18px; border-left: 1px solid var(--line); }
    .inspector-section { min-width: 0; }
    .inspector-section h3 { margin: 0 0 10px; color: var(--text); font-size: 14px; font-weight: 500; }
    .inspector-section + .inspector-section { margin-top: 14px; }
    .inspector-grid > .inspector-section + .inspector-section { margin-top: 0; }
    .inspector-section p { margin: 7px 0; color: var(--muted); overflow-wrap: anywhere; }
    .definition-list { display: grid; grid-template-columns: minmax(90px, auto) minmax(0, 1fr); gap: 7px 14px; margin: 0; font-size: 13px; line-height: 1.4; }
    .definition-list dt { color: var(--muted); }
    .definition-list dd { min-width: 0; margin: 0; color: var(--text); overflow-wrap: anywhere; }
    .activity-list { display: grid; gap: 9px; margin: 0; padding: 0; list-style: none; }
    .activity-item { display: flex; align-items: flex-start; gap: 10px; color: var(--text); font-family: var(--font-mono); font-size: 13px; line-height: 1.5; overflow-wrap: anywhere; }
    .activity-item time { flex: 0 0 auto; color: var(--muted); }
    .activity-time { flex: 0 0 auto; color: var(--muted); }
    .activity-summary { min-width: 0; overflow-wrap: anywhere; }
    .activity-item > :last-child { min-width: 0; }
    .empty-inspector { display: grid; place-content: center; gap: 5px; min-height: 90px; color: var(--muted); text-align: center; }
    .empty-inspector strong { color: var(--text); font-size: 15px; font-weight: 500; }
    .summary-copy { color: var(--muted); font-size: 14px; line-height: 1.6; white-space: pre-wrap; overflow-wrap: anywhere; }
    .review-markdown { overflow-wrap: anywhere; color: var(--muted); font-family: inherit; font-size: 14px; line-height: 1.6; white-space: pre-wrap; }
    pre { max-width: 100%; margin: 0; padding: 12px; overflow: auto; border: 1px solid var(--line); border-radius: var(--radius-sm); color: var(--code-text); background: var(--panel); font: 12px/1.6 var(--font-mono); tab-size: 2; white-space: pre-wrap; overflow-wrap: anywhere; }
    .evidence { min-width: 0; margin-top: 10px; padding: 12px; border: 1px solid var(--line); border-radius: var(--radius-sm); background: var(--panel); }
    .evidence-path { color: var(--accent); font-family: var(--font-mono); font-size: 12px; overflow-wrap: anywhere; }
    details.raw { margin-top: 8px; }
    details.raw summary { display: flex; align-items: center; min-height: var(--control-size); color: var(--muted); font-size: 13px; }
    details.raw[open] summary { margin-bottom: 6px; }
    .notice, .outcome-banner { display: flex; align-items: center; flex-wrap: wrap; justify-content: space-between; gap: 10px; margin: 0 0 14px; padding: 12px 14px; border: 1px solid var(--accent-border); border-radius: var(--radius-sm); color: var(--text); background: var(--accent-soft); font-size: 13px; line-height: 1.5; }
    .notice strong { color: var(--accent); }
    .outcome-banner.gate_findings, .outcome-banner.is-negative { border-color: var(--negative-border); background: var(--negative-soft); }
    .outcome-banner.gate_findings strong, .outcome-banner.is-negative strong { color: var(--red); }
    .outcome-banner.no_gate_findings, .outcome-banner.is-positive { border-color: var(--positive-border); background: var(--positive-soft); }
    .outcome-banner.no_gate_findings strong, .outcome-banner.is-positive strong { color: var(--green); }
    .outcome-strip { display: flex; align-items: center; flex-wrap: wrap; justify-content: space-between; gap: 8px 16px; margin-bottom: 14px; padding: 12px 14px; border: 1px solid var(--line); border-radius: var(--radius-sm); background: var(--panel); font-size: 13px; }
    .outcome-strip > div { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
    .outcome-strip:has(.gate_findings) { border-color: var(--negative-border); background: var(--negative-soft); }
    .outcome-strip:has(.no_gate_findings) { border-color: var(--positive-border); background: var(--positive-soft); }
    .outcome-strip .secondary { margin-top: 0; }
    .finding-title { margin: 0; color: var(--text); font-size: 15px; font-weight: 500; line-height: 1.45; }
    .finding-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 8px; color: var(--muted); font-size: 12px; }
    .finding-list { display: grid; gap: 10px; }
    .finding { min-width: 0; padding: 14px; border: 1px solid var(--line); border-left: 3px solid var(--amber); border-radius: var(--radius-sm); background: var(--panel); }
    .finding[data-severity="critical"], .finding[data-severity="high"] { border-left-color: var(--red); }
    .finding-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; }
    .finding p { margin: 7px 0 0; color: var(--muted); font-size: 13px; white-space: pre-wrap; overflow-wrap: anywhere; }
    .location-cell { max-width: 260px; font-size: 12px; }
    .findings-table td:nth-child(2) { width: 32%; }
    .event-table-wrap { max-height: 480px; }
    .event-child td { color: var(--muted); background: var(--nested-fill); }
    .event-child td:nth-child(3) { padding-left: 28px; }
    .heartbeat-group { background: var(--subtle-fill); }
    .heartbeat-group .row-button { color: var(--muted); }
    .events-table td:last-child { width: 42%; }
    .side-card { padding: 13px; }
    .drawer-section { margin-top: 14px; }
    .drawer-section:first-child { margin-top: 0; }
    .drawer-section h3 { margin: 0 0 9px; font-size: 14px; font-weight: 500; }
    .timeline { padding: 0 12px; }
    .timeline-row { position: relative; display: grid; grid-template-columns: 76px 10px minmax(0, 1fr); gap: 10px; min-width: 0; }
    .timeline-row:not(:last-child)::after { position: absolute; top: 22px; bottom: -3px; left: 90px; width: 1px; background: var(--line); content: ""; }
    .timeline-time { padding-top: 12px; color: var(--muted); font-family: var(--font-mono); font-size: 11px; }
    .timeline-dot { position: relative; z-index: 1; width: 8px; height: 8px; margin-top: 17px; border-radius: 50%; background: var(--muted); }
    .timeline-dot.active { background: var(--accent); }
    .timeline-dot.good { background: var(--green); }
    .timeline-dot.warn { background: var(--amber); }
    .timeline-dot.bad { background: var(--red); }
    .timeline-body { min-width: 0; padding: 10px 0 12px; }
    .timeline-body strong { display: block; font-size: 13px; font-weight: 500; }
    .timeline-body p { margin: 3px 0 0; color: var(--muted); font-size: 12px; }
    .timeline-meta { display: flex; flex-wrap: wrap; gap: 5px 10px; margin-top: 6px; color: var(--muted); font-family: var(--font-mono); font-size: 11px; }

    .model-chain { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; min-width: 0; }
    .model-token { display: inline-flex; align-items: center; gap: 6px; min-width: 0; color: var(--text); font-size: 12px; }
    .model-token strong { display: block; font-weight: 400; overflow-wrap: anywhere; }
    .model-token small { display: block; margin-top: 2px; color: var(--muted); font-size: 10px; overflow-wrap: anywhere; }
    .model-token > span:first-child, .chain-index { display: inline-grid; place-items: center; width: 22px; height: 22px; flex: 0 0 auto; border: 1px solid var(--line-strong); border-radius: 50%; color: var(--muted); background: var(--panel); font-size: 11px; font-variant-numeric: tabular-nums; }
    .chain-arrow { color: var(--muted); font-size: 12px; }
    .model-token.is-active .chain-index, .model-token.is-active > span:first-child { color: var(--accent); border-color: var(--accent); }
    .chain { display: grid; gap: 10px; }
    .chain-row { display: grid; grid-template-columns: 24px minmax(0, 1fr) auto; gap: 10px; align-items: start; }
    .chain-main { min-width: 0; }
    .chain-main strong { display: block; font-size: 14px; font-weight: 500; }
    .chain-main span { display: block; margin-top: 3px; color: var(--muted); font-family: var(--font-mono); font-size: 12px; overflow-wrap: anywhere; }
    .system-columns, .system-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 28px; }
    .system-policy-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 24px; margin-bottom: 16px; }
    .system-policy-grid > .panel + .panel { margin-top: 0; }
    .system-layout { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 28px; }
    .system-column { min-width: 0; }
    .system-layout .data-table { min-width: 0; }
    .system-layout .system-policy-grid { display: flex; flex-direction: column; gap: 20px; }
    .system-layout .system-policy-grid .panel { border: 0; background: transparent; }
    .system-layout .system-policy-grid .panel-header { min-height: 36px; padding: 0 0 10px; background: transparent; }
    .system-layout .system-policy-grid .panel-header h2 { font-size: 18px; }
    .system-layout .system-policy-grid .panel-body { padding: 12px 0; }
    .system-column > .panel + .panel { margin-top: 22px; }
    .system-column:first-child > .panel { border: 0; background: transparent; }
    .system-column:first-child > .panel > .panel-header { min-height: 36px; padding: 0 0 10px; border-radius: 0; background: transparent; }
    .system-column:first-child > .panel > .panel-header h2 { font-size: 18px; }
    .system-column:first-child > .panel > .panel-body { padding: 12px 0; }
    .system-status-bar { display: flex; align-items: center; flex-wrap: wrap; justify-content: space-between; gap: 10px 20px; margin-bottom: 18px; padding: 12px 16px; border: 1px solid var(--line); border-radius: var(--radius); background: var(--panel); color: var(--muted); font-size: 12px; }
    .system-status-bar > span { display: inline-flex; align-items: center; gap: 6px; }
    .system-status-bar strong { color: var(--text); font-weight: 400; }
    .system-version { margin-top: 14px; color: var(--muted); font-size: 12px; }
    .data-locations { display: grid; gap: 6px; }
    .location-row { display: grid; grid-template-columns: minmax(100px, auto) minmax(0, 1fr) 44px; align-items: center; gap: 10px; color: var(--muted); font-size: 12px; }
    .location-row code { padding: 6px 8px; border: 1px solid var(--line); border-radius: 4px; font-family: var(--font-mono); font-size: 11px; color: var(--text); overflow-wrap: anywhere; }
    .copy-button { border-color: transparent; background: transparent; }
    .credential-list { display: grid; gap: 9px; }
    .credential-list > div { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px; font-size: 12px; }
    .assigned-reviewers { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
    .assigned-reviewer { display: flex; flex-direction: column; justify-content: center; min-height: var(--control-size); gap: 3px; padding: 10px 12px; border: 1px solid var(--line); border-radius: var(--radius-sm); color: var(--text); background: var(--panel); text-decoration: none; }
    .assigned-reviewer:hover { border-color: var(--line-strong); color: var(--accent); }
    .assigned-reviewer strong { font-size: 13px; font-weight: 500; }
    .assigned-reviewer span { color: var(--muted); font-size: 12px; }
    .purpose-cell { max-width: 260px; color: var(--muted); font-size: 13px; }
    .catalog-table td:nth-child(3) { width: 41%; }
    .projects-table td:first-child { width: 32%; }
    .system-status, .status-strip { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 10px 24px; margin-bottom: 18px; padding: 12px 16px; border: 1px solid var(--line); border-radius: var(--radius); background: var(--panel); color: var(--muted); font-size: 13px; }
    .config-section { margin-top: 18px; }
    .config-block { padding: 0; }
    .config-block h2 { margin: 0 0 12px; font-size: 18px; font-weight: 500; }
    .config-block + .config-block { margin-top: 22px; }
    .adapter-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
    .adapter-card { min-width: 0; padding: 12px; border: 1px solid var(--line); border-radius: var(--radius-sm); background: var(--panel); }
    .adapter-card-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .adapter-card-head strong { font-size: 14px; font-weight: 500; }
    .key-grid, .fact-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 1px; margin: 0; overflow: hidden; border: 1px solid var(--line); border-radius: var(--radius); background: var(--line); }
    .key-value, .fact { min-width: 0; padding: 12px; background: var(--panel); }
    .key-value span, .fact dt { display: block; color: var(--muted); font-size: 12px; }
    .key-value strong, .fact dd { display: block; margin: 5px 0 0; color: var(--text); font-size: 13px; font-weight: 500; overflow-wrap: anywhere; }
    .metric-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; margin-bottom: 18px; }
    .metric { min-width: 0; padding: 14px; border: 1px solid var(--line); border-radius: var(--radius); background: var(--panel); }
    .metric-label { color: var(--muted); font-size: 12px; }
    .metric-value { margin-top: 6px; overflow-wrap: anywhere; font-size: 28px; font-weight: 600; font-variant-numeric: tabular-nums; line-height: 1.15; letter-spacing: -.025em; }
    .metric-note { margin-top: 5px; color: var(--muted); font-size: 12px; overflow-wrap: anywhere; }
    .empty, .error-state { min-height: 150px; display: grid; place-items: center; padding: 24px; border: 1px solid var(--line); border-radius: var(--radius); color: var(--muted); background: var(--panel); text-align: center; }
    .empty-icon { display: grid; place-items: center; width: 40px; height: 40px; margin: 0 auto 12px; border: 1px solid var(--line); border-radius: var(--radius); color: var(--muted); background: var(--panel-2); }
    .empty strong, .error-state strong { display: block; margin-bottom: 6px; color: var(--text); font-size: 15px; font-weight: 500; }
    .empty span, .error-state span { display: block; max-width: 580px; font-size: 13px; line-height: 1.6; }
    .error-state { border-color: var(--negative-border); background: var(--negative-soft); }
    .skeleton { position: relative; overflow: hidden; height: 90px; border: 1px solid var(--line); border-radius: var(--radius); background: var(--panel); }
    .skeleton::after { position: absolute; inset: 0; background: linear-gradient(100deg, transparent 15%, var(--hover-fill) 45%, transparent 75%); content: ""; animation: shimmer 1.5s infinite ease-out; }
    @keyframes shimmer { from { transform: translateX(-100%); } to { transform: translateX(100%); } }
    .toast { position: fixed; right: 20px; bottom: 20px; z-index: 80; max-width: min(380px, calc(100vw - 32px)); padding: 12px 14px; border: 1px solid var(--line-strong); border-radius: var(--radius); color: var(--text); background: var(--panel-3); box-shadow: var(--shadow); font-size: 13px; visibility: hidden; opacity: 0; transition: opacity var(--motion-fast), visibility var(--motion-fast); }
    .toast.show { visibility: visible; opacity: 1; }

    @media (max-width: 1100px) {
      .view-scroll { padding-right: 20px; padding-left: 20px; }
      .topbar { padding-right: 20px; padding-left: 20px; }
      .dock-panel { margin-right: 20px; margin-left: 20px; }
      .run-card-top, .live-run-card { grid-template-columns: minmax(150px, .7fr) minmax(0, 1.3fr); gap: 14px; }
      .inspector-grid { grid-template-columns: minmax(0, 1fr) minmax(210px, .65fr); gap: 16px; }
      .system-columns, .system-grid { gap: 20px; }
      .system-layout { gap: 20px; }
    }
    @media (max-width: 820px) {
      .shell { grid-template-columns: minmax(0, 1fr); grid-template-rows: auto minmax(0, 1fr); }
      .sidebar { padding: 8px 12px; overflow: visible; border-right: 0; border-bottom: 1px solid var(--line); }
      .brand, .nav-label, .sidebar-foot { display: none; }
      .nav { grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; }
      .nav a { justify-content: center; gap: 7px; min-height: var(--control-size); padding: 8px 4px; font-size: 13px; }
      .topbar { flex-basis: 44px; padding-top: 0; }
      .view-heading h1, .page-head h1 { font-size: 30px; }
      .metric-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .dock-panel { max-height: calc(100% - 156px); margin-bottom: 16px; }
      .system-columns, .system-grid { grid-template-columns: minmax(0, 1fr); }
      .system-layout, .system-policy-grid { grid-template-columns: minmax(0, 1fr); }
      .system-status, .status-strip { justify-content: flex-start; }
      .heading-actions { justify-content: flex-start; }
    }
    @media (max-width: 620px) {
      .topbar { min-height: 52px; padding-right: 12px; padding-left: 12px; }
      .theme-option { width: var(--control-size); height: var(--control-size); }
      .theme-option .icon { width: 18px; height: 18px; }
      .crumbs { font-size: 12px; }
      .connection { padding: 4px 6px; font-size: 11px; }
      .freshness, .updated-at { display: none; }
      .view-scroll { padding: 6px 12px 12px; }
      .view-heading, .page-head { flex-direction: column; gap: 10px; margin-bottom: 14px; }
      .view-heading h1, .page-head h1 { font-size: 28px; }
      .view-heading p, .page-head p { font-size: 13px; }
      .heading-actions { width: 100%; }
      .filter-bar { gap: 8px; }
      .search-field { flex: 1 1 100%; width: 100%; }
      .filter-select { flex: 1 1 120px; min-width: 0; max-width: 100%; }
      .filter-label { flex: 1 1 120px; }
      .filter-label .filter-select { width: 100%; }
      .filter-toggle { flex: 1 1 auto; }
      .filter-result-count { margin-left: 0; }
      .timeline-milestones { min-height: 82px; margin-top: 12px; gap: 0; }
      .milestone { gap: 7px; }
      .milestone-circle { width: 28px; height: 28px; }
      .milestone:not(:last-child)::after { top: 13px; left: calc(50% + 14px); width: calc(100% - 28px); }
      .milestone-circle .icon { width: 15px; height: 15px; }
      .milestone-label { font-size: 11px; padding: 0 2px; }
      .milestone-time { font-size: 10px; }
      .run-card-top, .live-run-card { grid-template-columns: minmax(0, 1fr); gap: 16px; padding: 12px; }
      .active-run-card { grid-template-columns: minmax(0, 1fr); gap: 16px; padding: 12px; }
      .active-run-head { grid-row: auto; }
      .reviewer-strip { padding-right: 12px; padding-left: 12px; }
      .dock-panel { min-height: 160px; max-height: calc(100% - 152px); margin: 0 12px 12px; }
      .dock-header { padding: 0 11px; }
      .dock-title { font-size: 16px; }
      .dock-subtitle { font-size: 11px; }
      .dock-tabs { margin: 0 10px; gap: 3px; }
      .dock-tabs .tab { padding-right: 8px; padding-left: 8px; font-size: 13px; }
      .dock-content { padding: 11px; }
      .inspector-grid { grid-template-columns: minmax(0, 1fr); gap: 16px; }
      .inspector-grid > :nth-child(2) { padding-top: 12px; padding-left: 0; border-top: 1px solid var(--line); border-left: 0; }
      .definition-list { grid-template-columns: minmax(90px, .8fr) minmax(0, 1.2fr); font-size: 12px; gap: 7px 10px; }
      .activity-item { flex-wrap: wrap; gap: 4px 8px; font-size: 12px; }
      .adapter-grid { grid-template-columns: minmax(0, 1fr); }
      .assigned-reviewers { grid-template-columns: minmax(0, 1fr); }
      .location-row { grid-template-columns: minmax(0, 1fr) 44px; gap: 5px 8px; }
      .location-row > span { grid-column: 1 / -1; }
      .key-grid, .fact-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .panel-header { flex-wrap: wrap; gap: 8px; }
      #app > .stack, #app > .error-state, #app > .empty { margin-right: 12px; margin-left: 12px; }
    }
    @media (max-width: 480px) {
      .sidebar { padding: 6px 8px; }
      .nav { gap: 6px; }
      .nav a { flex-direction: column; gap: 3px; min-height: 50px; font-size: 11px; padding: 5px 2px; }
      .nav-glyph .icon { width: 17px; height: 17px; }
      .topbar { flex: 0 0 auto; align-items: stretch; flex-direction: column; gap: 0; padding-top: 4px; }
      .top-actions { justify-content: space-between; gap: 6px; }
      .crumbs { max-width: 100%; min-height: 24px; gap: 4px; }
      .connection { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
      .connection-label { overflow: hidden; text-overflow: ellipsis; }
      .metric-grid { grid-template-columns: 1fr; }
      .section-head { align-items: flex-start; flex-direction: column; gap: 6px; }
      .table-wrap { overflow: visible; border: 0; background: transparent; }
      .panel > .table-wrap { padding: 8px; background: var(--bg); }
      table, tbody { display: block; min-width: 0 !important; width: 100%; }
      thead { display: none; }
      tbody { display: grid; gap: 8px; }
      tbody tr { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); overflow: hidden; border: 1px solid var(--line); border-radius: var(--radius-sm); background: var(--panel); }
      tbody tr:hover { background: var(--panel-2); }
      tbody tr.is-selected { border-color: var(--selected-border); background: var(--surface-selected); }
      tbody tr.is-selected td, tbody tr.is-selected td:first-child, tbody tr.is-selected td:last-child { box-shadow: none; }
      td { display: grid; align-content: start; gap: 4px; min-width: 0; padding: 9px 10px; border-top: 1px solid var(--line); font-size: 13px; }
      td.secondary { display: grid; }
      tbody tr:first-child td { border-top: 1px solid var(--line); }
      td:first-child, tbody tr:first-child td:first-child { grid-column: 1 / -1; border-top: 0; }
      td::before { color: var(--muted); font-size: 11px; font-weight: 500; content: attr(data-label); }
      td:has(.row-button) { padding-top: 4px; padding-bottom: 4px; }
      .row-button { width: 100%; }
      .truncate { max-width: 100%; white-space: normal; overflow-wrap: anywhere; }
      .reviewer-lane td:first-child { min-width: 0; }
      .reviewer-lane td:has(.phase-track), .model-lane td:has(.phase-track) { grid-column: 1 / -1; padding-top: 8px; padding-bottom: 8px; }
      .phase-track { min-width: 0; width: 100%; min-height: 40px; }
      .phase-marker { min-height: 34px; flex-direction: column; gap: 4px; }
      .phase-marker:not(:last-child)::after { top: 6px; }
      .phase-label { padding: 0; background: transparent; font-size: 9px; white-space: normal; text-align: center; overflow-wrap: anywhere; }
      .phase-marker:not(.is-current) .phase-label { display: block; }
      .is-selected .phase-label { background: transparent; }
      .model-lane td:first-child { padding-left: 20px; }
      .model-chain { gap: 7px; }
      .model-token { font-size: 11px; }
      .phase-cell, .findings-table td:nth-child(2), .events-table td:last-child, .catalog-table td:nth-child(3), .projects-table td:first-child { width: auto; }
      .catalog-table td:nth-child(3), .findings-table td:nth-child(2), .events-table td:last-child { grid-column: 1 / -1; }
      .catalog-table .purpose-cell { grid-column: 1 / -1; }
      .purpose-cell, .location-cell { max-width: none; }
      .event-table-wrap { max-height: none; }
      .dock-resizer { flex-basis: 16px; min-height: 16px; }
      .dock-header { gap: 6px; }
      .dock-title { font-size: 15px; }
      .dock-tabs .tab { min-height: var(--control-size); }
      .key-grid, .fact-grid { grid-template-columns: minmax(0, 1fr); }
    }
    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after { scroll-behavior: auto !important; animation: none !important; transition: none !important; }
    }
    @media (forced-colors: active) {
      .theme-option[aria-pressed="true"] { border-color: Highlight; outline: 1px solid Highlight; outline-offset: -3px; }
      .milestone-circle, .phase-circle, .chain-index, .model-token > span:first-child { border-color: ButtonText; }
      .milestone.is-current .milestone-circle, .phase-marker.is-current .phase-circle, .is-selected { outline: 2px solid Highlight; }
      .milestone::after, .phase-marker::after, .dock-resizer::before { background: CanvasText; }
    }
`;
