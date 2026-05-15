async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
  return res.json();
}

async function fetchText(url) {
  const res = await fetch(url);
  if (!res.ok) return null;
  return res.text();
}

function flagChip(value) {
  const v = Number(value);
  if (v === 0 || value === false) return '<span class="flag ok">No</span>';
  return '<span class="flag danger">Yes</span>';
}

function hasAnyFlag(row) {
  return (
    Number(row.has_commits_before_t0) > 0 ||
    Number(row.has_bulk_commits) > 0 ||
    Number(row.has_large_initial_commit_after_t0) > 0 ||
    Number(row.has_merge_commits) > 0
  );
}

function formatNumber(num) {
  const n = Number(num) || 0;
  if (n >= 1000000) return (n / 1000000).toFixed(1) + "M";
  if (n >= 1000) return (n / 1000).toFixed(1) + "K";
  return n.toString();
}

function updateStats(rows) {
  const total = rows.length;
  const tracked = rows.filter((r) => r.submission_status !== "missing").length;
  const analyzed = rows.filter((r) => r.analysis_status === "analyzed").length;
  const flagged = rows.filter(
    (r) => r.analysis_status === "analyzed" && hasAnyFlag(r)
  ).length;
  const clean = rows.filter(
    (r) => r.analysis_status === "analyzed" && !hasAnyFlag(r)
  ).length;

  // Calculate total commits and LoC
  const totalCommits = rows.reduce(
    (sum, r) => sum + (Number(r.total_commits) || 0),
    0
  );
  const totalLocAdded = rows.reduce(
    (sum, r) => sum + (Number(r.total_loc_added) || 0),
    0
  );
  const totalLocDeleted = rows.reduce(
    (sum, r) => sum + (Number(r.total_loc_deleted) || 0),
    0
  );
  const totalLoc = totalLocAdded + totalLocDeleted;

  const setText = (id, value) => {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  };
  setText("stat-total", total);
  setText("stat-tracked", tracked);
  setText("stat-analyzed", analyzed);
  setText("stat-flagged", flagged);
  setText("stat-clean", clean);
  setText("stat-commits", formatNumber(totalCommits));
  setText("stat-loc", formatNumber(totalLoc));
  setText("submissions-count", total);
}

function extractRepoName(repoUrl) {
  const match = repoUrl.match(/github\.com\/([^\/]+\/[^\/]+?)(?:\.git)?$/);
  if (match) return match[1];
  return repoUrl;
}

// Judge data cache
let judgeMap = new Map();
let submissionMap = new Map();
let judgeCurrentIndex = 0;

function normalizeRepoKey(repoUrl = "") {
  return repoUrl
    .trim()
    .replace(/\.git$/i, "")
    .toLowerCase();
}

/** Load before submission/judge merges so cohort scoping matches config. */
let eventFormat = null;
let hacksIndex = { hacks: [], active_hack_id: null };

function getActiveHackId() {
  return (
    hacksIndex.active_hack_id ||
    (eventFormat && eventFormat.hack_id) ||
    "cursor-live-london-q3-2026"
  );
}

// ---------- Judge delegation (deterministic hash-based assignment) ----------
//
// Each submission is deterministically assigned to one judge in the configured
// judge pool via `djb2(repo_url) % numJudges`. With N judges and S submissions,
// each judge gets roughly S/N (e.g. 60/5 = 12). The current judge identifies
// themselves by typing their name into the auth gate; we fuzzy-match it
// against the judge pool from `event-format.json`.

function djb2Hash(str) {
  let h = 5381;
  const s = String(str || "");
  for (let i = 0; i < s.length; i++) {
    h = (((h << 5) + h) ^ s.charCodeAt(i)) >>> 0;
  }
  return h >>> 0;
}

function normalizeJudgeName(s) {
  return String(s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

/**
 * Bidirectional fuzzy match — same logic as getJudgeIndex but for any pair.
 * Handles "Jan" ↔ "Ján Stehlík" (substring). Used by coverage view so a
 * panel judge's chip turns green even when they typed a short form.
 */
function judgeMatchesPool(typedName, poolName) {
  const a = normalizeJudgeName(typedName);
  const b = normalizeJudgeName(poolName);
  if (!a || !b) return false;
  if (a === b) return true;
  return a.includes(b) || b.includes(a);
}

function getJudgePool() {
  const list = eventFormat && Array.isArray(eventFormat.judges) ? eventFormat.judges : [];
  return list.filter((j) => j && j.name);
}

/** -1 if the typed name doesn't match any configured judge. */
function getJudgeIndex(judgeName) {
  const pool = getJudgePool();
  if (!pool.length) return -1;
  const target = normalizeJudgeName(judgeName);
  if (!target) return -1;
  const exact = pool.findIndex((j) => normalizeJudgeName(j.name) === target);
  if (exact !== -1) return exact;
  const partial = pool.findIndex((j) => {
    const n = normalizeJudgeName(j.name);
    return n.includes(target) || target.includes(n);
  });
  return partial;
}

function entryAssignmentKey(entry) {
  const row = entry && entry.row;
  const sub = entry && entry.sub;
  return (
    normalizeRepoKey((sub && sub.repo_url) || (row && row.repo) || "") ||
    (sub && sub.submission_id) ||
    (sub && sub.project_name) ||
    (entry && entry.id) ||
    ""
  );
}

/**
 * Balanced round-robin assignment: sort all entries by stable key, then
 * assign sortedIndex(i) → judges[i % N]. Each judge gets ⌈S/N⌉ or ⌊S/N⌋
 * submissions (e.g. 60/5 = 12 each). Mutates entries in-place to attach
 * `assignedJudge` and `assignedIndex`.
 */
function assignJudgesBalanced(entries) {
  const pool = getJudgePool();
  if (!pool.length || !entries.length) {
    entries.forEach((e) => {
      e.assignedJudge = "";
      e.assignedIndex = -1;
    });
    return;
  }
  // Stable sort by assignment key (alphabetical) — deterministic across reloads.
  const sorted = entries
    .map((entry, originalIdx) => ({ entry, originalIdx, key: entryAssignmentKey(entry) }))
    .sort((a, b) => {
      if (a.key < b.key) return -1;
      if (a.key > b.key) return 1;
      return a.originalIdx - b.originalIdx;
    });
  sorted.forEach((s, sortedIdx) => {
    const judgeIdx = sortedIdx % pool.length;
    s.entry.assignedIndex = judgeIdx;
    s.entry.assignedJudge = pool[judgeIdx]?.name || "";
  });
}

function isAssignedToCurrentJudge(entry) {
  const me = getJudgeIndex(getJudgeNameForUi());
  if (me === -1) return true; // Unknown judge → don't filter (managers, guests)
  return entry && entry.assignedIndex === me;
}

function isJudgeMineOnlyChecked() {
  const cb = document.getElementById("judge-mine-only");
  if (!cb) return false; // Default OFF — judges self-coordinate via coverage view
  return !!cb.checked;
}

/** Names of judges (configured + walk-in) who scored this submission. */
function scoredJudgeNamesForRow(row) {
  const info = getJudgeInfoForRow(row);
  if (!info || !Array.isArray(info.responses)) return [];
  const seen = new Set();
  const out = [];
  info.responses.forEach((r) => {
    const raw = String(r.judge_name || r.judge || "").trim();
    if (!raw) return;
    const k = normalizeJudgeName(raw);
    if (seen.has(k)) return;
    seen.add(k);
    out.push(raw);
  });
  return out;
}

/**
 * Belt-and-braces cutoff: even if a stale row was tagged with the active
 * hack_id, drop it unless `submitted_at` is on/after the event start.
 * Today's London event opened 2026-04-30 UTC. Earlier London hackathon
 * (April 2, 2026) rows live in the same table and must be excluded.
 */
const EVENT_CUTOFF_AT_MS = Date.UTC(2026, 3, 30, 0, 0, 0); // 2026-04-30T00:00:00Z

function submissionWithinEventWindow(sub) {
  const t = sub && (sub.submitted_at || sub.timestamp);
  if (!t) return true; // missing timestamp → don't drop
  const ms = Date.parse(t);
  if (Number.isNaN(ms)) return true;
  return ms >= EVENT_CUTOFF_AT_MS;
}

function submissionMatchesActiveHack(sub) {
  if (!sub || typeof sub !== "object") return false;
  const active = String(getActiveHackId() || "").trim();
  const h = String(sub.hack_id || "").trim();
  let hackOk;
  if (h) hackOk = h === active;
  // Legacy rows from API: only `hackathon_id` (UUID). GET is scoped to the default hackathon.
  else if (String(sub.hackathon_id || "").trim()) hackOk = !!active;
  else hackOk = false;
  if (!hackOk) return false;
  return submissionWithinEventWindow(sub);
}

function hackStorageSlug() {
  const id = String(getActiveHackId() || "hack").trim();
  const s = slugify(id.replace(/[^\w\s-]/g, " "));
  return s || "hack";
}

function localSubmissionsKey() {
  return `hack-${hackStorageSlug()}-submissions`;
}

function localScoresKey() {
  return `hack-${hackStorageSlug()}-scores`;
}

function localJudgeNameKey() {
  return `hack-${hackStorageSlug()}-judge-name`;
}

function slugify(value = "") {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Match summary rows whether repo_id is slug-style or github org/repo style. */
function canonicalRepoRowSlug(row) {
  if (!row) return "";
  const rid = (row.repo_id && String(row.repo_id).trim()) || "";
  if (rid) return slugify(rid);
  const ex = extractRepoName(row.repo || "");
  return ex ? slugify(ex) : "";
}

function findSummaryRowForRepoId(repoId) {
  const needle = slugify(String(repoId || "").trim());
  if (!needle) return undefined;
  return (window.__summaryRows || []).find(
    (r) => canonicalRepoRowSlug(r) === needle
  );
}

/** Encode repo id for /api/repo/:id/... paths (repo_id may contain reserved URL chars). */
function encodeRepoApiSegment(repoId) {
  return encodeURIComponent(String(repoId || "").trim());
}

async function loadJudgeData() {
  try {
    const data = await fetchJSON("/api/judges");
    const map = new Map();
    if (data && data.by_repo) {
      for (const [repoUrl, info] of Object.entries(data.by_repo)) {
        const key = normalizeRepoKey(repoUrl);
        map.set(key, info);
        // Also store raw repoUrl as-is for exact matches
        map.set(normalizeRepoKey(repoUrl.replace(/\.git$/i, "")), info);
      }
    }
    judgeMap = map;
  } catch (err) {
    console.error("Failed to load judge data", err);
    judgeMap = new Map();
  }
}

async function loadSubmissionData() {
  try {
    const data = await fetchJSON("/api/submissions");
    const map = new Map();
    for (const submission of data.submissions || []) {
      if (!submissionMatchesActiveHack(submission)) continue;
      if (submission.repo_url) {
        map.set(normalizeRepoKey(submission.repo_url), submission);
      }
      if (submission.submission_id) {
        map.set(`submission:${submission.submission_id}`, submission);
      }
    }
    submissionMap = map;
  } catch (err) {
    console.error("Failed to load submission data", err);
    submissionMap = new Map();
  }
}

// Cache for AI summaries
const aiCache = new Map();

async function fetchAISummary(repoId) {
  if (aiCache.has(repoId)) return aiCache.get(repoId);
  const seg = encodeRepoApiSegment(repoId);
  const text = await fetchText(`/api/repo/${seg}/ai`);
  aiCache.set(repoId, text);
  return text;
}

function getAIPreview(aiText) {
  if (!aiText) return '<span class="ai-preview no-data">No AI analysis</span>';
  // Get first two sentences or first 150 chars
  const sentences = aiText
    .split(/(?<=[.!?])\s+/)
    .slice(0, 2)
    .join(" ");
  const preview =
    sentences.length > 180 ? sentences.slice(0, 180) + "…" : sentences;
  return `<span class="ai-preview">${escapeHtml(preview)}</span>`;
}

function extractVerdict(aiText) {
  if (!aiText)
    return { icon: "⏳", class: "pending", full: "Pending analysis" };

  const verdictMatch = aiText.match(
    /Overall authenticity assessment:\s*(.+?)$/im
  );
  if (!verdictMatch)
    return { icon: "⏳", class: "pending", full: "No assessment found" };

  const verdict = verdictMatch[1].trim();
  const isAuthentic = /consistent|authentic|legitimate/i.test(verdict);
  const isSuspicious = /suspicious|concern|flag|issue|question/i.test(verdict);

  if (isSuspicious) {
    return { icon: "⚠️", class: "suspicious", full: verdict };
  } else if (isAuthentic) {
    return { icon: "✅", class: "authentic", full: verdict };
  }
  return { icon: "➖", class: "neutral", full: verdict };
}

function getVerdictBadge(aiText) {
  const verdict = extractVerdict(aiText);
  return `<span class="verdict-icon ${verdict.class}" title="${escapeHtml(
    verdict.full
  )}">${verdict.icon}</span>`;
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

function escapeAttr(text) {
  return (text || "")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function humanizeKey(text) {
  return String(text || "")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function getJudgeInfoForRow(row) {
  if (!row) return null;
  const key = normalizeRepoKey(row.repo || "");
  return (
    judgeMap.get(key) ||
    judgeMap.get(normalizeRepoKey(row.repo || "").replace(/\.git$/i, ""))
  );
}

function getSubmissionInfoForRow(row) {
  if (!row) return null;
  const repoKey = normalizeRepoKey(row.repo || row.repo_url || "");
  if (repoKey && submissionMap.has(repoKey)) return submissionMap.get(repoKey);
  if (row.repo_id && submissionMap.has(`submission:${row.repo_id}`))
    return submissionMap.get(`submission:${row.repo_id}`);
  if (
    row.project_name != null ||
    row.team_name != null ||
    row.chosen_track != null ||
    row.demo_url != null
  ) {
    return row;
  }
  return null;
}

function analysisStatusChip(row) {
  if (row.analysis_status === "analyzed")
    return '<span class="status-chip status-chip--analyzed">Analyzed</span>';
  return '<span class="status-chip status-chip--pending">Submitted</span>';
}

function trackChip(track) {
  if (!track)
    return '<span class="track-chip track-chip--empty" aria-label="Unassigned track">—</span>';
  return `<span class="track-chip">${escapeHtml(track)}</span>`;
}

function normalizeTrackForMatch(track) {
  return String(track || "")
    .toLowerCase()
    .replace(/_/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Match submission track labels to Buy-Side vs Sell-Side & Measurement.
 *
 * Internal category keys ("money-movement" / "financial-intelligence") are
 * preserved because they're hard-coded into element IDs in the manager UI;
 * they map to the new track names below. Old finance labels are accepted
 * for backward compatibility with archived submissions.
 */
function trackMatchesCategory(track, category) {
  if (!category) return true;
  if (!track) return false;
  const t = normalizeTrackForMatch(track);
  const slug = t.replace(/\s+/g, "-");
  // category "money-movement" is the internal key for Buy-Side Agents
  if (category === "money-movement") {
    if (
      slug.includes("buy-side") ||
      slug.includes("buyside") ||
      slug.includes("ad-buyer") ||
      slug.includes("advertiser")
    )
      return true;
    if (
      slug.includes("sell-side") ||
      slug.includes("publisher") ||
      slug.includes("measurement")
    )
      return false;
    // legacy
    if (slug.includes("money-movement") || slug.includes("moneymovement"))
      return true;
    if (slug.includes("financial-intelligence")) return false;
    return /\bbuy\b/.test(t) || /\bbidder\b/.test(t);
  }
  // category "financial-intelligence" is the internal key for Sell-Side & Measurement
  if (category === "financial-intelligence") {
    if (
      slug.includes("sell-side") ||
      slug.includes("sellside") ||
      slug.includes("publisher") ||
      slug.includes("measurement") ||
      slug.includes("attribution")
    )
      return true;
    if (slug.includes("buy-side") || slug.includes("advertiser")) return false;
    // legacy
    if (
      slug.includes("financial-intelligence") ||
      slug.includes("financialintelligence")
    )
      return true;
    if (slug.includes("money-movement")) return false;
    return /\bsell\b/.test(t) || /\bmeasure\b/.test(t);
  }
  return true;
}

function getRowTrackLabel(row) {
  const sub = getSubmissionInfoForRow(row);
  return (sub?.chosen_track || row.chosen_track || "").trim();
}

function demoLink(submission) {
  if (!submission || !submission.demo_url) return "";
  return `<a class="repo-link" href="${escapeAttr(
    submission.demo_url
  )}" target="_blank" rel="noreferrer">Demo</a>`;
}

function repoLink(url) {
  if (!url) return "";
  return `<a class="repo-link" href="${escapeAttr(
    url
  )}" target="_blank" rel="noreferrer">Repo</a>`;
}

function repoUrlForRow(row) {
  if (!row) return "";
  const sub = getSubmissionInfoForRow(row);
  return String(row.repo || sub?.repo_url || "").trim();
}

function lbNameCell(row, displayName) {
  const url = repoUrlForRow(row);
  const safe = escapeHtml(displayName);
  if (url) {
    return `<a class="lb-name lb-name--link" href="${escapeAttr(
      url
    )}" target="_blank" rel="noreferrer">${safe}</a>`;
  }
  return `<span class="lb-name">${safe}</span>`;
}

function buildJudgeTooltip(info) {
  if (!info || !info.responses || info.responses.length === 0)
    return "No judge responses";
  const parts = info.responses.map((r, idx) => {
    const thought = r.notes
      ? ` — ${r.notes}`
      : r.thoughts
      ? ` — ${r.thoughts}`
      : "";
    if (info.legacy_mode) {
      return `#${idx + 1}: ${r.total_score}${thought}`;
    }
    return `#${idx + 1}: ${r.total_score}/10 (core ${r.core_total}, bonus ${
      r.bonus_total_capped
    })${thought}`;
  });
  return parts.join("\n");
}

function renderJudgeCell(info) {
  if (!info || !info.responses || info.responses.length === 0) {
    return '<span class="judge-chip no-data">—</span>';
  }
  const avg = Number(
    (info.averages && info.averages.grand_total) ?? info.average_score ?? 0
  ).toFixed(1);
  const cap = info.legacy_mode ? "" : '<span class="judge-count">/10</span>';
  const tooltip = escapeAttr(buildJudgeTooltip(info));
  return `<span class="judge-chip" title="${tooltip}">${avg}${cap}<span class="judge-count"> · ${info.responses.length}</span></span>`;
}

function judgeImportResponsesListHtml(info) {
  if (!info?.responses?.length) return "";
  return info.responses
    .map((r, idx) => {
      const thought = r.thoughts
        ? `<div class="judge-thought">${escapeHtml(r.thoughts)}</div>`
        : "";
      const scoreLine = info.legacy_mode
        ? `#${idx + 1} • ${r.total_score}`
        : `#${idx + 1} • ${r.total_score}/10 (core ${r.core_total}, bonus ${
            r.bonus_total_capped
          })`;
      return `<div class="judge-row"><div class="judge-score-pill">${scoreLine}</div>${thought}</div>`;
    })
    .join("");
}

function judgeAggregateBlockHtml(info) {
  if (!info || !info.responses || info.responses.length === 0) {
    return "";
  }
  const grandAvg = Number(
    (info.averages && info.averages.grand_total) ?? info.average_score ?? 0
  ).toFixed(1);
  const coreAvg = Number(
    (info.averages && info.averages.core_total) ?? info.average_score ?? 0
  ).toFixed(1);
  const bonusAvg = Number(
    (info.averages && info.averages.bonus_total) ?? 0
  ).toFixed(1);
  const criterionList = info.legacy_mode
    ? ""
    : Object.entries(info.averages.core_scores || {})
        .map(
          ([key, value]) =>
            `<div class="judge-row"><div class="judge-score-pill">${escapeHtml(
              humanizeKey(key)
            )}</div><div class="judge-thought">${Number(value).toFixed(
              1
            )} avg</div></div>`
        )
        .join("");
  const bonusList = info.legacy_mode
    ? ""
    : Object.entries(info.averages.bonus_bucket_scores || {})
        .map(
          ([key, value]) =>
            `<div class="judge-row"><div class="judge-score-pill">${escapeHtml(
              humanizeKey(key)
            )}</div><div class="judge-thought">${Number(value).toFixed(
              1
            )} avg</div></div>`
        )
        .join("");
  return `
    <div class="judge-summary">
      <div class="judge-score-pill highlight" title="Average of imported judge scores (${info.responses.length} response${info.responses.length !== 1 ? "s" : ""})."><span class="judge-score-avg-label">Avg</span> ${grandAvg}${
    info.legacy_mode ? "" : "/10"
  }</div>
      <div class="judge-meta">${info.responses.length} response${
    info.responses.length !== 1 ? "s" : ""
  }</div>
    </div>
    ${
      info.legacy_mode
        ? ""
        : `
      <div class="judge-summary">
        <div class="judge-score-pill">Core ${coreAvg}/7</div>
        <div class="judge-score-pill">Bonus ${bonusAvg}/3</div>
      </div>
      <div class="judge-list">${criterionList}</div>
      <div class="judge-list">${bonusList}</div>
    `
    }`;
}

function renderJudgeDetails(info, containerEl) {
  const container =
    containerEl || document.getElementById("judge-output");
  if (!info || !info.responses || info.responses.length === 0) {
    container.innerHTML =
      '<div class="empty-state"><div class="empty-state-icon">🧑‍⚖️</div><div>No judge responses</div></div>';
    return;
  }
  const list = judgeImportResponsesListHtml(info);
  container.innerHTML = `${judgeAggregateBlockHtml(info)}<div class="judge-list">${list}</div>`;
}

async function renderSummaryTable(rows) {
  const tbody = document.querySelector("#summary-table tbody");
  if (!tbody) return;
  tbody.innerHTML = "";
  const filterPre = document.querySelector("#filter-preT0")?.checked ?? false;
  const filterBulk = document.querySelector("#filter-bulk")?.checked ?? false;
  const filterMerge = document.querySelector("#filter-merge")?.checked ?? false;
  const sortMode =
    document.querySelector("#sort-select")?.value || "default";

  const trackFilter = window.__trackFilter || null;
  const filteredRows = rows.filter((r) => {
    if (filterPre && Number(r.has_commits_before_t0) === 0) return false;
    if (filterBulk && Number(r.has_bulk_commits) === 0) return false;
    if (filterMerge && Number(r.has_merge_commits) === 0) return false;
    if (trackFilter) {
      const sub = getSubmissionInfoForRow(r);
      const track = sub?.chosen_track || r.chosen_track || "";
      if (!trackMatchesCategory(track, trackFilter)) return false;
    }
    return true;
  });

  const sortedRows = [...filteredRows].sort((a, b) => {
    if (sortMode === "judge") {
      const ja = getJudgeInfoForRow(a);
      const jb = getJudgeInfoForRow(b);
      const avga = ja
        ? Number(
            (ja.averages && ja.averages.grand_total) ??
              ja.average_score ??
              -Infinity
          )
        : -Infinity;
      const avgb = jb
        ? Number(
            (jb.averages && jb.averages.grand_total) ??
              jb.average_score ??
              -Infinity
          )
        : -Infinity;
      if (avga === avgb) return 0;
      return avgb - avga;
    }
    if (sortMode === "commits") {
      return Number(b.total_commits || 0) - Number(a.total_commits || 0);
    }
    return 0;
  });

  updateStats(rows);

  if (sortedRows.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="13">
          <div class="empty-state">
            <div class="empty-state-icon">📭</div>
            <div>No submissions match the current filters</div>
          </div>
        </td>
      </tr>
    `;
    return;
  }

  // Render rows first with loading placeholders for AI
  sortedRows.forEach((row) => {
    const tr = document.createElement("tr");
    const repoId =
      row.repo_id || row.submission_id || extractRepoName(row.repo);
    const submission = getSubmissionInfoForRow(row);
    const displayName =
      submission?.project_name || row.repo_id || extractRepoName(row.repo);
    const teamName = submission?.team_name || "";
    const judgeInfo = getJudgeInfoForRow(row);

    tr.innerHTML = `
      <td>
        <div class="repo-cell">
          <span class="repo-name">${escapeHtml(displayName)}</span>
          ${
            teamName
              ? `<span class="repo-meta">Team ${escapeHtml(teamName)}</span>`
              : ""
          }
          <span class="repo-url">${escapeHtml(
            row.repo || submission?.repo_url || ""
          )}</span>
          <div class="repo-actions">${repoLink(
            row.repo || submission?.repo_url || ""
          )}${demoLink(submission)}</div>
        </div>
      </td>
      <td>${trackChip(submission?.chosen_track || row.chosen_track || "")}</td>
      <td>${analysisStatusChip(row)}</td>
      <td><div class="judge-cell">${renderJudgeCell(judgeInfo)}</div></td>
      <td><span class="num-cell">${row.total_commits}</span></td>
      <td><span class="num-cell loc-add">+${formatNumber(
        row.total_loc_added
      )}</span></td>
      <td><span class="num-cell loc-del">−${formatNumber(
        row.total_loc_deleted
      )}</span></td>
      <td style="text-align:center">${flagChip(row.has_commits_before_t0)}</td>
      <td style="text-align:center">${flagChip(row.has_bulk_commits)}</td>
      <td style="text-align:center">${flagChip(
        row.has_large_initial_commit_after_t0
      )}</td>
      <td style="text-align:center">${flagChip(row.has_merge_commits)}</td>
      <td class="verdict-cell"><span class="verdict-icon pending">⏳</span></td>
      <td class="ai-cell"><span class="ai-preview no-data">Loading...</span></td>
    `;
    tr.dataset.repoId = repoId;
    tr.tabIndex = 0;
    tr.setAttribute("role", "button");
    tr.setAttribute("aria-label", `Open details for ${displayName}`);
    const openRow = () => {
      document
        .querySelectorAll("#summary-table tbody tr")
        .forEach((r) => r.classList.remove("selected"));
      tr.classList.add("selected");
      openDrawer(repoId);
    };
    tr.addEventListener("click", openRow);
    tr.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        openRow();
      }
    });
    tbody.appendChild(tr);

    // Fetch AI summary async
    fetchAISummary(repoId).then((aiText) => {
      const aiCell = tr.querySelector(".ai-cell");
      const verdictCell = tr.querySelector(".verdict-cell");
      if (aiCell) aiCell.innerHTML = getAIPreview(aiText);
      if (verdictCell) verdictCell.innerHTML = getVerdictBadge(aiText);
    });
  });
}

async function loadSummary() {
  await Promise.all([loadHacks(), loadEventFormat()]);
  const [summaryData] = await Promise.all([
    fetchJSON("/api/summary").catch(() => ({ rows: [] })),
    loadJudgeData(),
    loadSubmissionData(),
  ]);
  const summaryRows = summaryData.rows || [];
  const seenSubKeys = new Set();
  const dedupApi = [];
  for (const value of submissionMap.values()) {
    const key =
      normalizeRepoKey(value.repo_url || "") ||
      (value.submission_id ? `sid:${value.submission_id}` : "") ||
      slugify(value.project_name || "") ||
      slugify(value.team_name || "");
    if (!key || seenSubKeys.has(key)) continue;
    seenSubKeys.add(key);
    dedupApi.push(value);
  }
  const merged = mergeRows(summaryRows, dedupApi);
  window.__summaryRows = merged;
  maybeRenderSummaryTable();
}

/** Live submissions grid + scores: only populate on the event site after password unlock. */
function canRenderSensitiveSummaryTable() {
  if (document.body.classList.contains("organizer-page")) return true;
  return isAuthed();
}

function maybeRenderSummaryTable() {
  const rows = window.__summaryRows || [];
  if (!canRenderSensitiveSummaryTable()) {
    const tbody = document.querySelector("#summary-table tbody");
    if (tbody) tbody.innerHTML = "";
    return;
  }
  renderSummaryTable(rows);
}

function dedupeSubmissionsBySubmissionId(submissions) {
  const seen = new Set();
  const out = [];
  for (const s of [...(submissions || [])].reverse()) {
    if (!s) continue;
    const repoKey = normalizeRepoKey(s.repo_url || "");
    const projectKey = slugify(s.project_name || "");
    const teamKey = slugify(s.team_name || "");
    const id = repoKey || projectKey || teamKey || String(s.submission_id || "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(s);
  }
  return out.reverse();
}

function mergeRows(summaryRows, submissions) {
  const byRepo = new Map();
  const submissionsDedup = dedupeSubmissionsBySubmissionId(submissions);
  const allowedRepoKeys = new Set(
    submissionsDedup
      .map((s) => normalizeRepoKey(s.repo_url || ""))
      .filter(Boolean)
  );

  summaryRows.forEach((row) => {
    const repoKey = normalizeRepoKey(row.repo || "");
    if (!repoKey || !allowedRepoKeys.has(repoKey)) return;
    byRepo.set(repoKey, {
      ...row,
      repo_id: row.repo_id || extractRepoName(row.repo),
      submission_status: submissionMap.has(repoKey) ? "submitted" : "missing",
      analysis_status: "analyzed",
    });
  });

  submissionsDedup.forEach((submission) => {
    const repoKey = normalizeRepoKey(submission.repo_url || "");
    if (!repoKey) return;
    if (byRepo.has(repoKey)) {
      byRepo.set(repoKey, {
        ...byRepo.get(repoKey),
        ...submission,
        submission_status: "submitted",
      });
      return;
    }

    byRepo.set(repoKey, {
      repo_id: submission.submission_id,
      repo: submission.repo_url,
      repo_url: submission.repo_url,
      submission_id: submission.submission_id,
      project_name: submission.project_name,
      team_name: submission.team_name,
      chosen_track: submission.chosen_track,
      demo_url: submission.demo_url,
      submission_status: "submitted",
      analysis_status: "pending",
      total_commits: 0,
      total_loc_added: 0,
      total_loc_deleted: 0,
      has_commits_before_t0: 0,
      has_bulk_commits: 0,
      has_large_initial_commit_after_t0: 0,
      has_merge_commits: 0,
    });
  });

  return Array.from(byRepo.values());
}

function formatJSON(obj) {
  return JSON.stringify(obj, null, 2);
}

// Drawer functionality
function openDrawer(repoId) {
  const drawer = document.getElementById("details-drawer");
  const overlay = document.getElementById("drawer-overlay");

  drawer.classList.remove("hidden");
  overlay.classList.remove("hidden");

  // Trigger reflow for animation
  drawer.offsetHeight;

  drawer.classList.add("visible");
  overlay.classList.add("visible");

  loadDetails(repoId);
}

function closeDrawer() {
  const drawer = document.getElementById("details-drawer");
  const overlay = document.getElementById("drawer-overlay");

  drawer.classList.remove("visible");
  overlay.classList.remove("visible");

  setTimeout(() => {
    drawer.classList.add("hidden");
    overlay.classList.add("hidden");
  }, 250);

  document
    .querySelectorAll("#summary-table tbody tr")
    .forEach((r) => r.classList.remove("selected"));
}

function detailElsForDrawer() {
  return {
    detailTitle: document.getElementById("detail-title"),
    submissionOutput: document.getElementById("submission-output"),
    metricsSummary: document.getElementById("metrics-summary"),
    metricsFlags: document.getElementById("metrics-flags"),
    metricsTime: document.getElementById("metrics-time"),
    aiOutput: document.getElementById("ai-output"),
    judgeOutput: document.getElementById("judge-output"),
    commitsTbody: document.querySelector("#commits-table tbody"),
    commitCountEl: document.querySelector("#details-drawer .commit-count"),
  };
}

function detailElsForJudgeSidePanel() {
  return {
    detailTitle: document.getElementById("judge-side-detail-title"),
    submissionOutput: document.getElementById("judge-side-submission-output"),
    metricsSummary: document.getElementById("judge-side-metrics-summary"),
    metricsFlags: document.getElementById("judge-side-metrics-flags"),
    metricsTime: document.getElementById("judge-side-metrics-time"),
    aiOutput: document.getElementById("judge-side-ai-output"),
    judgeOutput: document.getElementById("judge-side-judge-output"),
    commitsTbody: document.querySelector("#judge-side-commits-table tbody"),
    commitCountEl: document.getElementById("judge-side-commit-count"),
  };
}

function mergeDetailEls(overrides) {
  if (!overrides) return detailElsForDrawer();

  const submissionOut = overrides.submissionOutput;
  const judgeOut = overrides.judgeOutput;
  const targetsJudgeSidePanel =
    (submissionOut && submissionOut.id === "judge-side-submission-output") ||
    (judgeOut && judgeOut.id === "judge-side-judge-output");

  if (targetsJudgeSidePanel) {
    const side = detailElsForJudgeSidePanel();
    const o = { ...side };
    Object.keys(overrides).forEach((k) => {
      if (overrides[k] != null) o[k] = overrides[k];
    });
    return o;
  }

  const base = detailElsForDrawer();
  const o = { ...base };
  Object.keys(overrides).forEach((k) => {
    if (overrides[k] != null) o[k] = overrides[k];
  });
  return o;
}

function mergedTableRowsHtml(merged) {
  return merged
    .map(
      (e) => `
    <tr>
      <td class="judge-prior-td judge-prior-judge">${escapeHtml(e.judge)}${
        e.source === "local"
          ? ' <span class="judge-prior-src">local</span>'
          : ' <span class="judge-prior-src">import</span>'
      }</td>
      <td class="judge-prior-td judge-prior-when">${escapeHtml(
        formatJudgeTime(e.at)
      )}</td>
      <td class="judge-prior-td judge-prior-num">${escapeHtml(
        String(e.total ?? "—")
      )}</td>
      <td class="judge-prior-td judge-prior-detail">${escapeHtml(e.detail)}</td>
    </tr>`
    )
    .join("");
}

function countUniqueJudges(merged) {
  const s = new Set();
  for (const e of merged) {
    const j = (e.judge && String(e.judge).trim()) || "";
    if (j) s.add(j.toLowerCase());
  }
  return s.size;
}

function renderJudgeSideScoresTab(submissionId, judgeInfo) {
  const agg = document.getElementById("judge-side-scores-aggregate");
  const tbody = document.querySelector("#judge-side-merged-scores tbody");
  if (!agg || !tbody) return;
  const merged = buildMergedScoreEntries(submissionId, judgeInfo);
  tbody.innerHTML = mergedTableRowsHtml(merged);
  if (judgeInfo && judgeInfo.responses && judgeInfo.responses.length) {
    agg.innerHTML = judgeAggregateBlockHtml(judgeInfo);
  } else {
    agg.innerHTML = merged.length
      ? `<p class="judge-scores-tab-hint">No imported panel average — see merged scores below (local + any imports).</p>`
      : `<div class="empty-state"><div class="empty-state-icon">🧑‍⚖️</div><div>No scores yet for this pick.</div></div>`;
  }
}

async function loadDetails(repoId, elsOrOverrides) {
  const {
    detailTitle,
    submissionOutput,
    metricsSummary,
    metricsFlags,
    metricsTime,
    aiOutput,
    judgeOutput,
    commitsTbody,
    commitCountEl,
  } = mergeDetailEls(elsOrOverrides);

  if (detailTitle) {
    detailTitle.textContent = repoId;
    if (detailTitle.id === "judge-side-detail-title") {
      if (repoId) detailTitle.removeAttribute("hidden");
      else detailTitle.setAttribute("hidden", "");
    }
  }

  if (submissionOutput) submissionOutput.textContent = "Loading...";
  if (metricsSummary) metricsSummary.textContent = "Loading...";
  if (metricsFlags) metricsFlags.textContent = "Loading...";
  if (metricsTime) metricsTime.textContent = "Loading...";
  if (aiOutput) aiOutput.textContent = "Loading...";
  if (judgeOutput) judgeOutput.textContent = "Loading...";

  try {
    const apiSeg = encodeRepoApiSegment(repoId);
    const summaryRow = findSummaryRowForRepoId(repoId);
    renderSubmissionDetails(summaryRow, submissionOutput);
    const [metrics, aiText, commitsData] = await Promise.all([
      fetchJSON(`/api/repo/${apiSeg}/metrics`),
      fetchText(`/api/repo/${apiSeg}/ai`),
      fetchJSON(`/api/repo/${apiSeg}/commits`).catch(() => ({ rows: [] })),
    ]);

    if (metricsSummary) {
      metricsSummary.textContent = formatJSON(metrics.summary || {});
    }
    if (metricsFlags) {
      metricsFlags.textContent = formatJSON(metrics.flags || {});
    }
    if (metricsTime) {
      metricsTime.textContent = formatJSON(metrics.time_distribution || {});
    }

    if (aiOutput) {
      if (aiText) {
        aiOutput.innerHTML = formatAIOutput(aiText);
      } else {
        aiOutput.textContent = "No AI analysis available for this submission.";
      }
    }

    const judgeInfo = getJudgeInfoForRow(summaryRow);
    renderJudgeDetails(judgeInfo, judgeOutput);

    const commitTargets = { tbody: commitsTbody, countEl: commitCountEl };
    renderCommits(commitsData.rows || [], commitTargets);
    if (judgeOutput && judgeOutput.id === "judge-side-judge-output") {
      const sid = document.getElementById("judge-submission-select")?.value;
      if (sid) renderJudgeSideScoresTab(sid, judgeInfo);
    }
  } catch (err) {
    const summaryRow = findSummaryRowForRepoId(repoId);
    renderSubmissionDetails(summaryRow, submissionOutput);
    if (metricsSummary) {
      metricsSummary.textContent = rowHasAnalysis(summaryRow)
        ? `Error: ${err.message}`
        : "Analysis not generated yet.";
    }
    if (metricsFlags) {
      metricsFlags.textContent = rowHasAnalysis(summaryRow)
        ? ""
        : "Run scan.py to populate commit metrics and authenticity flags.";
    }
    if (metricsTime) metricsTime.textContent = "";
    if (aiOutput) {
      aiOutput.textContent = rowHasAnalysis(summaryRow)
        ? ""
        : "AI analysis appears after repo analysis has been run.";
    }
    const judgeInfo = getJudgeInfoForRow(summaryRow);
    renderJudgeDetails(judgeInfo, judgeOutput);
    const commitTargets = { tbody: commitsTbody, countEl: commitCountEl };
    renderCommits([], commitTargets);
    if (judgeOutput && judgeOutput.id === "judge-side-judge-output") {
      const sid = document.getElementById("judge-submission-select")?.value;
      if (sid) renderJudgeSideScoresTab(sid, judgeInfo);
    }
  }
}

function rowHasAnalysis(row) {
  return row && row.analysis_status === "analyzed";
}

function renderSubmissionDetails(row, outputEl) {
  const container =
    outputEl || document.getElementById("submission-output");
  if (!container) return;
  const submission = getSubmissionInfoForRow(row) || row;
  if (!submission) {
    container.innerHTML =
      '<div class="empty-state"><div class="empty-state-icon">📨</div><div>No submission metadata</div></div>';
    return;
  }
  const items = [
    ["Project", submission.project_name || row?.repo_id || "—", ""],
    ["Team", submission.team_name || "—", ""],
    ["Track", submission.chosen_track || "—", ""],
    ["Submitted", submission.timestamp || "—", ""],
    ["GitHub repo", submission.repo_url || row?.repo || "—", "url"],
    ["Demo", submission.demo_url || "—", "url"],
  ];
  container.innerHTML = `
    <div class="submission-grid">
      ${items
        .map(
          ([label, value, type]) =>
            `<div class="submission-item"><div class="submission-label">${escapeHtml(
              label
            )}</div><div class="submission-value">${
              type === "url" && value && value !== "—"
                ? `<a class="repo-link" href="${escapeAttr(
                    value
                  )}" target="_blank" rel="noopener noreferrer">${escapeHtml(
                    value
                  )}</a>`
                : escapeHtml(value)
            }</div></div>`
        )
        .join("")}
    </div>
  `;
}

function formatAIOutput(text) {
  // Convert bullet points and highlight the verdict
  let html = escapeHtml(text);

  // Look for authenticity assessment line
  const verdictMatch = html.match(/(Overall authenticity assessment:.*?)$/im);
  if (verdictMatch) {
    const verdict = verdictMatch[1];
    const isSuspicious = /suspicious|concern|flag|issue|question/i.test(
      verdict
    );
    const isAuthentic = /consistent|authentic|legitimate/i.test(verdict);
    // Suspicious takes priority over authentic keywords
    const verdictClass = isSuspicious
      ? "suspicious"
      : isAuthentic
      ? "authentic"
      : "suspicious";
    html = html.replace(
      verdict,
      `<span class="verdict ${verdictClass}">${verdict}</span>`
    );
  }

  return html;
}

function renderCommits(rows, targets) {
  const tbody =
    (targets && targets.tbody) ||
    document.querySelector("#commits-table tbody");
  const countEl =
    (targets && targets.countEl) ||
    document.querySelector("#details-drawer .commit-count");
  if (!tbody) return;
  tbody.innerHTML = "";

  if (countEl) countEl.textContent = `(${rows.length})`;

  if (rows.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="9" style="text-align: center; color: var(--muted); padding: 20px;">
          No commits data available
        </td>
      </tr>
    `;
    return;
  }

  rows.slice(0, 100).forEach((row) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><span class="num-cell">${row.seq_index}</span></td>
      <td style="font-size: 0.7rem; color: var(--muted); white-space: nowrap;">${
        row.author_time_iso
      }</td>
      <td><span class="num-cell loc-add">+${row.insertions}</span></td>
      <td><span class="num-cell loc-del">−${row.deletions}</span></td>
      <td><span class="num-cell">${row.files_changed}</span></td>
      <td style="text-align:center">${flagChip(row.flag_bulk_commit)}</td>
      <td style="text-align:center">${flagChip(row.is_before_t0)}</td>
      <td style="text-align:center">${flagChip(row.is_after_t1)}</td>
      <td style="max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${escapeHtml(
        row.subject
      )}">${escapeHtml(row.subject)}</td>
    `;
    tbody.appendChild(tr);
  });
}

// ================================================================
// Event format (rubric / side quests / judges / prizes) + modals
// ================================================================

function getActiveHack() {
  const id = getActiveHackId();
  return (hacksIndex.hacks || []).find((h) => h.id === id) || null;
}

async function loadHacks() {
  try {
    hacksIndex = await fetchJSON("/api/hacks");
  } catch (e) {
    hacksIndex = { hacks: [], active_hack_id: null };
  }
}

async function loadEventFormat() {
  try {
    eventFormat = await fetchJSON("/api/event-format");
  } catch (e) {
    eventFormat = null;
  }
  renderRubric();
  renderSideQuests();
  renderPrizes();
  renderJudges();
  buildJudgeFormSkeleton();
}

function renderRubric() {
  const ol = document.getElementById("rubric-criteria");
  if (!ol) return;
  const criteria = eventFormat?.rubric?.criteria || [];
  ol.innerHTML = criteria
    .map(
      (c) => `
    <li>
      <div class="rubric-criterion-body">
        <span class="rubric-criterion-name">${escapeHtml(c.name)}</span>
        <span class="rubric-criterion-desc">${escapeHtml(
          c.description || ""
        )}</span>
      </div>
      <span class="rubric-criterion-pts">${c.points} ${Number(c.points) === 1 ? "pt" : "pts"}</span>
    </li>
  `
    )
    .join("");
}

function renderSideQuests() {
  const ul = document.getElementById("side-quests");
  if (!ul) return;
  const quests = eventFormat?.side_quests || [];
  ul.innerHTML = quests
    .map(
      (q) => `
    <li>
      <div class="sq-body">
        <span class="sq-name">${escapeHtml(q.name)}</span>
        <span class="sq-blurb">${escapeHtml(q.blurb || "")}</span>
      </div>
      <span class="sq-pts">${q.points ?? 1} ${Number(q.points ?? 1) === 1 ? "pt" : "pts"}</span>
    </li>
  `
    )
    .join("");
}

function renderPrizes() {
  const ul = document.getElementById("prize-grid");
  if (!ul) return;
  const prizes = eventFormat?.prizes || [];
  ul.innerHTML = prizes
    .map(
      (p) => `
    <li class="prize-card tier-${escapeAttr(p.tier || "default")}">
      <span class="prize-tier">${escapeHtml(p.tier || "prize")}</span>
      <span class="prize-name">${escapeHtml(p.name)}</span>
      <span class="prize-value">${escapeHtml(p.value || "")}</span>
      <span class="prize-desc">${escapeHtml(p.description || "")}</span>
    </li>
  `
    )
    .join("");
}

function renderJudges() {
  const ul = document.getElementById("judge-grid");
  if (!ul) return;
  const judges = eventFormat?.judges || [];
  ul.innerHTML = judges
    .map((j) => {
      const initials = (j.name || "?")
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2)
        .map((p) => p[0])
        .join("")
        .toUpperCase();
      const color = j.avatar_color || "#429aaa";
      const avatar = j.photo_url
        ? `<img class="judge-avatar judge-avatar--img" src="${escapeAttr(
            j.photo_url
          )}" alt="" loading="lazy" onerror="this.outerHTML='<span class=&quot;judge-avatar&quot; style=&quot;background:${escapeAttr(
            color
          )}&quot;>${escapeHtml(initials)}</span>'">`
        : `<span class="judge-avatar" style="background:${escapeAttr(
            color
          )}">${escapeHtml(initials)}</span>`;
      const roleLine = j.title
        ? `<span class="judge-name">${escapeHtml(
            j.name
          )}</span><span class="judge-role">${escapeHtml(
            j.title
          )} · ${escapeHtml(j.role || "")}</span>`
        : `<span class="judge-name">${escapeHtml(
            j.name
          )}</span><span class="judge-role">${escapeHtml(j.role || "")}</span>`;
      const inner = `
      ${avatar}
      <div class="judge-body">
        ${roleLine}
        <span class="judge-focus">${escapeHtml(j.focus || "")}</span>
      </div>
      ${
        j.linkedin
          ? '<span class="judge-linkedin" aria-hidden="true">in →</span>'
          : ""
      }
    `;
      if (j.linkedin) {
        return `<li><a class="judge-card judge-card--link" href="${escapeAttr(
          j.linkedin
        )}" target="_blank" rel="noreferrer noopener" aria-label="${escapeAttr(
          j.name
        )} on LinkedIn">${inner}</a></li>`;
      }
      return `<li class="judge-card">${inner}</li>`;
    })
    .join("");
}

// Public submissions table on the marketing page.
// Independent from the gated organizer/judge flows.
async function loadAndRenderPublicSubmissions() {
  const tbody = document.getElementById("submissions-tbody");
  if (!tbody) return;
  let submissions = [];
  try {
    const data = await fetchJSON("/api/submissions");
    submissions = Array.isArray(data?.submissions) ? data.submissions : [];
  } catch (err) {
    console.error("Failed to load public submissions", err);
    tbody.innerHTML =
      '<tr><td colspan="5" class="submissions-empty">Submissions are temporarily unavailable. Refresh in a moment.</td></tr>';
    return;
  }

  const filtered = submissions.filter(submissionWithinEventWindow);

  // Dedupe by repo URL (fallback to project|team).
  const byKey = new Map();
  for (const s of filtered) {
    const key = (s?.repo_url && normalizeRepoKey(s.repo_url)) ||
      (s?.submission_id && `submission:${s.submission_id}`) ||
      `${(s?.project_name || "").toLowerCase()}|${(s?.team_name || "").toLowerCase()}`;
    if (!key) continue;
    const prev = byKey.get(key);
    // Prefer the most recently submitted version.
    if (
      !prev ||
      Date.parse(s?.submitted_at || s?.timestamp || 0) >
        Date.parse(prev?.submitted_at || prev?.timestamp || 0)
    ) {
      byKey.set(key, s);
    }
  }

  const rows = Array.from(byKey.values()).sort((a, b) => {
    const ta = Date.parse(a?.submitted_at || a?.timestamp || 0) || 0;
    const tb = Date.parse(b?.submitted_at || b?.timestamp || 0) || 0;
    if (tb !== ta) return tb - ta; // most recent first
    return String(a?.project_name || "").localeCompare(
      String(b?.project_name || "")
    );
  });

  const meta = document.getElementById("submissions-meta");
  if (meta) {
    meta.textContent = `${rows.length} ${
      rows.length === 1 ? "submission" : "submissions"
    } · sorted by most recent first`;
  }

  if (rows.length === 0) {
    tbody.innerHTML =
      '<tr><td colspan="5" class="submissions-empty">No submissions yet.</td></tr>';
    return;
  }

  tbody.innerHTML = rows
    .map((row, idx) => renderPublicSubmissionRow(row, idx + 1))
    .join("");
}

function renderPublicSubmissionRow(submission, displayIndex) {
  const project = String(submission?.project_name || "Untitled project").trim();
  const team = String(submission?.team_name || "—").trim();
  const desc = String(submission?.description || "").trim();
  const track = String(submission?.chosen_track || "").trim();
  const repoUrl = String(submission?.repo_url || "").trim();
  const demoUrl = String(submission?.demo_url || "").trim();

  const trackClass = track.toLowerCase().includes("money")
    ? "track-money"
    : track.toLowerCase().includes("intel")
    ? "track-intel"
    : "track-unknown";
  const trackLabel = track || "—";

  const repoBtn = repoUrl
    ? `<a class="submission-link-btn is-repo" href="${escapeAttr(
        repoUrl
      )}" target="_blank" rel="noopener noreferrer" aria-label="Open ${escapeAttr(
        project
      )} repo on GitHub">Repo →</a>`
    : `<span class="submission-link-btn is-repo" aria-disabled="true" title="No repo link">Repo</span>`;
  const demoBtn = demoUrl
    ? `<a class="submission-link-btn is-demo" href="${escapeAttr(
        demoUrl
      )}" target="_blank" rel="noopener noreferrer" aria-label="Watch the ${escapeAttr(
        project
      )} demo">Demo →</a>`
    : `<span class="submission-link-btn is-demo" aria-disabled="true" title="No demo link">Demo</span>`;

  return `
    <tr>
      <td class="col-num">${displayIndex.toString().padStart(2, "0")}</td>
      <td class="col-project">
        <span class="submission-project-name">${escapeHtml(project)}</span>
        ${desc ? `<span class="submission-project-desc">${escapeHtml(desc)}</span>` : ""}
      </td>
      <td class="col-team">${escapeHtml(team)}</td>
      <td class="col-track">
        <span class="submission-track ${trackClass}">${escapeHtml(trackLabel)}</span>
      </td>
      <td class="col-actions">
        <span class="submission-actions">${repoBtn}${demoBtn}</span>
      </td>
    </tr>
  `;
}

function getLocalList(key) {
  try {
    return JSON.parse(localStorage.getItem(key) || "[]");
  } catch {
    return [];
  }
}
function setLocalList(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}

// ---------- Modal infra ----------
let lastFocusedBeforeModal = null;
const GATED_MODALS = new Set(["judge-modal", "manager-modal"]);
const AUTH_KEY = "bfa_auth";
const AUTH_JUDGE_NAME_KEY = "bfa_auth_judge_name";
const AUTH_CODE = "BCFTW123!";
let pendingGatedModalId = null;

function readStoredJudgeName() {
  try {
    const s = sessionStorage.getItem(AUTH_JUDGE_NAME_KEY);
    if (s != null && String(s).trim()) return String(s).trim();
  } catch {}
  if (!isAuthed()) return "";
  try {
    const c = localStorage.getItem(localJudgeNameKey());
    if (c != null && String(c).trim()) return String(c).trim();
  } catch {}
  return "";
}

function syncJudgeNameToDom(name) {
  const t = String(name || "").trim();
  const hidden = document.getElementById("judge-name-hidden");
  if (hidden) hidden.value = t;
  const display = document.getElementById("judge-display-name");
  if (display) display.textContent = t || "—";
}

function writeStoredJudgeName(name) {
  const t = String(name || "").trim();
  try {
    if (t) sessionStorage.setItem(AUTH_JUDGE_NAME_KEY, t);
    else sessionStorage.removeItem(AUTH_JUDGE_NAME_KEY);
  } catch {}
  try {
    if (t) localStorage.setItem(localJudgeNameKey(), t);
  } catch {}
  syncJudgeNameToDom(t);
}

function getJudgeNameForUi() {
  const hidden = document.getElementById("judge-name-hidden");
  const fromHidden = hidden && String(hidden.value || "").trim();
  if (fromHidden) return fromHidden;
  return readStoredJudgeName();
}

function isAuthed() {
  try {
    return sessionStorage.getItem(AUTH_KEY) === AUTH_CODE;
  } catch {
    return false;
  }
}

function applyAuthState() {
  const authed = isAuthed();
  document.body.classList.toggle("is-authed", authed);
  document.querySelectorAll(".organizer-wrap").forEach((el) => {
    el.hidden = !authed;
  });
  document.querySelectorAll(".organizer-gate").forEach((el) => {
    el.hidden = authed;
  });
  if (authed) {
    syncJudgeNameToDom(readStoredJudgeName());
    maybeRenderSummaryTable();
  }
}

/** Clone submissions panel from template — not in DOM until Manager opens (no landing leak). */
function ensureManagerSubmissionsPanel() {
  const host = document.getElementById("manager-submissions-host");
  const tpl = document.getElementById("manager-submissions-template");
  if (!host || !tpl || host.childElementCount > 0) return;
  host.appendChild(tpl.content.cloneNode(true));
}

function setManagerTab(name) {
  const modal = document.getElementById("manager-modal");
  if (!modal) return;
  modal.querySelectorAll("[data-manager-tab]").forEach((tab) => {
    const on = tab.getAttribute("data-manager-tab") === name;
    tab.setAttribute("aria-selected", on ? "true" : "false");
    tab.tabIndex = on ? 0 : -1;
  });
  modal.querySelectorAll("[data-manager-panel]").forEach((panel) => {
    const on = panel.getAttribute("data-manager-panel") === name;
    panel.hidden = !on;
  });
}

function initManagerTabs() {
  const modal = document.getElementById("manager-modal");
  if (!modal) return;
  modal.querySelectorAll("[data-manager-tab]").forEach((tab) => {
    tab.addEventListener("click", () => {
      setManagerTab(tab.getAttribute("data-manager-tab"));
    });
    tab.addEventListener("keydown", (e) => {
      const tabs = [...modal.querySelectorAll("[data-manager-tab]")];
      const i = tabs.indexOf(document.activeElement);
      if (i < 0) return;
      if (e.key === "ArrowRight" || e.key === "ArrowDown") {
        e.preventDefault();
        const next = tabs[(i + 1) % tabs.length];
        next.focus();
        setManagerTab(next.getAttribute("data-manager-tab"));
      } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
        e.preventDefault();
        const prev = tabs[(i - 1 + tabs.length) % tabs.length];
        prev.focus();
        setManagerTab(prev.getAttribute("data-manager-tab"));
      }
    });
  });
}

function openModal(id) {
  const modal = document.getElementById(id);
  if (!modal) return;
  if (GATED_MODALS.has(id) && !isAuthed()) {
    pendingGatedModalId = id;
    openModal("password-modal");
    return;
  }
  lastFocusedBeforeModal = document.activeElement;
  modal.classList.remove("hidden");
  const firstInput =
    id === "judge-modal"
      ? modal.querySelector("#judge-submission-picker")
      : modal.querySelector("input:not([type=hidden]), select, textarea, button");
  if (firstInput) setTimeout(() => firstInput.focus(), 60);
  if (id === "manager-modal") {
    ensureManagerSubmissionsPanel();
    setManagerTab("submissions");
    renderManagerPanel();
    maybeRenderSummaryTable();
  }
  if (id === "judge-modal") {
    openJudgeSidePanel();
    refreshJudgeSubmissionSelect();
    refreshJudgeSubmissions({ silent: false });
  }
}

/**
 * Pull fresh submissions from the API and re-render the judge picker.
 * Without this, anyone who opened the page before submissions came in
 * would forever see "1 / 1" — there's no other refresh trigger.
 */
async function refreshJudgeSubmissions({ silent = false } = {}) {
  const btn = document.getElementById("judge-refresh-submissions");
  if (btn) {
    btn.disabled = true;
    btn.classList.add("is-loading");
  }
  try {
    await loadSummary();
    const before = (document.getElementById("judge-submission-select")?.options.length || 1) - 1;
    refreshJudgeSubmissionSelect();
    const after = (document.getElementById("judge-submission-select")?.options.length || 1) - 1;
    updateSubmissionsCount(window.__summaryRows || []);
    if (!silent) {
      const delta = after - before;
      if (delta > 0) toast(`+${delta} new submission${delta === 1 ? "" : "s"} loaded`);
      else toast(`${after} submissions — list up to date`);
    }
  } catch (err) {
    if (!silent) toast("Could not refresh submissions");
    console.error("refreshJudgeSubmissions", err);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.classList.remove("is-loading");
    }
  }
}
function getJudgeApiRepoId() {
  const id = document.getElementById("judge-submission-select")?.value;
  if (!id) return "";
  const found = findSubmissionById(id);
  if (found && found.row) {
    return (
      found.row.repo_id ||
      extractRepoName(found.row.repo) ||
      id
    );
  }
  return id;
}

function isJudgeSidePanelOpen() {
  const p = document.getElementById("judge-side-panel");
  const modal = document.getElementById("judge-modal");
  return !!(p && modal?.classList.contains("judge-side-open") && !p.hidden);
}

function closeJudgeSidePanel() {
  const panel = document.getElementById("judge-side-panel");
  const modal = document.getElementById("judge-modal");
  if (panel) {
    panel.hidden = true;
    panel.setAttribute("aria-hidden", "true");
  }
  if (modal) modal.classList.remove("judge-side-open");
  syncJudgePanelToggleState();
}

function openJudgeSidePanel() {
  const panel = document.getElementById("judge-side-panel");
  const modal = document.getElementById("judge-modal");
  if (!panel || !modal) return;
  setActiveJudgeSideTab("submission");
  panel.hidden = false;
  panel.setAttribute("aria-hidden", "false");
  modal.classList.add("judge-side-open");
  syncJudgePanelToggleState();
  const repoId = getJudgeApiRepoId();
  if (repoId) {
    loadDetails(repoId, detailElsForJudgeSidePanel());
  }
}

function setActiveJudgeSideTab(which) {
  const subP = document.getElementById("judge-panel-submission");
  const scP = document.getElementById("judge-panel-scores");
  const tSub = document.getElementById("judge-tab-submission");
  const tSc = document.getElementById("judge-tab-scores");
  if (!subP || !scP || !tSub || !tSc) return;
  if (which === "scores") {
    subP.classList.remove("is-active");
    scP.classList.add("is-active");
    tSub.classList.remove("is-active");
    tSub.setAttribute("aria-selected", "false");
    tSub.tabIndex = -1;
    tSc.classList.add("is-active");
    tSc.setAttribute("aria-selected", "true");
    tSc.tabIndex = 0;
  } else {
    scP.classList.remove("is-active");
    subP.classList.add("is-active");
    tSc.classList.remove("is-active");
    tSc.setAttribute("aria-selected", "false");
    tSc.tabIndex = -1;
    tSub.classList.add("is-active");
    tSub.setAttribute("aria-selected", "true");
    tSub.tabIndex = 0;
  }
}

/** Selected submission ⇒ show enrichment side panel; cleared selection ⇒ hide. */
function syncJudgeFullViewFromSelection() {
  const sel = document.getElementById("judge-submission-select");
  if (!sel) return;
  const id = (sel.value || "").trim();
  const hidden = document.getElementById("judge-submission-hidden");
  if (hidden) hidden.value = id;
  renderJudgeVideoStage();
  renderJudgeScoreQueue();
  if (!id) {
    openJudgeSidePanel();
    return;
  }
  if (isJudgeSidePanelOpen()) {
    const repoId = getJudgeApiRepoId();
    if (repoId) loadDetails(repoId, detailElsForJudgeSidePanel());
  }
}

function onJudgeSubmissionSelectChanged() {
  const selectedId = document.getElementById("judge-submission-select")?.value || "";
  const allEntries = getJudgeReviewEntries();
  const idx = allEntries.findIndex((e) => e.id === selectedId);
  if (idx >= 0) judgeCurrentIndex = idx;
  renderJudgeCoverageChips(allEntries);
  renderJudgeSubmissionSummary();
  syncJudgeFullViewFromSelection();
}

function closeModal(id) {
  const modal = document.getElementById(id);
  if (!modal) return;
  if (id === "judge-modal") closeJudgeSidePanel();
  modal.classList.add("hidden");
  if (
    lastFocusedBeforeModal &&
    typeof lastFocusedBeforeModal.focus === "function"
  ) {
    lastFocusedBeforeModal.focus();
  }
}

// ---------- Submit form ----------
function setSubmitFormLoading(form, loading) {
  if (!form) return;
  const btn = form.querySelector(".btn-submit-project, button[type='submit']");
  const cancel = form.querySelector(".modal-foot [data-close-modal]");
  form.setAttribute("aria-busy", loading ? "true" : "false");
  if (btn) {
    btn.classList.toggle("is-loading", loading);
    btn.disabled = !!loading;
  }
  if (cancel) cancel.disabled = !!loading;
}

async function handleSubmitForm(e) {
  e.preventDefault();
  const form = e.target;
  const data = Object.fromEntries(new FormData(form).entries());
  const demoUrl = String(data.demo_url || "").trim();
  const focusDemo = () => {
    const demoInput = form.querySelector('input[name="demo_url"]');
    if (demoInput) demoInput.focus();
  };
  if (!demoUrl) {
    toast("Demo URL is required — paste a YouTube/Loom/recording link.");
    focusDemo();
    return;
  }
  try {
    const u = new URL(demoUrl);
    if (!/^https?:$/.test(u.protocol)) throw new Error("Invalid demo URL");
  } catch {
    toast("Demo URL must be a full https:// link.");
    focusDemo();
    return;
  }
  const entry = {
    submitted_at: new Date().toISOString(),
    hack_id: getActiveHackId(),
    team_name: data.team_name || "",
    project_name: data.project_name || "",
    repo_url: data.github_url || "",
    chosen_track: data.chosen_track || "",
    demo_url: demoUrl,
    team_members: data.team_members || "",
    description: data.description || "",
    notes: data.notes || "",
  };
  setSubmitFormLoading(form, true);
  try {
    const res = await fetch("/api/submissions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(entry),
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(payload.error || "Failed to save submission");
  } catch (err) {
    toast(err.message || "Submission failed. Supabase did not save it.");
    return;
  } finally {
    setSubmitFormLoading(form, false);
  }
  form.reset();
  closeModal("submit-modal");
  await loadSubmissionData();
  await loadSummary();
  toast("", {
    variant: "success",
    title: "You're in — submission received!",
    detail: `${entry.project_name || "Your project"} · ${
      entry.chosen_track || "track not set"
    }`,
    meta: "Your entry is saved. Judges and organizers can see it on the live board.",
  });
  requestAnimationFrame(() => {
    setTimeout(() => launchConfetti(), 90);
  });
}

// ---------- Judge form ----------
function buildJudgeFormSkeleton() {
  renderJudgeRubricReminder();
  attachScoreInputListeners();
}

function renderJudgeRubricReminder() {
  const targets = [
    document.getElementById("judge-rubric-reminder"),
    document.getElementById("judge-rubric-reminder-side"),
  ].filter(Boolean);
  if (!targets.length) return;
  const criteria = eventFormat?.rubric?.criteria || [];
  const quests = eventFormat?.side_quests || [];
  const html = `
    <div class="judge-rubric-total">7 core + 3 bonus = 10</div>
    <div class="judge-rubric-list">
      ${criteria
        .map(
          (c) => `<div class="judge-rubric-line"><span>${escapeHtml(
            c.name
          )}</span><strong>${escapeHtml(String(c.points))}</strong></div>`
        )
        .join("")}
    </div>
    <div class="judge-rubric-list judge-rubric-list--bonus">
      ${quests
        .map(
          (q) => `<div class="judge-rubric-line"><span>${escapeHtml(
            q.name
          )}</span><strong>${escapeHtml(String(q.points ?? 1))}</strong></div>`
        )
        .join("")}
    </div>
  `;
  targets.forEach((target) => {
    target.innerHTML = html;
  });
}

function attachScoreInputListeners() {
  const scoreInput = document.getElementById("judge-score-input");
  if (!scoreInput) return;
  scoreInput.addEventListener("input", updateJudgeRunningTotal);
  scoreInput.addEventListener("blur", () => {
    const score = clampJudgeScore(scoreInput.value);
    scoreInput.value = score === null ? "" : formatJudgeScore(score);
    updateJudgeRunningTotal();
  });
}

function updateJudgeRunningTotal() {
  const total = clampJudgeScore(document.getElementById("judge-score-input")?.value);
  const el = document.getElementById("judge-running-total");
  if (el) el.textContent = total === null ? "0" : formatJudgeScore(total);
}

function clampJudgeScore(value) {
  if (value === "" || value == null) return null;
  const n = Number(value);
  if (Number.isNaN(n)) return null;
  return Math.round(Math.max(0, Math.min(10, n)) * 10) / 10;
}

function formatJudgeScore(value) {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}


function formatTrackForLabel(raw) {
  const t = (raw || "").trim();
  if (!t || t.toLowerCase() === "unassigned") return "unscored";
  return t;
}

function scoredIdsForJudge(judgeName) {
  const trimmed = (judgeName || "").trim().toLowerCase();
  if (!trimmed) return new Set();
  const out = new Set();
  const seenInfos = new Set();
  judgeMap.forEach((info) => {
    if (!info || seenInfos.has(info)) return;
    seenInfos.add(info);
    (info.responses || [])
      .filter((s) => (s.judge_name || s.judge || "").trim().toLowerCase() === trimmed)
      .forEach((s) => {
        const repoKey = normalizeRepoKey(s.repo_url || s.repo_key || "");
        if (repoKey) out.add(repoKey);
        const identity = normalizeSubmissionIdentity({ sub: s });
        if (identity) out.add(identity);
        if (s.project_name) out.add(slugify(s.project_name));
      });
    });
  return out;
}

function normalizeSubmissionIdentity(entry) {
  if (!entry) return "";
  const found = findSubmissionById(entry.submission_id || entry.id || "");
  const sub = entry.sub || found?.sub || entry;
  const row = entry.row || found?.row || null;
  return (
    normalizeRepoKey(sub?.repo_url || row?.repo || row?.repo_url || "") ||
    slugify(sub?.project_name || row?.project_name || "") ||
    slugify(sub?.team_name || row?.team_name || "") ||
    String(entry.submission_id || entry.id || "").trim()
  );
}

function getJudgeReviewEntries() {
  const rows = window.__summaryRows || [];
  const cachedName = getJudgeNameForUi();
  const scored = scoredIdsForJudge(cachedName);
  const entries = [];

  rows.forEach((r) => {
    const sub = getSubmissionInfoForRow(r);
    const name = sub?.project_name || r.repo_id || extractRepoName(r.repo);
    const id = r.repo_id || name;
    entries.push({
      id,
      name,
      trackLabel: formatTrackForLabel(sub?.chosen_track || r.chosen_track || ""),
      scored: scored.has(id) || scored.has(normalizeSubmissionIdentity({ id, row: r, sub })),
      isLocal: false,
      row: r,
      sub: sub || null,
      assignedJudge: "",
      assignedIndex: -1,
      scoredBy: scoredJudgeNamesForRow(r),
    });
  });

  const deduped = [];
  const seen = new Set();
  for (const entry of entries) {
    const key = normalizeSubmissionIdentity(entry);
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    deduped.push(entry);
  }

  // Compute balanced round-robin judge assignment AFTER dedup so each judge
  // gets ⌈S/N⌉ or ⌊S/N⌋ unique submissions (e.g. 60/5 = 12 each).
  try {
    assignJudgesBalanced(deduped);
  } catch (err) {
    console.warn("Judge assignment failed; falling back to no-assignment view", err);
  }

  return deduped.sort((a, b) => {
    if (a.scored !== b.scored) return a.scored ? 1 : -1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });
}

function refreshJudgeSubmissionSelect() {
  const select = document.getElementById("judge-submission-select");
  if (!select) return;
  const picker = document.getElementById("judge-submission-picker");
  const previous = select.value;
  const allEntries = getJudgeReviewEntries();

  const judgeIdx = getJudgeIndex(getJudgeNameForUi());
  const hasAssignment = judgeIdx !== -1;
  const mineOnly = hasAssignment && isJudgeMineOnlyChecked();
  const mineEntries = hasAssignment
    ? allEntries.filter((e) => isAssignedToCurrentJudge(e))
    : allEntries;
  const entries = mineOnly ? mineEntries : allEntries;

  const total = entries.length;
  const totalAll = allEntries.length;
  const totalMine = mineEntries.length;
  const unscoredCount = entries.filter((e) => !e.scored).length;
  const totalConfiguredJudges = getJudgePool().length;
  let placeholder;
  if (!total) {
    placeholder = "— no submissions in queue —";
  } else if (mineOnly) {
    placeholder = `— pick yours (${totalMine} assigned, ${unscoredCount} unscored, ${totalAll} total) —`;
  } else if (hasAssignment) {
    placeholder = `— pick a submission (${totalAll} in queue, ${unscoredCount} unscored) —`;
  } else {
    placeholder = `— pick a submission (${total} in queue, ${unscoredCount} unscored) —`;
  }
  const options = [`<option value="">${escapeHtml(placeholder)}</option>`];
  entries.forEach((e, idx) => {
    const statusBit = e.scored ? "you scored" : "unscored by you";
    const scoredCount = (e.scoredBy || []).length;
    const coverageBit = scoredCount
      ? ` · ${scoredCount}/${totalConfiguredJudges || scoredCount} scored`
      : " · 0 scored";
    const scorers = (e.scoredBy || []).slice(0, 6).join(", ");
    const optTitle = `${idx + 1}/${total} · ${e.name} — ${e.trackLabel} · ${statusBit}${coverageBit}${
      scorers ? ` · by ${scorers}` : ""
    }`;
    options.push(
      `<option value="${escapeAttr(e.id)}" title="${escapeAttr(optTitle)}">${escapeHtml(
        `${idx + 1}/${total}`
      )} · ${escapeHtml(e.name)}${escapeHtml(coverageBit)}${escapeHtml(
        scorers ? ` (${scorers})` : ""
      )}</option>`
    );
  });

  select.innerHTML = options.join("");
  if (picker) picker.innerHTML = options.join("");
  if (
    previous &&
    Array.from(select.options).some((o) => o.value === previous)
  ) {
    select.value = previous;
    judgeCurrentIndex = Math.max(
      0,
      entries.findIndex((e) => e.id === previous)
    );
  } else if (entries.length) {
    judgeCurrentIndex = Math.min(judgeCurrentIndex, entries.length - 1);
    select.value = entries[judgeCurrentIndex].id;
  } else {
    judgeCurrentIndex = 0;
  }
  if (picker) picker.value = select.value;
  updateJudgeQueueStatsUi({ totalAll, totalMine, hasAssignment, mineOnly });
  renderJudgeCoverageChips(allEntries);
  renderJudgeSubmissionSummary();
  syncJudgeFullViewFromSelection();
}

function renderJudgeCoverageChips(allEntries) {
  const host = document.getElementById("judge-coverage-chips");
  if (!host) return;
  const select = document.getElementById("judge-submission-select");
  const selectedId = select && select.value ? select.value : "";
  const selected = selectedId ? allEntries.find((e) => e.id === selectedId) : null;

  const pool = getJudgePool();
  const chips = [];

  if (selected) {
    const scorers = selected.scoredBy || [];
    pool.forEach((j) => {
      const has = scorers.some((nm) => judgeMatchesPool(nm, j.name));
      chips.push(
        `<span class="judge-cov-chip ${has ? "is-scored" : "is-pending"}" title="${escapeAttr(
          (has ? "Scored: " : "Awaiting: ") + j.name
        )}">${has ? "✓ " : ""}${escapeHtml(j.name)}</span>`
      );
    });
    // Walk-in scorers: nobody in the panel matches this name
    scorers.forEach((name) => {
      const matches = pool.some((j) => judgeMatchesPool(name, j.name));
      if (!matches) {
        chips.push(
          `<span class="judge-cov-chip is-extra" title="${escapeAttr(
            "Scored (walk-in): " + name
          )}">+ ${escapeHtml(name)}</span>`
        );
      }
    });
    const totalConfigured = pool.length;
    const scoredFromPool = pool.filter((j) =>
      scorers.some((nm) => judgeMatchesPool(nm, j.name))
    ).length;
    host.innerHTML = `<span class="judge-cov-meta">${escapeHtml(selected.name)} · ${scoredFromPool}/${totalConfigured} of panel scored</span>${chips.join(
      ""
    )}`;
  } else {
    // Aggregate coverage across the whole queue
    const totalSubs = allEntries.length;
    if (!totalSubs) {
      host.innerHTML = "";
      return;
    }
    const poolCounts = pool.map(() => 0);
    const walkInCounts = new Map();
    allEntries.forEach((e) => {
      (e.scoredBy || []).forEach((nm) => {
        const matchedIdx = pool.findIndex((j) => judgeMatchesPool(nm, j.name));
        if (matchedIdx !== -1) {
          poolCounts[matchedIdx] += 1;
        } else {
          walkInCounts.set(nm, (walkInCounts.get(nm) || 0) + 1);
        }
      });
    });
    pool.forEach((j, i) => {
      const c = poolCounts[i];
      chips.push(
        `<span class="judge-cov-chip ${c > 0 ? "is-scored" : "is-pending"}" title="${escapeAttr(
          `${j.name}: ${c}/${totalSubs} scored`
        )}">${escapeHtml(j.name)} <em>${c}/${totalSubs}</em></span>`
      );
    });
    Array.from(walkInCounts.entries()).forEach(([nm, c]) => {
      chips.push(
        `<span class="judge-cov-chip is-extra" title="${escapeAttr(
          `${nm}: ${c}/${totalSubs} scored (walk-in)`
        )}">+ ${escapeHtml(nm)} <em>${c}/${totalSubs}</em></span>`
      );
    });
    host.innerHTML = `<span class="judge-cov-meta">Pick a submission to see who scored it. Across ${totalSubs}:</span>${chips.join(
      ""
    )}`;
  }
}

function updateJudgeQueueStatsUi({ totalAll, totalMine, hasAssignment, mineOnly }) {
  const stats = document.getElementById("judge-queue-stats");
  const wrap = document.getElementById("judge-mine-toggle-wrap");
  const cb = document.getElementById("judge-mine-only");
  const judgeName = getJudgeNameForUi();
  if (wrap) {
    if (hasAssignment) {
      wrap.hidden = false;
      wrap.removeAttribute("aria-hidden");
    } else {
      wrap.hidden = true;
      wrap.setAttribute("aria-hidden", "true");
    }
  }
  if (cb && !hasAssignment) cb.checked = false;
  if (stats) {
    if (hasAssignment && mineOnly) {
      stats.textContent = `${judgeName}: viewing your assigned slice (${totalMine} of ${totalAll}). Untick to see everyone's queue.`;
    } else if (hasAssignment) {
      stats.textContent = `${judgeName} · viewing all ${totalAll}. (Your suggested slice would be ${totalMine}.)`;
    } else if (judgeName) {
      stats.textContent = `${judgeName} · viewing all ${totalAll}.`;
    } else {
      stats.textContent = "";
    }
  }
}

function findSubmissionById(id) {
  if (!id) return null;
  const rows = window.__summaryRows || [];
  for (const r of rows) {
    const sub = getSubmissionInfoForRow(r);
    const rid = r.repo_id || sub?.project_name || extractRepoName(r.repo);
    if (rid === id) return { row: r, sub: sub || null };
  }
  return null;
}

function judgeNamesMatch(a, b) {
  return (a || "").trim().toLowerCase() === (b || "").trim().toLowerCase();
}

function formatJudgeTime(isoOrStr) {
  if (!isoOrStr) return "—";
  const d = new Date(isoOrStr);
  if (Number.isNaN(d.getTime())) return String(isoOrStr);
  return d.toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" });
}

function buildMergedScoreEntries(submissionId, judgeInfo) {
  const out = [];
  if (judgeInfo?.responses?.length) {
    judgeInfo.responses.forEach((r, idx) => {
      const jLabel =
        r.judge !== null &&
        r.judge !== undefined &&
        String(r.judge).trim()
          ? String(r.judge).trim()
          : `Panel import #${idx + 1}`;
      const detail = judgeInfo.legacy_mode
        ? `${r.total_score}`
        : `${r.total_score}/10 (core ${r.core_total ?? "—"}, bonus ${
            r.bonus_total_capped ?? "—"
          })`;
      out.push({
        source: "imported",
        judge: jLabel,
        at: r.timestamp || null,
        total: r.total_score,
        detail,
      });
    });
  }
  out.sort((a, b) => {
    const ta = a.at ? new Date(a.at).getTime() : 0;
    const tb = b.at ? new Date(b.at).getTime() : 0;
    return ta - tb;
  });
  return out;
}

function mergedScoreAverage(entries) {
  if (!entries.length) return null;
  const sum = entries.reduce((s, e) => s + Number(e.total ?? 0), 0);
  return (sum / entries.length).toFixed(1);
}

function isYouScoreEntry(entry, judgeName) {
  return entry.source === "local" && judgeNamesMatch(entry.judge, judgeName);
}

function demoEmbedUrl(url) {
  const raw = String(url || "").trim();
  if (!raw) return "";
  try {
    const u = new URL(raw);
    const host = u.hostname.replace(/^www\./, "");
    if (host === "youtu.be") {
      return `https://www.youtube.com/embed/${encodeURIComponent(
        u.pathname.slice(1)
      )}?enablejsapi=1`;
    }
    if (host.includes("youtube.com")) {
      const id = u.searchParams.get("v");
      if (id) return `https://www.youtube.com/embed/${encodeURIComponent(id)}?enablejsapi=1`;
      if (u.pathname.startsWith("/shorts/")) {
        return `https://www.youtube.com/embed/${encodeURIComponent(
          u.pathname.split("/")[2] || ""
        )}?enablejsapi=1`;
      }
    }
    if (host.includes("vimeo.com")) {
      const id = u.pathname.split("/").filter(Boolean).pop();
      if (id) return `https://player.vimeo.com/video/${encodeURIComponent(id)}`;
    }
    if (host.includes("loom.com")) {
      const parts = u.pathname.split("/").filter(Boolean);
      const shareIndex = parts.indexOf("share");
      const id = shareIndex >= 0 ? parts[shareIndex + 1] : parts.pop();
      if (id) return `https://www.loom.com/embed/${encodeURIComponent(id)}`;
    }
  } catch {}
  return "";
}

function setJudgeSubmissionByIndex(index) {
  const entries = getJudgeReviewEntries();
  if (!entries.length) {
    judgeCurrentIndex = 0;
    const select = document.getElementById("judge-submission-select");
    if (select) select.value = "";
    renderJudgeSubmissionSummary();
    syncJudgeFullViewFromSelection();
    return;
  }
  judgeCurrentIndex = (index + entries.length) % entries.length;
  const current = entries[judgeCurrentIndex];
  const select = document.getElementById("judge-submission-select");
  if (select) select.value = current.id;
  const picker = document.getElementById("judge-submission-picker");
  if (picker) picker.value = current.id;
  renderJudgeSubmissionSummary();
  syncJudgeFullViewFromSelection();
}

function moveJudgeSubmission(delta) {
  setJudgeSubmissionByIndex(judgeCurrentIndex + delta);
}

function initJudgeSwipeControls() {
  const card = document.querySelector("#judge-modal .judge-demo-card");
  if (!card) return;
  const swipeLayer = document.getElementById("judge-card-swipe-layer");
  let startX = 0;
  let startY = 0;
  let currentX = 0;
  let tracking = false;

  function resetCard() {
    card.style.transform = "";
    card.style.opacity = "";
  }

  function toggleDemoPlayback() {
    const frame = document.querySelector("#judge-demo-stage iframe");
    if (!frame?.contentWindow) return;
    const src = frame.getAttribute("src") || "";
    const playing = card.dataset.demoPlaying === "true";
    if (src.includes("youtube.com/embed/")) {
      frame.contentWindow.postMessage(
        JSON.stringify({
          event: "command",
          func: playing ? "pauseVideo" : "playVideo",
          args: [],
        }),
        "*"
      );
    } else if (src.includes("player.vimeo.com/video/")) {
      frame.contentWindow.postMessage(
        JSON.stringify({ method: playing ? "pause" : "play" }),
        "*"
      );
    } else {
      return;
    }
    card.dataset.demoPlaying = playing ? "false" : "true";
  }

  const startSwipe = (e) => {
    if (e.target.closest("a, button, iframe, .judge-panel-toggle")) return;
    e.stopPropagation();
    tracking = true;
    startX = e.clientX;
    startY = e.clientY;
    currentX = 0;
    card.classList.add("is-swiping");
    card.classList.add("is-peeking-controls");
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };

  const moveSwipe = (e) => {
    if (!tracking) return;
    e.stopPropagation();
    currentX = e.clientX - startX;
    const rotate = Math.max(-8, Math.min(8, currentX / 24));
    const fade = Math.max(0.82, 1 - Math.abs(currentX) / 900);
    card.style.transform = `translateX(${currentX}px) rotate(${rotate}deg)`;
    card.style.opacity = String(fade);
  };

  const endSwipe = (e) => {
    if (!tracking) return;
    e.stopPropagation();
    tracking = false;
    card.classList.remove("is-swiping");
    card.classList.remove("is-peeking-controls");
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (Math.abs(dx) < 8 && Math.abs(dy) < 8) {
      resetCard();
      toggleDemoPlayback();
      return;
    }
    if (dy > 120 && Math.abs(dy) > Math.abs(dx) * 1.25) {
      resetCard();
      closeModal("judge-modal");
      return;
    }
    if (!isJudgeSidePanelOpen() && dx < -100 && Math.abs(dx) > Math.abs(dy) * 1.25) {
      resetCard();
      openJudgeSidePanel();
      return;
    }
    if (Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy) * 1.4) {
      const direction = dx < 0 ? -1 : 1;
      card.classList.add("is-swipe-release");
      card.style.transform = `translateX(${direction * window.innerWidth}px) rotate(${
        direction * 10
      }deg)`;
      card.style.opacity = "0";
      window.setTimeout(() => {
        card.classList.remove("is-swipe-release");
        resetCard();
        moveJudgeSubmission(dx < 0 ? 1 : -1);
      }, 180);
    } else {
      card.classList.add("is-swipe-release");
      resetCard();
      window.setTimeout(() => card.classList.remove("is-swipe-release"), 180);
    }
  };

  const cancelSwipe = () => {
    tracking = false;
    card.classList.remove("is-swiping");
    card.classList.remove("is-peeking-controls");
    card.classList.add("is-swipe-release");
    resetCard();
    window.setTimeout(() => card.classList.remove("is-swipe-release"), 180);
  };

  [card, swipeLayer].filter(Boolean).forEach((target) => {
    target.addEventListener("pointerdown", startSwipe);
    target.addEventListener("pointermove", moveSwipe);
    target.addEventListener("pointerup", endSwipe);
    target.addEventListener("pointercancel", cancelSwipe);
  });
}

function syncJudgePanelToggleState() {
  const toggle = document.getElementById("judge-panel-toggle");
  if (!toggle) return;
  const open = isJudgeSidePanelOpen();
  toggle.classList.toggle("is-open", open);
  toggle.setAttribute("aria-expanded", open ? "true" : "false");
  toggle.querySelector("span").textContent = open ? "›" : "‹";
}

function initJudgePanelToggle() {
  const toggle = document.getElementById("judge-panel-toggle");
  if (!toggle) return;
  toggle.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (isJudgeSidePanelOpen()) closeJudgeSidePanel();
    else openJudgeSidePanel();
    syncJudgePanelToggleState();
  });
  syncJudgePanelToggleState();
}

function renderJudgeVideoStage() {
  const title = document.getElementById("judge-video-title");
  const meta = document.getElementById("judge-video-meta");
  const count = document.getElementById("judge-video-count");
  const stage = document.getElementById("judge-demo-stage");
  const card = document.querySelector("#judge-modal .judge-demo-card");
  if (card) card.dataset.demoPlaying = "false";
  if (!stage) return;
  const entries = getJudgeReviewEntries();
  const selectedId = document.getElementById("judge-submission-select")?.value || "";
  const index = Math.max(0, entries.findIndex((e) => e.id === selectedId));
  if (selectedId && entries[index]) judgeCurrentIndex = index;
  const current = entries[judgeCurrentIndex];

  if (!current) {
    if (title) title.textContent = "";
    if (meta) meta.textContent = "";
    if (count) count.textContent = "0 / 0";
    stage.innerHTML = "";
    renderJudgeScoreQueue();
    return;
  }

  const sub = current.sub || {};
  const demoUrl = sub.demo_url || "";
  const repoUrl = sub.repo_url || current.row?.repo || "";
  const embed = demoEmbedUrl(demoUrl);
  if (title) title.textContent = current.name || "Untitled project";
  if (meta) {
    meta.textContent = `${current.trackLabel || "unscored"} · ${
      current.scored ? "already scored" : "needs score"
    }`;
  }
  if (count) count.textContent = `${judgeCurrentIndex + 1} / ${entries.length}`;

  const links = [
    repoUrl
      ? `<a href="${escapeAttr(repoUrl)}" target="_blank" rel="noopener noreferrer">Repo</a>`
      : "",
    demoUrl
      ? `<a href="${escapeAttr(demoUrl)}" target="_blank" rel="noopener noreferrer">Open demo</a>`
      : "",
  ]
    .filter(Boolean)
    .join("");

  stage.innerHTML = embed
    ? `<iframe class="judge-demo-frame" src="${escapeAttr(
        embed
      )}" title="${escapeAttr(current.name)} demo video" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowfullscreen></iframe><div class="judge-demo-links">${links}</div>`
    : `<div class="judge-demo-empty"><strong>No embeddable demo video.</strong><span>Use the links below, then score from the rail.</span><div class="judge-demo-links">${links || "No demo link provided"}</div></div>`;
}

function renderJudgeScoreQueue() {
  const target = document.getElementById("judge-score-queue");
  if (!target) return;
  const entries = getJudgeReviewEntries();
  const selectedId = document.getElementById("judge-submission-select")?.value || "";
  const done = entries.filter((e) => e.scored).length;
  target.innerHTML = `
    <div class="judge-queue-stats"><strong>${done}</strong> scored · <strong>${
    entries.length - done
  }</strong> left</div>
    <div class="judge-queue-list">
      ${entries
        .map(
          (e, idx) => `<button type="button" class="judge-queue-item ${
            e.id === selectedId ? "is-active" : ""
          } ${e.scored ? "is-scored" : ""}" data-judge-queue-id="${escapeAttr(
            e.id
          )}" data-judge-queue-index="${idx}">
            <span>${escapeHtml(e.name)}</span>
            <small>${escapeHtml(e.scored ? "scored" : "needs score")}</small>
          </button>`
        )
        .join("")}
    </div>
  `;
  target.querySelectorAll("[data-judge-queue-index]").forEach((btn) => {
    btn.addEventListener("click", () => {
      setJudgeSubmissionByIndex(Number(btn.getAttribute("data-judge-queue-index")));
    });
  });
}

function renderJudgeSubmissionToolbar() {
  const toolbar = document.getElementById("judge-submission-toolbar");
  if (!toolbar) return;
  const select = document.getElementById("judge-submission-select");
  const id = select?.value || "";
  const judgeName = getJudgeNameForUi();

  if (!id) {
    toolbar.innerHTML = "";
    return;
  }

  const scored = judgeName.trim()
    ? scoredIdsForJudge(judgeName).has(id)
    : false;
  const hint = scored
    ? `<p class="judge-toolbar-hint">You already saved a score for this project in this browser. Submitting again adds another local entry (amend / duplicate).</p>`
    : "";
  toolbar.innerHTML = hint;
}

function renderJudgeSubmissionSummary() {
  renderJudgeSubmissionToolbar();
  const target = document.getElementById("judge-submission-summary");
  const recap = document.getElementById("judge-quick-recap");
  if (!target) return;
  const select = document.getElementById("judge-submission-select");
  const id = select?.value || "";
  const judgeName = getJudgeNameForUi();
  if (!id) {
    target.innerHTML = "";
    target.classList.remove("is-visible");
    if (recap) {
      recap.textContent = "";
      recap.hidden = true;
    }
    return;
  }
  const found = findSubmissionById(id);
  if (!found) {
    target.innerHTML = "";
    target.classList.remove("is-visible");
    if (recap) {
      recap.textContent = "";
      recap.hidden = true;
    }
    return;
  }
  const { row, sub } = found;
  const subInfo =
    sub || (row ? getSubmissionInfoForRow(row) : null);
  const team = subInfo?.team_name || "—";
  const trackDisplay = formatTrackForLabel(
    subInfo?.chosen_track || row?.chosen_track || ""
  );
  const repoUrl = subInfo?.repo_url || row?.repo || "";
  const demoUrl = subInfo?.demo_url || "";
  const judgeInfo = row ? getJudgeInfoForRow(row) : null;
  const merged = buildMergedScoreEntries(id, judgeInfo);
  const youScored = judgeName.trim()
    ? scoredIdsForJudge(judgeName).has(id)
    : false;
  const youPill = !judgeName.trim()
    ? `<span class="judge-sub-pill judge-sub-pill-you judge-sub-pill-muted" title="Your name is set when you unlock the judge panel">You · —</span>`
    : `<span class="judge-sub-pill judge-sub-pill-you ${
        youScored ? "is-on" : ""
      }" title="Your saves in this browser">You · ${
        youScored ? "scored" : "not scored"
      }</span>`;

  const othersEntries = merged.filter((e) => !isYouScoreEntry(e, judgeName));
  const othersPill =
    othersEntries.length > 0
      ? `<span class="judge-sub-pill judge-sub-pill-others is-on" title="Imports + other judges’ local saves">Others · ${othersEntries.length}</span>`
      : `<span class="judge-sub-pill judge-sub-pill-others judge-sub-pill-muted">Others · none</span>`;

  const repoCell = repoUrl
    ? `<a href="${escapeAttr(
        repoUrl
      )}" target="_blank" rel="noreferrer noopener" class="repo-link judge-sub-link-compact">Repo</a>`
    : `<span class="judge-sub-muted">Repo · —</span>`;
  const demoCell = demoUrl
    ? `<a href="${escapeAttr(
        demoUrl
      )}" target="_blank" rel="noopener noreferrer" class="repo-link judge-sub-link-compact">Demo</a>`
    : `<span class="judge-sub-muted">Demo · —</span>`;

  if (recap) {
    if (merged.length) {
      const ma = mergedScoreAverage(merged);
      const nJ = countUniqueJudges(merged);
      recap.textContent = `Quick recap: avg ${ma} · ${merged.length} score${
        merged.length === 1 ? "" : "s"
      } · ${nJ} judge${nJ === 1 ? "" : "s"}`;
      recap.hidden = false;
    } else {
      recap.textContent = "";
      recap.hidden = true;
    }
  }

  target.innerHTML = `
    <div class="judge-sub-summary-card">
      <div class="judge-sub-meta-row">
        <span class="judge-sub-pill judge-sub-pill-team" title="Team">Team · ${escapeHtml(
          team
        )}</span>
        <span class="judge-sub-pill judge-sub-pill-track track-chip" title="Track">Track · ${escapeHtml(
          trackDisplay
        )}</span>
        <span class="judge-sub-links-inline">${repoCell}<span class="judge-sub-dot" aria-hidden="true">·</span>${demoCell}</span>
        ${youPill}
        ${othersPill}
      </div>
    </div>
  `;
  target.classList.add("is-visible");
}

async function handleJudgeForm(e) {
  e.preventDefault();
  const form = e.target;
  const data = Object.fromEntries(new FormData(form).entries());
  if (!data.submission_id) {
    toast("Pick a submission first");
    return;
  }
  if (!data.judge_name) {
    toast("Judge name is required");
    return;
  }
  const enteredScore = clampJudgeScore(data.judge_score);
  if (enteredScore === null) {
    toast("Add a score between 0 and 10");
    return;
  }
  writeStoredJudgeName(data.judge_name);

  const coreMax = Number(eventFormat?.rubric?.core_max_points ?? 7);
  const bonusCap = Number(eventFormat?.judge_bonus_bucket?.max_points ?? 3);
  const coreTotal = Math.min(enteredScore, coreMax);
  const bonusCapped = Math.min(Math.max(enteredScore - coreMax, 0), bonusCap);
  const coreScores = { overall: coreTotal };
  const bonusScores = {};
  const bonusTotal = bonusCapped;
  (eventFormat?.side_quests || []).forEach((q) => {
    bonusScores[q.id] = 0;
  });
  const grandTotal = enteredScore;
  const found = findSubmissionById(data.submission_id);
  const sub = found?.sub || {};
  const row = found?.row || {};
  const repoUrl = sub.repo_url || row.repo || row.repo_url || "";
  if (!repoUrl) {
    toast("This submission has no repo URL, so it cannot be saved to Supabase.");
    return;
  }

  const entry = {
    scored_at: new Date().toISOString(),
    hack_id: getActiveHackId(),
    judge_name: data.judge_name,
    submission_id: data.submission_id,
    repo_url: repoUrl,
    project_name: sub.project_name || row.project_name || "",
    chosen_track: sub.chosen_track || row.chosen_track || "",
    scored_track: sub.chosen_track || row.chosen_track || "",
    core_scores: coreScores,
    core_total: coreTotal,
    bonus_bucket_scores: bonusScores,
    bonus_total: bonusTotal,
    bonus_total_capped: bonusCapped,
    total_score: grandTotal,
    thoughts: data.thoughts || "",
    notes: data.thoughts || "",
  };

  try {
    const res = await fetch("/api/judges", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(entry),
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(payload.error || "Failed to save score");
    await loadJudgeData();
  } catch (err) {
    toast(err.message || "Score failed. Supabase did not save it.");
    return;
  }

  // Reset score only — keep judge name cached for next submission
  const scoredId = entry.submission_id;
  const scoreInput = document.getElementById("judge-score-input");
  if (scoreInput) scoreInput.value = "";
  const notes = form.querySelector("textarea[name=thoughts]");
  if (notes) notes.value = "";
  updateJudgeRunningTotal();

  // Refresh select so this submission shows [SCORED], then auto-advance.
  refreshJudgeSubmissionSelect();
  const select = document.getElementById("judge-submission-select");
  if (select) {
    const idx = Array.from(select.options).findIndex(
      (o) => o.value === scoredId
    );
    const nextIdx = idx >= 0 && idx < select.options.length - 1 ? idx + 1 : 0;
    for (let i = nextIdx; i < select.options.length; i++) {
      const opt = select.options[i];
      if (opt.value && !opt.disabled) {
        select.value = opt.value;
        break;
      }
    }
    renderJudgeSubmissionSummary();
    onJudgeSubmissionSelectChanged();
    if (isJudgeSidePanelOpen()) {
      const r = getJudgeApiRepoId();
      if (r) loadDetails(r, detailElsForJudgeSidePanel());
    }
  }
  toast(
    `Score saved — ${formatJudgeScore(
      grandTotal
    )}/10. Supabase is now the source of truth.`
  );
}

// ---------- Manager ----------
function rowJudgeScore(row) {
  const info = getJudgeInfoForRow(row);
  return Number(info?.averages?.grand_total ?? info?.average_score ?? 0);
}

function integrityShortTags(r) {
  const tags = [];
  if (Number(r.has_commits_before_t0) > 0) tags.push("pre");
  if (Number(r.has_bulk_commits) > 0) tags.push("bulk");
  if (Number(r.has_large_initial_commit_after_t0) > 0) tags.push("init");
  if (Number(r.has_merge_commits) > 0) tags.push("merge");
  return tags;
}

function ensureLeaderboardNote(listEl, show, text) {
  const wrap = listEl.closest(".leaderboard") || listEl.parentElement;
  if (!wrap) return;
  let note = wrap.querySelector("[data-lb-fallback-note]");
  if (show) {
    if (!note) {
      note = document.createElement("p");
      note.setAttribute("data-lb-fallback-note", "1");
      note.className = "manager-hint manager-lb-fallback";
      wrap.insertBefore(note, listEl);
    }
    note.hidden = false;
    note.textContent = text;
  } else if (note) {
    note.hidden = true;
  }
}

function renderManagerPanel() {
  const stats = document.getElementById("manager-stats");
  const aggregates = document.getElementById("manager-aggregates");
  const rows = window.__summaryRows || [];
  const persistedScores = Array.from(judgeMap.values()).reduce(
    (sum, info) => sum + (info?.responses?.length || 0),
    0
  );
  const tracked = rows.length;

  const moneyMovement = rows.filter((r) =>
    trackMatchesCategory(getRowTrackLabel(r), "money-movement")
  ).length;
  const financialIntelligence = rows.filter((r) =>
    trackMatchesCategory(getRowTrackLabel(r), "financial-intelligence")
  ).length;
  const noTrackLabel = rows.filter((r) => !getRowTrackLabel(r)).length;
  const vagueTrack = rows.filter((r) => {
    const t = getRowTrackLabel(r);
    if (!t) return false;
    return (
      !trackMatchesCategory(t, "money-movement") &&
      !trackMatchesCategory(t, "financial-intelligence")
    );
  }).length;
  const flagged = rows.filter((r) => hasAnyFlag(r)).length;

  const sumCommits = rows.reduce(
    (s, r) => s + (Number(r.total_commits) || 0),
    0
  );
  const sumAdd = rows.reduce(
    (s, r) => s + (Number(r.total_loc_added) || 0),
    0
  );
  const sumDel = rows.reduce(
    (s, r) => s + (Number(r.total_loc_deleted) || 0),
    0
  );
  const analyzed = rows.filter((r) => r.analysis_status === "analyzed").length;
  const nRepos = rows.length || 1;
  const avgCommits = sumCommits / nRepos;

  if (stats) {
    stats.innerHTML = `
    <div class="manager-stat"><span class="manager-stat-num">${tracked}</span><span class="manager-stat-lbl">Total</span></div>
    <div class="manager-stat"><span class="manager-stat-num">${moneyMovement}</span><span class="manager-stat-lbl">Money mov.</span></div>
    <div class="manager-stat"><span class="manager-stat-num">${financialIntelligence}</span><span class="manager-stat-lbl">Fin. intel.</span></div>
    <div class="manager-stat"><span class="manager-stat-num">${flagged}</span><span class="manager-stat-lbl">Flagged</span></div>
    <div class="manager-stat"><span class="manager-stat-num">${persistedScores}</span><span class="manager-stat-lbl">DB scores</span></div>
    <div class="manager-stat"><span class="manager-stat-num">0</span><span class="manager-stat-lbl">Local-only</span></div>
    <div class="manager-stat"><span class="manager-stat-num">${noTrackLabel}</span><span class="manager-stat-lbl">No track</span></div>
    <div class="manager-stat"><span class="manager-stat-num">${vagueTrack}</span><span class="manager-stat-lbl">Other track</span></div>
    <div class="manager-stat"><span class="manager-stat-num">${formatNumber(sumCommits)}</span><span class="manager-stat-lbl">Σ commits</span></div>
    <div class="manager-stat"><span class="manager-stat-num">${avgCommits.toFixed(1)}</span><span class="manager-stat-lbl">Avg cmt/repo</span></div>
    <div class="manager-stat"><span class="manager-stat-num">${formatNumber(analyzed)}</span><span class="manager-stat-lbl">Analyzed</span></div>
    <div class="manager-stat"><span class="manager-stat-num">${formatNumber(sumAdd)}</span><span class="manager-stat-lbl">Σ +LOC</span></div>
  `;
  }

  if (aggregates) {
    aggregates.innerHTML = `
    <div class="manager-aggregate-strip">
      <div class="manager-agg"><span class="manager-agg-k">Σ commits</span><span class="manager-agg-v">${formatNumber(
        sumCommits
      )}</span></div>
      <div class="manager-agg"><span class="manager-agg-k">Σ +LOC</span><span class="manager-agg-v">${formatNumber(
        sumAdd
      )}</span></div>
      <div class="manager-agg"><span class="manager-agg-k">Σ −LOC</span><span class="manager-agg-v">${formatNumber(
        sumDel
      )}</span></div>
      <div class="manager-agg"><span class="manager-agg-k">Churn (add+del)</span><span class="manager-agg-v">${formatNumber(
        sumAdd + sumDel
      )}</span></div>
      <div class="manager-agg"><span class="manager-agg-k">Avg commits/repo</span><span class="manager-agg-v">${avgCommits.toFixed(
        1
      )}</span></div>
    </div>
  `;
  }

  renderOverallLeaderboard();
  renderLeaderboard("money-movement", "leaderboard-money-movement");
  renderLeaderboard(
    "financial-intelligence",
    "leaderboard-financial-intelligence"
  );
  renderManagerSnapshot();
  renderFlaggedList();
  renderLocalSubmissions();
}

function renderOverallLeaderboard() {
  const list = document.getElementById("leaderboard-overall");
  if (!list) return;
  const rows = window.__summaryRows || [];
  const ranked = [...rows]
    .map((r) => ({
      row: r,
      name:
        getSubmissionInfoForRow(r)?.project_name ||
        r.repo_id ||
        extractRepoName(r.repo),
      score: rowJudgeScore(r),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);
  if (ranked.length === 0) {
    list.innerHTML =
      '<li style="justify-content:center;color:var(--muted);font-style:italic;grid-column:1/-1;border:none;background:transparent">No submissions loaded yet</li>';
    return;
  }
  list.innerHTML = ranked
    .map(
      (r) => `
    <li>
      ${lbNameCell(r.row, r.name)}
      <span class="lb-score">${r.score > 0 ? r.score.toFixed(1) : "—"}</span>
    </li>
  `
    )
    .join("");
}

function renderLeaderboard(category, listId) {
  const list = document.getElementById(listId);
  if (!list) return;
  const rows = window.__summaryRows || [];
  let inTrack = rows.filter((r) =>
    trackMatchesCategory(getRowTrackLabel(r), category)
  );
  let ranked = inTrack
    .map((r) => ({
      row: r,
      name:
        getSubmissionInfoForRow(r)?.project_name ||
        r.repo_id ||
        extractRepoName(r.repo),
      score: rowJudgeScore(r),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

  let usedFallback = false;
  if (ranked.length === 0 && rows.length > 0) {
    usedFallback = true;
    ranked = rows
      .map((r) => ({
        row: r,
        name:
          getSubmissionInfoForRow(r)?.project_name ||
          r.repo_id ||
          extractRepoName(r.repo),
        score: rowJudgeScore(r),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);
  }

  if (ranked.length === 0) {
    ensureLeaderboardNote(list, false, "");
    list.innerHTML =
      '<li style="justify-content:center;color:var(--muted);font-style:italic;grid-column:1/-1;border:none;background:transparent">No submissions yet in this track</li>';
    return;
  }

  ensureLeaderboardNote(
    list,
    usedFallback,
    usedFallback
      ? "No projects matched this track label (missing or non-standard track text). Showing top judge scores overall instead."
      : ""
  );

  list.innerHTML = ranked
    .map(
      (r) => `
    <li>
      ${lbNameCell(r.row, r.name)}
      <span class="lb-score">${r.score > 0 ? r.score.toFixed(1) : "—"}</span>
    </li>
  `
    )
    .join("");
}

function renderManagerSnapshot() {
  const tbody = document.getElementById("manager-snapshot-tbody");
  if (!tbody) return;
  const rows = [...(window.__summaryRows || [])].sort(
    (a, b) =>
      (Number(b.total_commits) || 0) - (Number(a.total_commits) || 0)
  );

  if (rows.length === 0) {
    tbody.innerHTML = `<tr><td colspan="8" class="manager-snapshot-empty">No submission rows — check API or data bundle.</td></tr>`;
    return;
  }

  tbody.innerHTML = rows
    .map((r) => {
      const sub = getSubmissionInfoForRow(r);
      const repoId =
        r.repo_id || r.submission_id || extractRepoName(r.repo || sub?.repo_url);
      const name =
        sub?.project_name || r.repo_id || extractRepoName(r.repo);
      const track = getRowTrackLabel(r) || "—";
      const tc = Number(r.total_commits) || 0;
      const la = Number(r.total_loc_added) || 0;
      const ld = Number(r.total_loc_deleted) || 0;
      const tagStr = integrityShortTags(r).join(" · ") || "—";
      const j = rowJudgeScore(r);
      const url = r.repo || sub?.repo_url || "";
      const demo = sub?.demo_url || "";
      const links = `${repoLink(url)}${
        demo ? ` ${demoLink(sub)}` : ""
      } <button type="button" class="btn btn-ghost manager-open-detail" data-repo="${escapeAttr(
        repoId
      )}">Details</button>`;
      return `<tr data-repo-id="${escapeAttr(repoId)}" class="manager-snap-row" tabindex="0">
        <td><span class="snap-name">${escapeHtml(name)}</span>${tc ? `<span class="snap-meta">${tc} commits</span>` : ""}</td>
        <td>${trackChip(track === "—" ? "" : track)}</td>
        <td class="num-cell">${tc}</td>
        <td class="num-cell loc-add">+${formatNumber(la)}</td>
        <td class="num-cell loc-del">−${formatNumber(ld)}</td>
        <td class="snap-flags">${escapeHtml(tagStr)}</td>
        <td class="num-cell">${j > 0 ? j.toFixed(1) : "—"}</td>
        <td class="snap-actions">${links}</td>
      </tr>`;
    })
    .join("");

  tbody.querySelectorAll(".manager-open-detail").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const id = btn.getAttribute("data-repo");
      if (id) openDrawer(id);
    });
  });
  tbody.querySelectorAll(".manager-snap-row").forEach((tr) => {
    const id = tr.getAttribute("data-repo-id");
    const open = () => id && openDrawer(id);
    tr.addEventListener("dblclick", open);
    tr.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        open();
      }
    });
  });
}

function renderFlaggedList() {
  const ul = document.getElementById("flagged-list");
  if (!ul) return;
  const rows = window.__summaryRows || [];
  const flagged = rows.filter((r) => hasAnyFlag(r)).slice(0, 30);
  if (flagged.length === 0) {
    ul.innerHTML =
      '<li style="justify-content:center;color:var(--muted);font-style:italic">No flags raised</li>';
    return;
  }
  ul.innerHTML = flagged
    .map((r) => {
      const tags = [];
      if (Number(r.has_commits_before_t0) > 0) tags.push("pre-T0");
      if (Number(r.has_bulk_commits) > 0) tags.push("bulk");
      if (Number(r.has_large_initial_commit_after_t0) > 0)
        tags.push("big-init");
      if (Number(r.has_merge_commits) > 0) tags.push("merge");
      const sub = getSubmissionInfoForRow(r);
      const name = sub?.project_name || r.repo_id;
      const tc = Number(r.total_commits) || 0;
      const url = r.repo || sub?.repo_url || "";
      const repoId =
        r.repo_id || r.submission_id || extractRepoName(r.repo || url);
      const detailBtn = `<button type="button" class="btn btn-ghost manager-open-detail" data-repo="${escapeAttr(
        repoId
      )}">Details</button>`;
      const linkPart = url
        ? `<a class="repo-link" href="${escapeAttr(
            url
          )}" target="_blank" rel="noreferrer">Repo</a>`
        : "";
      return `
      <li>
        <span class="flagged-name">${escapeHtml(name)}<span class="flagged-meta">${tc} commits</span></span>
        <span class="flagged-actions"><span class="flagged-tags">${escapeHtml(
          tags.join(" · ")
        )}</span>${linkPart ? ` ${linkPart}` : ""} ${detailBtn}</span>
      </li>
    `;
    })
    .join("");

  ul.querySelectorAll(".manager-open-detail").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      const id = btn.getAttribute("data-repo");
      if (id) openDrawer(id);
    });
  });
}

function renderLocalSubmissions() {
  const ul = document.getElementById("local-submissions");
  if (!ul) return;
  const local = getLocalList(localSubmissionsKey());
  if (local.length === 0) {
    ul.innerHTML =
      '<li style="justify-content:center;color:var(--muted);font-style:italic">No browser-only submissions. Live submissions must be in Supabase.</li>';
    return;
  }
  ul.innerHTML = local
    .map(
      (s) => `
    <li>
      <span class="flagged-name">${escapeHtml(s.project_name)} · ${escapeHtml(
        s.team_name
      )}</span>
      <span class="flagged-tags">${escapeHtml(
        s.chosen_track || "unassigned"
      )}</span>
    </li>
  `
    )
    .join("");
}

function exportSubmissionsJSON() {
  const rows = window.__summaryRows || [];
  const persistedScores = Array.from(judgeMap.values()).flatMap(
    (info) => info?.responses || []
  );
  const payload = {
    exported_at: new Date().toISOString(),
    event: eventFormat?.event_name || "Build Finance Agents · London 2026",
    storage: "supabase",
    judge_scores: persistedScores,
    github_summary_rows: rows,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${hackStorageSlug()}-export-${Date.now()}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  toast(
    `Exported ${rows.length} submissions and ${persistedScores.length} persisted scores`
  );
}

// ---------- Toasts ----------
/**
 * @param {string} message
 * @param {{ variant?: 'default'|'success'; title?: string; detail?: string; meta?: string; duration?: number }} [options]
 */
function toast(message, options) {
  const opts =
    options && typeof options === "object" ? options : {};
  const variant = opts.variant === "success" ? "success" : "default";
  const duration =
    typeof opts.duration === "number"
      ? opts.duration
      : variant === "success"
        ? 5800
        : 3500;

  let el = document.getElementById("toast-stack");
  if (!el) {
    el = document.createElement("div");
    el.id = "toast-stack";
    document.body.appendChild(el);
  }

  const wrap = document.createElement("div");
  wrap.className = `toast toast--${variant}`;
  wrap.setAttribute("role", "status");
  wrap.setAttribute("aria-live", "polite");

  if (variant === "success") {
    const title = String(opts.title || "Success").trim() || "Success";
    const detail = String(opts.detail || message || "").trim();
    const meta = String(opts.meta || "").trim();
    wrap.innerHTML =
      '<span class="toast-glow" aria-hidden="true"></span>' +
      '<span class="toast-shine" aria-hidden="true"></span>' +
      '<div class="toast-surface">' +
      '<span class="toast-check" aria-hidden="true"><span class="toast-check-mark">✓</span></span>' +
      '<div class="toast-text">' +
      '<div class="toast-title"></div>' +
      (detail
        ? '<div class="toast-detail"></div>'
        : "") +
      (meta
        ? '<div class="toast-meta"></div>'
        : "") +
      "</div></div>";
    wrap.querySelector(".toast-title").textContent = title;
    const dEl = wrap.querySelector(".toast-detail");
    if (dEl && detail) dEl.textContent = detail;
    const mEl = wrap.querySelector(".toast-meta");
    if (mEl && meta) mEl.textContent = meta;
  } else {
    wrap.textContent = String(message || "");
  }

  el.appendChild(wrap);
  const dismiss = () => {
    if (!wrap.isConnected) return;
    const done = () => {
      wrap.removeEventListener("animationend", onEnd);
      clearTimeout(fallback);
      wrap.remove();
    };
    const onEnd = (ev) => {
      if (ev.target !== wrap || ev.animationName !== "toast-exit") return;
      done();
    };
    wrap.addEventListener("animationend", onEnd);
    wrap.classList.add("toast--exit");
    const fallback = setTimeout(done, 650);
  };
  setTimeout(dismiss, duration);
}

const CONFETTI_COLORS = [
  "#f472b6",
  "#e879f9",
  "#a78bfa",
  "#818cf8",
  "#38bdf8",
  "#22d3ee",
  "#34d399",
  "#facc15",
  "#fb923c",
  "#f87171",
];

function spawnConfettiBurst(root, originX, originY, count, velocityScale, delayBase) {
  for (let i = 0; i < count; i++) {
    const p = document.createElement("div");
    p.className = "confetti-piece";
    const angle = Math.random() * Math.PI * 2;
    const speed = (5 + Math.random() * 14) * velocityScale;
    const dx = Math.cos(angle) * speed * (12 + Math.random() * 12);
    const dy =
      Math.sin(angle) * speed * (9 + Math.random() * 9) - (32 + Math.random() * 55) * velocityScale;
    const rot = (Math.random() - 0.5) * 1080;
    const w = 4 + Math.random() * 8;
    const h = 2.5 + Math.random() * 5.5;
    const color =
      CONFETTI_COLORS[(i + Math.floor(Math.random() * 5)) % CONFETTI_COLORS.length];
    p.style.background = color;
    p.style.width = `${w}px`;
    p.style.height = `${h}px`;
    p.style.left = `${originX}px`;
    p.style.top = `${originY}px`;
    p.style.borderRadius = Math.random() > 0.55 ? "50%" : "2px";
    p.style.setProperty("--dx", `${dx}px`);
    p.style.setProperty("--dy", `${dy}px`);
    p.style.setProperty("--rot", `${rot}deg`);
    const delay = delayBase + Math.random() * 0.14;
    p.style.animationDelay = `${delay}s`;
    root.appendChild(p);
  }
}

function launchConfetti() {
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
    return;
  }
  const root = document.createElement("div");
  root.className = "confetti-layer";
  root.setAttribute("aria-hidden", "true");
  document.body.appendChild(root);
  requestAnimationFrame(() => root.classList.add("confetti-layer--active"));

  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const originX = vw / 2;
  const originY = Math.min(vh * 0.36, vh * 0.48);

  spawnConfettiBurst(root, originX, originY, 56, 1, 0);
  spawnConfettiBurst(root, originX, originY, 36, 0.72, 0.1);

  setTimeout(() => {
    root.classList.add("confetti-layer--fade");
    setTimeout(() => root.remove(), 720);
  }, 2680);
}

// ---------- Update submissions count after load ----------
function updateSubmissionsCount(rows) {
  const el = document.getElementById("submissions-count");
  if (!el) return;
  if (!canRenderSensitiveSummaryTable()) {
    el.textContent = "—";
    return;
  }
  el.textContent = rows.length;
}

document.addEventListener("DOMContentLoaded", () => {
  initManagerTabs();

  // Public submissions table on the marketing page (no auth required).
  if (document.getElementById("submissions-tbody")) {
    loadAndRenderPublicSubmissions();
  }

  // Filters live inside a <template> until Manager opens — delegate changes.
  document.getElementById("manager-modal")?.addEventListener("change", (e) => {
    const t = e.target;
    if (
      t &&
      (t.id === "filter-preT0" ||
        t.id === "filter-bulk" ||
        t.id === "filter-merge" ||
        t.id === "sort-select")
    ) {
      maybeRenderSummaryTable();
    }
  });

  // Modal open triggers
  // Cursor SDK bonus: JS-controlled fixed popover so it cannot be clipped by cards.
  const subtrackSdkPopovers = [];

  function positionSubtrackSdkPopover(btn, pop) {
    const gap = 8;
    const margin = 14;
    const rect = btn.getBoundingClientRect();
    const width = Math.min(292, window.innerWidth - margin * 2);
    pop.style.width = `${width}px`;
    pop.style.left = `${Math.min(Math.max(margin, rect.right - width), window.innerWidth - width - margin)}px`;

    const height = pop.offsetHeight || 0;
    const above = rect.top - height - gap;
    const below = rect.bottom + gap;
    pop.style.top = `${above >= margin ? above : Math.min(below, window.innerHeight - height - margin)}px`;
  }

  function closeAllSubtrackSdkPopovers(exceptWrap) {
    subtrackSdkPopovers.forEach((item) => {
      if (exceptWrap && item.wrap === exceptWrap) return;
      item.pinned = false;
      item.wrap.classList.remove("subtrack-sdk-open");
      item.pop.classList.remove("subtrack-sdk-popover--open");
      item.pop.dataset.pinned = "false";
      item.btn.setAttribute("aria-expanded", "false");
    });
  }

  function openSubtrackSdkPopover(item, pinned) {
    closeAllSubtrackSdkPopovers(item.wrap);
    item.pinned = !!pinned;
    item.wrap.classList.add("subtrack-sdk-open");
    item.pop.classList.add("subtrack-sdk-popover--open");
    item.pop.dataset.pinned = item.pinned ? "true" : "false";
    item.btn.setAttribute("aria-expanded", "true");
    positionSubtrackSdkPopover(item.btn, item.pop);
  }

  function maybeCloseSubtrackSdkPopover(item) {
    window.setTimeout(() => {
      const active = document.activeElement;
      const hasFocus = item.wrap.contains(active) || item.pop.contains(active);
      const isHovering = item.wrap.matches(":hover") || item.pop.matches(":hover");
      if (item.pinned || hasFocus || isHovering) return;
      closeAllSubtrackSdkPopovers();
    }, 80);
  }

  document.querySelectorAll(".subtrack-info-wrap").forEach((wrap) => {
    const btn = wrap.querySelector(".subtrack-info-btn");
    const pop = btn && document.getElementById(btn.getAttribute("aria-controls") || "");
    if (!btn || !pop) return;
    if (pop.parentElement !== document.body) {
      document.body.appendChild(pop);
    }
    const item = { wrap, btn, pop, pinned: false };
    subtrackSdkPopovers.push(item);

    btn.addEventListener("mouseenter", () => {
      if (!item.pinned) openSubtrackSdkPopover(item, false);
    });
    btn.addEventListener("focus", () => {
      if (!item.pinned) openSubtrackSdkPopover(item, false);
    });
    wrap.addEventListener("mouseleave", () => maybeCloseSubtrackSdkPopover(item));
    pop.addEventListener("mouseenter", () => {
      if (!item.pinned) openSubtrackSdkPopover(item, false);
    });
    pop.addEventListener("mouseleave", () => maybeCloseSubtrackSdkPopover(item));
    pop.addEventListener("click", (e) => e.stopPropagation());
    pop.addEventListener("focusout", () => maybeCloseSubtrackSdkPopover(item));
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (item.pinned) {
        closeAllSubtrackSdkPopovers();
      } else {
        openSubtrackSdkPopover(item, true);
      }
    });
  });
  document.addEventListener("click", (e) => {
    const t = e.target;
    if (
      t &&
      typeof t.closest === "function" &&
      (t.closest(".subtrack-info-wrap") || t.closest(".subtrack-sdk-popover"))
    ) {
      return;
    }
    closeAllSubtrackSdkPopovers();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    const open = document.querySelector(".subtrack-info-wrap.subtrack-sdk-open .subtrack-info-btn");
    closeAllSubtrackSdkPopovers();
    if (open) open.focus();
  });
  window.addEventListener("resize", () => {
    subtrackSdkPopovers.forEach((item) => {
      if (item.wrap.classList.contains("subtrack-sdk-open")) {
        positionSubtrackSdkPopover(item.btn, item.pop);
      }
    });
  });
  window.addEventListener(
    "scroll",
    () => {
      subtrackSdkPopovers.forEach((item) => {
        if (item.wrap.classList.contains("subtrack-sdk-open")) {
          positionSubtrackSdkPopover(item.btn, item.pop);
        }
      });
    },
    true
  );

  document.querySelectorAll("[data-open-modal]").forEach((btn) => {
    btn.addEventListener("click", () => openModal(btn.dataset.openModal));
  });
  const requestedModal = new URLSearchParams(window.location.search).get("open");
  const modalByRequest = {
    submit: "submit-modal",
    judge: "judge-modal",
    manager: "manager-modal",
  };
  if (modalByRequest[requestedModal]) {
    window.setTimeout(() => openModal(modalByRequest[requestedModal]), 120);
  }
  document.querySelectorAll("[data-close-modal]").forEach((el) => {
    el.addEventListener("click", () => {
      const modal = el.closest(".modal");
      if (modal) closeModal(modal.id);
    });
  });

  // Submit + Judge forms
  const submitForm = document.getElementById("submit-form");
  if (submitForm) submitForm.addEventListener("submit", handleSubmitForm);
  const judgeForm = document.getElementById("judge-form");
  if (judgeForm) judgeForm.addEventListener("submit", handleJudgeForm);

  const judgeSelect = document.getElementById("judge-submission-select");
  if (judgeSelect) {
    judgeSelect.addEventListener("change", onJudgeSubmissionSelectChanged);
  }
  const judgePicker = document.getElementById("judge-submission-picker");
  if (judgePicker) {
    judgePicker.addEventListener("change", () => {
      const select = document.getElementById("judge-submission-select");
      if (select) select.value = judgePicker.value;
      onJudgeSubmissionSelectChanged();
    });
  }
  const prevJudge = document.getElementById("judge-prev-submission");
  if (prevJudge) prevJudge.addEventListener("click", () => moveJudgeSubmission(-1));
  const nextJudge = document.getElementById("judge-next-submission");
  if (nextJudge) nextJudge.addEventListener("click", () => moveJudgeSubmission(1));
  const refreshJudge = document.getElementById("judge-refresh-submissions");
  if (refreshJudge) refreshJudge.addEventListener("click", () => refreshJudgeSubmissions({ silent: false }));
  const mineOnlyCb = document.getElementById("judge-mine-only");
  if (mineOnlyCb) {
    mineOnlyCb.addEventListener("change", () => {
      refreshJudgeSubmissionSelect();
      const sel = document.getElementById("judge-submission-select");
      if (sel) onJudgeSubmissionSelectChanged();
    });
  }
  const moreInfo = document.getElementById("judge-more-info");
  if (moreInfo) {
    moreInfo.addEventListener("click", () => {
      openJudgeSidePanel();
    });
  }
  initJudgeSwipeControls();
  initJudgePanelToggle();
  document.querySelectorAll("[data-judge-side-tab]").forEach((b) => {
    b.addEventListener("click", () => {
      setActiveJudgeSideTab(
        b.getAttribute("data-judge-side-tab") || "submission"
      );
    });
  });

  // Password gate
  applyAuthState();
  const passwordForm = document.getElementById("password-form");
  if (passwordForm) {
    passwordForm.addEventListener("submit", (e) => {
      e.preventDefault();
      const pwInput = passwordForm.querySelector("input[name=password]");
      const gateNameInput = passwordForm.querySelector("#password-judge-name");
      const errorEl = document.getElementById("password-error");
      const nameVal = (gateNameInput && gateNameInput.value.trim()) || "";
      const value = (pwInput && pwInput.value) || "";
      if (nameVal.length < 2) {
        if (errorEl) {
          errorEl.textContent =
            "Enter your full name (at least 2 characters).";
        }
        if (gateNameInput) gateNameInput.focus();
        return;
      }
      if (value === AUTH_CODE) {
        try {
          sessionStorage.setItem(AUTH_KEY, AUTH_CODE);
        } catch {}
        writeStoredJudgeName(nameVal);
        passwordForm.reset();
        if (errorEl) errorEl.textContent = "";
        applyAuthState();
        closeModal("password-modal");
        const next = pendingGatedModalId;
        pendingGatedModalId = null;
        renderJudgeScoreQueue();
        renderJudgeSubmissionToolbar();
        renderJudgeSubmissionSummary();
        if (next) setTimeout(() => openModal(next), 80);
        toast("Unlocked — judge + manager panels available");
      } else {
        if (errorEl) errorEl.textContent = "Wrong code. Try again.";
        if (pwInput) {
          pwInput.value = "";
          pwInput.focus();
        }
      }
    });
  }

  // Drawer "Score this" button opens the judge modal pre-populated
  const drawerJudgeBtn = document.getElementById("drawer-judge-btn");
  if (drawerJudgeBtn) {
    drawerJudgeBtn.addEventListener("click", () => {
      const title = document.getElementById("detail-title").textContent.trim();
      closeDrawer();
      openModal("judge-modal");
      const select = document.getElementById("judge-submission-select");
      if (select) {
        const opt = Array.from(select.options).find(
          (o) => o.value === title || o.textContent.startsWith(title)
        );
        if (opt) {
          select.value = opt.value;
          renderJudgeSubmissionSummary();
          syncJudgeFullViewFromSelection();
        }
      }
    });
  }

  const exportBtn = document.getElementById("export-submissions-btn");
  if (exportBtn) exportBtn.addEventListener("click", exportSubmissionsJSON);

  // Drawer close handlers
  document
    .getElementById("close-drawer")
    .addEventListener("click", closeDrawer);
  document
    .getElementById("drawer-overlay")
    .addEventListener("click", closeDrawer);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      closeDrawer();
      if (isJudgeSidePanelOpen()) {
        closeJudgeSidePanel();
        return;
      }
      document
        .querySelectorAll(".modal:not(.hidden)")
        .forEach((m) => closeModal(m.id));
    } else if (
      !document.getElementById("judge-modal")?.classList.contains("hidden") &&
      (e.key === "ArrowLeft" || e.key === "ArrowRight") &&
      !["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName)
    ) {
      e.preventDefault();
      moveJudgeSubmission(e.key === "ArrowRight" ? 1 : -1);
    }
  });

  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  document.querySelectorAll(".brand-mark.brand-mark--video").forEach((brandShell) => {
    const brandVideo = brandShell.querySelector(".brand-cursor-video");
    if (!brandVideo) return;
    brandVideo.pause();
    brandVideo.currentTime = 0;

    function isActivelyPlaying() {
      return !brandVideo.paused && !brandVideo.ended;
    }

    function tryPlayBrandVideo() {
      if (reduceMotion) return;
      if (isActivelyPlaying()) return;
      if (brandVideo.ended) brandVideo.currentTime = 0;
      const p = brandVideo.play();
      if (p !== undefined) p.catch(() => {});
    }

    brandShell.addEventListener("mouseenter", tryPlayBrandVideo);
    brandShell.addEventListener("click", (e) => {
      e.preventDefault();
      tryPlayBrandVideo();
    });
    brandShell.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        tryPlayBrandVideo();
      }
    });
  });

  (function initContextLightbox() {
    const GALLERY = [
      {
        handle: "@sualehasif996",
        headline: "Scaling Shopify, turbopuffer, and databases",
        lead:
          "A conversation with @sirupsen on scaling Shopify through flash sales, collaborating across infra teams in the 2010s, and what is next for databases.",
        desc:
          "Sualeh Asif talks with Thomas Habets (@sirupsen) about scaling Shopify during flash sales and outages, how top infrastructure teams collaborated a decade ago, Logrus-era principles, on-call culture, and database futures.",
        href: "https://x.com/sualehasif996/status/2054992106196787686",
        linkLabel: "Open post on X",
        href2: null,
        link2Label: null,
      },
      {
        handle: "@kamil_sattar",
        headline: "Shopify AI Toolkit for your favorite coding agent",
        lead:
          "Shopify AI Toolkit connects Claude Code, Cursor, VS Code, Gemini CLI, Codex, and more to Shopify docs, schemas, validation, and your store.",
        desc:
          "Kamil Sattar highlights Shopify dropping the AI Toolkit so merchants can manage and build with familiar agents — wired directly into Shopify documentation, schemas, validation, and store operations.",
        href: "https://x.com/kamil_sattar/status/2042599288501354987",
        linkLabel: "Open post on X",
        href2: null,
        link2Label: null,
      },
      {
        handle: "@Shopify",
        headline: "The Shopify AI Toolkit is here",
        lead:
          "Manage your store with Claude Code, Codex, Cursor, VS Code, and more — connected to first-party Shopify tooling.",
        desc:
          "Shopify announces the AI Toolkit: operate your storefront through agents including Claude Code, Codex, Cursor, and VS Code, backed by Shopify-native docs and workflows.",
        href: "https://x.com/Shopify/status/2042335627862032754",
        linkLabel: "Open post on X",
        href2: null,
        link2Label: null,
      },
      {
        handle: "@glenngabe",
        headline: "OpenAI launches an ads signup landing page",
        lead:
          "New landing page includes sign-up flow, ads documentation, and a walkthrough video; OpenAI verifies each advertiser before they go live.",
        desc:
          "Glenn Gabe flags OpenAI's public ads landing page — registration, docs, and video guidance — noting advertiser verification can take time after sign-up.",
        href: "https://x.com/glenngabe/status/2051731899471847785",
        linkLabel: "Open post on X",
        href2: null,
        link2Label: null,
      },
      {
        handle: "@samboboev",
        headline: "Agentic commerce may start with builders, not baskets",
        lead:
          "a16z partner @nlevine19 argues early agentic commerce could center developers and solopreneurs accessing tools, APIs, and datasets — before everyday consumer purchases.",
        desc:
          "Sam Boboev summarizes an insight from @nlevine19 at Andreessen Horowitz: agentic commerce might first scale where builders procure software and data through agents rather than shoppers buying commodity SKUs.",
        href: "https://x.com/samboboev/status/2054508641990983694",
        linkLabel: "Open post on X",
        href2: null,
        link2Label: null,
      },
      {
        handle: "@JeremyMearsX",
        headline: "Buyers can DM merchants inside Agentic Commerce chats",
        lead:
          "No detached contact forms — shoppers ask questions in-thread, agents relay them, and merchants answer without breaking the conversational surface.",
        desc:
          "Jeremy Mears describes in-conversation merchant messaging for Agentic Commerce: buyers request handwritten notes or tweaks, agents transmit them, merchants reply inline.",
        href: "https://x.com/JeremyMearsX/status/2055124083084603648",
        linkLabel: "Open post on X",
        href2: null,
        link2Label: null,
      },
    ];
    const lightbox = document.getElementById("context-lightbox");
    const backdrop = lightbox && lightbox.querySelector(".context-lightbox__backdrop");
    const shell = lightbox && lightbox.querySelector(".context-lightbox__shell");
    const desc = document.getElementById("context-lb-desc");
    const hrefEl = document.getElementById("context-lb-href");
    const href2El = document.getElementById("context-lb-href2");
    const prevBtn = document.getElementById("context-lb-prev");
    const nextBtn = document.getElementById("context-lb-next");
    const strip = document.getElementById("context-strip");
    const handleEl = document.getElementById("context-lb-handle");
    const titleEl = document.getElementById("context-lb-preview-title");
    const leadEl = document.getElementById("context-lb-preview-lead");
    if (
      !lightbox ||
      !backdrop ||
      !shell ||
      !desc ||
      !hrefEl ||
      !href2El ||
      !prevBtn ||
      !nextBtn ||
      !strip ||
      !handleEl ||
      !titleEl ||
      !leadEl
    ) {
      return;
    }
    if (!GALLERY.length) return;

    let currentIndex = 0;
    let openFromEl = null;

    function renderAt(i) {
      const m = GALLERY.length;
      const idx = ((i % m) + m) % m;
      const item = GALLERY[idx];
      currentIndex = idx;
      handleEl.textContent = item.handle;
      titleEl.textContent = item.headline;
      leadEl.textContent = item.lead;
      desc.textContent = item.desc;
      hrefEl.href = item.href;
      hrefEl.textContent = item.linkLabel;
      const isFragment = /^#/.test(item.href);
      const isOpaque = /^javascript:/i.test(item.href);
      if (isFragment || isOpaque) {
        hrefEl.removeAttribute("target");
        hrefEl.removeAttribute("rel");
      } else {
        hrefEl.target = "_blank";
        hrefEl.rel = "noopener noreferrer";
      }
      if (item.href2 && item.link2Label) {
        href2El.href = item.href2;
        href2El.textContent = item.link2Label;
        href2El.removeAttribute("hidden");
        href2El.classList.remove("hidden");
        const frag2 = /^#/.test(item.href2);
        if (frag2) {
          href2El.removeAttribute("target");
          href2El.removeAttribute("rel");
        } else {
          href2El.target = "_blank";
          href2El.rel = "noopener noreferrer";
        }
      } else {
        href2El.setAttribute("hidden", "");
        href2El.classList.add("hidden");
      }
    }

    function openAt(i, fromEl) {
      openFromEl = fromEl && typeof fromEl.focus === "function" ? fromEl : null;
      renderAt(i);
      lightbox.removeAttribute("hidden");
      document.body.style.overflow = "hidden";
      prevBtn.focus();
    }

    function close() {
      lightbox.setAttribute("hidden", "");
      document.body.style.overflow = "";
      if (openFromEl) {
        try {
          openFromEl.focus();
        } catch (e) {
          /* ignore */
        }
        openFromEl = null;
      }
    }

    function step(d) {
      renderAt(currentIndex + d);
    }

    function onDocKey(e) {
      if (lightbox.hasAttribute("hidden")) return;
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        step(-1);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        step(1);
      } else if (e.key === "Escape") {
        e.preventDefault();
        close();
      }
    }

    strip.querySelectorAll(".context-post-card[data-idx]").forEach((card) => {
      card.addEventListener("click", (e) => {
        if (e.target.closest("a[href]")) return;
        const raw = parseInt(card.getAttribute("data-idx") || "0", 10);
        const i = Number.isNaN(raw) ? 0 : raw;
        openAt(i, card);
      });
      card.addEventListener("keydown", (e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        if (e.target.closest("a[href]")) return;
        e.preventDefault();
        const raw = parseInt(card.getAttribute("data-idx") || "0", 10);
        const i = Number.isNaN(raw) ? 0 : raw;
        openAt(i, card);
      });
    });

    backdrop.addEventListener("click", () => {
      close();
    });

    shell.addEventListener("click", (e) => {
      if (
        e.target.closest(".context-lightbox__nav") ||
        e.target.closest("a") ||
        e.target.closest(".context-lightbox-preview-card") ||
        e.target.closest(".context-lightbox__desc")
      ) {
        return;
      }
      close();
    });

    prevBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      step(-1);
    });
    nextBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      step(1);
    });

    document.addEventListener("keydown", onDocKey, true);
  })();

  loadSummary()
    .then(() => {
      updateSubmissionsCount(window.__summaryRows || []);
      if (document.body.classList.contains("organizer-page")) {
        renderManagerPanel();
      }
    })
    .catch((err) => {
      if (!canRenderSensitiveSummaryTable()) return;
      const tbody = document.querySelector("#summary-table tbody");
      if (tbody) {
        tbody.innerHTML = `
      <tr>
        <td colspan="13">
          <div class="empty-state">
            <div class="empty-state-icon">⚠️</div>
            <div>Failed to load data: ${err.message}</div>
          </div>
        </td>
      </tr>
    `;
      }
    });
});
