export const dashboardClient = String.raw`
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
    var STAGES = ["Context", "Select reviewers", "Review", "Consolidate", "Finish"];
    var ACTIVE_STATES = ["running", "probing", "starting", "reviewing", "validating"];
    var TERMINAL_STATES = ["passed", "findings", "incomplete", "completed", "skipped", "failed", "clear", "gate_findings", "inconclusive", "cancelled"];
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
      eventSource: null,
      pollTimer: null,
      streamRetryTimer: null,
      refreshTimer: null,
      connection: "connecting",
      route: null,
      requestGeneration: 0,
      lastFocusedKey: null
    };

    var app = document.getElementById("app");
    var crumbs = document.getElementById("crumbs");
    var connection = document.getElementById("connection");
    var refreshButton = document.getElementById("refresh-button");
    var toast = document.getElementById("toast");
    var themeOptions = Array.from(document.querySelectorAll('[data-theme-option]'));
    var themePreference = "system";
    var themeMedia = typeof window.matchMedia === "function" ? window.matchMedia("(prefers-color-scheme: dark)") : null;
    try {
      var storedTheme = window.localStorage.getItem("review-mesh.theme");
      if (["dark", "light", "system"].indexOf(storedTheme) >= 0) themePreference = storedTheme;
    } catch (_) {}
    function applyTheme() {
      var theme = themePreference === "system" ? themeMedia && themeMedia.matches ? "dark" : "light" : themePreference;
      document.documentElement.dataset.theme = theme;
      document.documentElement.dataset.themePreference = themePreference;
      document.documentElement.style.colorScheme = theme;
      var meta = document.querySelector('meta[name="theme-color"]');
      if (meta) meta.setAttribute("content", theme === "dark" ? "#14181D" : "#F4F6F8");
      themeOptions.forEach(function (button) {
        button.setAttribute('aria-pressed', String(button.getAttribute('data-theme-option') === themePreference));
      });
    }
    applyTheme();
    themeOptions.forEach(function (button) {
      button.addEventListener('click', function () {
        themePreference = button.getAttribute('data-theme-option');
        try { window.localStorage.setItem("review-mesh.theme", themePreference); } catch (_) {}
        applyTheme();
      });
    });
    if (themeMedia) {
      var onThemeChange = function () { if (themePreference === "system") applyTheme(); };
      if (themeMedia.addEventListener) themeMedia.addEventListener("change", onThemeChange);
      else if (themeMedia.addListener) themeMedia.addListener(onThemeChange);
    }

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
      if (run.stale === true || run.status === "stale") return "stale";
      if (run.active === true) return text(firstDefined(run.stage, run.phase, run.status), "running").toLowerCase();
      return text(firstDefined(run.run_outcome, run.status, run.outcome, run.state, run.gate_outcome), "unknown").toLowerCase();
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
      if (direct === "completed" && (verdict === "pass" || verdict === "clear")) return "passed";
      return direct;
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
      var direct = number(firstDefined(source.atomic_subfindings, get(source, ["canonical", "counts", "atomic_subfindings"]), source.unique_findings, source.findings_count, source.actionable_findings, get(source, ["counts", "findings"]), get(source, ["result", "actionable_findings_count"]), get(source, ["result", "actionable_findings"]))) ;
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
      return '<span class="badge ' + status + '">' + escapeHtml(label || displayName(value)) + "</span>";
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
      return firstDefined(run && run.started_at, run && run.created_at, get(run, ["summary", "deadline", "started_at"]), get(run, ["deadline", "started_at"]), get(run, ["timestamps", "started_at"]), run && run.timestamp);
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

    function findingsOf(detail) {
      if (!isObject(detail)) return [];
      if (Array.isArray(get(detail, ["canonical", "atomics"]))) return detail.canonical.atomics;
      var direct = firstDefined(get(detail, ["findings", "consolidated"]), get(detail, ["findings", "raw"]), Array.isArray(detail.findings) ? detail.findings : undefined, detail.actionable_findings, get(detail, ["result", "actionable_findings"]));
      var collected = array(direct).filter(isObject).slice();
      if (collected.length) return collected;
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
      }).join("") + (finding.gate_eligibility ? '<p><strong>Gate eligibility:</strong> ' + (finding.gate_eligibility.eligible ? "Eligible" : escapeHtml(array(finding.gate_eligibility.reasons).join(", ").replace(/_/g, " "))) + "</p>" : "") + (finding.suggested_direction ? '<p><strong>Suggested direction:</strong> ' + escapeHtml(finding.suggested_direction) + "</p>" : "") + "</article>";
    }

    function renderDefinitionList(entries) {
      var filtered = entries.filter(function (entry) { return entry[1] !== undefined && entry[1] !== null && entry[1] !== ""; });
      if (!filtered.length) return '<div class="section-hint">No metadata recorded.</div>';
      return '<dl class="definition-list">' + filtered.map(function (entry) {
        var value = isObject(entry[1]) || Array.isArray(entry[1]) ? safeJson(entry[1]) : text(entry[1]);
        return '<dt>' + escapeHtml(entry[0]) + '</dt><dd title="' + escapeAttr(value) + '">' + escapeHtml(value) + "</dd>";
      }).join("") + "</dl>";
    }

    function modelRunsOf(agent) {
      var value = firstDefined(agent && agent.model_runs, agent && agent.models, agent && agent.runs, agent && agent.reviewers);
      var runs = namedList(value);
      if (!runs.length && (agent.model || agent.adapter)) runs = [{ id: agent.id || "primary", model: agent.model, adapter: agent.adapter, effort: agent.effort }];
      return runs;
    }

    function projectAgents(project) {
      var value = firstDefined(project && project.agents, project && project.agent_ids, project && project.reviewers, get(project, ["selection", "agents"]));
      if (Array.isArray(value)) return value.map(function (item) { return text(isObject(item) ? firstDefined(item.id, item.name) : item); }).filter(Boolean);
      return [];
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
      return '<h3>Recorded activity</h3>' + (events.length ? '<div class="activity-list">' + events.map(function (event) {
        return '<div class="activity-item"><time class="activity-time">' + escapeHtml(formatDate(eventTime(event), false)) + '</time><span class="activity-summary">' + escapeHtml(eventSummary(event)) + '</span></div>';
      }).join('') + '</div>' : summary ? '<p class="summary-copy">' + escapeHtml(summary) + '</p>' : '<p class="secondary">No persisted activity summaries are available for this reviewer.</p>') + '<p class="secondary activity-notice">Recorded activity summaries</p>';
    }

    function renderReviewerResult(detail) {
      var result = isObject(detail.result) ? detail.result : isObject(get(detail, ["terminal", "result"])) ? get(detail, ["terminal", "result"]) : {};
      var status = reviewerState(detail);
      var summary = text(firstDefined(result.summary, detail.summary, get(detail, ["failure", "message"]), get(detail, ["skipped", "reason"])), "No terminal summary recorded.");
      var findings = array(firstDefined(result.actionable_findings, detail.findings)).filter(isObject);
      var notes = array(result.informational_notes).filter(isObject);
      var reviewMarkdown = text(result.review_markdown);
      var html = '<section class="drawer-section"><h3>Terminal result</h3><div class="panel side-card"><div style="margin-bottom:10px">' + badge(firstDefined(result.verdict, status)) + '</div><div class="summary-copy">' + escapeHtml(summary) + "</div></div></section>";
      if (result.change_coverage) html += '<section class="drawer-section"><h3>Changed-file evidence</h3>' + renderDefinitionList([["Status", result.change_coverage.status], ["Proof", result.change_coverage.proof_kind], ["Inspected", result.change_coverage.inspected_count], ["Deficits", result.change_coverage.deficit_count]]) + '<div class="finding-list">' + array(detail.coverage).filter(function (entry) { return entry.relevant; }).map(function (entry) { return '<div class="panel side-card"><strong>' + escapeHtml(entry.path) + '</strong><p>' + escapeHtml(entry.snapshot_read + ' · ' + entry.diff_delivery + (entry.reason ? ' · ' + entry.reason : '')) + '</p></div>'; }).join("") + '</div></section>';
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
      var attemptSection = attempts.length ? '<section class="drawer-section"><h3>Attempts · ' + attempts.length + '</h3><div class="panel timeline">' + attempts.map(function (attempt) {
        var failure = isObject(attempt.failure) ? attempt.failure : {};
        var failed = Object.keys(failure).length > 0 || attempt.status === 'incomplete';
        return '<div class="timeline-row"><div class="timeline-time">#' + escapeHtml(firstDefined(attempt.attempt, "?")) + '</div><div class="timeline-dot ' + (failed ? 'bad' : attempt.status === 'running' ? 'active' : 'good') + '"></div><div class="timeline-body"><strong>' + escapeHtml(text(firstDefined(failure.reason, attempt.status, "recorded attempt")).replace(/_/g, " ")) + '</strong>' + (failure.message ? '<p>' + escapeHtml(failure.message) + '</p>' : '') + '<div class="timeline-meta"><span>' + escapeHtml(formatDuration(attempt.elapsed_ms)) + '</span><span>' + escapeHtml(formatDate(attempt.started_at, true)) + '</span></div></div></div>';
      }).join("") + "</div></section>" : "";
      return '<section class="drawer-section"><h3>Runtime metadata</h3><div class="panel side-card">' + renderDefinitionList(entries) + "</div></section>" + attemptSection + (diagnostics ? '<section class="drawer-section"><h3>Sanitized diagnostics</h3><pre>' + escapeHtml(safeJson(diagnostics)) + "</pre></section>" : "") + '<section class="drawer-section"><h3>API record</h3><details class="raw"><summary>Show sanitized reviewer payload</summary><pre>' + escapeHtml(safeJson(detail)) + "</pre></details></section>";
    }

    function showToast(message) {
      toast.textContent = message;
      toast.classList.add("show");
      window.setTimeout(function () { toast.classList.remove("show"); }, 2500);
    }

    function scheduleRefresh() {
      if (state.refreshPromise) { state.refreshQueued = true; return; }
      if (state.refreshTimer) return;
      state.refreshTimer = window.setTimeout(function () {
        state.refreshTimer = null;
        refreshSnapshot({ includeDetail: true });
      }, 120);
    }
    function scheduleRefreshRetry() {
      if (state.snapshotRetryTimer || state.pollTimer) return;
      state.snapshotRetryTimer = window.setTimeout(function () {
        state.snapshotRetryTimer = null;
        refreshSnapshot({ includeDetail: true });
      }, POLL_INTERVAL);
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


    // Selections are local view state. The observer has no mutation endpoints.
    Object.assign(state, {
      selectedRun: "", selectedFinding: "", selectedEvent: "", selectedAgent: "", selectedProject: "", selectedAdapter: "",
      inspectorTabs: {}, expandedLenses: {}, expandedHeartbeats: {}, filters: {},
      followLatest: true, inspectorHeight: (window.innerWidth || 1440) > 840 ? 320 : 284, reviewerGeneration: 0,
      reviewerKey: "", refreshPromise: null, refreshQueued: false, snapshotRetryTimer: null, pendingReviewerTab: "", runSort: "finished", runSortDirection: -1
    });
    try {
      var savedHeight = Number(window.sessionStorage.getItem("review-mesh.inspector-height"));
      if (savedHeight >= 160 && savedHeight <= 640) state.inspectorHeight = savedHeight;
    } catch (_) {}

    var PHASES = [
      ["queued", "Queued"], ["runtime", "Runtime check"], ["reviewing", "Reviewing"],
      ["validating", "Validating"], ["finalizing", "Finalizing"], ["finished", "Finished"]
    ];

    function displayName(value) {
      var raw = text(value, "Not recorded");
      var labels = { execute_lenses: "Review", resolve_context: "Context", resolve_suite: "Select reviewers", complete: "Complete", running: "In progress", full_review: "Full review", changes: "Changes", gate_findings: "Gate findings", not_applicable: "Not applicable", max_concurrency: "Concurrency limit", heartbeat_interval_ms: "Heartbeat interval", shutdown_grace_period_ms: "Shutdown grace period", retry_backoff: "Retry backoff" };
      var label = labels[raw] || raw.replace(/_/g, " ");
      return label.charAt(0).toUpperCase() + label.slice(1);
    }
    function configOf() { return firstDefined(get(state.snapshot, ["configuration"]), get(state.snapshot, ["config"]), {}); }
    function filterValue(key) { return text(state.filters[key]); }
    function matchesSearch(value, query) { return !query || text(value).toLowerCase().indexOf(query.toLowerCase()) >= 0; }
    function agentId(agent) { return text(firstDefined(agent && agent.id, agent && agent.agent_id, agent && agent.name)); }
    function projectId(project) { return text(firstDefined(project && project.name, project && project.project_name, project && project.id)); }
    function branchOf(run) { return text(firstDefined(get(run, ["context", "git", "branch"]), get(run, ["git", "branch"]), run && run.branch), "Branch not recorded"); }
    function scopeOf(run) { return text(firstDefined(run && run.scope, get(run, ["review_scope", "mode"]), get(run, ["context", "review_scope", "mode"]), get(run, ["request", "review_scope", "mode"])), "Not recorded"); }
    function selectButton(attribute, value, label, extra, focusSuffix) {
      return '<button type="button" class="row-button" ' + attribute + '="' + escapeAttr(value) + '" data-focus-key="' + escapeAttr(attribute + ":" + value + (focusSuffix || '')) + '"' + (extra || "") + '>' + label + '</button>';
    }
    function viewHeading(title, subtitle, actions) {
      return '<div class="view-heading"><div class="heading-copy"><h1>' + escapeHtml(title) + '</h1><p>' + escapeHtml(subtitle) + '</p></div>' + (actions ? '<div class="heading-actions">' + actions + '</div>' : "") + '</div>';
    }
    function searchField(key, label) {
      return '<label class="search-field"><span class="sr-only">' + escapeHtml(label) + '</span><svg class="icon" aria-hidden="true" viewBox="0 0 24 24"><circle cx="10.5" cy="10.5" r="6.5"></circle><path d="m16 16 5 5"></path></svg><input type="search" data-filter="' + escapeAttr(key) + '" data-focus-key="filter:' + escapeAttr(key) + '" aria-label="' + escapeAttr(label) + '" placeholder="' + escapeAttr(label) + '" value="' + escapeAttr(filterValue(key)) + '"></label>';
    }
    function selectFilter(key, label, values) {
      return '<label class="filter-label"><span class="sr-only">' + escapeHtml(label) + '</span><select class="filter-select" data-filter="' + escapeAttr(key) + '" data-focus-key="filter:' + escapeAttr(key) + '" aria-label="' + escapeAttr(label) + '"><option value="">' + escapeHtml(label) + '</option>' + Array.from(new Set(values.filter(Boolean))).sort().map(function (value) {
        return '<option value="' + escapeAttr(value) + '"' + (filterValue(key) === value ? ' selected' : '') + '>' + escapeHtml(displayName(value)) + '</option>';
      }).join("") + '</select></label>';
    }
    function panel(title, count, body, hint) {
      return '<section class="panel"><div class="panel-header"><h2>' + escapeHtml(title) + (count === undefined ? '' : ' <span class="section-count">' + escapeHtml(count) + '</span>') + '</h2>' + (hint ? '<span class="section-hint">' + hint + '</span>' : '') + '</div>' + body + '</section>';
    }
    function workspace(body, inspector) {
      return '<div class="workspace-view' + ((state.route || {}).runId ? ' run-workspace' : '') + '"><div class="view-scroll" data-scroll-key="view:' + escapeAttr((state.route || {}).view + ':' + text((state.route || {}).runId) + ':' + text((state.route || {}).tab)) + '">' + body + '</div>' + inspector + '</div>';
    }
    function inspectorTab(kind, fallback) { return text(state.inspectorTabs[kind], fallback); }
    function renderInspector(options) {
      var kind = options.kind || "selection";
      var tabs = array(options.tabs);
      var active = options.active || (tabs[0] && tabs[0][0]);
      var workspaceHeight = app.clientHeight || (window.innerHeight || 900) - 60;
      var maxHeight = Math.max(160, Math.min(640, workspaceHeight - ((window.innerWidth || 1440) <= 480 ? 152 : (window.innerWidth || 1440) <= 840 ? 156 : 164)));
      var height = Math.min(state.inspectorHeight, maxHeight);
      return '<aside class="dock-panel' + (options.empty ? ' is-empty' : '') + '" style="height:' + height + 'px" aria-label="' + escapeAttr(options.title || "Selection inspector") + '">' +
        '<div class="dock-resizer" role="separator" aria-orientation="horizontal" aria-label="Resize detail inspector" tabindex="0" aria-valuemin="160" aria-valuemax="' + maxHeight + '" aria-valuenow="' + height + '" data-focus-key="inspector-resizer"></div>' +
        '<div class="dock-header"><div><h2 class="dock-title">' + escapeHtml(options.title || "Selection inspector") + '</h2>' + (options.subtitle ? '<div class="dock-subtitle">' + escapeHtml(options.subtitle) + '</div>' : '') + '</div>' + (!options.empty ? '<button class="icon-button" type="button" data-close-inspector data-focus-key="close-inspector" aria-label="Clear selection and close details">' + icon("close") + '</button>' : '') + '</div>' +
        (tabs.length ? '<div class="dock-tabs tabs" role="tablist" aria-label="' + escapeAttr(options.title + " details") + '">' + tabs.map(function (tab) {
          return '<button type="button" id="inspector-tab-' + escapeAttr(kind + '-' + tab[0]) + '" class="tab" role="tab" data-inspector-tab="' + escapeAttr(tab[0]) + '" data-inspector-kind="' + escapeAttr(kind) + '" data-focus-key="inspector-tab:' + escapeAttr(kind + ':' + tab[0]) + '" aria-selected="' + (active === tab[0]) + '" tabindex="' + (active === tab[0] ? 0 : -1) + '" aria-controls="inspector-panel">' + escapeHtml(tab[1]) + '</button>';
        }).join("") + '</div>' : '') + '<div id="inspector-panel" class="dock-content" data-scroll-key="inspector:' + escapeAttr(kind + ':' + active + ':' + options.title) + '"' + (tabs.length ? ' role="tabpanel" aria-labelledby="inspector-tab-' + escapeAttr(kind + '-' + active) + '"' : '') + '>' + options.content + '</div></aside>';
    }
    function emptyInspector(message) {
      return renderInspector({ title: "Details", empty: true, content: '<div class="empty-inspector">' + icon("inbox") + '<p>' + escapeHtml(message) + '</p></div>' });
    }

    function phaseKey(value) {
      value = text(value).toLowerCase();
      if (/deferred|queued|waiting|pending/.test(value)) return "queued";
      if (/prob|runtime|starting|preflight|retry|backoff/.test(value)) return "runtime";
      if (/validat/.test(value)) return "validating";
      if (/finaliz|reporting|collecting/.test(value)) return "finalizing";
      if (/completed|passed|clear|findings|failed|incomplete|skipped|cancelled|finished|terminal/.test(value)) return "finished";
      if (/review|execut|running|inspect|continu/.test(value)) return "reviewing";
      return "";
    }
    function phaseLabel(reviewer) {
      var status = reviewerState(reviewer);
      if (status === "deferred") return "Waiting";
      if (/retry|backoff/.test(text(reviewer.phase))) return "Retry backoff";
      if (reviewer.phase === "continuing") return "Continuing review";
      if (status === "passed" || status === "clear") return "Clear";
      if (status === "completed") return "Completed";
      if (["findings", "incomplete", "failed", "skipped", "cancelled"].indexOf(status) >= 0) return displayName(status);
      var key = phaseKey(firstDefined(reviewer.phase, reviewer.state, reviewer.status));
      var phase = PHASES.find(function (entry) { return entry[0] === key; });
      return phase ? phase[1] : displayName(status);
    }
    function renderReviewerPhase(reviewer) {
      if (!isObject(reviewer)) reviewer = { state: reviewer };
      var key = phaseKey(firstDefined(reviewer.phase, reviewer.state, reviewer.status));
      var visited = new Set();
      var transitions = [];
      array(firstDefined(reviewer.phase_history, reviewer.activity)).forEach(function (event) {
        var observed = phaseKey(firstDefined(event.phase, get(event, ["data", "phase"]), eventName(event)));
        if (observed) { visited.add(observed); if (transitions[transitions.length - 1] !== observed) transitions.push(observed); }
      });
      var attempt = number(firstDefined(reviewer.attempt, get(reviewer, ["activity", "attempt"]))) || 1;
      var retryCount = Math.max(attempt - 1, array(reviewer.attempts).reduce(function (maximum, entry) { return Math.max(maximum, (number(entry.attempt) || 1) - 1); }, 0));
      var historyText = transitions.length ? "Observed phases: " + transitions.join(" → ") : "Only the recorded current phase is shown.";
      return '<div class="phase-track" aria-label="' + escapeAttr(phaseLabel(reviewer) + (retryCount ? ', retry ' + retryCount : '') + '. ' + historyText) + '" title="' + escapeAttr(historyText) + '">' + PHASES.map(function (phase) {
        var current = phase[0] === key;
        var seen = visited.has(phase[0]);
        return '<span class="phase-marker phase-' + phase[0] + ' ' + (current ? 'is-current' : seen ? 'is-complete' : 'is-pending') + '"><span class="phase-circle" aria-hidden="true"></span><span class="phase-label">' + escapeHtml(current ? phaseLabel(reviewer) : phase[1]) + (current && retryCount ? '<small class="retry-label">Retry ' + retryCount + '</small>' : '') + '</span></span>';
      }).join("") + '</div>';
    }
    function renderStageRail(run, compact) {
      var current = stageIndex(run);
      var terminal = !isActiveRun(run) && current === 4;
      var stageEvents = eventsOf(run);
      var observed = [false, false, false, false, terminal];
      var times = [undefined, undefined, undefined, undefined, firstDefined(run.finished_at, run.completed_at)];
      stageEvents.forEach(function (event) {
        var name = eventName(event);
        var index = /context\.resolved/.test(name) ? 0 : /suite\.resolved/.test(name) ? 1 : /^reviewer\.(started|activity|progress|completed|incomplete)/.test(name) ? 2 : /consolidat/.test(name) ? 3 : /run\.completed/.test(name) ? 4 : -1;
        if (index >= 0 && !times[index]) times[index] = eventTime(event);
        if (index >= 0 && (index !== 2 || /completed|incomplete/.test(name))) observed[index] = true;
      });
      var roster = reviewersOf(run), counts = runModelCounts(run);
      var hasRoster = roster.length > 0 || (number(counts.total) || 0) > 0;
      observed[0] = observed[0] || hasRoster || Boolean(runWorkspace(run) || get(run, ['context', 'review_scope']) || get(run, ['context', 'git', 'is_repository']) === true);
      observed[1] = observed[1] || hasRoster;
      observed[2] = observed[2] || roster.some(function (reviewer) { return ['completed', 'passed', 'findings', 'incomplete', 'failed'].indexOf(reviewerState(reviewer)) >= 0; }) || (number(counts.completed) || 0) + (number(counts.incomplete) || 0) > 0;
      observed[3] = observed[3] || isObject(run.canonical) || array(get(run, ['summary', 'lens_summaries'])).length > 0 || array(get(run, ['findings', 'consolidated'])).length > 0 || array(run.findings).length > 0;
      return '<div class="timeline-milestones' + (compact ? ' is-compact' : '') + (terminal ? ' is-finished' : '') + '" aria-label="Run stages">' + STAGES.map(function (name, index) {
        var complete = terminal ? observed[index] : index < current;
        var active = index === current && !complete;
        return '<div class="milestone ' + (complete ? 'is-complete' : active ? 'is-current' : 'is-pending') + '"' + (active ? ' aria-current="step"' : '') + (times[index] ? ' title="' + escapeAttr(name + ' · ' + formatDate(times[index], true)) + '"' : '') + ' aria-label="' + escapeAttr(name + ': ' + (complete ? 'complete' : active ? 'current' : terminal ? 'not recorded' : 'pending')) + '"><span class="milestone-circle" aria-hidden="true">' + (complete ? '✓' : index + 1) + '</span><span class="milestone-label">' + escapeHtml(name) + '</span>' + (!compact && times[index] ? '<span class="milestone-time">' + escapeHtml(formatDate(times[index], false)) + '</span>' : '') + '</div>';
      }).join("") + '</div>';
    }
    function logicalGroups(detail) {
      var groups = groupReviewers(reviewersOf(detail));
      return groups.map(function (entry) {
        var rows = entry[1].slice().sort(function (a, b) { return (number(a.configured_model_index) || 0) - (number(b.configured_model_index) || 0); });
        var active = rows.find(function (row) { return ACTIVE_STATES.indexOf(reviewerState(row)) >= 0; });
        var queued = rows.find(function (row) { return reviewerState(row) === "queued"; });
        var attempted = rows.filter(function (row) { return ["queued", "deferred", "waiting", "skipped"].indexOf(reviewerState(row)) < 0; });
        var current = active || queued || attempted[attempted.length - 1] || rows[0];
        var lens = array(detail && detail.lenses).find(function (item) { return text(firstDefined(item.lens_id, item.id)) === entry[0]; });
        var lensState = lens && text(firstDefined(lens.state, lens.status));
        var logical = lensState && ['completed', 'incomplete', 'skipped'].indexOf(lensState) >= 0 ? Object.assign({}, current, { state: lensState, status: lensState, phase: 'terminal', result: undefined, verdict: undefined, actionable_findings: undefined }) : current;
        return { id: entry[0], reviewers: rows, current: current, logical: logical };
      });
    }
    function logicalCounts(detail) {
      var recorded = detail && detail.logical_lenses;
      if (isObject(recorded)) return recorded;
      var groups = logicalGroups(detail);
      return { total: groups.length, running: groups.filter(function (g) { return ACTIVE_STATES.indexOf(reviewerState(g.current)) >= 0; }).length,
        queued: groups.filter(function (g) { return ["queued", "deferred", "waiting"].indexOf(reviewerState(g.current)) >= 0; }).length,
        completed: groups.filter(function (g) { return phaseKey(reviewerState(g.current)) === "finished"; }).length };
    }
    function reviewerTotals(run) {
      var counts = logicalCounts(run);
      return text(counts.total, "0") + ' reviewers · ' + text(counts.running, "0") + ' active · ' + text(firstDefined(counts.queued, counts.waiting), "0") + ' waiting · ' + text((number(counts.completed) || 0) + (number(counts.incomplete) || 0) + (number(counts.skipped) || 0), "0") + ' finished';
    }
    function coverageLabel(run) {
      var coverage = firstDefined(run && run.change_coverage, run && run.file_coverage, {});
      var required = number(firstDefined(coverage.required_count, coverage.required_files, get(coverage, ["counts", "required"])));
      var inspected = number(firstDefined(coverage.inspected_count, coverage.inspected_files, get(coverage, ["counts", "inspected"])));
      if (required !== undefined && inspected !== undefined && required > 0) return Math.round(inspected / required * 100) + "%";
      return displayName(firstDefined(coverage.status, run && run.coverage_outcome, "Not recorded"));
    }
    function renderActiveRun(run) {
      var id = runId(run);
      var liveRows = reviewersOf(run).filter(function (reviewer) { return ACTIVE_STATES.indexOf(reviewerState(reviewer)) >= 0; });
      return '<article class="active-run-card"><div class="active-run-head"><div><h3><a href="#/reviews/' + encodeURIComponent(id) + '">' + escapeHtml(runProject(run)) + '</a></h3><div class="secondary">' + escapeHtml(branchOf(run)) + '</div><div class="run-summary">' + escapeHtml(reviewerTotals(run)) + '</div></div><div class="active-run-actions"><span class="mono">Elapsed ' + escapeHtml(formatDuration(runElapsed(run))) + '</span><a class="text-link" href="#/reviews/' + encodeURIComponent(id) + '">View review ↗</a></div></div>' + renderStageRail(run, true) + (liveRows.length ? '<div class="live-reviewer-pills">' + liveRows.slice(0, 4).map(function (reviewer) {
        return selectButton('data-open-reviewer', reviewerId(reviewer), '<span class="status-dot"></span>' + escapeHtml(text(reviewer.lens_id, reviewerId(reviewer)) + ' · ' + phaseLabel(reviewer)), ' data-run-id="' + escapeAttr(id) + '"');
      }).join('') + '</div>' : '') + '</article>';
    }
    function renderReviewPreview(run) {
      if (!run) return emptyInspector("Select a recent review to inspect its outcome and coverage.");
      var counts = logicalCounts(run);
      return renderInspector({ title: "Selected review · " + runProject(run), subtitle: runId(run), kind: "run", content: '<div class="inspector-grid"><section class="inspector-section"><h3>Outcome</h3>' + badge(runStatus(run)) + '<p>' + escapeHtml(text(firstDefined(run.headline, run.reason, run.outcome_reason), "No outcome reason recorded.")) + '</p><a class="text-link" href="#/reviews/' + encodeURIComponent(runId(run)) + '">Open full review ↗</a></section><section class="inspector-section"><h3>Reviewer totals</h3>' + renderDefinitionList([["Total", counts.total], ["Finished", (number(counts.completed) || 0) + (number(counts.incomplete) || 0) + (number(counts.skipped) || 0)], ["File coverage", coverageLabel(run)], ["Duration", formatDuration(runElapsed(run))]]) + '</section><section class="inspector-section"><h3>Review context</h3>' + renderDefinitionList([["Branch", branchOf(run)], ["Scope", scopeOf(run)], ["Started", formatDate(runStartedAt(run), true)], ["Updated", formatDate(runUpdatedAt(run), true)]]) + '</section></div>' });
    }
    function renderReviews() {
      var runs = snapshotRuns(state.snapshot || {});
      var search = filterValue("reviews-search"), project = filterValue("reviews-project"), status = filterValue("reviews-status");
      var visible = runs.filter(function (run) { return matchesSearch(runProject(run) + ' ' + runId(run) + ' ' + branchOf(run), search) && (!project || runProject(run) === project) && (!status || runStatus(run) === status); });
      var active = visible.filter(isActiveRun), recent = visible.filter(function (run) { return !isActiveRun(run); });
      recent.sort(function (a, b) {
        var av = state.runSort === 'project' ? runProject(a) : state.runSort === 'duration' ? number(runElapsed(a)) || 0 : state.runSort === 'outcome' ? runStatus(a) : parseDate(runUpdatedAt(a))?.getTime() || 0;
        var bv = state.runSort === 'project' ? runProject(b) : state.runSort === 'duration' ? number(runElapsed(b)) || 0 : state.runSort === 'outcome' ? runStatus(b) : parseDate(runUpdatedAt(b))?.getTime() || 0;
        return (typeof av === 'string' ? av.localeCompare(bv) : av - bv) * state.runSortDirection;
      });
      var needsAttention = runs.filter(function (run) { return /incomplete|inconclusive|failed/.test(runStatus(run)); }).length;
      var body = viewHeading("Reviews", runs.filter(isActiveRun).length + ' active · ' + runs.filter(function (run) { return !isActiveRun(run); }).length + ' recent · ' + needsAttention + ' need attention');
      body += '<div class="filter-bar">' + searchField("reviews-search", "Search reviews") + selectFilter("reviews-project", "All projects", runs.map(runProject)) + selectFilter("reviews-status", "All statuses", runs.map(runStatus)) + '</div>';
      if (get(configOf(), ["diagnostics", "persist_runs"]) === false) body += '<div class="notice">Live run diagnostics are disabled. Only retained records are available.</div>';
      body += panel("Active reviews", active.length, active.length ? '<div class="active-runs">' + active.map(renderActiveRun).join('') + '</div>' : renderEmpty("No active reviews", visible.length ? "No visible review is currently running." : "No reviews match these filters."));
      function sortable(key, label) { return '<th aria-sort="' + (state.runSort === key ? state.runSortDirection > 0 ? 'ascending' : 'descending' : 'none') + '"><button type="button" class="table-sort" data-run-sort="' + key + '" data-focus-key="sort:' + key + '">' + label + (state.runSort === key ? state.runSortDirection > 0 ? ' ↑' : ' ↓' : '') + '</button></th>'; }
      var table = '<div class="table-wrap"><table class="data-table"><thead><tr>' + sortable('project', 'Project') + '<th>Branch</th>' + sortable('outcome', 'Outcome') + '<th>Reviewers finished</th><th>Gate findings</th><th>File coverage</th>' + sortable('duration', 'Duration') + sortable('finished', 'Finished') + '</tr></thead><tbody>' + recent.map(function (run) {
        var counts = logicalCounts(run), done = (number(counts.completed) || 0) + (number(counts.incomplete) || 0) + (number(counts.skipped) || 0);
        return '<tr class="' + (state.selectedRun === runId(run) ? 'is-selected' : '') + '"><td>' + selectButton('data-select-run', runId(run), escapeHtml(runProject(run))) + '</td><td class="secondary">' + escapeHtml(branchOf(run)) + '</td><td>' + badge(runStatus(run)) + '</td><td class="mono">' + done + '/' + text(counts.total, "0") + '</td><td class="mono">' + escapeHtml(firstDefined(run.gate_eligible_subfindings, run.gate_effective_findings, get(run, ["canonical", "counts", "gate_eligible_subfindings"]), "—")) + '</td><td>' + escapeHtml(coverageLabel(run)) + '</td><td class="mono">' + escapeHtml(formatDuration(runElapsed(run))) + '</td><td title="' + escapeAttr(formatDate(runUpdatedAt(run), true)) + '">' + escapeHtml(relativeTime(runUpdatedAt(run))) + '</td></tr>';
      }).join('') + '</tbody></table></div>';
      body += panel("Recent reviews", recent.length, recent.length ? table : renderEmpty("No recent reviews", "Completed reviews will appear here when retained locally."));
      return workspace(body, renderReviewPreview(runs.find(function (run) { return runId(run) === state.selectedRun; })));
    }
    function renderLensList(detail) {
      var groups = logicalGroups(detail);
      if (!groups.length) return renderEmpty("No reviewer roster", "This retained record has no reviewer roster.");
      var phaseHeadings = '<div class="phase-headings">' + PHASES.map(function (phase) { return '<span>' + phase[1] + '</span>'; }).join('') + '</div>';
      var body = groups.map(function (group) {
        var current = group.logical || group.current;
        var expanded = state.expandedLenses[runId(detail) + ':' + group.id] === true;
        var selected = state.route.reviewerId;
        var isSelected = group.reviewers.some(function (row) { return reviewerId(row) === selected; });
        var currentId = reviewerId(group.current);
        var head = '<tr class="reviewer-lane logical-lane' + (isSelected && !expanded ? ' is-selected' : '') + '" data-state="' + escapeAttr(reviewerState(current)) + '"><td><div class="lens-identity"><button type="button" class="expand-button" data-toggle-lens="' + escapeAttr(group.id) + '" aria-label="' + (expanded ? 'Collapse ' : 'Expand ') + escapeAttr(group.id) + ' model chain" aria-expanded="' + expanded + '" data-focus-key="lens:' + escapeAttr(group.id) + '">' + (expanded ? '⌄' : '›') + '</button>' + selectButton('data-open-reviewer', currentId, '<strong>' + escapeHtml(group.id) + '</strong><span class="secondary">' + escapeHtml(phaseLabel(current)) + '</span>', ' data-run-id="' + escapeAttr(runId(detail)) + '"', ':lens') + '</div></td><td class="phase-cell">' + renderReviewerPhase(current) + '</td><td class="mono">' + escapeHtml(formatDuration(current.elapsed_ms)) + '</td><td class="secondary" title="' + escapeAttr(text(current.last_activity_message)) + '">' + escapeHtml(current.last_activity_at ? relativeTime(current.last_activity_at) : '—') + '</td></tr>';
        if (!expanded) return head;
        return head + group.reviewers.map(function (reviewer, index) {
          var id = reviewerId(reviewer);
          var label = text(reviewer.model, 'Model ' + (index + 1));
          return '<tr class="reviewer-lane model-lane' + (selected === id ? ' is-selected' : '') + '" data-state="' + escapeAttr(reviewerState(reviewer)) + '"><td>' + selectButton('data-open-reviewer', id, '<span class="model-index">' + (index + 1) + '</span><span><strong>' + escapeHtml(label) + '</strong><span class="secondary">' + escapeHtml(text(reviewer.adapter, 'Adapter not recorded') + (reviewer.mode ? ' · ' + displayName(reviewer.mode) : '')) + '</span></span>', ' data-run-id="' + escapeAttr(runId(detail)) + '"') + '</td><td class="phase-cell">' + renderReviewerPhase(reviewer) + '</td><td class="mono">' + escapeHtml(formatDuration(reviewer.elapsed_ms)) + '</td><td>' + badge(reviewerState(reviewer), phaseLabel(reviewer)) + '</td></tr>';
        }).join('');
      }).join('');
      var counts = logicalCounts(detail), slots = reviewersOf(detail).length || number(runModelCounts(detail).total) || 0;
      return panel(groups.length + ' reviewers · ' + slots + ' configured model slots', undefined, '<div class="table-wrap"><table class="data-table reviewer-table"><thead><tr><th>Reviewer / model</th><th>' + phaseHeadings + '</th><th>Elapsed</th><th>Last progress</th></tr></thead><tbody>' + body + '</tbody></table></div>', '<span class="status-count active">' + text(counts.running, '0') + ' active</span><span class="status-count waiting">' + text(counts.queued, '0') + ' waiting</span><span class="status-count finished">' + ((number(counts.completed) || 0) + (number(counts.incomplete) || 0) + (number(counts.skipped) || 0)) + ' finished</span>');
    }
    function runTabs(detail) {
      var active = state.route.tab;
      return '<div class="tabs run-tabs" role="tablist" aria-label="Run detail">' + [['timeline', 'Timeline'], ['findings', 'Findings'], ['events', 'Events']].map(function (tab) {
        return '<button class="tab" type="button" role="tab" id="run-tab-' + tab[0] + '" data-run-tab="' + tab[0] + '" data-focus-key="run-tab:' + tab[0] + '" tabindex="' + (active === tab[0] ? 0 : -1) + '" aria-selected="' + (active === tab[0]) + '" aria-controls="run-panel">' + tab[1] + (tab[0] === 'findings' && findingsCount(detail) !== undefined ? ' <span class="tab-count">' + findingsCount(detail) + '</span>' : '') + '</button>';
      }).join('') + '</div>';
    }
    function renderRunDetail() {
      if (state.runLoading && !state.runDetail) return workspace('<div class="skeleton" aria-label="Loading review"></div>', emptyInspector("Reviewer details will appear here."));
      if (state.runError && !state.runDetail) return workspace(renderError("Review unavailable", state.runError), emptyInspector("No review selected."));
      var detail = normalizeRunDetail();
      if (!detail) return workspace(renderEmpty("Review unavailable", "No run detail was returned."), emptyInspector("No review selected."));
      var tab = state.route.tab;
      var changed = firstDefined(get(detail, ['context', 'git', 'changed_files_count']), get(detail, ['git', 'changed_files_count']), Array.isArray(get(detail, ['context', 'git', 'changed_files'])) ? detail.context.git.changed_files.length : undefined);
      var stale = detail.stale === true || runStatus(detail) === 'stale';
      var subtitle = branchOf(detail) + (changed !== undefined ? ' · ' + changed + ' changed files' : '') + ' · ' + (stale ? 'Last observed elapsed ' : isActiveRun(detail) ? 'Elapsed ' : 'Finished in ') + formatDuration(runElapsed(detail));
      var title = tab === 'findings' ? 'Results and findings' : tab === 'events' ? 'Events' : stale ? 'Review stopped updating' : isActiveRun(detail) ? 'Review in progress' : 'Review completed';
      var body = '<header class="run-header">' + viewHeading(title, subtitle, badge(runStatus(detail))) + '<div class="run-progress-panel">' + renderStageRail(detail) + '</div></header>';
      if (stale) body += '<div class="notice" role="status">This run has stopped updating. Reviewer phases below show the last recorded activity; completion was not recorded.</div>';
      if (state.runError) body += '<div class="notice" role="status">Showing the last received review. ' + escapeHtml(state.runError) + '</div>';
      if (!stale && (!isActiveRun(detail) || tab === 'findings')) body += '<div class="outcome-strip"><div>' + badge(firstDefined(detail.run_outcome, detail.gate_outcome, runStatus(detail))) + '<span>' + escapeHtml(text(detail.headline, 'Review outcome is recorded below.')) + '</span></div><span class="secondary">Required reviewer coverage: ' + escapeHtml(displayName(firstDefined(get(detail, ['execution_coverage', 'status']), detail.coverage_outcome, 'Not recorded'))) + ' · Changed-file coverage: ' + escapeHtml(coverageLabel(detail)) + '</span></div>';
      body += runTabs(detail) + '<div id="run-panel" role="tabpanel" aria-labelledby="run-tab-' + tab + '">';
      body += tab === 'findings' ? renderFindings(detail) : tab === 'events' ? renderEvents(detail) : renderLensList(detail);
      body += '</div>';
      var inspector = tab === 'findings' ? renderFindingInspector(detail) : tab === 'events' ? renderEventInspector(detail) : renderReviewerInspector();
      return workspace(body, inspector);
    }

    function findingId(finding, index) { return text(firstDefined(finding.id, finding.finding_id, finding.atomic_id), 'finding-' + index); }
    function findingEvidence(finding) { return array(firstDefined(finding.evidence, finding.evidence_refs, finding.locations)).filter(isObject); }
    function evidenceLocation(evidence) {
      var path = text(firstDefined(evidence.path, evidence.file, evidence.file_path), 'Location not recorded');
      var line = firstDefined(evidence.start_line, evidence.line, get(evidence, ['range', 'start', 'line']));
      return path + (line === undefined ? '' : ':' + line);
    }
    function findingReviewers(finding) {
      var records = firstDefined(finding.supporting_reviewers, finding.reviewer_ids, finding.source_refs, finding.sources, finding.source_findings);
      var ids = array(records).map(function (entry) { return text(isObject(entry) ? firstDefined(entry.reviewer_id, entry.lens_id, entry.source_ref) : entry).split('#')[0]; });
      if (finding.reviewer_id) ids.push(finding.reviewer_id);
      return Array.from(new Set(ids.filter(Boolean)));
    }
    function findingClassification(finding) {
      if (get(finding, ['gate_eligibility', 'eligible']) === true || get(finding, ['gate_eligibility', 'status']) === 'eligible' || finding.gate_eligible === true) return 'Gate finding';
      if (get(finding, ['gate_eligibility', 'eligible']) === false || get(finding, ['gate_eligibility', 'status']) === 'ineligible' || finding.gate_eligible === false) return 'Advisory finding';
      return displayName(firstDefined(finding.classification, 'Not recorded'));
    }
    function renderFindings(detail) {
      var all = findingsOf(detail);
      var findings = all.filter(function (finding) { return matchesSearch(text(finding.title) + ' ' + text(finding.description) + ' ' + findingEvidence(finding).map(evidenceLocation).join(' '), filterValue('findings-search')) && (!filterValue('findings-severity') || finding.severity === filterValue('findings-severity')); });
      var body = '<div class="filter-bar">' + searchField('findings-search', 'Search findings') + selectFilter('findings-severity', 'All severities', all.map(function (finding) { return finding.severity; })) + '<span class="filter-result-count">' + findings.length + ' findings</span></div>';
      if (!findings.length) return body + renderEmpty(all.length ? "No matching findings" : "No structured findings", all.length ? "Adjust the filters to show more findings." : (findingsCount(detail) || 0) > 0 ? "Findings were counted, but structured records are not available in this response." : "No actionable finding records are available for this review.");
      return body + '<div class="table-wrap"><table class="data-table findings-table"><thead><tr><th>Severity</th><th>Finding</th><th>Location</th><th>Supporting reviewers</th><th>Classification</th></tr></thead><tbody>' + findings.map(function (finding) {
        var id = findingId(finding, all.indexOf(finding));
        var evidence = findingEvidence(finding);
        return '<tr class="' + (state.selectedFinding === id ? 'is-selected' : '') + '"><td>' + badge(text(finding.severity, 'unspecified')) + '</td><td>' + selectButton('data-select-finding', id, escapeHtml(text(firstDefined(finding.title, finding.summary), 'Untitled finding'))) + '</td><td class="mono location-cell">' + escapeHtml(evidence.length ? evidenceLocation(evidence[0]) : 'Not recorded') + '</td><td class="secondary">' + escapeHtml(findingReviewers(finding).join(' · ') || 'Not recorded') + '</td><td>' + badge(findingClassification(finding) === 'Gate finding' ? 'gate_findings' : 'advisory', findingClassification(finding)) + '</td></tr>';
      }).join('') + '</tbody></table></div>';
    }
    function renderEvidence(evidence) {
      if (!evidence.length) return renderEmpty("No evidence record", "No source evidence was included in this finding.");
      return '<div class="evidence-list">' + evidence.map(function (item) {
        var snippet = text(firstDefined(item.snippet, item.excerpt, item.source_excerpt, item.code));
        return '<section class="evidence"><h3 class="evidence-path">' + escapeHtml(evidenceLocation(item)) + '</h3>' + (text(firstDefined(item.detail, item.description, item.reason)) ? '<p>' + escapeHtml(text(firstDefined(item.detail, item.description, item.reason))) + '</p>' : '') + (snippet ? '<pre class="source-excerpt">' + escapeHtml(snippet) + '</pre>' : '<p class="secondary">A source excerpt was not included in the recorded evidence.</p>') + '</section>';
      }).join('') + '</div>';
    }
    function renderCoverage(detail) {
      var result = firstDefined(detail.result, {});
      var coverage = firstDefined(result.change_coverage, detail.change_coverage, detail.coverage_attestation, {});
      var files = array(firstDefined(detail.coverage, coverage.files, get(detail, ['change_coverage', 'files']))).filter(isObject);
      var summary = renderDefinitionList([["Status", firstDefined(coverage.status, detail.coverage_outcome)], ["Proof", coverage.proof_kind], ["Required files", firstDefined(coverage.required_count, coverage.required_files)], ["Inspected", firstDefined(coverage.inspected_count, coverage.inspected_files)], ["Deficits", coverage.deficit_count], ["Reviewer coverage", get(detail, ['execution_coverage', 'status'])]]);
      var deficits = array(coverage.deficit_sample).filter(isObject);
      if (deficits.length) summary += '<h3>Recorded coverage deficits</h3><div class="evidence-list">' + deficits.map(function (entry) { return '<div class="evidence"><strong class="mono">' + escapeHtml(text(entry.path, 'Not recorded')) + '</strong><p>' + escapeHtml(displayName(entry.reason)) + '</p></div>'; }).join('') + '</div>';
      return '<section class="inspector-section"><h3>Recorded coverage</h3>' + summary + '</section>' + (files.length ? '<div class="table-wrap"><table class="data-table"><thead><tr><th>File</th><th>Relevant</th><th>Snapshot</th><th>Diff</th><th>Reason</th></tr></thead><tbody>' + files.map(function (entry) {
        return '<tr><td class="mono">' + escapeHtml(text(firstDefined(entry.path, entry.file), 'Not recorded')) + '</td><td>' + escapeHtml(entry.relevant === undefined ? 'Not recorded' : entry.relevant ? 'Yes' : 'No') + '</td><td>' + escapeHtml(displayName(firstDefined(entry.snapshot_read, entry.status))) + '</td><td>' + escapeHtml(displayName(entry.diff_delivery)) + '</td><td>' + escapeHtml(text(entry.reason, '—')) + '</td></tr>';
      }).join('') + '</tbody></table></div>' : '<p class="secondary">No per-file coverage records are available.</p>');
    }
    function renderFindingInspector(detail) {
      var all = findingsOf(detail);
      var finding = all.find(function (item, index) { return findingId(item, index) === state.selectedFinding; });
      if (!finding) return emptyInspector("Select a finding to inspect its explanation, evidence, and supporting reviewer reports.");
      var tab = inspectorTab('finding', 'explanation');
      var content;
      if (tab === 'evidence') content = renderEvidence(findingEvidence(finding));
      else if (tab === 'coverage') content = renderCoverage(detail) + '<p class="secondary">Coverage is recorded for this review. It does not assert that every reviewer independently inspected this finding.</p>';
      else if (tab === 'reports') {
        var ids = findingReviewers(finding);
        var reports = reviewersOf(detail).filter(function (reviewer) { return ids.indexOf(reviewerId(reviewer)) >= 0 || ids.indexOf(reviewer.lens_id) >= 0; });
        content = reports.length ? '<div class="inspector-grid">' + reports.map(function (reviewer) { return '<section class="inspector-section"><h3>' + escapeHtml(reviewerId(reviewer)) + '</h3>' + badge(reviewerState(reviewer)) + '<p>' + escapeHtml(text(get(reviewer, ['result', 'summary']), 'No report summary recorded.')) + '</p>' + selectButton('data-open-reviewer', reviewerId(reviewer), 'Open reviewer report ↗', ' data-run-id="' + escapeAttr(runId(detail)) + '" data-target-tab="timeline" data-reviewer-tab="result"') + '</section>'; }).join('') + '</div>' : renderEmpty("No reviewer reports", "Supporting reviewer reports are not included in this record.");
      } else content = '<div class="inspector-grid"><section class="inspector-section"><h3>Explanation</h3><p class="summary-copy">' + escapeHtml(text(firstDefined(finding.description, finding.detail, finding.summary), 'No explanation recorded.')) + '</p>' + (firstDefined(finding.trigger, get(finding, ['claim', 'trigger'])) ? '<p><strong>Trigger:</strong> ' + escapeHtml(firstDefined(finding.trigger, get(finding, ['claim', 'trigger']))) + '</p>' : '') + (firstDefined(finding.impact, get(finding, ['claim', 'outcome'])) ? '<p><strong>Impact:</strong> ' + escapeHtml(firstDefined(finding.impact, get(finding, ['claim', 'outcome']))) + '</p>' : '') + (finding.suggested_direction ? '<p><strong>Suggested direction:</strong> ' + escapeHtml(finding.suggested_direction) + '</p>' : '') + '</section><section class="inspector-section"><h3>Finding facts</h3>' + renderDefinitionList([["Severity", finding.severity], ["Classification", findingClassification(finding)], ["Confidence", finding.confidence], ["Supporting reviewers", findingReviewers(finding).join(' · ')], ["Gate decision reasons", array(get(finding, ['gate_eligibility', 'reasons'])).join(' · ')]]) + '</section></div>';
      return renderInspector({ kind: 'finding', title: text(firstDefined(finding.title, finding.summary), 'Finding'), tabs: [['explanation', 'Explanation'], ['evidence', 'Evidence'], ['reports', 'Reviewer reports'], ['coverage', 'Coverage']], active: tab, content: content });
    }

    function eventId(event, index) { return text(firstDefined(event.id, event.seq), 'event-' + index); }
    function eventReviewer(event) { return text(firstDefined(event.reviewer_id, get(event, ['data', 'reviewer_id']), get(event, ['data', 'lens_id'])), 'Run'); }
    function filteredEvents(detail) {
      return eventsOf(detail).map(function (event, index) { return { event: event, id: eventId(event, index), index: index }; }).filter(function (entry) {
        return matchesSearch(eventName(entry.event) + ' ' + eventSummary(entry.event) + ' ' + eventReviewer(entry.event), filterValue('events-search')) && (!filterValue('events-reviewer') || eventReviewer(entry.event) === filterValue('events-reviewer')) && (!filterValue('events-type') || eventName(entry.event) === filterValue('events-type'));
      });
    }
    function eventGroups(entries) {
      var groups = [];
      entries.forEach(function (entry) {
        var previous = groups[groups.length - 1];
        var heartbeat = /heartbeat/.test(eventName(entry.event));
        if (heartbeat && previous && previous.heartbeat && previous.entries[previous.entries.length - 1].index === entry.index - 1 && eventReviewer(previous.entries[0].event) === eventReviewer(entry.event)) previous.entries.push(entry);
        else groups.push({ id: entry.id, heartbeat: heartbeat, entries: [entry] });
      });
      return groups;
    }
    function eventRow(entry, child) {
      var event = entry.event;
      return '<tr class="event-row' + (child ? ' event-child' : '') + (state.selectedEvent === entry.id ? ' is-selected' : '') + '"><td class="mono">' + escapeHtml(formatDate(eventTime(event), false)) + '</td><td class="secondary">' + escapeHtml(eventReviewer(event)) + '</td><td>' + selectButton('data-select-event', entry.id, escapeHtml(displayName(eventName(event)).replace(/\./g, ' · '))) + '</td><td>' + escapeHtml(eventSummary(event)) + '</td></tr>';
    }
    function renderEvents(detail) {
      var all = eventsOf(detail), visible = filteredEvents(detail);
      var filters = '<div class="filter-bar">' + searchField('events-search', 'Search activity') + selectFilter('events-reviewer', 'All reviewers', all.map(eventReviewer)) + selectFilter('events-type', 'All event types', all.map(eventName)) + '<label class="filter-toggle"><input type="checkbox" data-follow-latest data-focus-key="follow-latest"' + (state.followLatest ? ' checked' : '') + '> Follow latest</label><span class="filter-result-count">' + visible.length + ' events</span></div>';
      if (!visible.length) return filters + renderEmpty(all.length ? "No matching events" : "No persisted events", all.length ? "Adjust your activity filters." : "This run has no event envelopes.");
      var rows = eventGroups(visible).map(function (group) {
        if (!group.heartbeat || group.entries.length < 2) return group.entries.map(function (entry) { return eventRow(entry, false); }).join('');
        var expanded = state.expandedHeartbeats[runId(detail) + ':' + group.id] === true;
        var first = group.entries[0], last = group.entries[group.entries.length - 1];
        return '<tr class="heartbeat-group"><td class="mono">' + escapeHtml(formatDate(eventTime(first.event), false)) + '</td><td class="secondary">' + escapeHtml(eventReviewer(first.event)) + '</td><td><button class="row-button" type="button" data-toggle-heartbeats="' + escapeAttr(group.id) + '" aria-expanded="' + expanded + '" data-focus-key="heartbeats:' + escapeAttr(group.id) + '">' + (expanded ? '⌄' : '›') + ' ' + group.entries.length + ' heartbeat updates</button></td><td>' + escapeHtml(formatDate(eventTime(first.event), false) + ' – ' + formatDate(eventTime(last.event), false)) + '</td></tr>' + (expanded ? group.entries.map(function (entry) { return eventRow(entry, true); }).join('') : '');
      }).join('');
      return filters + '<div class="table-wrap event-table-wrap" data-scroll-key="event-table:' + escapeAttr(runId(detail)) + '"><table class="data-table events-table"><thead><tr><th>Time</th><th>Reviewer</th><th>Event</th><th>Summary</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
    }
    function renderEventInspector(detail) {
      var events = eventsOf(detail);
      var selected = events.find(function (event, index) { return eventId(event, index) === state.selectedEvent; });
      if (!selected) return emptyInspector("Select an event to inspect its recorded activity and structured data.");
      return renderInspector({ kind: 'event', title: eventReviewer(selected), subtitle: eventName(selected), content: '<div class="inspector-grid"><section class="inspector-section">' + renderDefinitionList([["Event", eventName(selected)], ["Reason", firstDefined(get(selected, ['data', 'reason']), get(selected, ['data', 'failure', 'reason']))], ["Attempt", firstDefined(selected.attempt, get(selected, ['data', 'attempt']))], ["Recorded at", formatDate(eventTime(selected), true)], ["Sequence", selected.seq]]) + '<p>' + escapeHtml(eventSummary(selected)) + '</p></section><section class="inspector-section"><h3>Structured event</h3><pre>' + escapeHtml(safeJson(selected)) + '</pre></section></div><p class="secondary">Recorded activity summaries</p>' });
    }

    function reviewerObject() {
      var route = state.route || {};
      var row = reviewersOf(normalizeRunDetail()).find(function (reviewer) { return reviewerId(reviewer) === route.reviewerId; }) || {};
      if (!isObject(state.reviewerDetail) || state.reviewerKey !== route.runId + ':' + route.reviewerId) return row;
      var fetched = isObject(state.reviewerDetail.reviewer) ? Object.assign({}, state.reviewerDetail.reviewer, state.reviewerDetail) : state.reviewerDetail;
      // Run detail is refreshed before this endpoint; never overlay it with an older live row.
      var rowTime = parseDate(firstDefined(row.last_activity_at, row.finished_at, row.started_at));
      var fetchedTime = parseDate(firstDefined(fetched.last_activity_at, fetched.finished_at, fetched.started_at));
      return rowTime && (!fetchedTime || rowTime >= fetchedTime) ? Object.assign({}, fetched, row) : Object.assign({}, row, fetched);
    }
    function renderReviewerInspector() {
      var route = state.route || {};
      if (!route.reviewerId) return emptyInspector("Select a reviewer or expand a model chain to inspect an exact model run.");
      var detail = reviewerObject();
      var tab = inspectorTab('reviewer', 'activity');
      var content = state.reviewerError ? '<div class="notice">' + escapeHtml(state.reviewerError) + '</div>' : '';
      if (state.reviewerLoading && !Object.keys(detail).length) content += '<div class="skeleton" aria-label="Loading reviewer details"></div>';
      else if (tab === 'result') content += renderReviewerResult(detail);
      else if (tab === 'coverage') content += renderCoverage(detail);
      else if (tab === 'runtime') content += renderReviewerRuntime(detail);
      else content += '<div class="inspector-grid activity-inspector"><section class="inspector-section">' + renderReviewerActivity(detail) + '</section><section class="inspector-section"><h3>Selected reviewer facts</h3>' + renderDefinitionList([["Mode", displayName(firstDefined(detail.mode, 'Not recorded'))], ["Attempt", firstDefined(detail.attempt, 'Not recorded')], ["Last progress", detail.last_activity_at ? relativeTime(detail.last_activity_at) : 'Not recorded'], ["Result", firstDefined(get(detail, ['result', 'verdict']), phaseKey(reviewerState(detail)) === 'finished' ? reviewerState(detail) : 'Pending')], ["Model", detail.model], ["Adapter", detail.adapter]]) + '</section></div>';
      var lensTitle = text(firstDefined(detail.lens_id, detail.agent_id), 'Reviewer');
      return renderInspector({ title: lensTitle.charAt(0).toUpperCase() + lensTitle.slice(1) + ' / ' + text(detail.model, route.reviewerId), subtitle: route.reviewerId, kind: 'reviewer', tabs: [['activity', 'Activity'], ['result', 'Result'], ['coverage', 'Coverage'], ['runtime', 'Runtime']], active: tab, content: content });
    }
    function renderModelChain(agent) {
      var models = modelRunsOf(agent);
      return '<div class="model-chain">' + models.map(function (model, index) {
        return (index ? '<span class="chain-arrow" aria-hidden="true">→</span>' : '') + '<span class="model-token"><span class="model-index">' + (index + 1) + '</span><span><strong>' + escapeHtml(text(model.model, 'Model not recorded')) + '</strong><small>' + escapeHtml(text(firstDefined(model.provider_group, model.adapter), 'Provider not recorded')) + '</small></span></span>';
      }).join('') + '</div>';
    }
    function renderAgentInspector(agent) {
      if (!agent) return emptyInspector("Select a logical reviewer to inspect its ordered model chain and configuration.");
      var models = modelRunsOf(agent);
      var content = '<div class="inspector-grid"><section class="inspector-section"><h3>Purpose</h3><p>' + escapeHtml(text(agent.purpose, 'Purpose not recorded.')) + '</p><div class="table-wrap"><table class="data-table"><thead><tr><th>Slot</th><th>Model</th><th>Provider</th><th>Reasoning</th><th>Timeout</th></tr></thead><tbody>' + models.map(function (model, index) {
        var override = model.timeout_ms !== undefined && agent.timeout_ms !== undefined && model.timeout_ms !== agent.timeout_ms;
        return '<tr><td>' + (index + 1) + '</td><td>' + escapeHtml(text(model.model, 'Not recorded')) + '</td><td>' + escapeHtml(text(firstDefined(model.provider_group, model.adapter), 'Not recorded')) + '</td><td>' + escapeHtml(displayName(firstDefined(model.effort, agent.effort))) + '</td><td>' + escapeHtml(formatDuration(firstDefined(model.timeout_ms, agent.timeout_ms))) + (override ? ' · override' : '') + '</td></tr>';
      }).join('') + '</tbody></table></div></section><section class="inspector-section"><h3>Review policy</h3>' + renderDefinitionList([["Pass requirement", firstDefined(agent.pass_quorum, get(agent, ['policy', 'pass_quorum']))], ["Provider diversity", firstDefined(agent.minimum_provider_groups, get(agent, ['policy', 'minimum_provider_groups']))], ["Adjudication", firstDefined(agent.adjudication, get(agent, ['policy', 'adjudication']))], ["Assigned projects", array(agent.projects).join(', ') || (agent.default ? 'Default selection' : 'None')], ["Instructions", agent.has_instructions === true ? 'Configured · ' + text(agent.instruction_source, 'source not recorded') : agent.has_instructions === false ? 'None' : 'Not recorded'], ["Isolation", agent.isolation]]) + '</section></div><p class="secondary">Models are considered in order. Later models may provide another required pass, recover from an execution failure, or adjudicate findings.</p>';
      return renderInspector({ title: agentId(agent) + ' — Configuration', kind: 'agent', content: content });
    }
    function renderAgents() {
      var all = snapshotAgents(state.snapshot || {});
      var agents = all.filter(function (agent) { return matchesSearch(agentId(agent) + ' ' + text(agent.purpose) + ' ' + modelRunsOf(agent).map(function (model) { return text(model.model); }).join(' '), filterValue('agents-search')) && (!filterValue('agents-project') || array(agent.projects).indexOf(filterValue('agents-project')) >= 0); });
      var modelCount = all.reduce(function (sum, agent) { return sum + modelRunsOf(agent).length; }, 0);
      var body = viewHeading('Reviewers', all.length + ' logical reviewers · ' + modelCount + ' configured model slots') + '<div class="filter-bar">' + searchField('agents-search', 'Search reviewers') + selectFilter('agents-project', 'All projects', all.flatMap(function (agent) { return array(agent.projects); })) + '</div>';
      body += agents.length ? '<div class="table-wrap"><table class="data-table catalog-table"><thead><tr><th>Reviewer</th><th>Purpose</th><th>Ordered model chain</th><th>Pass requirement</th><th>Projects</th></tr></thead><tbody>' + agents.map(function (agent) {
        return '<tr class="' + (state.selectedAgent === agentId(agent) ? 'is-selected' : '') + '"><td>' + selectButton('data-select-agent', agentId(agent), escapeHtml(agentId(agent))) + '</td><td class="purpose-cell">' + escapeHtml(text(agent.purpose, 'Not recorded')) + '</td><td>' + renderModelChain(agent) + '</td><td>' + escapeHtml(agent.pass_quorum === undefined ? 'Not recorded' : agent.pass_quorum + ' qualifying pass' + (agent.pass_quorum === 1 ? '' : 'es')) + '</td><td class="secondary">' + escapeHtml(array(agent.projects).join(', ') || (agent.default ? 'Default selection' : 'None')) + '</td></tr>';
      }).join('') + '</tbody></table></div>' : renderEmpty(all.length ? 'No matching reviewers' : 'No configured reviewers', all.length ? 'Adjust your filters.' : 'The safe configuration snapshot has no reviewer catalog.');
      return workspace(body, renderAgentInspector(all.find(function (agent) { return agentId(agent) === state.selectedAgent; })));
    }
    function projectList() {
      var defaults = firstDefined(configOf().defaults, {});
      return snapshotProjects(state.snapshot || {}).concat([Object.assign({}, defaults, { id: '__defaults__', name: 'Default configuration', is_default: true, source: 'Defaults', agents: array(defaults.agents) })]);
    }
    function effectiveProjectAgents(project) {
      var assigned = projectAgents(project);
      return assigned.length ? assigned : array(get(configOf(), ['defaults', 'agents']));
    }
    function projectSource(project) {
      if (project.is_default) return 'Defaults';
      return text(firstDefined(project.settings_source, project.source, project.selection_source), projectAgents(project).length ? 'Project assignments' : 'Defaults');
    }
    function projectSettings(project) {
      var defaults = configOf().defaults || {};
      var effective = isObject(project.effective_settings) ? project.effective_settings : {};
      var rows = [];
      var sources = firstDefined(project.setting_sources, project.sources, {});
      function add(label, key, fallback, format) {
        var own = firstDefined(effective[key], project[key], get(project, ['settings', key]));
        var value = firstDefined(own, defaults[key], fallback);
        if (value === undefined) return;
        rows.push([label, format ? format(value) : isObject(value) ? text(value.mode, safeJson(value)) : displayName(value), text(sources[key], own !== undefined && !project.is_default ? 'Project configuration' : project.is_default ? 'Defaults' : defaults[key] !== undefined ? 'Inherited defaults' : 'Global execution policy')]);
      }
      add('Review scope', 'review_scope');
      add('Concurrency limit', 'max_concurrency', get(configOf(), ['execution', 'max_concurrency']));
      add('Timeout', 'timeout_ms', undefined, formatDuration);
      add('Isolation', 'isolation');
      rows.push(['Guidance', project.has_guidance === true ? 'Configured' : project.has_guidance === false ? 'None' : 'Not recorded', text(project.guidance_source, 'Not recorded')]);
      rows.push(['Required context', project.has_context === true ? 'Configured' : project.has_context === false ? 'None' : 'Not recorded', text(project.context_source, project.is_default ? 'Defaults' : 'Project configuration')]);
      return rows;
    }
    function renderProjectInspector(project) {
      if (!project) return emptyInspector("Select a project to inspect reviewer assignments and effective settings.");
      var tab = inspectorTab('project', 'reviewers');
      var assigned = effectiveProjectAgents(project), agents = snapshotAgents(state.snapshot || {});
      var settings = '<section class="inspector-section"><h3>Effective settings summary</h3><div class="table-wrap"><table class="data-table"><thead><tr><th>Setting</th><th>Value</th><th>Source</th></tr></thead><tbody>' + projectSettings(project).map(function (row) { return '<tr><td>' + escapeHtml(row[0]) + '</td><td>' + escapeHtml(row[1]) + '</td><td class="secondary">' + escapeHtml(row[2]) + '</td></tr>'; }).join('') + '</tbody></table></div></section>';
      var roster = '<section class="inspector-section"><h3>Assigned reviewers</h3>' + (assigned.length ? '<div class="assigned-reviewers">' + assigned.map(function (id) {
        var agent = agents.find(function (item) { return agentId(item) === id; });
        return '<a class="assigned-reviewer" href="#/reviewers?selected=' + encodeURIComponent(id) + '"><strong>' + escapeHtml(id) + '</strong><span>' + (agent ? modelRunsOf(agent).length + ' model slots' : 'Configuration unavailable') + '</span></a>';
      }).join('') + '</div>' : '<p class="secondary">No reviewer assignments recorded.</p>') + '</section>';
      return renderInspector({ title: projectId(project), kind: 'project', tabs: [['reviewers', 'Reviewers'], ['settings', 'Effective settings']], active: tab, content: tab === 'settings' ? settings : '<div class="inspector-grid">' + roster + settings + '</div>' });
    }
    function renderProjects() {
      var all = projectList(), visible = all.filter(function (project) { return matchesSearch(projectId(project) + ' ' + effectiveProjectAgents(project).join(' '), filterValue('projects-search')); });
      var body = viewHeading('Projects', 'Reviewer assignments and effective review settings') + '<div class="filter-bar">' + searchField('projects-search', 'Search projects') + '</div>';
      body += visible.length ? '<div class="table-wrap"><table class="data-table projects-table"><thead><tr><th>Project</th><th>Assigned reviewers</th><th>Review scope</th><th>Settings source</th></tr></thead><tbody>' + visible.map(function (project) {
        var id = project.is_default ? '__defaults__' : projectId(project);
        var scope = firstDefined(project.review_scope, get(project, ['effective_settings', 'review_scope']), get(configOf(), ['defaults', 'review_scope']));
        return '<tr class="' + (state.selectedProject === id ? 'is-selected' : '') + '"><td>' + selectButton('data-select-project', id, '<strong>' + escapeHtml(projectId(project)) + '</strong>' + (project.is_default ? '<span class="secondary">Applies when a project has no explicit assignment.</span>' : '')) + '</td><td>' + effectiveProjectAgents(project).length + ' reviewers</td><td>' + escapeHtml(isObject(scope) ? displayName(scope.mode) : displayName(scope)) + '</td><td class="secondary">' + escapeHtml(projectSource(project)) + '</td></tr>';
      }).join('') + '</tbody></table></div>' : renderEmpty('No matching projects', 'Adjust your project search.');
      return workspace(body, renderProjectInspector(all.find(function (project) { return (project.is_default ? '__defaults__' : projectId(project)) === state.selectedProject; })));
    }
    function adaptersOf() { return namedList(firstDefined(state.snapshot && state.snapshot.adapters, configOf().adapters, get(snapshotSystem(state.snapshot), ['adapters']))); }
    function adapterPresence(adapter) {
      var variables = array(adapter.credential_environment);
      if (!variables.length) return 'Not required';
      return variables.every(function (entry) { return entry.present === true; }) ? 'Present' : 'Missing';
    }
    function renderAdapterInspector(adapter) {
      if (!adapter) return emptyInspector("Select an adapter to inspect its configuration and credential-variable presence.");
      var variables = array(adapter.credential_environment);
      return renderInspector({ title: 'Adapter configuration · ' + text(firstDefined(adapter.id, adapter.name), 'Adapter'), kind: 'adapter', content: '<div class="inspector-grid"><section class="inspector-section">' + renderDefinitionList([["Adapter identifier", firstDefined(adapter.id, adapter.name)], ["Type", adapter.type], ["Expected variables", variables.map(function (entry) { return text(firstDefined(entry.name, entry.variable)); }).join(', ') || 'None'], ["Credential state", adapterPresence(adapter)]]) + '</section><section class="inspector-section"><h3>Observer environment</h3>' + (variables.length ? '<div class="credential-list">' + variables.map(function (entry) { return '<div><span class="mono">' + escapeHtml(text(firstDefined(entry.name, entry.variable), 'Not recorded')) + '</span>' + badge(entry.present === true ? 'present' : 'missing', entry.present === true ? 'Present' : 'Missing') + '</div>'; }).join('') + '</div>' : '<p>No credential variables required by this adapter configuration.</p>') + '<p class="secondary">Connection health: ' + escapeHtml(text(adapter.connection_health, 'Not checked')) + '</p><p class="secondary">Presence reflects this observer process environment.</p></section></div>' });
    }
    function renderSystem() {
      var config = configOf(), snapshot = state.snapshot || {}, system = snapshotSystem(snapshot), adapters = adaptersOf();
      var execution = firstDefined(snapshot.execution, config.execution, system.execution, {}), diagnostics = firstDefined(snapshot.diagnostics, config.diagnostics, system.diagnostics, {});
      var body = viewHeading('System', 'Execution policy, diagnostics, adapters, and local data') + '<div class="system-status-bar"><span>Local connection: ' + badge(state.connection, state.connection === 'live' ? 'Live' : displayName(state.connection)) + '</span><span>Last update: <strong>' + escapeHtml(relativeTime(generatedAt(snapshot))) + '</strong></span><span>Configuration: ' + badge(config.valid === true ? 'passed' : config.valid === false ? 'failed' : 'unknown', config.valid === true ? 'Valid' : config.valid === false ? 'Invalid' : 'Not recorded') + '</span><span>Access: <strong>Read only</strong></span></div>';
      if (config.valid === false) body += '<div class="notice">' + escapeHtml(text(config.message, displayName(config.error))) + '</div>';
      body += '<div class="system-layout"><div class="system-column">' + panel('Execution policy', undefined, '<div class="panel-body">' + renderDefinitionList(scalarEntries(execution).map(function (entry) { return [displayName(entry[0].replace(/ /g, '_')).replace(/ ms$/, ''), / ms$/.test(entry[0]) ? formatDuration(entry[1]) : entry[1]]; })) + (isObject(execution.deadline) ? renderDefinitionList(scalarEntries(execution.deadline)) : '') + '</div>') + panel('Diagnostics', undefined, '<div class="panel-body">' + renderDefinitionList([["Retain completed runs", diagnostics.persist_runs === true ? 'Yes' : diagnostics.persist_runs === false ? 'No' : 'Not recorded'], ["Retention limit", diagnostics.max_runs], ["Available activity detail", 'Recorded summaries']]) + '</div>') + '</div>';
      body += '<div class="system-column">' + panel('Adapters', adapters.length, adapters.length ? '<div class="table-wrap"><table class="data-table adapters-table"><thead><tr><th>Adapter</th><th>Type</th><th>Credential variable</th><th>State</th></tr></thead><tbody>' + adapters.map(function (adapter) {
        var id = text(firstDefined(adapter.id, adapter.name));
        return '<tr class="' + (state.selectedAdapter === id ? 'is-selected' : '') + '"><td>' + selectButton('data-select-adapter', id, escapeHtml(id)) + '</td><td>' + escapeHtml(displayName(adapter.type)) + '</td><td class="mono">' + escapeHtml(array(adapter.credential_environment).map(function (entry) { return text(firstDefined(entry.name, entry.variable)); }).join(', ') || '—') + '</td><td>' + badge(adapterPresence(adapter).toLowerCase().replace(/ /g, '_'), adapterPresence(adapter)) + '</td></tr>';
      }).join('') + '</tbody></table></div>' : renderEmpty('No configured adapters', 'No adapter catalog was exposed in the safe snapshot.'));
      var locations = firstDefined(snapshot.locations, system.locations, config.locations, { config_path: config.config_path, runs_directory: config.runs_directory });
      body += panel('Data locations', undefined, '<div class="panel-body data-locations">' + scalarEntries(locations).filter(function (entry) { return typeof entry[1] === 'string'; }).map(function (entry) {
        return '<div class="location-row"><span>' + escapeHtml(displayName(entry[0])) + '</span><code>' + escapeHtml(entry[1]) + '</code><button type="button" class="icon-button copy-button" data-copy-value="' + escapeAttr(entry[1]) + '" aria-label="Copy ' + escapeAttr(entry[0]) + '" title="Copy path">⧉</button></div>';
      }).join('') + '</div>');
      body += '</div></div><div class="system-version">Configuration schema: ' + escapeHtml(text(config.schema_version, 'Not recorded')) + ' · Observer version: ' + escapeHtml(text(firstDefined(get(snapshot, ['server', 'version']), system.version), 'Not recorded')) + '</div>';
      return workspace(body, renderAdapterInspector(adapters.find(function (adapter) { return text(firstDefined(adapter.id, adapter.name)) === state.selectedAdapter; })));
    }
    function parseRoute() {
      var raw = (location.hash || '#/reviews').replace(/^#/, '').split('?');
      var parts = raw[0].split('/').filter(Boolean).map(safeDecode);
      var params = new URLSearchParams(raw[1] || '');
      var view = ['reviews', 'agents', 'reviewers', 'projects', 'system'].indexOf(parts[0]) >= 0 ? parts[0] : 'reviews';
      if (view === 'agents') view = 'reviewers';
      return { view: view, runId: view === 'reviews' && parts.length > 1 ? parts.slice(1).join('/') : '', tab: ['timeline', 'findings', 'events'].indexOf(params.get('tab')) >= 0 ? params.get('tab') : 'timeline', reviewerId: params.get('reviewer') || '', selected: params.get('selected') || '' };
    }
    function routeHash(route) {
      var hash = '#/' + route.view + (route.runId ? '/' + encodeURIComponent(route.runId) : '');
      var params = new URLSearchParams();
      if (route.runId && route.tab !== 'timeline') params.set('tab', route.tab);
      if (route.runId && route.reviewerId) params.set('reviewer', route.reviewerId);
      if (route.selected) params.set('selected', route.selected);
      return hash + (params.size ? '?' + params.toString() : '');
    }
    function setRoute(patch, replace) {
      var next = Object.assign({}, state.route || parseRoute(), patch);
      var hash = routeHash(next);
      if (replace) { history.replaceState(null, '', hash); handleRouteChange(); }
      else if (location.hash === hash) handleRouteChange();
      else location.hash = hash;
    }
    function setConnection(value) {
      state.connection = value;
      connection.dataset.state = value;
      var labels = { connecting: 'Connecting', live: 'Live stream', polling: 'Polling', offline: 'Offline' };
      var label = connection.querySelector('.connection-label');
      if (label) label.textContent = labels[value] || value;
      connection.title = value === 'live' ? 'Receiving local updates' : value === 'polling' ? 'Refreshing every two seconds' : labels[value] || value;
    }
    function setCrumbs() {
      var route = state.route || parseRoute();
      var separator = '<span class="crumb-sep" aria-hidden="true">' + icon('chevronRight') + '</span>';
      var label = route.view.charAt(0).toUpperCase() + route.view.slice(1);
      var detail = normalizeRunDetail();
      crumbs.innerHTML = '<a href="#/' + escapeAttr(route.view) + '">' + escapeHtml(label) + '</a>' + (route.runId ? separator + '<span class="crumb-current" title="' + escapeAttr(route.runId) + '">' + escapeHtml(detail && runId(detail) === route.runId ? runProject(detail) : route.runId) + '</span>' : '');
      document.querySelectorAll('[data-nav]').forEach(function (link) {
        var nav = link.dataset.nav === 'agents' ? 'reviewers' : link.dataset.nav;
        if (nav === route.view) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
      });
      document.title = (route.runId ? detail && runId(detail) === route.runId ? runProject(detail) : route.runId : label) + ' · Review Mesh';
    }
    function viewIdentity() {
      var route = state.route || parseRoute();
      return route.view + ':' + text(route.runId) + ':' + text(route.tab);
    }
    function assignFocusKeys() {
      var occurrences = new Map();
      app.querySelectorAll('a[href], button, input, select, textarea, summary, [tabindex]').forEach(function (element) {
        if (element.hasAttribute('data-focus-key')) return;
        var scope = element.closest('[data-scroll-key]');
        var identity = firstDefined(element.getAttribute('id'), element.getAttribute('href'), element.getAttribute('name'), element.getAttribute('data-copy-value'), element.getAttribute('aria-label'), element.textContent.trim());
        var key = 'semantic:' + text(scope && scope.getAttribute('data-scroll-key')) + ':' + element.tagName + ':' + text(identity);
        var occurrence = occurrences.get(key) || 0;
        occurrences.set(key, occurrence + 1);
        element.setAttribute('data-focus-key', key + ':' + occurrence);
      });
    }
    function captureViewState() {
      var active = document.activeElement;
      var focus = active && app.contains(active) ? { key: active.getAttribute('data-focus-key'), start: active.selectionStart, end: active.selectionEnd, direction: active.selectionDirection } : null;
      var scroll = {};
      app.querySelectorAll('[data-scroll-key]').forEach(function (element) { scroll[element.getAttribute('data-scroll-key')] = [element.scrollTop, element.scrollLeft]; });
      var expandedDetails = [];
      app.querySelectorAll('details[open]').forEach(function (element) { var summary = element.querySelector('summary'); if (summary) expandedDetails.push(summary.textContent); });
      return { focus: focus, scroll: scroll, expandedDetails: expandedDetails, view: app.getAttribute('data-rendered-view') };
    }
    function restoreViewState(saved) {
      app.querySelectorAll('[data-scroll-key]').forEach(function (element) {
        var position = saved.scroll[element.getAttribute('data-scroll-key')];
        if (position) { element.scrollTop = position[0]; element.scrollLeft = position[1]; }
      });
      app.querySelectorAll('details').forEach(function (element) { var summary = element.querySelector('summary'); if (summary && saved.expandedDetails.indexOf(summary.textContent) >= 0) element.open = true; });
      if (saved.focus && saved.focus.key && saved.view === viewIdentity()) {
        var target = Array.from(app.querySelectorAll('[data-focus-key]')).find(function (element) { return element.getAttribute('data-focus-key') === saved.focus.key; });
        if (target) {
          target.focus({ preventScroll: true });
          if (typeof target.setSelectionRange === 'function' && saved.focus.start !== null && saved.focus.start !== undefined) {
            try { target.setSelectionRange(saved.focus.start, saved.focus.end, saved.focus.direction); } catch (_) {}
          }
        }
      }
    }
    function render(options) {
      options = options || {};
      if (!app) return;
      var saved = captureViewState();
      if (state.snapshotLoading && !state.snapshot) app.innerHTML = '<div class="view-scroll" aria-label="Loading dashboard"><div class="skeleton"></div><div class="skeleton"></div></div>';
      else if (state.snapshotError && !state.snapshot) app.innerHTML = renderError('Dashboard snapshot unavailable', state.snapshotError);
      else {
        var route = state.route || parseRoute();
        app.innerHTML = route.view === 'reviewers' ? renderAgents() : route.view === 'projects' ? renderProjects() : route.view === 'system' ? renderSystem() : route.runId ? renderRunDetail() : renderReviews();
        if (state.snapshotError) {
          var scroller = app.querySelector('.view-scroll');
          if (scroller) scroller.insertAdjacentHTML('afterbegin', '<div class="notice" role="status">Showing the last received snapshot. ' + escapeHtml(state.snapshotError) + '</div>');
        }
        app.querySelectorAll('table').forEach(function (table) {
          var headings = Array.from(table.querySelectorAll('thead th')).map(function (heading) { return heading.textContent.replace(/[↑↓]/g, '').trim(); });
          table.querySelectorAll('tbody tr').forEach(function (row) { Array.from(row.children).forEach(function (cell, index) { if (cell.tagName === 'TD') cell.setAttribute('data-label', cell.classList.contains('phase-cell') ? 'Phase' : headings[index] || ''); }); });
        });
      }
      assignFocusKeys();
      restoreViewState(saved);
      app.setAttribute('data-rendered-view', viewIdentity());
      setCrumbs();
      if (options.follow && state.followLatest && state.route && state.route.tab === 'events') {
        var events = app.querySelector('.event-table-wrap');
        var view = app.querySelector('.view-scroll');
        if (events && events.scrollHeight > events.clientHeight) events.scrollTop = events.scrollHeight;
        if (view) view.scrollTop = view.scrollHeight;
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
        var previousEvents = eventsOf(normalizeRunDetail());
        var next = isObject(detail) ? detail : {};
        var nextEvents = eventsOf(next);
        var newEvents = nextEvents.length && (!previousEvents.length || eventId(nextEvents[nextEvents.length - 1], nextEvents.length - 1) !== eventId(previousEvents[previousEvents.length - 1], previousEvents.length - 1));
        state.runDetail = next;
        state.runLoading = false;
        if (shouldRender !== false) render({ follow: newEvents });
        if (state.route.reviewerId) await loadReviewer(id, state.route.reviewerId, true);
      } catch (error) {
        if (generation !== state.requestGeneration || !state.route || state.route.runId !== id) return;
        state.runError = error instanceof Error ? error.message : String(error);
        scheduleRefreshRetry();
      } finally {
        if (generation === state.requestGeneration) { state.runLoading = false; if (shouldRender !== false) render(); }
      }
    }
    async function loadReviewer(run, reviewer, preserve) {
      var generation = ++state.reviewerGeneration;
      var key = run + ':' + reviewer;
      state.reviewerLoading = true;
      state.reviewerError = null;
      if (!preserve || state.reviewerKey !== key) state.reviewerDetail = null;
      state.reviewerKey = key;
      render();
      try {
        var detail = await fetchJson(API.reviewer(run, reviewer));
        if (generation !== state.reviewerGeneration || !state.route || state.route.runId !== run || state.route.reviewerId !== reviewer) return;
        state.reviewerDetail = isObject(detail) ? detail : {};
      } catch (error) {
        if (generation !== state.reviewerGeneration || !state.route || state.route.runId !== run || state.route.reviewerId !== reviewer) return;
        state.reviewerError = error instanceof Error ? error.message : String(error);
        scheduleRefreshRetry();
      } finally {
        if (generation === state.reviewerGeneration) { state.reviewerLoading = false; render(); }
      }
    }
    async function refreshSnapshot(options) {
      options = options || {};
      if (state.refreshPromise) { state.refreshQueued = true; return state.refreshPromise; }
      state.refreshPromise = (async function () {
        refreshButton.disabled = true;
        do {
          state.refreshQueued = false;
          if (state.snapshotRetryTimer) { window.clearTimeout(state.snapshotRetryTimer); state.snapshotRetryTimer = null; }
          try {
            var snapshot = await fetchJson(API.snapshot);
            state.snapshot = isObject(snapshot) ? snapshot : {};
            state.snapshotError = null;
            state.snapshotLoading = false;
            if (state.eventSource && state.connection === 'offline') setConnection('live');
            render();
            if (state.route && state.route.runId && options.includeDetail !== false) await loadRun(state.route.runId, true);
          } catch (error) {
            state.snapshotError = error instanceof Error ? error.message : String(error);
            if (state.connection !== 'polling') setConnection('offline');
            state.refreshQueued = false;
            scheduleRefreshRetry();
            break;
          } finally {
            state.snapshotLoading = false;
            render();
          }
        } while (state.refreshQueued);
        if (options.announce && !state.snapshotError) showToast('Dashboard refreshed.');
      }());
      try { await state.refreshPromise; } finally {
        state.refreshPromise = null;
        refreshButton.disabled = false;
        if (state.refreshQueued) scheduleRefresh();
      }
    }
    async function handleRouteChange() {
      var previous = state.route;
      var route = parseRoute();
      state.route = route;
      if (route.view === 'reviewers' && route.selected) state.selectedAgent = route.selected;
      if (!previous || previous.runId !== route.runId) {
        state.requestGeneration += 1;
        state.reviewerGeneration += 1;
        state.runDetail = null;
        state.runError = null;
        state.reviewerDetail = null;
        state.reviewerError = null;
        state.reviewerKey = '';
        state.selectedFinding = '';
        state.selectedEvent = '';
      }
      if (!previous || previous.reviewerId !== route.reviewerId) {
        state.reviewerGeneration += 1;
        state.reviewerDetail = null;
        state.reviewerError = null;
        state.reviewerLoading = false;
        state.reviewerKey = '';
        state.inspectorTabs.reviewer = state.pendingReviewerTab || 'activity';
        state.pendingReviewerTab = '';
      }
      render();
      if (route.runId && (!state.runDetail || !previous || previous.runId !== route.runId)) await loadRun(route.runId, true);
      else if (route.reviewerId && (!previous || previous.reviewerId !== route.reviewerId)) await loadReviewer(route.runId, route.reviewerId, false);
    }
    function closeInspector() {
      var route = state.route || {};
      if (route.runId && route.tab === 'timeline' && route.reviewerId) setRoute({ reviewerId: '' }, true);
      else if (route.runId && route.tab === 'findings') { state.selectedFinding = ''; render(); }
      else if (route.runId && route.tab === 'events') { state.selectedEvent = ''; render(); }
      else if (route.view === 'reviewers') { state.selectedAgent = ''; render(); }
      else if (route.view === 'projects') { state.selectedProject = ''; render(); }
      else if (route.view === 'system') { state.selectedAdapter = ''; render(); }
      else { state.selectedRun = ''; render(); }
      if (state.lastFocusedKey) {
        var target = Array.from(app.querySelectorAll('[data-focus-key]')).find(function (element) { return element.getAttribute('data-focus-key') === state.lastFocusedKey; });
        if (target) target.focus({ preventScroll: true });
      }
    }
    function resizeInspector(height) {
      var panel = app.querySelector('.dock-panel');
      if (!panel) return;
      var separator = panel.querySelector('.dock-resizer');
      var maximum = Number(separator.getAttribute('aria-valuemax')) || 640;
      state.inspectorHeight = Math.round(Math.max(160, Math.min(maximum, height)));
      panel.style.height = state.inspectorHeight + 'px';
      separator.setAttribute('aria-valuenow', String(state.inspectorHeight));
      try { window.sessionStorage.setItem('review-mesh.inspector-height', String(state.inspectorHeight)); } catch (_) {}
    }
    document.addEventListener('click', function (event) {
      var target = event.target instanceof Element ? event.target : null;
      if (!target) return;
      if (target.closest('.skip-link[href="#main-content"]')) {
        event.preventDefault();
        var mainContent = document.getElementById('main-content');
        if (mainContent) mainContent.focus({ preventScroll: true });
        return;
      }
      var selection = target.closest('[data-select-run], [data-select-finding], [data-select-event], [data-select-agent], [data-select-project], [data-select-adapter], [data-open-reviewer]');
      if (selection) {
        state.lastFocusedKey = selection.getAttribute('data-focus-key');
        if (selection.hasAttribute('data-open-reviewer')) {
          state.pendingReviewerTab = selection.getAttribute('data-reviewer-tab') || '';
          if (state.pendingReviewerTab && state.route.reviewerId === selection.getAttribute('data-open-reviewer')) state.inspectorTabs.reviewer = state.pendingReviewerTab;
          setRoute({ view: 'reviews', runId: selection.getAttribute('data-run-id') || '', reviewerId: selection.getAttribute('data-open-reviewer') || '', tab: selection.getAttribute('data-target-tab') || 'timeline', selected: '' });
          return;
        }
        var selections = [['run', 'selectedRun'], ['finding', 'selectedFinding'], ['event', 'selectedEvent'], ['agent', 'selectedAgent'], ['project', 'selectedProject'], ['adapter', 'selectedAdapter']];
        selections.forEach(function (entry) { if (selection.hasAttribute('data-select-' + entry[0])) state[entry[1]] = selection.getAttribute('data-select-' + entry[0]); });
        render(); return;
      }
      var tab = target.closest('[data-run-tab]');
      if (tab) { setRoute({ tab: tab.getAttribute('data-run-tab') }); return; }
      var inspector = target.closest('[data-inspector-tab]');
      if (inspector) { state.inspectorTabs[inspector.getAttribute('data-inspector-kind')] = inspector.getAttribute('data-inspector-tab'); render(); return; }
      if (target.closest('[data-close-inspector]')) { closeInspector(); return; }
      var lens = target.closest('[data-toggle-lens]');
      if (lens) { var lensKey = state.route.runId + ':' + lens.getAttribute('data-toggle-lens'); state.expandedLenses[lensKey] = !state.expandedLenses[lensKey]; render(); return; }
      var heartbeat = target.closest('[data-toggle-heartbeats]');
      if (heartbeat) { var groupKey = state.route.runId + ':' + heartbeat.getAttribute('data-toggle-heartbeats'); state.expandedHeartbeats[groupKey] = !state.expandedHeartbeats[groupKey]; render(); return; }
      var sort = target.closest('[data-run-sort]');
      if (sort) { var key = sort.getAttribute('data-run-sort'); state.runSortDirection = state.runSort === key ? -state.runSortDirection : key === 'finished' || key === 'duration' ? -1 : 1; state.runSort = key; render(); return; }
      var copy = target.closest('[data-copy-value]');
      if (copy) {
        var value = copy.getAttribute('data-copy-value') || '';
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(value).then(function () { showToast('Path copied.'); }, function () { showToast('Copy was unavailable. Select the displayed path to copy it.'); });
        else showToast('Copy was unavailable. Select the displayed path to copy it.');
      }
    });
    function onFilter(event) {
      var target = event.target;
      if (!(target instanceof Element)) return;
      if (target.hasAttribute('data-filter')) { state.filters[target.getAttribute('data-filter')] = target.value; render(); }
      if (target.hasAttribute('data-follow-latest')) { state.followLatest = target.checked === true; render({ follow: state.followLatest }); }
    }
    document.addEventListener('input', onFilter);
    document.addEventListener('change', function (event) { if (event.target instanceof Element && (event.target.tagName === 'SELECT' || event.target.hasAttribute('data-follow-latest'))) onFilter(event); });
    document.addEventListener('keydown', function (event) {
      var target = event.target instanceof Element ? event.target : null;
      if (target && target.classList.contains('dock-resizer') && ['ArrowUp', 'ArrowDown', 'Home', 'End'].indexOf(event.key) >= 0) {
        event.preventDefault();
        var value = Number(target.getAttribute('aria-valuenow'));
        resizeInspector(event.key === 'Home' ? 160 : event.key === 'End' ? Number(target.getAttribute('aria-valuemax')) : value + (event.key === 'ArrowUp' ? 24 : -24));
        return;
      }
      var tab = target ? target.closest('[role="tab"]') : null;
      if (tab && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].indexOf(event.key) >= 0) {
        var list = tab.closest('[role="tablist"]');
        var tabs = list ? Array.from(list.querySelectorAll('[role="tab"]')) : [];
        var current = tabs.indexOf(tab);
        if (current >= 0 && tabs.length) {
          event.preventDefault();
          var next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (current + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
          var focusKey = tabs[next].getAttribute('data-focus-key');
          tabs[next].focus(); tabs[next].click();
          window.setTimeout(function () { var replacement = Array.from(app.querySelectorAll('[data-focus-key]')).find(function (element) { return element.getAttribute('data-focus-key') === focusKey; }); if (replacement) replacement.focus({ preventScroll: true }); }, 0);
        }
        return;
      }
      if (event.key === 'Escape') closeInspector();
    });
    var drag = null;
    document.addEventListener('pointerdown', function (event) {
      var target = event.target instanceof Element ? event.target.closest('.dock-resizer') : null;
      if (!target || event.button !== 0) return;
      event.preventDefault();
      target.focus({ preventScroll: true });
      drag = { pointer: event.pointerId, y: event.clientY, height: Number(target.getAttribute('aria-valuenow')) };
      document.body.classList.add('resizing-inspector');
      try { target.setPointerCapture(event.pointerId); } catch (_) {}
    });
    document.addEventListener('pointermove', function (event) { if (drag && event.pointerId === drag.pointer) { event.preventDefault(); resizeInspector(drag.height + drag.y - event.clientY); } });
    function stopResize() { drag = null; document.body.classList.remove('resizing-inspector'); }
    document.addEventListener('pointerup', stopResize);
    document.addEventListener('pointercancel', stopResize);
    refreshButton.addEventListener('click', function () { refreshSnapshot({ announce: true, includeDetail: true }); });
    window.addEventListener('hashchange', handleRouteChange);
    window.addEventListener('resize', function () { if (!drag) render(); });
    document.addEventListener('visibilitychange', function () { if (!document.hidden && state.connection === 'polling') refreshSnapshot({ includeDetail: true }); });
    state.route = parseRoute();
    if (state.route.view === 'reviewers' && state.route.selected) state.selectedAgent = state.route.selected;
    if (!location.hash) history.replaceState(null, '', '#/reviews');
    render();
    refreshSnapshot({ includeDetail: true }).then(connectStream);
  }());
`;
