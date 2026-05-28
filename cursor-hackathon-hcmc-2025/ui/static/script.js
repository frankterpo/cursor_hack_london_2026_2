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

// ============================================================
// Admin overrides + fork detection (organizer cockpit only)
// ============================================================
//
// `hasAnyFlagWithAdmin` mixes raised integrity flags + any organizer-applied
// manual flag (set via the Flag button in the submissions table) + fork
// detection. Storage is browser-local: `__hackAdminFlags` (Set of repo URLs
// flagged manually) and `__forkStatusCache` (24h cache of GitHub fork lookups).
//
// Fork detection hits the public GitHub REST API without auth (60 req/h/IP).
// Failures degrade gracefully to "unknown" without blocking row render.

const ADMIN_FLAGS_KEY = "hack-admin-flags-v1";
const ADMIN_HIDDEN_KEY = "hack-admin-hidden-v1";
const FORK_CACHE_KEY = "hack-fork-status-v1";
const FORK_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const FORK_INFLIGHT = new Map();
let _forkRateLimited = false;

function loadJSONSet(key) {
  try {
    const raw = JSON.parse(localStorage.getItem(key) || "[]");
    return new Set(Array.isArray(raw) ? raw.map(String) : []);
  } catch {
    return new Set();
  }
}

function saveJSONSet(key, set) {
  try {
    localStorage.setItem(key, JSON.stringify([...set]));
  } catch {}
}

function adminFlaggedSet() {
  if (!window.__adminFlagSet) window.__adminFlagSet = loadJSONSet(ADMIN_FLAGS_KEY);
  return window.__adminFlagSet;
}

function adminHiddenSet() {
  if (!window.__adminHiddenSet) window.__adminHiddenSet = loadJSONSet(ADMIN_HIDDEN_KEY);
  return window.__adminHiddenSet;
}

function isRowAdminFlagged(row) {
  const url = normalizeRepoKey(row?.repo || getSubmissionInfoForRow(row)?.repo_url || "");
  return url ? adminFlaggedSet().has(url) : false;
}

function toggleAdminFlag(rowOrUrl) {
  const url = normalizeRepoKey(
    typeof rowOrUrl === "string"
      ? rowOrUrl
      : rowOrUrl?.repo || getSubmissionInfoForRow(rowOrUrl)?.repo_url || ""
  );
  if (!url) return false;
  const set = adminFlaggedSet();
  const willFlag = !set.has(url);
  if (willFlag) set.add(url);
  else set.delete(url);
  saveJSONSet(ADMIN_FLAGS_KEY, set);
  return willFlag;
}

function isRowAdminHidden(row) {
  const url = normalizeRepoKey(row?.repo || getSubmissionInfoForRow(row)?.repo_url || "");
  if (!url) return false;
  return adminHiddenSet().has(url);
}

function markRowAdminHidden(rowOrUrl) {
  const url = normalizeRepoKey(
    typeof rowOrUrl === "string"
      ? rowOrUrl
      : rowOrUrl?.repo || getSubmissionInfoForRow(rowOrUrl)?.repo_url || ""
  );
  if (!url) return;
  const set = adminHiddenSet();
  set.add(url);
  saveJSONSet(ADMIN_HIDDEN_KEY, set);
}

function hasAnyFlagWithAdmin(row) {
  if (hasAnyFlag(row)) return true;
  if (isRowAdminFlagged(row)) return true;
  const url = row?.repo || getSubmissionInfoForRow(row)?.repo_url || "";
  return getCachedForkStatus(url) === "fork";
}

function parseGithubOwnerRepo(url) {
  if (!url) return null;
  const m = String(url).match(/github\.com\/([^\/\s]+)\/([^\/\s?#]+?)(?:\.git)?(?:[\/?#]|$)/i);
  if (!m) return null;
  return { owner: m[1], repo: m[2] };
}

function loadForkCache() {
  if (window.__forkCache) return window.__forkCache;
  try {
    const raw = JSON.parse(localStorage.getItem(FORK_CACHE_KEY) || "{}");
    const now = Date.now();
    const out = {};
    for (const [k, v] of Object.entries(raw)) {
      if (v && typeof v === "object" && Number(v.at) && now - Number(v.at) < FORK_CACHE_TTL_MS) {
        out[k] = v;
      }
    }
    window.__forkCache = out;
  } catch {
    window.__forkCache = {};
  }
  return window.__forkCache;
}

function persistForkCache() {
  try {
    localStorage.setItem(FORK_CACHE_KEY, JSON.stringify(window.__forkCache || {}));
  } catch {}
}

function getCachedForkStatus(repoUrl) {
  const k = normalizeRepoKey(repoUrl);
  if (!k) return null;
  const entry = loadForkCache()[k];
  return entry ? entry.status : null;
}

/**
 * Look up fork status for a repo URL. Returns a Promise that resolves to one of:
 *   "new"     — the repo is not a fork
 *   "fork"    — GitHub says fork=true (and may have a parent)
 *   "unknown" — private, deleted, rate-limited, or not a GitHub repo URL
 *
 * Results are cached for 24h in localStorage. In-flight lookups are
 * deduplicated. If we hit the unauthenticated rate limit we stop trying for
 * the rest of the session.
 */
async function fetchForkStatus(repoUrl) {
  const k = normalizeRepoKey(repoUrl);
  if (!k) return "unknown";
  const cache = loadForkCache();
  if (cache[k]) return cache[k].status;
  if (FORK_INFLIGHT.has(k)) return FORK_INFLIGHT.get(k);
  if (_forkRateLimited) return "unknown";
  const parsed = parseGithubOwnerRepo(repoUrl);
  if (!parsed) {
    cache[k] = { status: "unknown", at: Date.now() };
    persistForkCache();
    return "unknown";
  }
  const promise = (async () => {
    try {
      const res = await fetch(
        `https://api.github.com/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}`,
        { headers: { Accept: "application/vnd.github+json" } }
      );
      if (res.status === 403 || res.status === 429) {
        _forkRateLimited = true;
        return "unknown";
      }
      if (!res.ok) return "unknown";
      const data = await res.json();
      const status = data && data.fork === true ? "fork" : "new";
      cache[k] = {
        status,
        at: Date.now(),
        parent: data?.parent?.full_name || null,
        created_at: data?.created_at || null,
      };
      persistForkCache();
      return status;
    } catch (err) {
      return "unknown";
    } finally {
      FORK_INFLIGHT.delete(k);
    }
  })();
  FORK_INFLIGHT.set(k, promise);
  return promise;
}

function forkChipHtml(status) {
  if (status === "fork") {
    return '<span class="repo-flag-chip repo-flag-chip--fork" title="GitHub reports this repo is a fork">FORK</span>';
  }
  if (status === "new") {
    return '<span class="repo-flag-chip repo-flag-chip--new" title="Not a fork — created from scratch">NEW</span>';
  }
  if (status === "loading") {
    return '<span class="repo-flag-chip repo-flag-chip--loading" title="Checking GitHub…">…</span>';
  }
  return '<span class="repo-flag-chip repo-flag-chip--unknown" title="GitHub lookup unavailable (private / rate-limited / non-GitHub URL)">UNKNOWN</span>';
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

const JUDGE_LEGACY_TOTAL_CAP = 11;
const JUDGE_LEGACY_SCALE_MAX = 11.5;

function judgeScoreTotalCap() {
  return Number(eventFormat?.rubric?.total_cap ?? 100);
}

/** True when this event/repo still uses the old 0–11 judge scale (HCMC-era imports). */
function usesLegacyJudgeScoreScale(info) {
  if (info && info.legacy_mode) return true;
  return judgeScoreTotalCap() <= 15;
}

/**
 * Map stored scores for display/editing.
 * London Q3 uses 0–100 in the DB — do not upscale low values (10 → 90.9 was a bug).
 */
function normalizeStoredJudgeScore(value, info) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  if (!usesLegacyJudgeScoreScale(info)) {
    return Math.round(n * 10) / 10;
  }
  if (n <= JUDGE_LEGACY_SCALE_MAX) {
    return Math.round((n * 100) / JUDGE_LEGACY_TOTAL_CAP * 10) / 10;
  }
  return Math.round(n * 10) / 10;
}

function judgeBonusCap() {
  return Number(eventFormat?.judge_bonus_bucket?.max_points ?? 4);
}
let hacksIndex = { hacks: [], active_hack_id: null };

function getActiveHackId() {
  return (
    hacksIndex.active_hack_id ||
    (eventFormat && eventFormat.hack_id) ||
    "cursor-thrads-london-2026"
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

/** Curl / QA judge names — exclude from panel coverage counts. */
function isTestJudgeName(name) {
  const n = normalizeJudgeName(name);
  if (!n) return false;
  if (n === "test" || n === "restarttest") return true;
  if (n.startsWith("test") && /^test\d*$/.test(n)) return true;
  return false;
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
  const out = [];
  for (const j of list) {
    if (!j || !j.name) continue;
    out.push(j);
    const co = j.cohost;
    if (co && co.name) {
      out.push({ ...co, role: j.role || co.role || "" });
    }
  }
  return out;
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
  if (!cb) return false; // Default OFF — show full queue unless filtered
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
    if (!raw || isTestJudgeName(raw)) return;
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
    const res = await fetch("/api/judges", { credentials: "include" });
    if (!res.ok) throw new Error(`Failed to fetch /api/judges: ${res.status}`);
    const data = await res.json();
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
    if (data?.panel_audit) {
      window.__judgePanelAudit = data.panel_audit;
    }
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
    row.demo_url != null ||
    row.video_url != null ||
    row.demo_link != null ||
    row["Demo URL"] != null
  ) {
    return row;
  }
  return null;
}

/**
 * Partner tech labels (API ``technologies`` or checkbox UUIDs + catalog).
 * @returns {string[]}
 */
function submissionPartnerLabels(submission) {
  if (!submission) return [];
  const fromApi = submission.technologies;
  if (Array.isArray(fromApi) && fromApi.length) {
    return fromApi
      .map((t) => (t && (t.name || t.slug)) || "")
      .map((s) => String(s).trim())
      .filter(Boolean);
  }
  const ids = submission.technology_ids;
  if (Array.isArray(ids) && ids.length && technologiesCatalog.length) {
    return ids
      .map((id) => {
        const t = technologiesCatalog.find((x) => String(x.id) === String(id));
        return t ? String(t.name || t.slug || "").trim() : "";
      })
      .filter(Boolean);
  }
  return [];
}

/** Partner tech display string for tables and summaries. */
function submissionTechnologiesDisplay(submission) {
  const labels = submissionPartnerLabels(submission);
  return labels.length ? labels.join(", ") : "—";
}

function summaryPartnersCellHtml(submission) {
  const labels = submissionPartnerLabels(submission);
  if (!labels.length) {
    return '<span class="summary-tech-muted" aria-hidden="true">—</span>';
  }
  const plain = labels.join(", ");
  return `<span class="summary-tech-lines" title="${escapeAttr(
    plain
  )}">${escapeHtml(plain)}</span>`;
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
  const raw = submissionDemoUrl(submission, null);
  if (!raw) return "";
  const href = normalizeDemoUrlForParse(raw) || raw;
  return `<a class="repo-link" href="${escapeAttr(
    href
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

function judgeInfoAverageNumeric(info) {
  if (!info?.responses?.length) return 0;
  if (info.legacy_mode) {
    return Number(
      (info.averages && info.averages.grand_total) ?? info.average_score ?? 0
    );
  }
  const vals = info.responses
    .map((r) => normalizeStoredJudgeScore(r.total_score, info))
    .filter((v) => v !== null);
  if (!vals.length) return 0;
  return vals.reduce((sum, v) => sum + v, 0) / vals.length;
}

function judgeInfoDisplayAverage(info) {
  return formatJudgeScore(judgeInfoAverageNumeric(info));
}

function buildJudgeTooltip(info) {
  if (!info || !info.responses || info.responses.length === 0)
    return "No judge responses";
  const cap = judgeScoreTotalCap();
  const parts = info.responses.map((r, idx) => {
    const thought = r.notes
      ? ` — ${r.notes}`
      : r.thoughts
      ? ` — ${r.thoughts}`
      : "";
    if (info.legacy_mode) {
      return `#${idx + 1}: ${r.total_score}${thought}`;
    }
    const score = normalizeStoredJudgeScore(r.total_score, info);
    const scoreLabel = score === null ? "—" : formatJudgeScore(score);
    return `#${idx + 1}: ${scoreLabel}/${cap}${thought}`;
  });
  return parts.join("\n");
}

function renderJudgeCell(info) {
  if (!info || !info.responses || info.responses.length === 0) {
    return '<span class="judge-chip no-data">—</span>';
  }
  const avg = judgeInfoDisplayAverage(info);
  const count = info.responses.length;
  const countLabel = count === 1 ? "1 judge" : `${count} judges`;
  const totalCap = judgeScoreTotalCap();
  const denom = info.legacy_mode
    ? ""
    : `<span class="judge-score-denom">/${totalCap}</span>`;
  const tooltip = escapeAttr(buildJudgeTooltip(info));
  return `<span class="judge-chip" title="${tooltip}"><span class="judge-score-group"><span class="judge-score-val">${avg}</span>${denom}</span><span class="judge-meta-count">${countLabel}</span></span>`;
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
        : (() => {
            const score = normalizeStoredJudgeScore(r.total_score, info);
            const label = score === null ? "—" : formatJudgeScore(score);
            return `#${idx + 1} • ${label}/${judgeScoreTotalCap()}`;
          })();
      return `<div class="judge-row"><div class="judge-score-pill">${scoreLine}</div>${thought}</div>`;
    })
    .join("");
}

function judgeAggregateBlockHtml(info) {
  if (!info || !info.responses || info.responses.length === 0) {
    return "";
  }
  const grandAvg = judgeInfoDisplayAverage(info);
  return `
    <div class="judge-summary">
      <div class="judge-score-pill highlight" title="Average of imported judge scores (${info.responses.length} response${info.responses.length !== 1 ? "s" : ""})."><span class="judge-score-avg-label">Avg</span> ${grandAvg}${
    info.legacy_mode ? "" : `/${judgeScoreTotalCap()}`
  }</div>
      <div class="judge-meta">${info.responses.length} response${
    info.responses.length !== 1 ? "s" : ""
  }</div>
    </div>`;
}

function renderJudgeDetails(info, containerEl) {
  const container =
    containerEl || document.getElementById("judge-output");
  if (!container) return;
  if (!info || !info.responses || info.responses.length === 0) {
    container.innerHTML =
      '<div class="empty-state"><div class="empty-state-icon">🧑‍⚖️</div><div>No judge responses</div></div>';
    return;
  }
  const list = judgeImportResponsesListHtml(info);
  const rollup = judgeAggregateBlockHtml(info);
  container.innerHTML = `${rollup}<div class="judge-list">${list}</div>`;
}

async function renderSummaryTable(rows) {
  const tbody = document.querySelector("#summary-table tbody");
  if (!tbody) return;
  tbody.innerHTML = "";
  const filterPre = document.querySelector("#filter-preT0")?.checked ?? false;
  const filterBulk = document.querySelector("#filter-bulk")?.checked ?? false;
  const filterMerge = document.querySelector("#filter-merge")?.checked ?? false;
  const filterFork = document.querySelector("#filter-fork")?.checked ?? false;
  const sortMode =
    document.querySelector("#sort-select")?.value || "default";

  const trackFilter = window.__trackFilter || null;
  const hidden = adminHiddenSet();
  const filteredRows = rows.filter((r) => {
    const url = normalizeRepoKey(r.repo || getSubmissionInfoForRow(r)?.repo_url || "");
    if (url && hidden.has(url)) return false;
    if (filterPre && Number(r.has_commits_before_t0) === 0) return false;
    if (filterBulk && Number(r.has_bulk_commits) === 0) return false;
    if (filterMerge && Number(r.has_merge_commits) === 0) return false;
    if (filterFork) {
      const repoUrl = r.repo || getSubmissionInfoForRow(r)?.repo_url || "";
      if (getCachedForkStatus(repoUrl) !== "fork") return false;
    }
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
        <td colspan="14">
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

    const memberCount = countSubmissionMembers(submission);
    const teamLabel = submission?.team?.name || teamName;
    tr.innerHTML = `
      <td>
        <div class="repo-cell">
          <span class="repo-name">${escapeHtml(displayName)}</span>
          ${
            teamLabel
              ? `<span class="repo-meta">Team ${escapeHtml(teamLabel)}${
                  memberCount
                    ? ` <span class="repo-meta-chip">${memberCount} member${
                        memberCount === 1 ? "" : "s"
                      }</span>`
                    : ""
                }</span>`
              : memberCount
              ? `<span class="repo-meta"><span class="repo-meta-chip">${memberCount} member${
                  memberCount === 1 ? "" : "s"
                }</span></span>`
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
      <td class="summary-tech-cell">${summaryPartnersCellHtml(submission)}</td>
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
  await loadTechnologies();
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

function pickMergedDemoUrl(submission, existingRow) {
  const fromApi = [
    submission.demo_url,
    submission.video_url,
    submission.demo_link,
  ]
    .map((x) => String(x || "").trim())
    .find(Boolean);
  if (fromApi) return fromApi;
  const fromRow = [
    existingRow?.demo_url,
    existingRow?.video_url,
    existingRow?.demo_link,
    existingRow?.["Demo URL"],
  ]
    .map((x) => String(x || "").trim())
    .find(Boolean);
  return fromRow || "";
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
      const prev = byRepo.get(repoKey);
      byRepo.set(repoKey, {
        ...prev,
        ...submission,
        demo_url: pickMergedDemoUrl(submission, prev),
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
      demo_url: pickMergedDemoUrl(submission, {}),
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
    commitsTbody: document.querySelector("#judge-side-commits-table tbody"),
    commitCountEl: document.getElementById("judge-side-commit-count"),
  };
}

function mergeDetailEls(overrides) {
  if (!overrides) return detailElsForDrawer();

  const submissionOut = overrides.submissionOutput;
  const targetsJudgeSidePanel =
    submissionOut && submissionOut.id === "judge-side-submission-output";

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

function countUniqueJudges(merged) {
  const s = new Set();
  for (const e of merged) {
    const j = (e.judge && String(e.judge).trim()) || "";
    if (j) s.add(j.toLowerCase());
  }
  return s.size;
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
      const isJudgeRailAi = aiOutput.id === "judge-side-ai-output";
      if (aiText) {
        aiOutput.innerHTML = formatAIOutput(aiText);
      } else if (isJudgeRailAi) {
        aiOutput.innerHTML = `<div class="judge-ai-empty" role="status"><p class="judge-ai-empty-lead">No AI repo narrative loaded.</p><p class="judge-ai-empty-hint">When present, this summarizes authenticity and how the team applied their declared technologies. Generate notes with <code class="judge-inline-code">python3 ai/run_ai.py --work-dir work</code> after metrics exist.</p></div>`;
      } else {
        aiOutput.textContent = "No AI analysis available for this submission.";
      }
    }

    const judgeInfo = getJudgeInfoForRow(summaryRow);
    renderJudgeDetails(judgeInfo, judgeOutput);

    const commitTargets = { tbody: commitsTbody, countEl: commitCountEl };
    renderCommits(commitsData.rows || [], commitTargets);
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
      const isJudgeRailAi = aiOutput.id === "judge-side-ai-output";
      if (isJudgeRailAi) {
        if (rowHasAnalysis(summaryRow)) {
          aiOutput.innerHTML = `<p class="judge-ai-error" role="alert">${escapeHtml(
            `Could not load AI notes: ${err.message}`
          )}</p>`;
        } else {
          aiOutput.innerHTML = `<div class="judge-ai-empty" role="status"><p class="judge-ai-empty-lead">Repo analysis not ready.</p><p class="judge-ai-empty-hint">Run <code class="judge-inline-code">python3 scan.py …</code> then <code class="judge-inline-code">python3 ai/run_ai.py …</code> for stack-aware narrative in this tab.</p></div>`;
        }
      } else {
        aiOutput.textContent = rowHasAnalysis(summaryRow)
          ? ""
          : "AI analysis appears after repo analysis has been run.";
      }
    }
    const judgeInfo = getJudgeInfoForRow(summaryRow);
    renderJudgeDetails(judgeInfo, judgeOutput);
    const commitTargets = { tbody: commitsTbody, countEl: commitCountEl };
    renderCommits([], commitTargets);
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
    ["Team", submission.team?.name || submission.team_name || "—", ""],
    ["Track", submission.chosen_track || "—", ""],
    ["Technologies", submissionTechnologiesDisplay(submission), ""],
    ["Submitted", submission.timestamp || "—", ""],
    ["GitHub repo", submission.repo_url || row?.repo || "—", "url"],
    ["Demo", submission.demo_url || "—", "url"],
  ];
  const membersHtml = renderManagerTeamMembersHtml(submission);
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
    ${membersHtml}
  `;
}

/** Admin/organizer drawer: full member roster including emails. */
function renderManagerTeamMembersHtml(submission) {
  const team = submission?.team && typeof submission.team === "object" ? submission.team : null;
  const members = Array.isArray(team?.members) ? team.members : [];
  if (members.length) {
    const items = members
      .map((m) => {
        const name = escapeHtml(m.full_name || "—");
        const email = m.cursor_email
          ? `<span class="judge-team-member__email">${escapeHtml(m.cursor_email)}</span>`
          : "";
        const social = memberSocialLink(m);
        const luma = memberLumaLink(m);
        return `<li class="judge-team-member"><span class="judge-team-member__name">${name}</span>${
          email ? ` ${email}` : ""
        }${social ? ` ${social}` : ""}${luma ? ` ${luma}` : ""}</li>`;
      })
      .join("");
    return `<div class="submission-item submission-item--block"><div class="submission-label">Members (${members.length})</div><ul class="judge-team-list">${items}</ul></div>`;
  }
  const legacy = String(submission?.team_members || "").trim();
  if (legacy) {
    return `<div class="submission-item submission-item--block"><div class="submission-label">Members</div><div class="submission-value">${escapeHtml(
      legacy
    )}</div></div>`;
  }
  return "";
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

let technologiesCatalog = [];

/** Load tech chips before submit modal if APIs were unavailable at first paint. */
async function ensureTechnologiesLoaded() {
  const picker = document.querySelector("[data-tech-picker]");
  if (picker && picker.querySelector('input[type="checkbox"][name="technology_ids"]')) {
    return;
  }
  if (!eventFormat) {
    try {
      await loadEventFormat();
    } catch (_e) {
      /* loadEventFormat catches internally */
    }
  }
  await loadTechnologies();
}

async function loadTechnologies() {
  technologiesCatalog = [];
  try {
    let res = await fetch("/api/technologies");
    if (res.status === 404) {
      res = await fetch("/api/technologies.json").catch(() => null);
    }
    if (!res || !res.ok) {
      if (res && !res.ok) {
        const errBody = await res.text();
        console.error(
          `[technologies] /api/technologies failed: HTTP ${res.status}`,
          errBody
        );
      }
    } else {
      const bodyText = await res.text();
      let payload = null;
      try {
        payload = JSON.parse(bodyText);
      } catch (parseErr) {
        console.error(
          "[technologies] non-JSON response from /api/technologies",
          { body: bodyText, error: parseErr }
        );
      }
      const list = Array.isArray(payload?.technologies)
        ? payload.technologies
        : [];
      technologiesCatalog = list;
      if (list.length === 0) {
        console.warn(
          "[technologies] /api/technologies returned 200 with empty list",
          payload
        );
      }
    }
  } catch (e) {
    console.error("[technologies] network error fetching /api/technologies", e);
  }
  if (!technologiesCatalog.length && Array.isArray(eventFormat?.technology_partners)) {
    technologiesCatalog = eventFormat.technology_partners.filter(
      (t) => t && (t.id || t.slug)
    );
    if (technologiesCatalog.length) {
      console.info(
        "[technologies] using event-format.technology_partners fallback (%s rows)",
        technologiesCatalog.length
      );
    }
  }
  if (!technologiesCatalog.length) {
    const boot = document.getElementById("technology-partners-bootstrap");
    if (boot && boot.textContent) {
      try {
        const data = JSON.parse(boot.textContent.trim());
        const list = Array.isArray(data?.technologies)
          ? data.technologies
          : Array.isArray(data)
            ? data
            : [];
        technologiesCatalog = list.filter((t) => t && (t.id || t.slug));
        if (technologiesCatalog.length) {
          console.info(
            "[technologies] using inline #technology-partners-bootstrap (%s rows)",
            technologiesCatalog.length
          );
        }
      } catch (parseErr) {
        console.error("[technologies] bootstrap JSON parse failed", parseErr);
      }
    }
  }
  renderTechnologyPicker();
}

function renderTechnologyPicker() {
  const picker = document.querySelector("[data-tech-picker]");
  if (!picker) return;
  if (!technologiesCatalog.length) {
    picker.innerHTML =
      '<span class="tech-picker-empty" data-tech-picker-empty>No technologies configured.</span>';
    return;
  }
  picker.innerHTML = technologiesCatalog
    .map(
      (t) => `
        <label class="tech-pick">
          <input
            type="checkbox"
            name="technology_ids"
            value="${escapeAttr(t.id)}"
            data-tech-slug="${escapeAttr(t.slug || "")}"
          />
          <span>${escapeHtml(t.name || t.slug || "")}</span>
        </label>
      `
    )
    .join("");
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

function judgeCardAvatarMarkup(j) {
  const initials = (j.name || "?")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0])
    .join("")
    .toUpperCase();
  const color = j.avatar_color || "#429aaa";
  const photoSrc = j.photo_url || j.photo;
  if (photoSrc) {
    return `<span class="judge-avatar judge-avatar--img"><img src="${escapeAttr(
      photoSrc
    )}" alt="" loading="lazy" decoding="async" onerror="this.parentElement.outerHTML='<span class=&quot;judge-avatar&quot; style=&quot;background:${escapeAttr(
      color
    )}&quot;>${escapeHtml(initials)}</span>'"></span>`;
  }
  return `<span class="judge-avatar" style="background:${escapeAttr(color)}">${escapeHtml(
    initials
  )}</span>`;
}

function judgeRoleLine(person) {
  if (person.title) {
    return `<span class="judge-name">${escapeHtml(
      person.name
    )}</span><span class="judge-role">${escapeHtml(
      person.title
    )} · ${escapeHtml(person.role || "")}</span>`;
  }
  return `<span class="judge-name">${escapeHtml(
    person.name
  )}</span><span class="judge-role">${escapeHtml(person.role || "")}</span>`;
}

function judgeDualRoleLine(person, role) {
  const roleText = role || person.role || "";
  return `<span class="judge-name">${escapeHtml(
    person.name
  )}</span><span class="judge-role">${escapeHtml(roleText)}</span>`;
}

function renderJudgeDualCard(primary, secondary) {
  const sharedRole = primary.role || secondary.role || "";
  const col = (person) => {
    const avatar = judgeCardAvatarMarkup(person);
    const dualBody = `<div class="judge-body">${judgeDualRoleLine(
      person,
      sharedRole
    )}</div>`;
    const inBadge = person.linkedin
      ? '<span class="judge-linkedin" aria-hidden="true">in →</span>'
      : "";
    const linkInner = `${avatar}${dualBody}${inBadge}`;
    if (person.linkedin) {
      return `<a class="judge-dual-col judge-card--link" href="${escapeAttr(
        person.linkedin
      )}" target="_blank" rel="noopener noreferrer" aria-label="${escapeAttr(
        person.name
      )} on LinkedIn">${linkInner}</a>`;
    }
    return `<div class="judge-dual-col judge-card">${linkInner}</div>`;
  };

  return `<li class="judge-grid__cell--dual">
    <div class="judge-card judge-card--dual">
      <div class="judge-dual-cols">
        ${col(primary)}
        <div class="judge-dual-divider" role="presentation" aria-hidden="true"></div>
        ${col(secondary)}
      </div>
    </div>
  </li>`;
}

function renderJudges() {
  const ul = document.getElementById("judge-grid");
  if (!ul) return;
  const judges = eventFormat?.judges || [];
  // Static index ships judge cards in HTML; only replace when we have config
  // (e.g. opening file:// or failed fetch would clear the grid otherwise).
  if (!judges.length) return;

  const cohostNames = new Set(
    judges
      .map((j) => j?.cohost?.name)
      .filter(Boolean)
      .map((n) => normalizeJudgeName(n)),
  );

  ul.innerHTML = judges
    .map((j) => {
      if (!j || !j.name) return "";
      if (cohostNames.has(normalizeJudgeName(j.name))) return "";
      if (j.cohost && j.cohost.name) {
        const secondary = { ...j.cohost, role: j.role || j.cohost.role || "" };
        return renderJudgeDualCard(j, secondary);
      }
      const initials = (j.name || "?")
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2)
        .map((p) => p[0])
        .join("")
        .toUpperCase();
      const color = j.avatar_color || "#429aaa";
      const photoSrc = j.photo_url || j.photo;
      const avatar = photoSrc
        ? `<img class="judge-avatar judge-avatar--img" src="${escapeAttr(
            photoSrc
          )}" alt="" loading="lazy" onerror="this.outerHTML='<span class=&quot;judge-avatar&quot; style=&quot;background:${escapeAttr(
            color
          )}&quot;>${escapeHtml(initials)}</span>'">`
        : `<span class="judge-avatar" style="background:${escapeAttr(
            color
          )}">${escapeHtml(initials)}</span>`;
      const roleLine = judgeRoleLine(j);
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
        )}" target="_blank" rel="noopener noreferrer" aria-label="${escapeAttr(
          j.name
        )} on LinkedIn">${inner}</a></li>`;
      }
      return `<li class="judge-card">${inner}</li>`;
    })
    .join("");
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
/** Set in sessionStorage after successful POST /api/auth (matches SITE_PASSWORD on server). */
const AUTH_SESSION_VALUE = "1";
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
    return sessionStorage.getItem(AUTH_KEY) === AUTH_SESSION_VALUE;
  } catch {
    return false;
  }
}

async function syncAuthFromServer() {
  try {
    const res = await fetch("/api/auth", { credentials: "include" });
    const data = await res.json().catch(() => ({}));
    if (data.authenticated) {
      sessionStorage.setItem(AUTH_KEY, AUTH_SESSION_VALUE);
      if (data.judge_name) writeStoredJudgeName(data.judge_name);
      await loadJudgeData();
      return true;
    }
    sessionStorage.removeItem(AUTH_KEY);
  } catch (_) {
    /* offline or static-only preview */
  }
  return false;
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
  // Live leaderboard polling is only active while the Leaderboards tab is
  // visible. Switching away stops the timer, so we don't churn /api/judges.
  if (name === "leaderboards") {
    startLeaderboardLiveUpdates();
  } else {
    stopLeaderboardLiveUpdates();
  }
}

let _leaderboardLiveTimer = null;
const LEADERBOARD_POLL_MS = 8000;

async function pollLeaderboardOnce() {
  const indicator = document.getElementById("leaderboard-live-indicator");
  if (indicator) indicator.setAttribute("aria-busy", "true");
  try {
    await loadJudgeData();
    renderOverallLeaderboard();
    renderLeaderboard("money-movement", "leaderboard-money-movement");
    renderLeaderboard(
      "financial-intelligence",
      "leaderboard-financial-intelligence"
    );
  } catch (err) {
    console.warn("leaderboard poll failed", err);
  } finally {
    if (indicator) indicator.removeAttribute("aria-busy");
  }
}

function startLeaderboardLiveUpdates() {
  if (_leaderboardLiveTimer) return;
  // Kick once immediately so the user sees fresh numbers on tab switch.
  pollLeaderboardOnce();
  _leaderboardLiveTimer = setInterval(pollLeaderboardOnce, LEADERBOARD_POLL_MS);
}

function stopLeaderboardLiveUpdates() {
  if (_leaderboardLiveTimer) {
    clearInterval(_leaderboardLiveTimer);
    _leaderboardLiveTimer = null;
  }
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
  if (id === "submit-modal") {
    void ensureTechnologiesLoaded();
  }
  if (id === "manager-modal") {
    ensureManagerSubmissionsPanel();
    setManagerTab("submissions");
    renderManagerPanel();
    maybeRenderSummaryTable();
    // Background-refresh in case the page sat idle since DOMContentLoaded.
    // Don't await — the panel already has whatever is cached on screen.
    loadSummary()
      .then(() => {
        maybeRenderSummaryTable();
        renderManagerPanel();
      })
      .catch((err) => console.warn("manager refresh", err));
  }
  if (id === "judge-modal") {
    setActiveJudgeRailTab(getStoredJudgeRailTab(), { persist: false });
    setActiveJudgeStageTab("overview");
    setJudgeSaveStatus("", "");
    refreshJudgeSubmissionSelect();
    refreshJudgeSubmissions({ silent: false });
    syncJudgeFullViewFromSelection();
    attachJudgeReelsHandlers();
    onJudgeModalOpened();
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

/**
 * Workbench is always two columns now, so the legacy "side panel open" concept
 * is folded into a no-op. Kept (as predicates that always say yes) so existing
 * call sites — e.g. handleJudgeForm — keep loading detail data after save.
 */
function isJudgeSidePanelOpen() {
  return !!document.getElementById("judge-rail");
}
function closeJudgeSidePanel() {
  // Workbench has no collapsible side panel — there is nothing to close.
}
function openJudgeSidePanel() {
  const repoId = getJudgeApiRepoId();
  if (repoId) loadDetails(repoId, detailElsForJudgeSidePanel());
}

const JUDGE_RAIL_TABS = ["score", "submission"];
const JUDGE_RAIL_TAB_KEY = "judge-rail-tab";

function getStoredJudgeRailTab() {
  try {
    const v = sessionStorage.getItem(JUDGE_RAIL_TAB_KEY);
    return JUDGE_RAIL_TABS.includes(v) ? v : "score";
  } catch {
    return "score";
  }
}

function setActiveJudgeRailTab(which, { persist = true } = {}) {
  const target = JUDGE_RAIL_TABS.includes(which) ? which : "score";
  document.querySelectorAll("[data-judge-rail-tab]").forEach((btn) => {
    const isActive = btn.getAttribute("data-judge-rail-tab") === target;
    btn.classList.toggle("is-active", isActive);
    btn.setAttribute("aria-selected", isActive ? "true" : "false");
    btn.tabIndex = isActive ? 0 : -1;
  });
  JUDGE_RAIL_TABS.forEach((key) => {
    const pane = document.getElementById(`judge-rail-panel-${key}`);
    if (!pane) return;
    const isActive = key === target;
    pane.classList.toggle("is-active", isActive);
    if (isActive) pane.removeAttribute("hidden");
    else pane.setAttribute("hidden", "");
  });
  if (persist) {
    try {
      sessionStorage.setItem(JUDGE_RAIL_TAB_KEY, target);
    } catch {}
  }
}

const JUDGE_STAGE_TABS = ["overview", "code", "ai"];
function judgeStageTabRoot() {
  return document.getElementById("judge-rail-panel-submission") || document;
}
function setActiveJudgeStageTab(which) {
  const target = JUDGE_STAGE_TABS.includes(which) ? which : "overview";
  judgeStageTabRoot().querySelectorAll("[data-judge-stage-tab]").forEach((btn) => {
    const isActive = btn.getAttribute("data-judge-stage-tab") === target;
    btn.classList.toggle("is-active", isActive);
    btn.setAttribute("aria-selected", isActive ? "true" : "false");
    btn.tabIndex = isActive ? 0 : -1;
  });
  JUDGE_STAGE_TABS.forEach((key) => {
    const pane = document.getElementById(`judge-stage-${key}`);
    if (!pane) return;
    const isActive = key === target;
    pane.classList.toggle("is-active", isActive);
    if (isActive) pane.removeAttribute("hidden");
    else pane.setAttribute("hidden", "");
  });
}
/**
 * Legacy alias kept so anything still calling the old function (e.g. a fallback
 * code path or future regression) maps to the new stage tabs without surprise.
 */
function setActiveJudgeSideTab(which) {
  const map = { submission: "overview", scores: "ai" };
  setActiveJudgeStageTab(map[which] || "overview");
}

/** Selected submission ⇒ load detail + render code signal + overview extras. */
function syncJudgeFullViewFromSelection() {
  const sel = document.getElementById("judge-submission-select");
  if (!sel) return;
  const id = (sel.value || "").trim();
  const hidden = document.getElementById("judge-submission-hidden");
  if (hidden) hidden.value = id;
  renderJudgeVideoStage();
  renderJudgeScoreQueue();
  renderJudgeOverviewMeta(id);
  renderJudgeOverviewExtras(id);
  renderJudgeCodeSignal(id);
  if (!id) {
    const subOut = document.getElementById("judge-side-submission-output");
    if (subOut) {
      subOut.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-icon">⌨</div>
          <div>No submission selected.</div>
          <div class="empty-state-hint">
            Use the queue on the right or press <kbd>→</kbd> to jump in.
          </div>
        </div>`;
    }
    const aiOut = document.getElementById("judge-side-ai-output");
    if (aiOut) aiOut.innerHTML = "";
    const repoPill = document.getElementById("judge-side-detail-title");
    if (repoPill) {
      repoPill.textContent = "";
      repoPill.setAttribute("hidden", "");
    }
    return;
  }
  const repoId = getJudgeApiRepoId();
  if (repoId) {
    loadDetails(repoId, detailElsForJudgeSidePanel());
    loadStagePayload(repoId).then(() => {
      renderJudgeCodeSignal(id);
    });
  }
}

function onJudgeSubmissionSelectChanged() {
  const selectedId = document.getElementById("judge-submission-select")?.value || "";
  const { allEntries, entries } = getJudgeQueueEntries();
  const idx = entries.findIndex((e) => e.id === selectedId);
  if (idx >= 0) judgeCurrentIndex = idx;
  syncJudgeIdentityQueueChip();
  if (_judgeSavedTick) clearInterval(_judgeSavedTick);
  if (_judgeSavedTimer) clearTimeout(_judgeSavedTimer);
  setJudgeSaveStatus("", "");
  renderJudgeSubmissionSummary();
  syncJudgeFullViewFromSelection();
  syncJudgeScoreFormFromExisting();
  if (isEagleViewOpen()) renderEagleView();
}

function closeModal(id) {
  const modal = document.getElementById(id);
  if (!modal) return;
  if (id === "judge-modal") {
    closeJudgeSidePanel();
    onJudgeModalClosed();
  }
  if (id === "manager-modal") stopLeaderboardLiveUpdates();
  if (id === "submit-modal") closeTeamRosterDrawer();
  modal.classList.add("hidden");
  if (
    lastFocusedBeforeModal &&
    typeof lastFocusedBeforeModal.focus === "function"
  ) {
    lastFocusedBeforeModal.focus();
  }
}

// ---------- Submit form ----------
// In-memory roster for the active submit modal session.
const submitTeamMembers = [];
let submitTeamMemberEditIndex = -1;

function teamRosterEls() {
  return {
    root: document.querySelector("[data-team-roster]"),
    chips: document.querySelector("[data-team-roster-chips]"),
    empty: document.querySelector("[data-team-roster-empty]"),
    addBtn: document.querySelector("[data-team-roster-add]"),
    drawer: document.querySelector("[data-team-roster-drawer]"),
    error: document.querySelector("[data-team-roster-drawer-error]"),
    save: document.querySelector("[data-team-roster-save]"),
    cancel: document.querySelector("[data-team-roster-cancel]"),
    inputs: {
      full_name: document.querySelector("[data-tm-field='full_name']"),
      cursor_email: document.querySelector("[data-tm-field='cursor_email']"),
      luma_profile: document.querySelector("[data-tm-field='luma_profile']"),
      social_url: document.querySelector("[data-tm-field='social_url']"),
    },
  };
}

function resetSubmitTeamRoster() {
  submitTeamMembers.length = 0;
  submitTeamMemberEditIndex = -1;
  renderTeamRosterChips();
  closeTeamRosterDrawer();
}

function isValidUrlLenient(value) {
  const s = String(value || "").trim();
  if (!s) return true;
  try {
    const u = new URL(s.startsWith("http") ? s : `https://${s}`);
    return /^https?:$/.test(u.protocol);
  } catch {
    return false;
  }
}

function isValidEmail(value) {
  const s = String(value || "").trim();
  if (!s) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

function renderTeamRosterChips() {
  const { chips } = teamRosterEls();
  if (!chips) return;
  chips.innerHTML = submitTeamMembers
    .map((m, idx) => {
      const name = escapeHtml(m.full_name);
      const email = m.cursor_email
        ? `<span class="team-roster__chip-sep" aria-hidden="true">·</span><span class="team-roster__chip-email" title="${escapeAttr(
            m.cursor_email
          )}">${escapeHtml(m.cursor_email)}</span>`
        : "";
      return `
        <li class="team-roster__chip" data-tm-idx="${idx}">
          <span class="team-roster__chip-name" title="${escapeAttr(
            m.full_name
          )}">${name}</span>${email}
          <span class="team-roster__chip-actions">
            <button type="button" class="team-roster__chip-btn team-roster__chip-btn--edit" data-tm-edit="${idx}" aria-label="Edit ${escapeAttr(
        m.full_name
      )}">✎</button>
            <button type="button" class="team-roster__chip-btn team-roster__chip-btn--remove" data-tm-remove="${idx}" aria-label="Remove ${escapeAttr(
        m.full_name
      )}">×</button>
          </span>
        </li>`;
    })
    .join("");
}

function clearTeamRosterDrawerInputs() {
  const { inputs, error } = teamRosterEls();
  if (!inputs) return;
  Object.values(inputs).forEach((el) => {
    if (el) el.value = "";
  });
  if (error) error.textContent = "";
}

function fillTeamRosterDrawerFrom(member) {
  const { inputs } = teamRosterEls();
  if (!inputs || !member) return;
  inputs.full_name.value = member.full_name || "";
  inputs.cursor_email.value = member.cursor_email || "";
  inputs.luma_profile.value = member.luma_profile || "";
  inputs.social_url.value = member.social_url || "";
}

function openTeamRosterDrawer(editIndex = -1) {
  const { drawer, addBtn, save, inputs, error } = teamRosterEls();
  if (!drawer || !addBtn) return;
  submitTeamMemberEditIndex = editIndex;
  if (editIndex >= 0 && submitTeamMembers[editIndex]) {
    fillTeamRosterDrawerFrom(submitTeamMembers[editIndex]);
    if (save) save.textContent = "Save";
  } else {
    clearTeamRosterDrawerInputs();
    if (save) save.textContent = "+ Add";
  }
  if (error) error.textContent = "";
  drawer.hidden = false;
  addBtn.setAttribute("aria-expanded", "true");
  setTimeout(() => inputs.full_name?.focus(), 30);
}

function closeTeamRosterDrawer() {
  const { drawer, addBtn } = teamRosterEls();
  if (!drawer || !addBtn) return;
  drawer.hidden = true;
  addBtn.setAttribute("aria-expanded", "false");
  submitTeamMemberEditIndex = -1;
}

function commitTeamRosterDrawer() {
  const { inputs, error } = teamRosterEls();
  if (!inputs) return;
  const member = {
    full_name: String(inputs.full_name.value || "").trim(),
    cursor_email: String(inputs.cursor_email.value || "").trim(),
    luma_profile: String(inputs.luma_profile.value || "").trim(),
    social_url: String(inputs.social_url.value || "").trim(),
  };
  if (!member.full_name) {
    if (error) error.textContent = "Full name is required.";
    inputs.full_name?.focus();
    return;
  }
  if (!member.cursor_email || !isValidEmail(member.cursor_email)) {
    if (error)
      error.textContent = "Enter a valid email so we can invite Cursor.";
    inputs.cursor_email?.focus();
    return;
  }
  if (!member.luma_profile) {
    if (error) error.textContent = "Luma profile is required.";
    inputs.luma_profile?.focus();
    return;
  }
  if (!isValidUrlLenient(member.luma_profile)) {
    if (error) error.textContent = "Luma profile must be a valid URL.";
    inputs.luma_profile?.focus();
    return;
  }
  if (!member.social_url) {
    if (error) error.textContent = "LinkedIn or X URL is required.";
    inputs.social_url?.focus();
    return;
  }
  if (!isValidUrlLenient(member.social_url)) {
    if (error) error.textContent = "LinkedIn / X must be a valid URL.";
    inputs.social_url?.focus();
    return;
  }
  if (submitTeamMemberEditIndex >= 0) {
    submitTeamMembers[submitTeamMemberEditIndex] = member;
  } else {
    submitTeamMembers.push(member);
  }
  renderTeamRosterChips();
  closeTeamRosterDrawer();
}

function setupTeamRosterHandlers() {
  const { root, chips, addBtn, save, cancel, inputs } = teamRosterEls();
  if (!root || root.dataset.bound === "1") return;
  root.dataset.bound = "1";
  if (addBtn) {
    addBtn.addEventListener("click", () => openTeamRosterDrawer(-1));
  }
  if (save) save.addEventListener("click", commitTeamRosterDrawer);
  if (cancel) cancel.addEventListener("click", () => closeTeamRosterDrawer());
  if (chips) {
    chips.addEventListener("click", (e) => {
      const editBtn = e.target.closest("[data-tm-edit]");
      const rmBtn = e.target.closest("[data-tm-remove]");
      if (editBtn) {
        const idx = Number(editBtn.getAttribute("data-tm-edit"));
        if (Number.isInteger(idx)) openTeamRosterDrawer(idx);
        return;
      }
      if (rmBtn) {
        const idx = Number(rmBtn.getAttribute("data-tm-remove"));
        if (Number.isInteger(idx) && submitTeamMembers[idx]) {
          submitTeamMembers.splice(idx, 1);
          renderTeamRosterChips();
        }
      }
    });
  }
  Object.values(inputs || {}).forEach((el) => {
    if (!el) return;
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        commitTeamRosterDrawer();
      }
    });
  });
}

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
  const formData = new FormData(form);
  const data = Object.fromEntries(formData.entries());
  const technologyIds = formData
    .getAll("technology_ids")
    .map((v) => String(v || "").trim())
    .filter(Boolean);
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
  if (technologyIds.length === 0) {
    toast("Pick at least one technology partner you used.");
    const firstTech = form.querySelector(
      '[data-tech-picker] input[type="checkbox"]'
    );
    if (firstTech) firstTech.focus();
    return;
  }
  if (submitTeamMembers.length === 0) {
    toast("Add at least one team member before submitting.");
    teamRosterEls().addBtn?.focus();
    return;
  }
  const incompleteMember = submitTeamMembers.find(
    (m) =>
      !String(m.full_name || "").trim() ||
      !String(m.cursor_email || "").trim() ||
      !String(m.luma_profile || "").trim() ||
      !String(m.social_url || "").trim()
  );
  if (incompleteMember) {
    toast(
      "Each team member needs full name, email, Luma profile, and LinkedIn or X URL."
    );
    teamRosterEls().addBtn?.focus();
    return;
  }
  const teamName =
    String(data.team_name || "").trim() ||
    String(data.project_name || "").trim();
  const members = submitTeamMembers.map((m) => ({
    full_name: String(m.full_name || "").trim(),
    cursor_email: String(m.cursor_email || "").trim(),
    luma_profile: String(m.luma_profile || "").trim(),
    social_url: String(m.social_url || "").trim(),
  }));
  // Legacy comma-separated names kept until backend rollouts are verified.
  const legacyMembersStr = members
    .map((m) => m.full_name)
    .filter(Boolean)
    .join(", ");
  const entry = {
    submitted_at: new Date().toISOString(),
    hack_id: getActiveHackId(),
    team_name: data.team_name || "",
    project_name: data.project_name || "",
    repo_url: data.github_url || "",
    chosen_track: data.chosen_track || "",
    demo_url: demoUrl,
    team_members: legacyMembersStr,
    team: { name: teamName, members },
    description: data.description || "",
    notes: data.notes || "",
    technology_ids: technologyIds,
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
  resetSubmitTeamRoster();
  closeModal("submit-modal");
  await loadSubmissionData();
  await loadSummary();
  const proj = String(entry.project_name || "").trim() || "Your project";
  const track = String(entry.chosen_track || "").trim();
  const partnerLabels = submissionPartnerLabels(entry);
  let title = `Submitted: ${proj}`;
  if (partnerLabels.length) {
    title += ` — linked ${partnerLabels.join(", ")}`;
  } else if (technologyIds.length) {
    const n = technologyIds.length;
    title += ` — linked ${n} partner technolog${n === 1 ? "y" : "ies"}`;
  }
  toast("", {
    variant: "success",
    title,
    detail: track,
    meta: "Saved — visible on the live board.",
  });
  requestAnimationFrame(() => {
    setTimeout(() => launchConfetti(), 90);
  });
}

// ---------- Judge form ----------
function buildJudgeFormSkeleton() {
  renderJudgeRubricReminder();
  syncJudgeScoreLabels();
  attachScoreInputListeners();
  initJudgeWorkbenchUx();
}

function renderJudgeRubricReminder() {
  const targets = [document.getElementById("judge-rubric-reminder-side")].filter(Boolean);
  if (!targets.length) return;
  const criteria = eventFormat?.rubric?.criteria || [];
  const quests = eventFormat?.side_quests || [];
  const html = `
    <div class="judge-rubric-list">
      ${criteria
        .map(
          (c) => `<div class="judge-rubric-line"><span>${escapeHtml(
            c.name
          )}</span><strong>${escapeHtml(String(c.points))}</strong></div>`
        )
        .join("")}
    </div>
    ${
      quests.length
        ? `<div class="judge-rubric-list judge-rubric-list--bonus">
            ${quests
              .map(
                (q) => `<div class="judge-rubric-line"><span>${escapeHtml(
                  q.name
                )}</span><strong>${escapeHtml(
                  String(q.points ?? 1)
                )}</strong></div>`
              )
              .join("")}
          </div>`
        : ""
    }
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
  updateJudgeScoreScaleHint();
}

function updateJudgeScoreScaleHint() {
  const hint = document.getElementById("judge-score-scale-hint");
  if (!hint) return;
  const score = clampJudgeScore(document.getElementById("judge-score-input")?.value);
  hint.textContent = score === null ? "" : `Out of ${judgeScoreTotalCap()}`;
}

function syncJudgeScoreLabels() {
  const cap = judgeScoreTotalCap();
  const label = document.getElementById("judge-score-label");
  const input = document.getElementById("judge-score-input");
  const rubricHint = document.getElementById("judge-rubric-cap-hint");
  if (label) label.textContent = `Score · 0–${cap}`;
  if (input) {
    input.max = String(cap);
    input.placeholder = "85";
  }
  if (rubricHint) {
    rubricHint.textContent = `Overall score · 0–${cap}`;
  }
}

// ---------- Judge workbench UX (rail resize, coop toasts, eagle view) ----------
const JUDGE_RAIL_WIDTH_KEY = "judge-rail-width";
const JUDGE_RAIL_MIN_PX = 280;
const JUDGE_RAIL_MAX_PX = 480;
const JUDGE_COOP_POLL_MS = 25000;
const JUDGE_EAGLE_REFRESH_MS = 30000;

let _judgeCoopTimer = null;
let _judgeEagleTimer = null;
let _judgeScoreFingerprint = null;
let _judgeCoopToastTimer = null;

function isJudgeModalOpen() {
  const modal = document.getElementById("judge-modal");
  return modal && !modal.classList.contains("hidden");
}

function getJudgeWorkbenchEl() {
  return document.querySelector(".judge-workbench");
}

function syncJudgeRailResizeA11y(widthPx) {
  const handle = document.getElementById("judge-rail-resize");
  if (!handle) return;
  const clamped = Math.round(
    Math.max(JUDGE_RAIL_MIN_PX, Math.min(JUDGE_RAIL_MAX_PX, widthPx))
  );
  handle.setAttribute("aria-valuemin", String(JUDGE_RAIL_MIN_PX));
  handle.setAttribute("aria-valuemax", String(JUDGE_RAIL_MAX_PX));
  handle.setAttribute("aria-valuenow", String(clamped));
}

function applyJudgeRailWidth(px) {
  const workbench = getJudgeWorkbenchEl();
  if (!workbench) return;
  const clamped = Math.round(
    Math.max(JUDGE_RAIL_MIN_PX, Math.min(JUDGE_RAIL_MAX_PX, px))
  );
  workbench.style.setProperty("--judge-rail-width", `${clamped}px`);
  syncJudgeRailResizeA11y(clamped);
  try {
    localStorage.setItem(JUDGE_RAIL_WIDTH_KEY, String(clamped));
  } catch {
    /* ignore */
  }
}

function restoreJudgeRailWidth() {
  const workbench = getJudgeWorkbenchEl();
  if (!workbench) return;
  let stored = null;
  try {
    stored = Number(localStorage.getItem(JUDGE_RAIL_WIDTH_KEY));
  } catch {
    stored = null;
  }
  if (Number.isFinite(stored) && stored >= JUDGE_RAIL_MIN_PX && stored <= JUDGE_RAIL_MAX_PX) {
    workbench.style.setProperty("--judge-rail-width", `${stored}px`);
    syncJudgeRailResizeA11y(stored);
  }
}

function initJudgeRailResize() {
  const handle = document.getElementById("judge-rail-resize");
  const rail = document.getElementById("judge-rail");
  const workbench = getJudgeWorkbenchEl();
  if (!handle || !rail || !workbench) return;
  if (handle.dataset.bound === "1") return;
  handle.dataset.bound = "1";

  const readWidth = () => {
    const raw = getComputedStyle(workbench).getPropertyValue("--judge-rail-width").trim();
    const n = parseFloat(raw);
    return Number.isFinite(n) ? n : JUDGE_RAIL_MIN_PX;
  };

  syncJudgeRailResizeA11y(readWidth());

  const onPointerDown = (e) => {
    if (window.matchMedia("(max-width: 920px)").matches) return;
    e.preventDefault();
    rail.classList.add("is-resizing");
    workbench.classList.add("is-rail-resizing");
    document.body.classList.add("is-judge-rail-resizing");
    const startX = e.clientX;
    const startW = readWidth();
    handle.setPointerCapture(e.pointerId);

    const onMove = (ev) => {
      const delta = startX - ev.clientX;
      applyJudgeRailWidth(startW + delta);
    };
    const onUp = (ev) => {
      rail.classList.remove("is-resizing");
      workbench.classList.remove("is-rail-resizing");
      document.body.classList.remove("is-judge-rail-resizing");
      try {
        handle.releasePointerCapture(ev.pointerId);
      } catch {
        /* ignore */
      }
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

  handle.addEventListener("pointerdown", onPointerDown);
  handle.addEventListener("keydown", (e) => {
    const step = e.shiftKey ? 32 : 12;
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      applyJudgeRailWidth(readWidth() + step);
      return;
    }
    if (e.key === "ArrowRight") {
      e.preventDefault();
      applyJudgeRailWidth(readWidth() - step);
      return;
    }
    if (e.key === "Home") {
      e.preventDefault();
      applyJudgeRailWidth(JUDGE_RAIL_MAX_PX);
      return;
    }
    if (e.key === "End") {
      e.preventDefault();
      applyJudgeRailWidth(JUDGE_RAIL_MIN_PX);
    }
  });
}

function buildJudgeScoreFingerprint() {
  const fp = new Map();
  judgeMap.forEach((info, repoKey) => {
    if (!info?.responses?.length) return;
    for (const r of info.responses) {
      const judge = String(r.judge_name || r.judge || "").trim();
      if (!judge) continue;
      const project = String(r.project_name || "").trim() || repoKey;
      const subId = String(r.submission_id || "").trim();
      const key = `${normalizeJudgeName(judge)}|${subId || normalizeRepoKey(r.repo_url || repoKey)}|${slugify(project)}`;
      const score = normalizeStoredJudgeScore(r.total_score, info);
      const at = r.scored_at || r.timestamp || "";
      const prev = fp.get(key);
      if (!prev || String(at) >= String(prev.at)) {
        fp.set(key, { judge, project, score, at, subId });
      }
    }
  });
  return fp;
}

function showJudgeCoopToast(message) {
  let el = document.getElementById("judge-coop-toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "judge-coop-toast";
    el.className = "judge-coop-toast";
    el.setAttribute("role", "status");
    el.setAttribute("aria-live", "polite");
    document.body.appendChild(el);
  }
  el.innerHTML = message;
  el.hidden = false;
  if (_judgeCoopToastTimer) clearTimeout(_judgeCoopToastTimer);
  _judgeCoopToastTimer = setTimeout(() => {
    el.hidden = true;
    el.textContent = "";
  }, 3000);
}

function diffJudgeCoopToasts(prevFp, nextFp) {
  if (!prevFp || !nextFp) return;
  const me = normalizeJudgeName(getJudgeNameForUi());
  for (const [key, next] of nextFp.entries()) {
    const prev = prevFp.get(key);
    if (prev && prev.score === next.score && prev.at === next.at) continue;
    const judgeKey = normalizeJudgeName(next.judge);
    if (!judgeKey || (me && judgeKey === me)) continue;
    const proj = escapeHtml(next.project || "submission");
    const judge = escapeHtml(next.judge);
    const score =
      next.score === null || next.score === undefined
        ? "—"
        : formatJudgeScore(Number(next.score));
    showJudgeCoopToast(`<strong>${judge}</strong> scored ${proj}: ${score}`);
    return;
  }
}

async function pollJudgeCoopOnce() {
  if (!isJudgeModalOpen()) return;
  const prev = _judgeScoreFingerprint || buildJudgeScoreFingerprint();
  try {
    await loadJudgeData();
  } catch (err) {
    console.warn("judge coop poll failed", err);
    return;
  }
  const next = buildJudgeScoreFingerprint();
  diffJudgeCoopToasts(prev, next);
  _judgeScoreFingerprint = next;
  if (!document.getElementById("judge-eagle-overlay")?.classList.contains("hidden")) {
    renderEagleView();
  }
}

function startJudgeCoopPolling() {
  if (_judgeCoopTimer) return;
  _judgeScoreFingerprint = buildJudgeScoreFingerprint();
  _judgeCoopTimer = setInterval(() => {
    pollJudgeCoopOnce().catch(() => {});
  }, JUDGE_COOP_POLL_MS);
}

function stopJudgeCoopPolling() {
  if (_judgeCoopTimer) {
    clearInterval(_judgeCoopTimer);
    _judgeCoopTimer = null;
  }
  _judgeScoreFingerprint = null;
  const toast = document.getElementById("judge-coop-toast");
  if (toast) {
    toast.hidden = true;
    toast.textContent = "";
  }
  if (_judgeCoopToastTimer) {
    clearTimeout(_judgeCoopToastTimer);
    _judgeCoopToastTimer = null;
  }
}

/** Eagle matrix columns: configured panel judges only (not walk-in / curl test names). */
function collectEagleJudgeColumns() {
  return getJudgePool()
    .map((j) => j?.name)
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
}

function latestJudgeScoreOnRow(row, judgeName) {
  const info = getJudgeInfoForRow(row);
  const response = latestJudgeResponseOnRow(row, judgeName);
  return response ? normalizeStoredJudgeScore(response.total_score, info) : null;
}

/** Mean of latest judge scores on a row (only judges with a score). */
function averageJudgeScoresOnRow(row, judgeNames) {
  if (!row) return null;
  const scores = [];
  for (const j of judgeNames) {
    const score = latestJudgeScoreOnRow(row, j);
    if (score !== null && score !== undefined && score !== "") {
      scores.push(Number(score));
    }
  }
  if (!scores.length) return null;
  const sum = scores.reduce((a, b) => a + b, 0);
  return Math.round((sum / scores.length) * 10) / 10;
}

function latestJudgeResponseOnRow(row, judgeName) {
  const info = getJudgeInfoForRow(row);
  if (!info?.responses?.length) return null;
  let best = null;
  for (const r of info.responses) {
    const raw = r.judge_name || r.judge || "";
    if (
      !judgeMatchesPool(raw, judgeName) &&
      normalizeJudgeName(raw) !== normalizeJudgeName(judgeName)
    ) {
      continue;
    }
    const at = r.scored_at || r.timestamp || "";
    if (!best || String(at) >= String(best.at)) {
      best = { response: r, at };
    }
  }
  return best ? best.response : null;
}

function syncJudgeScoreFormFromExisting() {
  const submissionId = document.getElementById("judge-submission-select")?.value || "";
  const judgeName = getJudgeNameForUi();
  const scoreInput = document.getElementById("judge-score-input");
  const notes = document.getElementById("judge-form")?.querySelector("textarea[name=thoughts]");
  if (!submissionId || !judgeName.trim()) {
    if (scoreInput) scoreInput.value = "";
    if (notes) notes.value = "";
    updateJudgeRunningTotal();
    return;
  }
  const found = findSubmissionById(submissionId);
  const row = found?.row;
  const judgeInfo = row ? getJudgeInfoForRow(row) : null;
  const mine = row ? latestJudgeResponseOnRow(row, judgeName) : null;
  if (mine) {
    const score = normalizeStoredJudgeScore(mine.total_score, judgeInfo);
    if (scoreInput) {
      scoreInput.value = score === null ? "" : formatJudgeScore(score);
    }
    if (notes) notes.value = mine.thoughts || mine.notes || "";
  } else {
    if (scoreInput) scoreInput.value = "";
    if (notes) notes.value = "";
  }
  updateJudgeRunningTotal();
}

function findJudgeReviewEntryById(submissionId) {
  const raw = String(submissionId || "").trim();
  if (!raw) return null;
  const entries = getJudgeReviewEntries();
  const exact = entries.find((e) => e.id === raw);
  if (exact) return exact;
  const lower = raw.toLowerCase();
  return (
    entries.find((e) => e.id.toLowerCase() === lower) ||
    entries.find((e) => normalizeSubmissionIdentity(e).toLowerCase() === lower) ||
    entries.find((e) => slugify(e.name || "").toLowerCase() === lower) ||
    null
  );
}

function focusJudgeScoreInput() {
  const scoreInput = document.getElementById("judge-score-input");
  if (!scoreInput) return;
  scoreInput.removeAttribute("readonly");
  scoreInput.disabled = false;
  if (!document.activeElement?.matches("textarea, input, select")) {
    scoreInput.focus({ preventScroll: true });
  }
}

function navigateToJudgeSubmission(submissionId, options = {}) {
  const { keepEagleOpen = false } = options;
  const entry = findJudgeReviewEntryById(submissionId);
  if (!entry) return;
  const id = entry.id;
  if (!keepEagleOpen) closeEagleView();
  setActiveJudgeRailTab("score");

  let { entries: queueEntries, mineOnly, allEntries } = getJudgeQueueEntries();
  let queueIdx = queueEntries.findIndex((e) => e.id === id);

  if (queueIdx < 0 && mineOnly && allEntries.some((e) => e.id === id)) {
    const mineOnlyCb = document.getElementById("judge-mine-only");
    if (mineOnlyCb?.checked) {
      mineOnlyCb.checked = false;
      refreshJudgeSubmissionSelect();
      ({ entries: queueEntries } = getJudgeQueueEntries());
      queueIdx = queueEntries.findIndex((e) => e.id === id);
    }
  }

  if (queueIdx >= 0) {
    setJudgeSubmissionByIndex(queueIdx);
  } else {
    const select = document.getElementById("judge-submission-select");
    if (!select || !Array.from(select.options).some((o) => o.value === id)) {
      toast("That project is not in your current queue filter");
      return;
    }
    judgeCurrentIndex = Math.max(0, queueEntries.findIndex((e) => e.id === id));
    select.value = id;
    const picker = document.getElementById("judge-submission-picker");
    if (picker) picker.value = id;
    onJudgeSubmissionSelectChanged();
  }

  focusJudgeScoreInput();
}

function renderEagleView() {
  const thead = document.getElementById("judge-eagle-thead");
  const tbody = document.getElementById("judge-eagle-tbody");
  const updated = document.getElementById("judge-eagle-updated");
  if (!thead || !tbody) return;

  const judges = collectEagleJudgeColumns();
  const entries = [...getJudgeReviewEntries()].sort((a, b) => {
    const avgA = a.row ? averageJudgeScoresOnRow(a.row, judges) : null;
    const avgB = b.row ? averageJudgeScoresOnRow(b.row, judges) : null;
    if (avgA === null && avgB === null) {
      return entryAssignmentKey(a).localeCompare(entryAssignmentKey(b));
    }
    if (avgA === null) return 1;
    if (avgB === null) return -1;
    if (avgB !== avgA) return avgB - avgA;
    return entryAssignmentKey(a).localeCompare(entryAssignmentKey(b));
  });
  const currentId = document.getElementById("judge-submission-select")?.value || "";

  const colCount = judges.length + 2;
  thead.innerHTML = `<tr><th scope="col" class="judge-eagle__project">Project</th>${judges
    .map((j) => `<th scope="col">${escapeHtml(j)}</th>`)
    .join("")}<th scope="col" class="judge-eagle__avg" title="Average of judges who scored">Avg</th></tr>`;

  if (!entries.length) {
    tbody.innerHTML = `<tr><td class="judge-eagle__project" colspan="${colCount}">No submissions</td></tr>`;
  } else {
    tbody.innerHTML = entries
      .map((entry) => {
        const row = entry.row;
        const isCurrent = entry.id === currentId;
        const rawLabel = entry.name || entry.id || "—";
        const label = escapeHtml(rawLabel);
        const cells = judges
          .map((j) => {
            const score = row ? latestJudgeScoreOnRow(row, j) : null;
            if (score === null || score === undefined || score === "") {
              return `<td class="judge-eagle__cell--empty">—</td>`;
            }
            return `<td class="judge-eagle__cell--score">${escapeHtml(
              formatJudgeScore(Number(score))
            )}</td>`;
          })
          .join("");
        const avg = row ? averageJudgeScoresOnRow(row, judges) : null;
        const avgCell =
          avg === null
            ? `<td class="judge-eagle__cell--empty judge-eagle__cell--avg">—</td>`
            : `<td class="judge-eagle__cell--score judge-eagle__cell--avg">${escapeHtml(
                formatJudgeScore(avg)
              )}</td>`;
        return `<tr class="${isCurrent ? "is-current" : ""}"><th scope="row" class="judge-eagle__project"><button type="button" class="judge-eagle__project-btn" data-judge-eagle-id="${escapeAttr(
          entry.id
        )}" title="${escapeAttr(`Go to ${rawLabel}`)}">${label}</button></th>${cells}${avgCell}</tr>`;
      })
      .join("");
  }

  if (updated) {
    updated.textContent = `Updated ${new Date().toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    })}`;
  }
}

function setEagleViewOpen(open) {
  const workbench = document.querySelector(".judge-workbench");
  const openBtn = document.getElementById("judge-eagle-open");
  workbench?.classList.toggle("is-eagle-open", open);
  if (openBtn) {
    openBtn.setAttribute("aria-expanded", open ? "true" : "false");
    openBtn.classList.toggle("is-active", open);
    const label = open ? "Close Eagle view" : "Eagle view";
    openBtn.setAttribute("aria-label", label);
    openBtn.setAttribute("title", label);
  }
}

function openEagleView() {
  const overlay = document.getElementById("judge-eagle-overlay");
  if (!overlay) return;
  overlay.classList.remove("hidden");
  overlay.removeAttribute("hidden");
  setEagleViewOpen(true);
  renderEagleView();
  if (_judgeEagleTimer) clearInterval(_judgeEagleTimer);
  _judgeEagleTimer = setInterval(() => {
    if (overlay.classList.contains("hidden")) return;
    pollJudgeCoopOnce()
      .then(() => renderEagleView())
      .catch(() => renderEagleView());
  }, JUDGE_EAGLE_REFRESH_MS);
  document.getElementById("judge-eagle-close")?.focus();
}

function closeEagleView() {
  const overlay = document.getElementById("judge-eagle-overlay");
  if (!overlay) return;
  overlay.classList.add("hidden");
  overlay.setAttribute("hidden", "");
  setEagleViewOpen(false);
  if (_judgeEagleTimer) {
    clearInterval(_judgeEagleTimer);
    _judgeEagleTimer = null;
  }
  document.getElementById("judge-eagle-open")?.focus();
}

function isEagleViewOpen() {
  const overlay = document.getElementById("judge-eagle-overlay");
  return overlay && !overlay.classList.contains("hidden");
}

function initEagleView() {
  const openBtn = document.getElementById("judge-eagle-open");
  const closeBtn = document.getElementById("judge-eagle-close");
  const refreshBtn = document.getElementById("judge-eagle-refresh");
  if (openBtn && openBtn.dataset.bound !== "1") {
    openBtn.dataset.bound = "1";
    openBtn.addEventListener("click", () => {
      if (isEagleViewOpen()) closeEagleView();
      else openEagleView();
    });
  }
  if (closeBtn && closeBtn.dataset.bound !== "1") {
    closeBtn.dataset.bound = "1";
    closeBtn.addEventListener("click", () => closeEagleView());
  }
  if (refreshBtn && refreshBtn.dataset.bound !== "1") {
    refreshBtn.dataset.bound = "1";
    refreshBtn.addEventListener("click", () => {
      pollJudgeCoopOnce()
        .then(() => renderEagleView())
        .catch(() => renderEagleView());
    });
  }
  const tbody = document.getElementById("judge-eagle-tbody");
  if (tbody && tbody.dataset.bound !== "1") {
    tbody.dataset.bound = "1";
    tbody.addEventListener("click", (e) => {
      const btn = e.target.closest(".judge-eagle__project-btn[data-judge-eagle-id]");
      if (!btn) return;
      e.preventDefault();
      navigateToJudgeSubmission(btn.getAttribute("data-judge-eagle-id"));
    });
    tbody.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      const btn = e.target.closest(".judge-eagle__project-btn[data-judge-eagle-id]");
      if (!btn) return;
      e.preventDefault();
      navigateToJudgeSubmission(btn.getAttribute("data-judge-eagle-id"));
    });
  }
}

function renderJudgeOverviewMeta(submissionId) {
  const host = document.getElementById("judge-overview-meta");
  if (!host) return;
  if (!submissionId) {
    host.innerHTML = "";
    return;
  }
  const found = findSubmissionById(submissionId);
  const sub = found?.sub || null;
  const row = found?.row || null;
  if (!sub && !row) {
    host.innerHTML = "";
    return;
  }
  const team = (sub?.team?.name || sub?.team_name || "").trim();
  const track = formatTrackForLabel(sub?.chosen_track || row?.chosen_track || "");
  const tech = submissionTechnologiesDisplay(sub || row || {});
  const repo = (sub?.repo_url || row?.repo || "").trim();
  const demo = submissionDemoUrl(sub, row);
  const chips = [];
  if (team) chips.push(`<span class="judge-overview-meta__chip">Team · ${escapeHtml(team)}</span>`);
  if (track && track !== "unscored") {
    chips.push(
      `<span class="judge-overview-meta__chip judge-overview-meta__chip--track">Track · ${escapeHtml(track)}</span>`
    );
  }
  if (tech && tech !== "—") {
    chips.push(`<span class="judge-overview-meta__chip">Tech · ${escapeHtml(tech)}</span>`);
  }
  if (repo) {
    chips.push(
      `<span class="judge-overview-meta__chip"><a href="${escapeAttr(repo)}" target="_blank" rel="noopener noreferrer">Repo ↗</a></span>`
    );
  }
  if (demo) {
    chips.push(
      `<span class="judge-overview-meta__chip"><a href="${escapeAttr(demo)}" target="_blank" rel="noopener noreferrer">Demo ↗</a></span>`
    );
  }
  host.innerHTML = chips.join("");
}

function initJudgeRailTabs() {
  const tabs = document.querySelectorAll("[data-judge-rail-tab]");
  if (!tabs.length || document.documentElement.dataset.judgeRailTabsBound === "1") {
    return;
  }
  document.documentElement.dataset.judgeRailTabsBound = "1";
  tabs.forEach((b) => {
    b.addEventListener("click", () => {
      const next = b.getAttribute("data-judge-rail-tab") || "score";
      setActiveJudgeRailTab(next);
      if (next === "score") {
        const scoreInput = document.getElementById("judge-score-input");
        if (scoreInput && !document.activeElement?.matches("textarea, input, select")) {
          scoreInput.focus({ preventScroll: true });
        }
      }
    });
    b.addEventListener("keydown", (e) => {
      const railTabs = [...document.querySelectorAll("[data-judge-rail-tab]")];
      const i = railTabs.indexOf(document.activeElement);
      if (i < 0) return;
      if (e.key === "ArrowRight") {
        e.preventDefault();
        const next = railTabs[(i + 1) % railTabs.length];
        next.focus();
        next.click();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        const prev = railTabs[(i - 1 + railTabs.length) % railTabs.length];
        prev.focus();
        prev.click();
      }
    });
  });
}

function initJudgeWorkbenchUx() {
  restoreJudgeRailWidth();
  initJudgeRailResize();
  initEagleView();
  initJudgeRubricPopover();
  initJudgeRailTabs();
}

let _judgeRubricPopover = null;

function positionJudgeRubricPopover(btn, pop) {
  const gap = 8;
  const margin = 14;
  const rect = btn.getBoundingClientRect();
  const width = Math.min(300, window.innerWidth - margin * 2);
  pop.style.width = `${width}px`;
  pop.style.left = `${Math.min(
    Math.max(margin, rect.right - width),
    window.innerWidth - width - margin
  )}px`;

  const height = pop.offsetHeight || 0;
  const above = rect.top - height - gap;
  const below = rect.bottom + gap;
  pop.style.top = `${above >= margin ? above : Math.min(below, window.innerHeight - height - margin)}px`;
}

function closeJudgeRubricPopover() {
  if (!_judgeRubricPopover) return;
  _judgeRubricPopover.pinned = false;
  _judgeRubricPopover.wrap.classList.remove("judge-rubric-open");
  _judgeRubricPopover.pop.classList.remove("subtrack-sdk-popover--open");
  _judgeRubricPopover.btn.setAttribute("aria-expanded", "false");
}

function openJudgeRubricPopover(pinned) {
  if (!_judgeRubricPopover) return;
  closeJudgeRubricPopover();
  _judgeRubricPopover.pinned = !!pinned;
  _judgeRubricPopover.wrap.classList.add("judge-rubric-open");
  _judgeRubricPopover.pop.classList.add("subtrack-sdk-popover--open");
  _judgeRubricPopover.btn.setAttribute("aria-expanded", "true");
  positionJudgeRubricPopover(_judgeRubricPopover.btn, _judgeRubricPopover.pop);
}

function maybeCloseJudgeRubricPopover() {
  if (!_judgeRubricPopover) return;
  window.setTimeout(() => {
    const item = _judgeRubricPopover;
    const active = document.activeElement;
    const hasFocus = item.wrap.contains(active) || item.pop.contains(active);
    const isHovering = item.wrap.matches(":hover") || item.pop.matches(":hover");
    if (item.pinned || hasFocus || isHovering) return;
    closeJudgeRubricPopover();
  }, 80);
}

function initJudgeRubricPopover() {
  const wrap = document.querySelector(".judge-rubric-info-wrap");
  const btn = document.getElementById("judge-rubric-info-btn");
  const pop = document.getElementById("judge-rubric-popover");
  if (!wrap || !btn || !pop || btn.dataset.bound === "1") return;
  btn.dataset.bound = "1";
  if (pop.parentElement !== document.body) {
    document.body.appendChild(pop);
  }
  _judgeRubricPopover = { wrap, btn, pop, pinned: false };

  btn.addEventListener("mouseenter", () => {
    if (!_judgeRubricPopover.pinned) openJudgeRubricPopover(false);
  });
  btn.addEventListener("focus", () => {
    if (!_judgeRubricPopover.pinned) openJudgeRubricPopover(false);
  });
  wrap.addEventListener("mouseleave", () => maybeCloseJudgeRubricPopover());
  pop.addEventListener("mouseenter", () => {
    if (!_judgeRubricPopover.pinned) openJudgeRubricPopover(false);
  });
  pop.addEventListener("mouseleave", () => maybeCloseJudgeRubricPopover());
  pop.addEventListener("click", (e) => e.stopPropagation());
  pop.addEventListener("focusout", () => maybeCloseJudgeRubricPopover());
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (_judgeRubricPopover.pinned) {
      closeJudgeRubricPopover();
    } else {
      openJudgeRubricPopover(true);
    }
  });

  if (!document.documentElement.dataset.judgeRubricPopoverBound) {
    document.documentElement.dataset.judgeRubricPopoverBound = "1";
    document.addEventListener("click", (e) => {
      const t = e.target;
      if (
        t &&
        typeof t.closest === "function" &&
        (t.closest(".judge-rubric-info-wrap") || t.closest("#judge-rubric-popover"))
      ) {
        return;
      }
      closeJudgeRubricPopover();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      const openBtn = _judgeRubricPopover?.btn;
      closeJudgeRubricPopover();
      if (openBtn && document.activeElement?.closest("#judge-rubric-popover")) {
        openBtn.focus();
      }
    });
    window.addEventListener("resize", () => {
      if (_judgeRubricPopover?.pop.classList.contains("subtrack-sdk-popover--open")) {
        positionJudgeRubricPopover(_judgeRubricPopover.btn, _judgeRubricPopover.pop);
      }
    });
    window.addEventListener(
      "scroll",
      () => {
        if (_judgeRubricPopover?.pop.classList.contains("subtrack-sdk-popover--open")) {
          positionJudgeRubricPopover(_judgeRubricPopover.btn, _judgeRubricPopover.pop);
        }
      },
      true
    );
  }
}

function onJudgeModalOpened() {
  restoreJudgeRailWidth();
  startJudgeCoopPolling();
  _judgeScoreFingerprint = buildJudgeScoreFingerprint();
}

function onJudgeModalClosed() {
  stopJudgeCoopPolling();
  closeEagleView();
}

function clampJudgeScore(value) {
  if (value === "" || value == null) return null;
  const n = Number(value);
  if (Number.isNaN(n)) return null;
  return Math.round(Math.max(0, Math.min(judgeScoreTotalCap(), n)));
}

/** Integer for Supabase judge_responses (Postgres rejects 3.0-style floats on int columns). */
function judgePayloadInt(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(judgeScoreTotalCap(), Math.round(n)));
}

function judgePayloadScoreMap(scores) {
  if (!scores || typeof scores !== "object" || Array.isArray(scores)) return {};
  const out = {};
  for (const [key, value] of Object.entries(scores)) {
    if (key == null) continue;
    out[String(key)] = judgePayloadInt(value);
  }
  return out;
}

/** Coerce every numeric judge field to integer before POST /api/judges. */
function judgeBuildSavePayload(raw) {
  const total = judgePayloadInt(raw.total_score ?? raw.core_total ?? 0);
  const coreTotal = judgePayloadInt(raw.core_total ?? total);
  return {
    ...raw,
    core_scores: judgePayloadScoreMap(raw.core_scores || { overall: coreTotal }),
    bonus_bucket_scores: judgePayloadScoreMap(raw.bonus_bucket_scores || {}),
    core_total: coreTotal,
    bonus_total_raw: judgePayloadInt(raw.bonus_total_raw ?? 0),
    bonus_total_capped: judgePayloadInt(raw.bonus_total_capped ?? 0),
    total_score: total,
  };
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
    const demoUrl = submissionDemoUrl(sub, r);
    const row =
      demoUrl && !String(r.demo_url || "").trim()
        ? { ...r, demo_url: demoUrl }
        : r;
    const name = sub?.project_name || row.repo_id || extractRepoName(row.repo);
    const id = row.repo_id || name;
    entries.push({
      id,
      name,
      trackLabel: formatTrackForLabel(sub?.chosen_track || row.chosen_track || ""),
      scored: scored.has(id) || scored.has(normalizeSubmissionIdentity({ id, row, sub })),
      isLocal: false,
      row,
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

  // Fixed queue order for judges: same stable key as round-robin assignment.
  // Do not move scored rows — reshuffling on submit was confusing the panel.
  return deduped.sort((a, b) => {
    const keyA = entryAssignmentKey(a);
    const keyB = entryAssignmentKey(b);
    if (keyA < keyB) return -1;
    if (keyA > keyB) return 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });
}

function getJudgeQueueEntries() {
  const allEntries = getJudgeReviewEntries();
  const judgeIdx = getJudgeIndex(getJudgeNameForUi());
  const hasAssignment = judgeIdx !== -1;
  const mineOnly = hasAssignment && isJudgeMineOnlyChecked();
  const mineEntries = hasAssignment
    ? allEntries.filter((e) => isAssignedToCurrentJudge(e))
    : allEntries;
  const entries = mineOnly ? mineEntries : allEntries;
  return { allEntries, mineEntries, entries, hasAssignment, mineOnly };
}

function syncJudgeIdentityQueueChip() {
  const { allEntries, mineEntries, entries, hasAssignment, mineOnly } =
    getJudgeQueueEntries();
  const selectedId =
    document.getElementById("judge-submission-select")?.value || "";
  let currentPos = entries.length ? judgeCurrentIndex : -1;
  if (selectedId && entries.length) {
    const bySelection = entries.findIndex((e) => e.id === selectedId);
    if (bySelection >= 0) currentPos = bySelection;
  }
  updateJudgeQueueStatsUi({
    totalAll: allEntries.length,
    totalMine: mineEntries.length,
    hasAssignment,
    mineOnly,
    currentPos,
    queueTotal: entries.length,
  });
}

function refreshJudgeSubmissionSelect() {
  const select = document.getElementById("judge-submission-select");
  if (!select) return;
  const picker = document.getElementById("judge-submission-picker");
  const previous = select.value;
  const { allEntries, mineEntries, entries, hasAssignment, mineOnly } =
    getJudgeQueueEntries();

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
  syncJudgeIdentityQueueChip();
  renderJudgeSubmissionSummary();
  syncJudgeFullViewFromSelection();
}

function formatJudgeQueueChip({
  totalAll,
  totalMine,
  hasAssignment,
  mineOnly,
  currentPos,
  queueTotal,
}) {
  const n = queueTotal ?? 0;
  if (n === 0) return totalAll === 0 ? "" : "0 of 0";

  const posLabel =
    currentPos >= 0 && currentPos < n
      ? `${currentPos + 1} of ${n}`
      : `${n} submission${n === 1 ? "" : "s"}`;

  if (hasAssignment && mineOnly) return `${posLabel} · mine`;
  if (hasAssignment) return `${posLabel} · all`;
  return posLabel;
}

function updateJudgeQueueStatsUi({
  totalAll,
  totalMine,
  hasAssignment,
  mineOnly,
  currentPos = -1,
  queueTotal = 0,
}) {
  const stats = document.getElementById("judge-queue-stats");
  const wrap = document.getElementById("judge-mine-toggle-wrap");
  const cb = document.getElementById("judge-mine-only");
  const identity = document.getElementById("judge-rail-identity");
  const judgeName = getJudgeNameForUi();
  const chip = formatJudgeQueueChip({
    totalAll,
    totalMine,
    hasAssignment,
    mineOnly,
    currentPos,
    queueTotal,
  });

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

  const mineLabel = document.querySelector(
    "#judge-mine-toggle-wrap .judge-mine-toggle__label"
  );
  if (mineLabel) {
    mineLabel.textContent = hasAssignment
      ? `Mine only (${totalMine})`
      : "Mine only";
  }

  if (stats) {
    stats.textContent = chip;
    if (hasAssignment && mineOnly) {
      stats.title = `Assigned slice · ${totalMine} of ${totalAll} total`;
    } else if (hasAssignment && totalMine < totalAll) {
      stats.title = `${totalMine} in your slice · ${totalAll} total`;
    } else {
      stats.removeAttribute("title");
    }
  }

  if (identity) {
    const label = judgeName
      ? chip
        ? `Judging as ${judgeName}, ${chip}`
        : `Judging as ${judgeName}`
      : chip || "Judge session";
    identity.setAttribute("aria-label", label);
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
      if (isTestJudgeName(jLabel)) return;
      const displayTotal = judgeInfo.legacy_mode
        ? r.total_score
        : normalizeStoredJudgeScore(r.total_score, judgeInfo);
      const detail = judgeInfo.legacy_mode
        ? `${r.total_score}`
        : `${displayTotal === null ? "—" : formatJudgeScore(displayTotal)}/${judgeScoreTotalCap()}`;
      out.push({
        source: "imported",
        judge: jLabel,
        at: r.timestamp || null,
        total: displayTotal,
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

/** Absolute http(s) URL for parsing/embeds; rejects unsafe schemes. */
function normalizeDemoUrlForParse(raw) {
  let s = String(raw || "").trim();
  if (!s) return "";
  const protoMatch = s.match(/^([a-z][a-z0-9+.-]*):/i);
  if (protoMatch) {
    const p = protoMatch[1].toLowerCase();
    if (p === "javascript" || p === "data" || p === "vbscript" || p === "file") {
      return "";
    }
    if (p !== "http" && p !== "https") return "";
  }
  if (!/^https?:\/\//i.test(s)) {
    if (s.startsWith("//")) s = `https:${s}`;
    else s = `https://${s.replace(/^\/+/, "")}`;
  }
  return s;
}

/** Resolve demo link from API objects and merged CSV/summary rows. */
function submissionDemoUrl(sub, row) {
  const o = sub || {};
  const r = row || {};
  const candidates = [
    o.demo_url,
    o.video_url,
    o.demo_link,
    o.presentation_url,
    r.demo_url,
    r.video_url,
    r.demo_link,
    r.presentation_url,
    r["Demo URL"],
    r["Demo Link"],
    r["Video URL"],
  ];
  for (const c of candidates) {
    let t = String(c || "").trim();
    if (!t) continue;
    t = t.replace(/[)\].,;]+$/u, "");
    if (t) return t;
  }
  return "";
}

function isLikelyDirectVideoUrl(url) {
  const base = normalizeDemoUrlForParse(url);
  if (!base) return false;
  try {
    const u = new URL(base);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    return /\.(mp4|webm|ogg|ogv|mov)(\?[^#]*)?(#|$)/i.test(u.pathname);
  } catch {
    return false;
  }
}

function demoEmbedUrl(url) {
  const normalized = normalizeDemoUrlForParse(url);
  if (!normalized) return "";
  try {
    const u = new URL(normalized);
    if (u.protocol !== "http:" && u.protocol !== "https:") return "";
    const host = u.hostname.replace(/^www\./, "").toLowerCase();

    if (host === "youtu.be") {
      const id = u.pathname.split("/").filter(Boolean)[0];
      if (id) {
        return `https://www.youtube.com/embed/${encodeURIComponent(
          id
        )}?enablejsapi=1`;
      }
    }

    if (host.includes("youtube.com") || host.includes("youtube-nocookie.com")) {
      const v = u.searchParams.get("v");
      if (v) {
        return `https://www.youtube.com/embed/${encodeURIComponent(
          v
        )}?enablejsapi=1`;
      }
      const parts = u.pathname.split("/").filter(Boolean);
      const shortsIdx = parts.indexOf("shorts");
      if (shortsIdx >= 0 && parts[shortsIdx + 1]) {
        return `https://www.youtube.com/embed/${encodeURIComponent(
          parts[shortsIdx + 1]
        )}?enablejsapi=1`;
      }
      const embedIdx = parts.indexOf("embed");
      if (embedIdx >= 0 && parts[embedIdx + 1]) {
        return `https://www.youtube.com/embed/${encodeURIComponent(
          parts[embedIdx + 1]
        )}?enablejsapi=1`;
      }
      const liveIdx = parts.indexOf("live");
      if (liveIdx >= 0 && parts[liveIdx + 1]) {
        return `https://www.youtube.com/embed/${encodeURIComponent(
          parts[liveIdx + 1]
        )}?enablejsapi=1`;
      }
    }

    if (host.includes("vimeo.com")) {
      const parts = u.pathname.split("/").filter(Boolean);
      const videoIdx = parts.indexOf("video");
      const id =
        videoIdx >= 0 ? parts[videoIdx + 1] : parts[parts.length - 1];
      if (id) {
        return `https://player.vimeo.com/video/${encodeURIComponent(id)}`;
      }
    }

    if (host.includes("loom.com")) {
      const parts = u.pathname.split("/").filter(Boolean);
      const shareIndex = parts.indexOf("share");
      const id = shareIndex >= 0 ? parts[shareIndex + 1] : parts.pop();
      if (id) return `https://www.loom.com/embed/${encodeURIComponent(id)}`;
    }

    if (host.includes("drive.google.com") || host === "docs.google.com") {
      const fileMatch = u.pathname.match(/\/file\/d\/([^/]+)/);
      const id = fileMatch?.[1] || u.searchParams.get("id");
      if (id) {
        return `https://drive.google.com/file/d/${encodeURIComponent(id)}/preview`;
      }
    }

    if (host === "m.youtube.com" || host === "music.youtube.com") {
      const v = u.searchParams.get("v");
      if (v) {
        return `https://www.youtube.com/embed/${encodeURIComponent(
          v
        )}?enablejsapi=1`;
      }
    }
  } catch {
    return "";
  }
  return "";
}

/** Force cross-origin embeds (YouTube, etc.) to reload when src changes. */
function applyJudgeDemoEmbed(iframe, embedUrl) {
  if (!iframe) return;
  const target = String(embedUrl || "").trim();
  iframe.removeAttribute("src");
  void iframe.offsetWidth;
  if (target) iframe.setAttribute("src", target);
}

function setJudgeDemoStageMode(
  mode,
  { iframe, videoEl, fallback, embed, demoUrl, demoOpenHref, embedKey }
) {
  if (!iframe || !fallback) return;
  const msgEl = fallback.querySelector(".judge-demo-fallback__msg");
  const fallbackLink = fallback.querySelector(".judge-demo-fallback__link");
  const fallbackHint = fallback.querySelector(".judge-demo-fallback__hint");
  if (fallbackHint) {
    fallbackHint.textContent = "";
    fallbackHint.setAttribute("hidden", "");
  }

  if (mode === "video" && videoEl) {
    const abs = normalizeDemoUrlForParse(demoUrl);
    delete iframe.dataset.judgeEmbedKey;
    iframe.removeAttribute("src");
    iframe.setAttribute("hidden", "");
    fallback.setAttribute("hidden", "");
    if (videoEl.src !== abs) videoEl.src = abs;
    videoEl.removeAttribute("hidden");
    return;
  }

  if (mode === "embed") {
    if (videoEl) {
      try {
        videoEl.pause();
      } catch {
        /* ignore */
      }
      videoEl.removeAttribute("src");
      if (typeof videoEl.load === "function") videoEl.load();
      videoEl.setAttribute("hidden", "");
    }
    fallback.setAttribute("hidden", "");
    iframe.removeAttribute("hidden");
    if (msgEl) msgEl.textContent = "No embeddable demo URL";
    const key = embedKey || embed || "";
    if (iframe.dataset.judgeEmbedKey !== key || !iframe.getAttribute("src")) {
      iframe.dataset.judgeEmbedKey = key;
      applyJudgeDemoEmbed(iframe, embed);
    }
    return;
  }

  delete iframe.dataset.judgeEmbedKey;

  if (videoEl) {
    try {
      videoEl.pause();
    } catch {
      /* ignore */
    }
    videoEl.removeAttribute("src");
    if (typeof videoEl.load === "function") videoEl.load();
    videoEl.setAttribute("hidden", "");
  }
  iframe.removeAttribute("src");
  iframe.setAttribute("hidden", "");
  fallback.removeAttribute("hidden");
  if (msgEl && !demoUrl) msgEl.textContent = "No demo URL on file";
  else if (msgEl) msgEl.textContent = "Link not embeddable — open in new tab";
  if (fallbackLink) {
    if (demoOpenHref) {
      fallbackLink.setAttribute("href", demoOpenHref);
      fallbackLink.removeAttribute("hidden");
    } else {
      fallbackLink.setAttribute("hidden", "");
    }
  }
}

function setJudgeSubmissionByIndex(index) {
  const { entries } = getJudgeQueueEntries();
  if (!entries.length) {
    judgeCurrentIndex = 0;
    const select = document.getElementById("judge-submission-select");
    if (select) select.value = "";
    syncJudgeIdentityQueueChip();
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
  syncJudgeIdentityQueueChip();
  renderJudgeSubmissionSummary();
  syncJudgeFullViewFromSelection();
  syncJudgeScoreFormFromExisting();
}

function moveJudgeSubmission(delta) {
  setJudgeSubmissionByIndex(judgeCurrentIndex + delta);
  // Forward navigation also triggers a silent queue refresh so newly-landed
  // submissions show up in the counter without a manual ↻ tap.
  if (delta > 0) {
    refreshJudgeSubmissions({ silent: true }).catch(() => {});
  }
}

// ---------- Reels-style wheel + swipe navigation on the demo stage ----------
let _judgeWheelLockUntil = 0;
const JUDGE_WHEEL_THRESHOLD = 24;
const JUDGE_WHEEL_DEBOUNCE_MS = 400;
const JUDGE_SWIPE_THRESHOLD_PX = 60;
const JUDGE_SWIPE_DIRECTION_RATIO = 1.2;

function judgePrefersReducedMotion() {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

function isJudgeModalOpen() {
  const modal = document.getElementById("judge-modal");
  return !!modal && !modal.classList.contains("hidden");
}

function attachJudgeReelsHandlers() {
  const card = document.getElementById("judge-demo-card");
  if (!card || card.dataset.reelsBound === "1") return;
  card.dataset.reelsBound = "1";

  // Wheel — debounced, ignore tiny deltas, ignore horizontal-dominant scrolls.
  // Note: wheel events fired inside the demo iframe do not bubble across the
  // cross-origin boundary, so this only triggers on the surrounding gutters
  // / caption / nav strip — iframe scroll is left intact.
  card.addEventListener(
    "wheel",
    (ev) => {
      if (!isJudgeModalOpen()) return;
      if (judgePrefersReducedMotion()) return;
      const absY = Math.abs(ev.deltaY);
      const absX = Math.abs(ev.deltaX);
      if (absY < JUDGE_WHEEL_THRESHOLD) return;
      if (absY <= absX) return;
      const now = Date.now();
      if (now < _judgeWheelLockUntil) {
        ev.preventDefault();
        return;
      }
      _judgeWheelLockUntil = now + JUDGE_WHEEL_DEBOUNCE_MS;
      ev.preventDefault();
      moveJudgeSubmission(ev.deltaY > 0 ? 1 : -1);
    },
    { passive: false }
  );

  // Pointer swipe — vertical only, lock if horizontal dominates.
  let startX = 0;
  let startY = 0;
  let tracking = false;
  let axisLock = "";

  card.addEventListener("pointerdown", (ev) => {
    if (!isJudgeModalOpen()) return;
    if (ev.pointerType === "mouse" && ev.button !== 0) return;
    // Don't hijack pointerdown originating from interactive overlay controls.
    if (ev.target.closest("button, a, input, textarea, select")) return;
    startX = ev.clientX;
    startY = ev.clientY;
    tracking = true;
    axisLock = "";
  });

  card.addEventListener("pointermove", (ev) => {
    if (!tracking) return;
    const dx = ev.clientX - startX;
    const dy = ev.clientY - startY;
    if (!axisLock) {
      if (
        Math.abs(dx) > 18 &&
        Math.abs(dx) > Math.abs(dy) * JUDGE_SWIPE_DIRECTION_RATIO
      ) {
        axisLock = "x";
      } else if (Math.abs(dy) > 18) {
        axisLock = "y";
      }
    }
    if (axisLock === "x") {
      tracking = false;
    }
  });

  const finishSwipe = (ev) => {
    if (!tracking) return;
    tracking = false;
    const dx = ev.clientX - startX;
    const dy = ev.clientY - startY;
    if (Math.abs(dy) < JUDGE_SWIPE_THRESHOLD_PX) return;
    if (Math.abs(dy) <= Math.abs(dx) * JUDGE_SWIPE_DIRECTION_RATIO) return;
    // Reels convention: swipe up → next, swipe down → previous.
    moveJudgeSubmission(dy < 0 ? 1 : -1);
  };
  card.addEventListener("pointerup", finishSwipe);
  card.addEventListener("pointercancel", () => {
    tracking = false;
  });
  card.addEventListener("pointerleave", () => {
    tracking = false;
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

// ---------- Code signal: tech detection + integrity flags ----------

const JUDGE_TECH_KEYWORDS = [
  {
    id: "cursor-sdk",
    label: "Cursor SDK",
    patterns: [/cursor[-_\s]?sdk/i, /@cursor\/sdk/i],
  },
  { id: "cursor", label: "Cursor", patterns: [/\bcursor\b/i] },
  { id: "specter", label: "Specter", patterns: [/\bspecter\b/i] },
  { id: "tavily", label: "Tavily", patterns: [/\btavily\b/i, /tavily-python/i] },
  { id: "overmind", label: "Overmind", patterns: [/\bovermind\b/i] },
  { id: "alpic", label: "Alpic", patterns: [/\balpic\b/i, /\bskybridge\b/i] },
  { id: "openai", label: "OpenAI", patterns: [/\bopen[\s-]?ai\b/i] },
  {
    id: "anthropic",
    label: "Anthropic",
    patterns: [/\banthropic\b/i, /\bclaude\b/i],
  },
  {
    id: "supabase",
    label: "Supabase",
    patterns: [/\bsupabase\b/i, /@supabase\//i],
  },
  { id: "vercel", label: "Vercel", patterns: [/\bvercel\b/i] },
  {
    id: "postgres",
    label: "Postgres",
    patterns: [/\bpostgres(?:ql)?\b/i, /\bpg[-_]/i],
  },
  { id: "redis", label: "Redis", patterns: [/\bredis\b/i, /\bupstash\b/i] },
  { id: "next", label: "Next.js", patterns: [/\bnext(?:\.js)?\b/i] },
  { id: "react", label: "React", patterns: [/\breact\b/i] },
];

const JUDGE_FLAG_DEFS = [
  {
    key: "has_bulk_commits",
    label: "Bulk commits",
    severity: "warn",
    tooltip:
      "metrics.flags.has_bulk_commits — one or more commits land an unusually large diff at once.",
  },
  {
    key: "has_commits_before_t0",
    label: "Pre-T₀ commits",
    severity: "warn",
    tooltip:
      "metrics.flags.has_commits_before_t0 — commits authored before the hackathon start time.",
  },
  {
    key: "has_large_initial_commit_after_t0",
    label: "Big initial dump",
    severity: "warn",
    tooltip:
      "metrics.flags.has_large_initial_commit_after_t0 — first post-T₀ commit is unusually large; may be paste of pre-work.",
  },
  {
    key: "has_merge_commits",
    label: "Merge commits",
    severity: "info",
    tooltip:
      "metrics.flags.has_merge_commits — repo contains merge commits; check branch history before trusting churn totals.",
  },
];

/**
 * Derive a small {stack, flags, top_commits} bundle from whatever is present
 * in the submission + cached analysis. Each detected stack entry carries the
 * source field it was matched against (so the tooltip can cite it). No
 * fabricated data — if a field isn't in the payload, it isn't scanned.
 */
function summarizeRepoSignals({ submission, row, analysis } = {}) {
  const sources = [];
  const push = (text, source) => {
    if (text == null || text === "") return;
    sources.push({ text: String(text), source });
  };

  push(submission?.notes, "submission.notes");
  push(submission?.description, "submission.description");

  if (Array.isArray(submission?.submission_technologies)) {
    push(
      submission.submission_technologies.join(" "),
      "submission.submission_technologies"
    );
  } else if (typeof submission?.submission_technologies === "string") {
    push(submission.submission_technologies, "submission.submission_technologies");
  }

  if (Array.isArray(submission?.technology_ids) && technologiesCatalog.length) {
    const slugs = submission.technology_ids
      .map((id) => technologiesCatalog.find((t) => t.id === id)?.slug || "")
      .filter(Boolean)
      .join(" ");
    if (slugs) push(slugs, "submission.technology_ids");
  }

  const meta = submission?.repo_metadata || analysis?.repo_metadata;
  if (meta) {
    if (Array.isArray(meta.dependencies)) {
      push(meta.dependencies.join(" "), "repo_metadata.dependencies");
    } else if (meta.dependencies && typeof meta.dependencies === "object") {
      push(Object.keys(meta.dependencies).join(" "), "repo_metadata.dependencies");
    }
    if (Array.isArray(meta.top_languages)) {
      push(meta.top_languages.join(" "), "repo_metadata.top_languages");
    }
    if (meta.readme_excerpt) {
      push(meta.readme_excerpt, "repo_metadata.readme_excerpt");
    }
  }

  push(submission?.repo_url || row?.repo, "submission.repo_url");

  const stackMap = new Map();
  for (const { text, source } of sources) {
    for (const t of JUDGE_TECH_KEYWORDS) {
      if (stackMap.has(t.id)) continue;
      if (t.patterns.some((p) => p.test(text))) {
        stackMap.set(t.id, { label: t.label, source });
      }
    }
  }
  const stack = Array.from(stackMap.values());

  const flags = [];
  const f = analysis?.metrics?.flags || {};
  for (const def of JUDGE_FLAG_DEFS) {
    if (f[def.key]) {
      flags.push({
        label: def.label,
        severity: def.severity,
        tooltip: def.tooltip,
      });
    }
  }
  const afterT1 = Number(analysis?.metrics?.summary?.total_commits_after_t1 || 0);
  if (afterT1 > 0) {
    flags.push({
      label: `${afterT1} after T₁`,
      severity: "info",
      tooltip:
        "metrics.summary.total_commits_after_t1 — commits authored after the demo deadline.",
    });
  }

  const commitRows = Array.isArray(analysis?.commits) ? analysis.commits : [];
  const top_commits = commitRows.slice(0, 3).map((r) => ({
    sha: r.commit_sha || r.sha || r.short_sha || "",
    subject: r.subject || "",
    when: r.author_time_iso || r.committed_at || r.author_date || "",
  }));

  return { stack, flags, top_commits };
}

/** Cache parsed metrics+commits responses so we don't refetch per tab switch. */
const _stageCache = new Map();

async function loadStagePayload(repoId) {
  if (!repoId) return null;
  if (_stageCache.has(repoId)) return _stageCache.get(repoId);
  const apiSeg = encodeRepoApiSegment(repoId);
  try {
    const [metrics, commitsData] = await Promise.all([
      fetchJSON(`/api/repo/${apiSeg}/metrics`).catch(() => ({})),
      fetchJSON(`/api/repo/${apiSeg}/commits`).catch(() => ({ rows: [] })),
    ]);
    const payload = { metrics, commits: commitsData.rows || [] };
    _stageCache.set(repoId, payload);
    return payload;
  } catch (err) {
    const empty = { metrics: {}, commits: [] };
    _stageCache.set(repoId, empty);
    return empty;
  }
}

function renderJudgeCodeSignal(submissionId) {
  const host = document.getElementById("judge-code-signal");
  if (!host) return;
  if (!submissionId) {
    host.innerHTML = `<p class="judge-code-empty">Select a submission for code signal.</p>`;
    return;
  }
  const found = findSubmissionById(submissionId);
  const submission = found?.sub || null;
  const row = found?.row || null;
  const repoId = row?.repo_id || extractRepoName(row?.repo) || submissionId;
  const analysis = _stageCache.get(repoId) || null;
  const { stack, flags, top_commits } = summarizeRepoSignals({
    submission,
    row,
    analysis,
  });
  const summary = analysis?.metrics?.summary || {};
  const totalCommits = Number(summary.total_commits ?? row?.total_commits ?? 0);
  const locAdd = Number(summary.total_loc_added ?? row?.total_loc_added ?? 0);
  const locDel = Number(summary.total_loc_deleted ?? row?.total_loc_deleted ?? 0);

  const statBlock = `
    <div class="judge-code-stats">
      <div class="judge-code-stat"><span>commits</span><strong>${totalCommits.toLocaleString()}</strong></div>
      <div class="judge-code-stat"><span>+ loc</span><strong>${locAdd.toLocaleString()}</strong></div>
      <div class="judge-code-stat"><span>− loc</span><strong>${locDel.toLocaleString()}</strong></div>
    </div>`;

  const stackBlock = stack.length
    ? `<div class="judge-code-group"><span class="judge-rail-mini-label">Tech / SDK signal</span>
        <div class="judge-code-chip-row">${stack
          .map(
            (s) =>
              `<span class="judge-code-chip judge-code-chip--tech" title="${escapeAttr(
                `Matched in ${s.source}`
              )}">${escapeHtml(s.label)}<em>${escapeHtml(
                shortSourceLabel(s.source)
              )}</em></span>`
          )
          .join("")}</div></div>`
    : `<div class="judge-code-group judge-code-group--empty"><span class="judge-rail-mini-label">Tech / SDK signal</span>
        <p class="judge-code-empty">${
          analysis ? "No tech mentions in notes, description, or repo." : "Loading analysis…"
        }</p></div>`;

  const flagBlock = flags.length
    ? `<div class="judge-code-group"><span class="judge-rail-mini-label">Integrity flags</span>
        <div class="judge-code-chip-row">${flags
          .map(
            (f) =>
              `<span class="judge-code-chip judge-code-chip--flag judge-code-chip--${escapeAttr(
                f.severity
              )}" title="${escapeAttr(f.tooltip)}">${escapeHtml(f.label)}</span>`
          )
          .join("")}</div></div>`
    : `<div class="judge-code-group judge-code-group--empty"><span class="judge-rail-mini-label">Integrity flags</span>
        <p class="judge-code-empty">${
          analysis ? "No integrity flags." : "Loading analysis…"
        }</p></div>`;

  const commitsBlock = top_commits.length
    ? `<div class="judge-code-group"><span class="judge-rail-mini-label">Top commits</span>
        <ol class="judge-code-commits">${top_commits
          .map(
            (c) => `<li>
              ${
                c.sha
                  ? `<code>${escapeHtml(String(c.sha).slice(0, 7))}</code>`
                  : ""
              }
              <span>${escapeHtml(c.subject || "(no subject)")}</span>
              ${
                c.when
                  ? `<span class="judge-code-commit-when">${escapeHtml(
                      formatJudgeTime(c.when)
                    )}</span>`
                  : ""
              }
            </li>`
          )
          .join("")}</ol></div>`
    : "";

  host.innerHTML = statBlock + stackBlock + flagBlock + commitsBlock;
}
function shortSourceLabel(source) {
  if (!source) return "";
  const tail = source.split(".").slice(-1)[0];
  if (!tail) return ` · ${source}`;
  return ` · ${tail}`;
}

function countSubmissionMembers(submission) {
  if (!submission) return 0;
  const team = submission.team && typeof submission.team === "object" ? submission.team : null;
  if (team && Array.isArray(team.members) && team.members.length) {
    return team.members.length;
  }
  const legacy = String(submission.team_members || "").trim();
  if (!legacy) return 0;
  return legacy.split(/[,;\n]+/).map((s) => s.trim()).filter(Boolean).length;
}

function memberSocialLink(member) {
  const url = String(member?.social_url || "").trim();
  if (!url) return "";
  let label = "link";
  try {
    const host = new URL(
      url.startsWith("http") ? url : `https://${url}`
    ).hostname.toLowerCase();
    if (host.includes("linkedin")) label = "in";
    else if (host.includes("twitter") || host === "x.com" || host.endsWith(".x.com")) label = "𝕏";
    else if (host.includes("github")) label = "gh";
    else label = host.replace(/^www\./, "").split(".")[0];
  } catch {
    label = "link";
  }
  return `<a class="judge-team-member__link" href="${escapeAttr(
    url
  )}" target="_blank" rel="noopener noreferrer" aria-label="${escapeAttr(
    member.full_name + " social profile"
  )}">${escapeHtml(label)} ↗</a>`;
}

function memberLumaLink(member) {
  const url = String(member?.luma_profile || "").trim();
  if (!url) return "";
  return `<a class="judge-team-member__link" href="${escapeAttr(
    url
  )}" target="_blank" rel="noopener noreferrer" aria-label="${escapeAttr(
    member.full_name + " Luma profile"
  )}">luma ↗</a>`;
}

/** Judge-side team block. Structured members win; legacy comma string is the fallback. */
function renderJudgeTeamBlock(team, members, legacyMembersStr) {
  const teamName = String(team?.name || "").trim();
  if (Array.isArray(members) && members.length) {
    const items = members
      .map((m) => {
        const social = memberSocialLink(m);
        const luma = memberLumaLink(m);
        const email = m.cursor_email
          ? `<span class="judge-team-member__email" title="${escapeAttr(
              m.cursor_email
            )}" aria-hidden="true">·</span>`
          : "";
        return `<li class="judge-team-member"><span class="judge-team-member__name">${escapeHtml(
          m.full_name || "—"
        )}</span>${email}${social ? ` ${social}` : ""}${
          luma ? ` ${luma}` : ""
        }</li>`;
      })
      .join("");
    const header = teamName
      ? `<p class="judge-rail-mini-label">Team · ${escapeHtml(teamName)}</p>`
      : `<span class="judge-rail-mini-label">Team</span>`;
    return `<div class="judge-overview-extra">${header}<ul class="judge-team-list">${items}</ul></div>`;
  }
  if (legacyMembersStr) {
    const header = teamName
      ? `<p class="judge-rail-mini-label">Team · ${escapeHtml(teamName)}</p>`
      : `<span class="judge-rail-mini-label">Members</span>`;
    return `<div class="judge-overview-extra">${header}<p>${escapeHtml(
      legacyMembersStr
    )}</p></div>`;
  }
  return "";
}

function renderJudgeOverviewExtras(submissionId) {
  const host = document.getElementById("judge-side-detail-extras");
  if (!host) return;
  if (!submissionId) {
    host.innerHTML = "";
    return;
  }
  const found = findSubmissionById(submissionId);
  const sub = found?.sub || null;
  const row = found?.row || null;
  const description = (sub?.description || "").trim();
  const legacyMembers = (sub?.team_members || "").trim();
  const team = sub?.team && typeof sub.team === "object" ? sub.team : null;
  const teamMembers = Array.isArray(team?.members) ? team.members : [];
  const notes = (sub?.notes || "").trim();
  const repoUrl = (sub?.repo_url || row?.repo || "").trim();
  const demoRaw = submissionDemoUrl(sub, row);
  const demoUrl =
    normalizeDemoUrlForParse(demoRaw) || String(demoRaw || "").trim();
  const blocks = [];
  if (description) {
    blocks.push(
      `<div class="judge-overview-extra"><span class="judge-rail-mini-label">Description</span><p>${escapeHtml(
        description
      )}</p></div>`
    );
  }
  const teamBlock = renderJudgeTeamBlock(team, teamMembers, legacyMembers);
  if (teamBlock) blocks.push(teamBlock);
  if (notes) {
    blocks.push(
      `<div class="judge-overview-extra"><span class="judge-rail-mini-label">Notes</span><p>${escapeHtml(
        notes
      )}</p></div>`
    );
  }
  const actions = [];
  if (repoUrl) {
    actions.push(
      `<a class="btn btn-ghost btn-small" href="${escapeAttr(
        repoUrl
      )}" target="_blank" rel="noopener noreferrer">Open repo ↗</a>`
    );
  }
  if (demoUrl) {
    actions.push(
      `<a class="btn btn-primary btn-small" href="${escapeAttr(
        demoUrl
      )}" target="_blank" rel="noopener noreferrer">Open demo ↗</a>`
    );
  }
  const actionsHtml = actions.length
    ? `<div class="judge-overview-actions">${actions.join("")}</div>`
    : "";
  const empty = blocks.length
    ? blocks.join("")
    : `<p class="judge-overview-empty">No description, notes, or members on file.</p>`;
  host.innerHTML = empty + actionsHtml;
}

function setJudgeReelsCounter(text) {
  const count = document.getElementById("judge-video-count");
  if (!count) return;
  if (count.textContent === text) return;
  count.textContent = text;
  if (judgePrefersReducedMotion()) return;
  count.classList.remove("is-flash");
  // Force reflow so the animation restarts cleanly.
  void count.offsetWidth;
  count.classList.add("is-flash");
}

function setJudgeReelsCaptionVisible(visible) {
  const caption = document.getElementById("judge-reels-caption");
  if (!caption) return;
  caption.classList.toggle("is-hidden", !visible);
}

function renderJudgeVideoStage() {
  const title = document.getElementById("judge-video-title");
  const meta = document.getElementById("judge-video-meta");
  const chips = document.getElementById("judge-stage-chips");
  const entries = getJudgeReviewEntries();
  const selectedId = document.getElementById("judge-submission-select")?.value || "";
  const bySelect = selectedId ? entries.findIndex((e) => e.id === selectedId) : -1;
  if (bySelect >= 0) judgeCurrentIndex = bySelect;
  else if (judgeCurrentIndex >= entries.length) {
    judgeCurrentIndex = Math.max(0, entries.length - 1);
  }
  const current = entries[judgeCurrentIndex];

  if (!current) {
    if (title) title.textContent = "No submissions yet";
    if (meta) meta.textContent = "Tap ↻ to refresh the queue.";
    setJudgeReelsCounter("0 / 0");
    if (chips) chips.innerHTML = "";
    setJudgeReelsCaptionVisible(false);
    const demoCard = document.getElementById("judge-demo-card");
    const iframe = document.querySelector("#judge-demo-stage iframe");
    const videoEl = document.getElementById("judge-demo-video");
    const fallback = document.getElementById("judge-demo-fallback");
    if (demoCard) demoCard.classList.add("is-empty");
    if (iframe) {
      delete iframe.dataset.judgeEmbedKey;
      iframe.removeAttribute("src");
      iframe.setAttribute("hidden", "");
    }
    if (videoEl) {
      try {
        videoEl.pause();
      } catch {
        /* ignore */
      }
      videoEl.removeAttribute("src");
      if (typeof videoEl.load === "function") videoEl.load();
      videoEl.setAttribute("hidden", "");
    }
    if (fallback) {
      fallback.removeAttribute("hidden");
      const msg = fallback.querySelector(".judge-demo-fallback__msg");
      if (msg) msg.textContent = "No submissions yet";
      const hint = fallback.querySelector(".judge-demo-fallback__hint");
      if (hint) {
        hint.textContent = "Tap ↻ to refresh the queue";
        hint.removeAttribute("hidden");
      }
      const fbLink = fallback.querySelector(".judge-demo-fallback__link");
      if (fbLink) fbLink.setAttribute("hidden", "");
    }
    renderJudgeScoreQueue();
    return;
  }

  const demoCard = document.getElementById("judge-demo-card");
  if (demoCard) demoCard.classList.remove("is-empty");
  setJudgeReelsCaptionVisible(true);

  const sub = current.sub || {};
  if (title) title.textContent = current.name || "Untitled project";
  setJudgeReelsCounter(`${judgeCurrentIndex + 1} / ${entries.length}`);
  const team = (sub.team_name || "").trim();
  if (meta) {
    const parts = [];
    if (team) parts.push(team);
    parts.push(current.scored ? "already scored" : "needs score");
    meta.textContent = parts.join(" · ");
  }
  if (chips) {
    const cells = [];
    if (current.trackLabel && current.trackLabel !== "unscored") {
      cells.push(
        `<span class="judge-stage-chip judge-stage-chip--track">${escapeHtml(current.trackLabel)}</span>`
      );
    }
    cells.push(
      current.scored
        ? `<span class="judge-stage-chip judge-stage-chip--status-scored">● scored</span>`
        : `<span class="judge-stage-chip judge-stage-chip--status-current">○ current</span>`
    );
    chips.innerHTML = cells.join("");
  }

  const demoUrl = submissionDemoUrl(sub, current.row);
  const embed = demoEmbedUrl(demoUrl);
  const directVideo = Boolean(demoUrl) && !embed && isLikelyDirectVideoUrl(demoUrl);
  const demoOpenHref =
    normalizeDemoUrlForParse(demoUrl) || String(demoUrl || "").trim();
  const embedKey = `${current.id}|${embed || demoUrl || ""}`;
  const iframe = document.querySelector("#judge-demo-stage iframe");
  const videoEl = document.getElementById("judge-demo-video");
  const fallback = document.getElementById("judge-demo-fallback");
  if (iframe && fallback) {
    if (directVideo && videoEl) {
      setJudgeDemoStageMode("video", {
        iframe,
        videoEl,
        fallback,
        embed,
        demoUrl,
        demoOpenHref,
        embedKey,
      });
    } else if (embed) {
      setJudgeDemoStageMode("embed", {
        iframe,
        videoEl,
        fallback,
        embed,
        demoUrl,
        demoOpenHref,
        embedKey,
      });
    } else {
      setJudgeDemoStageMode("fallback", {
        iframe,
        videoEl,
        fallback,
        embed,
        demoUrl,
        demoOpenHref,
        embedKey,
      });
    }
    if (demoCard) demoCard.dataset.demoPlaying = "false";
  }
}

const JUDGE_QUEUE_CHIP_VISIBLE_MAX = 5;

function judgeQueueChipLabel(name) {
  const n = String(name || "").trim();
  const first = n.split(/\s+/)[0];
  return first || n;
}

function judgeResponseForPoolName(responses, poolName) {
  if (!responses?.length) return null;
  return (
    responses.find((r) => judgeMatchesPool(r.judge_name || r.judge, poolName)) ||
    null
  );
}

/** Panel + walk-in judges with score state for one queue row. */
function getJudgeQueueChipStates(entry) {
  const pool = getJudgePool();
  const scorers = entry?.scoredBy || [];
  const currentJudge = getJudgeNameForUi();
  const info = entry?.row ? getJudgeInfoForRow(entry.row) : null;
  const responses = info?.responses || [];
  const chips = [];

  pool.forEach((j) => {
    const scored = scorers.some((nm) => judgeMatchesPool(nm, j.name));
    const resp = scored ? judgeResponseForPoolName(responses, j.name) : null;
    const score = resp ? normalizeStoredJudgeScore(resp.total_score, info) : null;
    const isMine =
      scored && currentJudge && judgeMatchesPool(j.name, currentJudge);
    chips.push({
      name: j.name,
      scored,
      isMine,
      score,
      kind: "panel",
    });
  });

  scorers.forEach((name) => {
    if (isTestJudgeName(name)) return;
    if (pool.some((j) => judgeMatchesPool(name, j.name))) return;
    const resp = responses.find(
      (r) =>
        normalizeJudgeName(r.judge_name || r.judge) === normalizeJudgeName(name)
    );
    const score = resp ? normalizeStoredJudgeScore(resp.total_score, info) : null;
    const isMine = currentJudge && judgeMatchesPool(name, currentJudge);
    chips.push({
      name,
      scored: true,
      isMine,
      score,
      kind: "extra",
    });
  });

  return chips;
}

function judgeQueueChipTitle(chip) {
  if (chip.scored && chip.score != null) {
    return `${chip.name}: ${formatJudgeScore(chip.score)}`;
  }
  if (chip.scored) return `${chip.name}: scored`;
  return `${chip.name}: not scored yet`;
}

function renderJudgeQueueChipHtml(chip) {
  const classes = ["judge-queue-chip"];
  if (!chip.scored) classes.push("is-pending");
  else if (chip.isMine) classes.push("is-mine");
  else classes.push("is-scored");
  if (chip.kind === "extra") classes.push("is-extra");
  const prefix = chip.kind === "extra" ? "+ " : "";
  return `<span class="${classes.join(" ")}" title="${escapeAttr(
    judgeQueueChipTitle(chip)
  )}">${prefix}${escapeHtml(judgeQueueChipLabel(chip.name))}</span>`;
}

function renderJudgeQueueChipsHtml(entry) {
  const chips = getJudgeQueueChipStates(entry);
  if (!chips.length) return "";
  const visible = chips.slice(0, JUDGE_QUEUE_CHIP_VISIBLE_MAX);
  const hidden = chips.slice(JUDGE_QUEUE_CHIP_VISIBLE_MAX);
  const parts = visible.map((c) => renderJudgeQueueChipHtml(c));
  if (hidden.length) {
    parts.push(
      `<button type="button" class="judge-queue-chip judge-queue-chip--more" data-judge-queue-overflow="${escapeAttr(
        entry.id
      )}" aria-expanded="false" aria-haspopup="dialog" title="${escapeAttr(
        `Show ${hidden.length} more judge${hidden.length === 1 ? "" : "s"}`
      )}">+${hidden.length}</button>`
    );
  }
  return `<div class="judge-rail-queue__chips">${parts.join("")}</div>`;
}

let _judgeQueueJudgesPopoverBound = false;
let _judgeQueueJudgesPopover = null;

function positionJudgeQueueJudgesPopover(trigger, popover) {
  const gap = 6;
  const margin = 12;
  const rect = trigger.getBoundingClientRect();
  const width = Math.min(264, window.innerWidth - margin * 2);
  popover.style.width = `${width}px`;
  let left = rect.left + rect.width / 2 - width / 2;
  left = Math.min(Math.max(margin, left), window.innerWidth - width - margin);
  popover.style.left = `${left}px`;

  const height = popover.offsetHeight || 0;
  const below = rect.bottom + gap;
  const above = rect.top - height - gap;
  if (below + height <= window.innerHeight - margin) {
    popover.style.top = `${below}px`;
    popover.classList.remove("is-above");
  } else if (above >= margin) {
    popover.style.top = `${above}px`;
    popover.classList.add("is-above");
  } else {
    popover.style.top = `${Math.min(below, window.innerHeight - height - margin)}px`;
    popover.classList.remove("is-above");
  }
}

function closeJudgeQueueJudgesPopover() {
  const popover = document.getElementById("judge-queue-judges-popover");
  if (!popover) return;
  _judgeQueueJudgesPopover?.trigger?.setAttribute("aria-expanded", "false");
  popover.hidden = true;
  popover.setAttribute("aria-hidden", "true");
  popover.classList.remove("is-open", "is-above");
  popover.style.top = "";
  popover.style.left = "";
  popover.style.width = "";
  _judgeQueueJudgesPopover = null;
}

function openJudgeQueueJudgesPopover(entryId, trigger) {
  const popover = document.getElementById("judge-queue-judges-popover");
  const list = document.getElementById("judge-queue-judges-popover-list");
  const title = document.getElementById("judge-queue-judges-popover-title");
  if (!popover || !list || !trigger) return;

  if (
    _judgeQueueJudgesPopover?.trigger === trigger &&
    popover.classList.contains("is-open")
  ) {
    closeJudgeQueueJudgesPopover();
    return;
  }

  closeJudgeQueueJudgesPopover();

  const entry = getJudgeReviewEntries().find((e) => e.id === entryId);
  if (!entry) return;
  const chips = getJudgeQueueChipStates(entry);
  if (title) title.textContent = entry.name;
  list.innerHTML = chips
    .map((chip) => {
      const status = !chip.scored
        ? "Not scored"
        : chip.score != null
          ? formatJudgeScore(chip.score)
          : "Scored";
      const rowCls = [
        "judge-queue-judges-popover__item",
        !chip.scored ? "is-pending" : chip.isMine ? "is-mine" : "is-scored",
      ].join(" ");
      return `<li class="${rowCls}"><span class="judge-queue-judges-popover__name">${escapeHtml(
        chip.name
      )}</span><span class="judge-queue-judges-popover__score">${escapeHtml(
        status
      )}</span></li>`;
    })
    .join("");

  popover.hidden = false;
  popover.setAttribute("aria-hidden", "false");
  popover.classList.add("is-open");
  trigger.setAttribute("aria-expanded", "true");
  _judgeQueueJudgesPopover = { popover, trigger, entryId };
  positionJudgeQueueJudgesPopover(trigger, popover);
}

function initJudgeQueueJudgesPopover() {
  if (_judgeQueueJudgesPopoverBound) return;
  const popover = document.getElementById("judge-queue-judges-popover");
  const queue = document.getElementById("judge-score-queue");
  if (!popover || !queue) return;
  _judgeQueueJudgesPopoverBound = true;

  if (popover.parentElement !== document.body) {
    document.body.appendChild(popover);
  }

  popover.addEventListener("click", (e) => e.stopPropagation());

  queue.addEventListener("click", (e) => {
    const overflow = e.target.closest("[data-judge-queue-overflow]");
    if (overflow) {
      e.preventDefault();
      e.stopPropagation();
      openJudgeQueueJudgesPopover(
        overflow.getAttribute("data-judge-queue-overflow"),
        overflow
      );
      return;
    }
    const row = e.target.closest("[data-judge-queue-index]");
    if (!row || e.target.closest(".judge-queue-chip--more")) return;
    setJudgeSubmissionByIndex(Number(row.getAttribute("data-judge-queue-index")));
  });

  queue.addEventListener("keydown", (e) => {
    const overflow = e.target.closest("[data-judge-queue-overflow]");
    if (overflow && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      e.stopPropagation();
      openJudgeQueueJudgesPopover(
        overflow.getAttribute("data-judge-queue-overflow"),
        overflow
      );
      return;
    }
    const row = e.target.closest("[data-judge-queue-index]");
    if (!row || (e.key !== "Enter" && e.key !== " ")) return;
    if (e.target.closest("[data-judge-queue-overflow]")) return;
    e.preventDefault();
    setJudgeSubmissionByIndex(Number(row.getAttribute("data-judge-queue-index")));
  });

  if (!document.documentElement.dataset.judgeQueueJudgesPopoverBound) {
    document.documentElement.dataset.judgeQueueJudgesPopoverBound = "1";

    document.addEventListener("click", (e) => {
      const t = e.target;
      if (
        t &&
        typeof t.closest === "function" &&
        (t.closest("[data-judge-queue-overflow]") ||
          t.closest("#judge-queue-judges-popover"))
      ) {
        return;
      }
      closeJudgeQueueJudgesPopover();
    });

    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      const pop = document.getElementById("judge-queue-judges-popover");
      if (!pop?.classList.contains("is-open")) return;
      e.preventDefault();
      e.stopPropagation();
      const trigger = _judgeQueueJudgesPopover?.trigger;
      closeJudgeQueueJudgesPopover();
      trigger?.focus();
    });

    window.addEventListener("resize", () => {
      if (!_judgeQueueJudgesPopover) return;
      positionJudgeQueueJudgesPopover(
        _judgeQueueJudgesPopover.trigger,
        _judgeQueueJudgesPopover.popover
      );
    });

    window.addEventListener(
      "scroll",
      () => {
        if (!_judgeQueueJudgesPopover) return;
        positionJudgeQueueJudgesPopover(
          _judgeQueueJudgesPopover.trigger,
          _judgeQueueJudgesPopover.popover
        );
      },
      true
    );
  }
}

function renderJudgeScoreQueue() {
  const target = document.getElementById("judge-score-queue");
  const countEl = document.getElementById("judge-rail-queue-count");
  if (!target) return;
  closeJudgeQueueJudgesPopover();
  initJudgeQueueJudgesPopover();
  const { entries } = getJudgeQueueEntries();
  const selectedId =
    document.getElementById("judge-submission-select")?.value || "";
  const done = entries.filter((e) => e.scored).length;
  if (countEl) {
    countEl.textContent = entries.length
      ? `${done} of ${entries.length}`
      : "";
  }
  if (!entries.length) {
    target.innerHTML = "";
    updateJudgeQuickRecap();
    return;
  }
  const width = String(entries.length).length;
  target.innerHTML = entries
    .map((e, idx) => {
      const isActive = e.id === selectedId;
      const cls = [
        "judge-rail-queue__row",
        isActive ? "is-active" : "",
        e.scored ? "is-scored" : "",
      ]
        .filter(Boolean)
        .join(" ");
      const yourScore = yourScoreForEntry(e);
      const otherCount = otherScoreCountForEntry(e);
      let scoreLabel = "";
      if (yourScore != null) {
        scoreLabel = formatJudgeScore(yourScore);
      } else if (otherCount > 0) {
        scoreLabel = `·${otherCount}`;
      }
      const chipsHtml = renderJudgeQueueChipsHtml(e);
      return `<div class="${cls}" role="button" tabindex="0" data-judge-queue-id="${escapeAttr(
        e.id
      )}" data-judge-queue-index="${idx}" title="${escapeAttr(
        `${idx + 1} / ${entries.length} · ${e.name} · ${
          e.scored ? "scored by you" : "needs your score"
        }${otherCount ? ` · ${otherCount} other score${otherCount === 1 ? "" : "s"}` : ""}`
      )}">
        <span class="judge-rail-queue__idx">${String(idx + 1).padStart(width, "0")}</span>
        <span class="judge-rail-queue__dot" aria-hidden="true"></span>
        <div class="judge-rail-queue__body">
          <div class="judge-rail-queue__top">
            <span class="judge-rail-queue__name">${escapeHtml(e.name)}</span>
            <span class="judge-rail-queue__score">${escapeHtml(scoreLabel)}</span>
          </div>
          ${chipsHtml}
        </div>
      </div>`;
    })
    .join("");
  updateJudgeQuickRecap();
}

function yourScoreForEntry(entry) {
  const judgeName = getJudgeNameForUi();
  if (!judgeName.trim() || !entry?.row) return null;
  return latestJudgeScoreOnRow(entry.row, judgeName);
}

function otherScoreCountForEntry(entry) {
  const judgeName = getJudgeNameForUi();
  const info = entry?.row ? getJudgeInfoForRow(entry.row) : null;
  if (!info?.responses?.length) return 0;
  const names = scoredJudgeNamesForRow(entry.row);
  if (!judgeName) return names.length;
  return names.filter((n) => !judgeMatchesPool(n, judgeName)).length;
}

/** Queue-wide recap: your per-row scores vs configured panel size. */
function updateJudgeQuickRecap() {
  const recap = document.getElementById("judge-quick-recap");
  if (!recap) return;

  const { entries } = getJudgeQueueEntries();
  if (!entries.length) {
    recap.textContent = "";
    recap.hidden = true;
    return;
  }

  const yourScores = [];
  for (const entry of entries) {
    const score = yourScoreForEntry(entry);
    if (score != null) yourScores.push(score);
  }

  const panelCount = getJudgePool().length;
  if (!yourScores.length && !panelCount) {
    recap.textContent = "";
    recap.hidden = true;
    return;
  }

  const avg =
    yourScores.length > 0
      ? Math.round(
          (yourScores.reduce((sum, s) => sum + s, 0) / yourScores.length) * 10
        ) / 10
      : null;
  const avgLabel = avg == null ? "—" : formatJudgeScore(avg);
  const scoreCount = yourScores.length;
  const judgeCount = panelCount;

  recap.textContent = `Quick recap: avg ${avgLabel} · ${scoreCount} score${
    scoreCount === 1 ? "" : "s"
  } · ${judgeCount} judge${judgeCount === 1 ? "" : "s"}`;
  recap.hidden = false;
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
  if (!target) return;
  const select = document.getElementById("judge-submission-select");
  const id = select?.value || "";
  const judgeName = getJudgeNameForUi();
  if (!id) {
    target.innerHTML = "";
    target.classList.remove("is-visible");
    return;
  }
  const found = findSubmissionById(id);
  if (!found) {
    target.innerHTML = "";
    target.classList.remove("is-visible");
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
  const demoUrl = submissionDemoUrl(subInfo, row);
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
    setJudgeSaveStatus("Pick a submission first", "is-error");
    return;
  }
  if (!data.judge_name) {
    toast("Judge name is required");
    setJudgeSaveStatus("Judge name is required", "is-error");
    return;
  }
  const enteredScore = clampJudgeScore(data.judge_score);
  if (enteredScore === null) {
    toast(`Add a score between 0 and ${judgeScoreTotalCap()}`);
    setJudgeSaveStatus(`Score must be between 0 and ${judgeScoreTotalCap()}`, "is-error");
    return;
  }
  writeStoredJudgeName(data.judge_name);
  setJudgeSaveBusy(true);
  setJudgeSaveStatus("Saving…", "is-saving");

  const grandTotal = judgePayloadInt(enteredScore);
  const coreScores = { overall: grandTotal };
  const bonusScores = judgePayloadScoreMap(
    Object.fromEntries((eventFormat?.side_quests || []).map((q) => [q.id, 0]))
  );
  const found = findSubmissionById(data.submission_id);
  const sub = found?.sub || {};
  const row = found?.row || {};
  const repoUrl = sub.repo_url || row.repo || row.repo_url || "";
  if (!repoUrl) {
    toast("This submission has no repo URL, so it cannot be saved to Supabase.");
    return;
  }

  const entry = judgeBuildSavePayload({
    scored_at: new Date().toISOString(),
    hack_id: getActiveHackId(),
    judge_name: data.judge_name,
    submission_id: data.submission_id,
    repo_url: repoUrl,
    project_name: sub.project_name || row.project_name || "",
    chosen_track: sub.chosen_track || row.chosen_track || "",
    scored_track: sub.chosen_track || row.chosen_track || "",
    core_scores: coreScores,
    core_total: grandTotal,
    bonus_bucket_scores: bonusScores,
    bonus_total_raw: 0,
    bonus_total_capped: 0,
    total_score: grandTotal,
    thoughts: data.thoughts || "",
    notes: data.thoughts || "",
  });

  try {
    const res = await fetch("/api/judges", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(entry),
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(payload.error || "Failed to save score");
    if (payload.response?.judge_name) {
      writeStoredJudgeName(payload.response.judge_name);
    }
    await loadJudgeData();
    _judgeScoreFingerprint = buildJudgeScoreFingerprint();
    if (isEagleViewOpen()) renderEagleView();
  } catch (err) {
    setJudgeSaveBusy(false);
    setJudgeSaveStatus(err.message || "Save failed — try again", "is-error");
    toast(err.message || "Score failed. Supabase did not save it.");
    return;
  }
  setJudgeSaveBusy(false);
  startJudgeSavedTimer(`Saved · ${formatJudgeScore(grandTotal)}/${judgeScoreTotalCap()}`);

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
  toast(`Score saved — ${formatJudgeScore(grandTotal)}/${judgeScoreTotalCap()}.`);
}

let _judgeSavedTimer = null;
let _judgeSavedAt = null;
let _judgeSavedTick = null;
function setJudgeSaveStatus(text, cls) {
  const el = document.getElementById("judge-save-status");
  if (!el) return;
  el.classList.remove("is-saving", "is-saved", "is-error");
  if (cls) el.classList.add(cls);
  el.textContent = text || "";
}
function setJudgeSaveBusy(isBusy) {
  const btn = document.getElementById("judge-save-btn");
  const label = btn?.querySelector(".judge-save-btn__label");
  if (btn) btn.disabled = isBusy;
  if (label) label.textContent = isBusy ? "Saving…" : "Save";
}
function startJudgeSavedTimer(prefix) {
  _judgeSavedAt = Date.now();
  if (_judgeSavedTimer) clearTimeout(_judgeSavedTimer);
  if (_judgeSavedTick) clearInterval(_judgeSavedTick);
  const update = () => {
    const secs = Math.max(0, Math.round((Date.now() - _judgeSavedAt) / 1000));
    const ago = secs < 2 ? "just now" : secs < 60 ? `${secs}s ago` : `${Math.round(secs / 60)}m ago`;
    setJudgeSaveStatus(`${prefix} · ${ago}`, "is-saved");
  };
  update();
  _judgeSavedTick = setInterval(update, 1000);
  _judgeSavedTimer = setTimeout(() => {
    if (_judgeSavedTick) clearInterval(_judgeSavedTick);
    _judgeSavedTick = null;
  }, 60_000);
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

/**
 * Slim KPI strip: only the four numbers organizers actually act on during a
 * judging session — Total / Scored / Unscored / Flagged (+ Forks once at least
 * one repo has resolved a fork status). Everything else moved into the table.
 */
function renderManagerPanel() {
  const stats = document.getElementById("manager-stats");
  const rows = window.__summaryRows || [];
  const total = rows.length;
  const scored = rows.filter((r) => {
    const info = getJudgeInfoForRow(r);
    return !!(info && info.responses && info.responses.length);
  }).length;
  const unscored = Math.max(0, total - scored);
  const flagged = rows.filter((r) => hasAnyFlagWithAdmin(r)).length;
  const forks = rows.filter((r) => {
    const url = r.repo || getSubmissionInfoForRow(r)?.repo_url || "";
    return getCachedForkStatus(url) === "fork";
  }).length;

  if (stats) {
    stats.innerHTML = `
      <div class="manager-stat"><span class="manager-stat-num">${total}</span><span class="manager-stat-lbl">Total submissions</span></div>
      <div class="manager-stat manager-stat--accent"><span class="manager-stat-num">${scored}</span><span class="manager-stat-lbl">Scored · ${unscored} unscored</span></div>
      <div class="manager-stat manager-stat--danger"><span class="manager-stat-num">${flagged}</span><span class="manager-stat-lbl">Flagged</span></div>
      <div class="manager-stat"><span class="manager-stat-num">${forks}</span><span class="manager-stat-lbl">Forks</span></div>
    `;
  }

  renderOverallLeaderboard();
  renderLeaderboard("money-movement", "leaderboard-money-movement");
  renderLeaderboard(
    "financial-intelligence",
    "leaderboard-financial-intelligence"
  );
  renderFlaggedList();
  renderForkedList();
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

function renderFlaggedList() {
  const ul = document.getElementById("flagged-list");
  if (!ul) return;
  const rows = window.__summaryRows || [];
  const flagged = rows.filter((r) => hasAnyFlagWithAdmin(r)).slice(0, 30);
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
      const url = r.repo || sub?.repo_url || "";
      if (getCachedForkStatus(url) === "fork") tags.push("fork");
      if (isRowAdminFlagged(r)) tags.push("admin⚑");
      const name = sub?.project_name || r.repo_id;
      const tc = Number(r.total_commits) || 0;
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

function renderForkedList() {
  const ul = document.getElementById("forked-list");
  if (!ul) return;
  const rows = window.__summaryRows || [];
  const forks = rows.filter((r) => {
    const url = r.repo || getSubmissionInfoForRow(r)?.repo_url || "";
    return getCachedForkStatus(url) === "fork";
  });
  if (forks.length === 0) {
    ul.innerHTML =
      '<li style="justify-content:center;color:var(--muted);font-style:italic">No forked repos detected (yet). Fork status resolves async after opening the Submissions tab.</li>';
    return;
  }
  ul.innerHTML = forks
    .map((r) => {
      const sub = getSubmissionInfoForRow(r);
      const url = r.repo || sub?.repo_url || "";
      const name = sub?.project_name || r.repo_id || extractRepoName(url);
      const parent = (loadForkCache()[normalizeRepoKey(url)] || {}).parent;
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
        <span class="flagged-name">${escapeHtml(name)}${
          parent
            ? `<span class="flagged-meta">forked from ${escapeHtml(parent)}</span>`
            : ""
        }</span>
        <span class="flagged-actions"><span class="flagged-tags">FORK</span>${
          linkPart ? ` ${linkPart}` : ""
        } ${detailBtn}</span>
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
    p.style.borderRadius = Math.random() > 0.55 ? "9999px" : "2px";
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

  // Filters live inside a <template> until Manager opens — delegate changes.
  document.getElementById("manager-modal")?.addEventListener("change", (e) => {
    const t = e.target;
    if (
      t &&
      (t.id === "filter-preT0" ||
        t.id === "filter-bulk" ||
        t.id === "filter-merge" ||
        t.id === "filter-fork" ||
        t.id === "sort-select")
    ) {
      maybeRenderSummaryTable();
    }
  });

  // Admin row actions inside the submissions table (delegated, since the table
  // lives in a <template> until the manager modal is opened).
  document.getElementById("manager-modal")?.addEventListener("click", (e) => {
    const t = e.target;
    if (!t || !t.closest) return;
    const editBtn = t.closest("[data-row-edit]");
    if (editBtn) {
      e.preventDefault();
      e.stopPropagation();
      const id = editBtn.getAttribute("data-row-edit");
      if (id) openDrawer(id);
      return;
    }
    const flagBtn = t.closest("[data-row-flag]");
    if (flagBtn) {
      e.preventDefault();
      e.stopPropagation();
      const url = flagBtn.getAttribute("data-row-flag");
      if (!url) return;
      const now = toggleAdminFlag(url);
      toast(
        now
          ? "Flagged — visible in Integrity watchlist"
          : "Unflagged"
      );
      maybeRenderSummaryTable();
      renderManagerPanel();
      return;
    }
    const delBtn = t.closest("[data-row-delete]");
    if (delBtn) {
      e.preventDefault();
      e.stopPropagation();
      const url = delBtn.getAttribute("data-row-delete");
      const name = delBtn.getAttribute("data-row-name") || "this submission";
      if (!url) return;
      const ok = window.confirm(
        `Delete ${name}?\n\nThis attempts a server-side delete and otherwise hides the row in this browser. Cannot be undone here.`
      );
      if (!ok) return;
      const repoKey = normalizeRepoKey(url);
      (async () => {
        let serverDeleted = false;
        try {
          const res = await fetch(
            `/api/submissions?repo_key=${encodeURIComponent(repoKey)}`,
            { method: "DELETE" }
          );
          serverDeleted = res.ok;
        } catch {}
        markRowAdminHidden(url);
        // Drop from in-memory rows so the panel rerenders cleanly.
        if (Array.isArray(window.__summaryRows)) {
          window.__summaryRows = window.__summaryRows.filter((r) => {
            const k = normalizeRepoKey(
              r.repo || getSubmissionInfoForRow(r)?.repo_url || ""
            );
            return k !== repoKey;
          });
        }
        maybeRenderSummaryTable();
        renderManagerPanel();
        toast(
          serverDeleted
            ? `Deleted ${name}`
            : `Hid ${name} locally (no server DELETE endpoint — follow-up needed)`
        );
      })();
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
  setupTeamRosterHandlers();
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
  initJudgePanelToggle();
  restoreJudgeRailWidth();
  initJudgeRailResize();
  initEagleView();
  initJudgeQueueJudgesPopover();
  judgeStageTabRoot().querySelectorAll("[data-judge-stage-tab]").forEach((b) => {
    b.addEventListener("click", () => {
      setActiveJudgeStageTab(
        b.getAttribute("data-judge-stage-tab") || "overview"
      );
    });
    b.addEventListener("keydown", (e) => {
      const tabs = [
        ...judgeStageTabRoot().querySelectorAll("[data-judge-stage-tab]"),
      ];
      const i = tabs.indexOf(document.activeElement);
      if (i < 0) return;
      if (e.key === "ArrowRight") {
        e.preventDefault();
        const next = tabs[(i + 1) % tabs.length];
        next.focus();
        next.click();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        const prev = tabs[(i - 1 + tabs.length) % tabs.length];
        prev.focus();
        prev.click();
      }
    });
  });

  // Password gate (validates against SITE_PASSWORD via POST /api/auth)
  syncAuthFromServer().finally(() => applyAuthState());
  const passwordForm = document.getElementById("password-form");
  if (passwordForm) {
    passwordForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const pwInput = passwordForm.querySelector("input[name=password]");
      const gateNameInput = passwordForm.querySelector("#password-judge-name");
      const errorEl = document.getElementById("password-error");
      const submitBtn = passwordForm.querySelector('button[type="submit"]');
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
      if (submitBtn) submitBtn.disabled = true;
      if (errorEl) errorEl.textContent = "";
      try {
        const res = await fetch("/api/auth", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ password: value, judge_name: nameVal }),
        });
        const payload = await res.json().catch(() => ({}));
        if (res.ok && payload.ok) {
          sessionStorage.setItem(AUTH_KEY, AUTH_SESSION_VALUE);
          const lockedName = String(payload.judge_name || nameVal).trim();
          writeStoredJudgeName(lockedName);
          passwordForm.reset();
          applyAuthState();
          closeModal("password-modal");
          const next = pendingGatedModalId;
          pendingGatedModalId = null;
          renderJudgeScoreQueue();
          renderJudgeSubmissionToolbar();
          renderJudgeSubmissionSummary();
          if (next) setTimeout(() => openModal(next), 80);
          if (payload.panel_judge === false) {
            toast(
              "Unlocked, but your name did not match a panel judge — scores must use names like David Gelberg or Rohit Gupta."
            );
          } else {
            toast(`Unlocked as ${lockedName}`);
          }
        } else {
          if (errorEl) {
            errorEl.textContent =
              res.status === 503
                ? "Access gate not configured on server."
                : "Wrong code. Try again.";
          }
          if (pwInput) {
            pwInput.value = "";
            pwInput.focus();
          }
        }
      } catch (_) {
        if (errorEl) errorEl.textContent = "Could not reach server. Try again.";
        if (pwInput) pwInput.focus();
      } finally {
        if (submitBtn) submitBtn.disabled = false;
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
    const judgeOpen = !document
      .getElementById("judge-modal")
      ?.classList.contains("hidden");
    const activeTag = document.activeElement?.tagName || "";
    const inTextInput =
      activeTag === "INPUT" || activeTag === "TEXTAREA" || activeTag === "SELECT";

    if (e.key === "Escape") {
      if (isEagleViewOpen()) {
        e.preventDefault();
        closeEagleView();
        return;
      }
      closeDrawer();
      document
        .querySelectorAll(".modal:not(.hidden)")
        .forEach((m) => closeModal(m.id));
      return;
    }

    // Cmd/Ctrl + Enter ⇒ save score from anywhere inside the judge modal
    if (judgeOpen && (e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      const judgeForm = document.getElementById("judge-form");
      if (judgeForm) {
        if (typeof judgeForm.requestSubmit === "function") {
          judgeForm.requestSubmit();
        } else {
          judgeForm.dispatchEvent(new Event("submit", { cancelable: true }));
        }
      }
      return;
    }

    // ← / → / [ / ] / ↑ / ↓ cycle queue when not typing
    if (judgeOpen && !inTextInput) {
      if (e.key === "ArrowRight" || e.key === "]" || e.key === "ArrowDown") {
        e.preventDefault();
        moveJudgeSubmission(1);
        return;
      }
      if (e.key === "ArrowLeft" || e.key === "[" || e.key === "ArrowUp") {
        e.preventDefault();
        moveJudgeSubmission(-1);
        return;
      }
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
        video: {
          src: "context-videos/shopify-sirupsen.mp4",
          poster: "context-post-thumbs/0.jpg",
        },
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
        video: {
          src: "context-videos/kamil-ai-toolkit.mp4",
          poster: "context-post-thumbs/1.jpg",
        },
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
        video: {
          src: "context-videos/shopify-ai-toolkit-announce.mp4",
          poster: "context-post-thumbs/2.jpg",
        },
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
        video: {
          src: "context-videos/glenngabe-openai-ads.mp4",
          poster: "context-post-thumbs/3.jpg",
        },
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
        video: {
          src: "context-videos/samboboev-agentic-commerce.mp4",
          poster: "context-post-thumbs/4.jpg",
        },
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
        image: {
          src: "context-post-thumbs/5.jpg",
          alt: "Agentic Commerce: buyers messaging merchants in-thread",
        },
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
    const mediaSlot = document.getElementById("context-lb-media-slot");
    const imgRow = lightbox.querySelector(".context-lightbox__imgrow");
    const lbVideo = document.getElementById("context-lb-video");
    const lbStill = document.getElementById("context-lb-still");
    const lbTwitterEmbed = document.getElementById("context-lb-twitter-embed");
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

    function pauseLightboxVideo() {
      if (!lbVideo) return;
      lbVideo.pause();
      try {
        lbVideo.currentTime = 0;
      } catch (e) {
        /* ignore */
      }
    }

    function clearLightboxTwitterEmbed() {
      if (!lbTwitterEmbed) return;
      lbTwitterEmbed.src = "about:blank";
      lbTwitterEmbed.setAttribute("hidden", "");
    }

    function hideLightboxStill() {
      if (!lbStill) return;
      lbStill.removeAttribute("src");
      lbStill.alt = "";
      lbStill.setAttribute("hidden", "");
    }

    function hideLightboxMedia() {
      pauseLightboxVideo();
      if (lbVideo) {
        lbVideo.removeAttribute("src");
        lbVideo.removeAttribute("poster");
        lbVideo.setAttribute("hidden", "");
      }
      clearLightboxTwitterEmbed();
      hideLightboxStill();
      if (mediaSlot) mediaSlot.setAttribute("hidden", "");
    }

    function renderAt(i) {
      const m = GALLERY.length;
      const idx = ((i % m) + m) % m;
      const item = GALLERY[idx];
      currentIndex = idx;
      pauseLightboxVideo();
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

      const tw =
        item.kind === "twitter_embed" &&
        typeof item.tweetId === "string" &&
        item.tweetId.length > 0;
      const v = item.video;
      const still = item.image;
      const hasVideo = !!(v && v.src);
      const hasStill = !!(still && still.src);

      if (!mediaSlot || (!tw && !hasVideo && !hasStill)) {
        hideLightboxMedia();
      } else if (tw && lbTwitterEmbed) {
        pauseLightboxVideo();
        hideLightboxStill();
        if (lbVideo) {
          lbVideo.removeAttribute("src");
          lbVideo.removeAttribute("poster");
          lbVideo.setAttribute("hidden", "");
        }
        mediaSlot.removeAttribute("hidden");
        lbTwitterEmbed.removeAttribute("hidden");
        lbTwitterEmbed.src = `https://platform.twitter.com/embed/Tweet.html?id=${encodeURIComponent(
          item.tweetId,
        )}&theme=dark`;
      } else if (hasVideo && lbVideo) {
        clearLightboxTwitterEmbed();
        hideLightboxStill();
        mediaSlot.removeAttribute("hidden");
        lbVideo.removeAttribute("hidden");
        lbVideo.preload = "auto";
        lbVideo.src = v.src;
        lbVideo.poster = v.poster || "";
        lbVideo.load();
      } else if (hasStill && lbStill) {
        pauseLightboxVideo();
        clearLightboxTwitterEmbed();
        if (lbVideo) {
          lbVideo.removeAttribute("src");
          lbVideo.removeAttribute("poster");
          lbVideo.setAttribute("hidden", "");
        }
        mediaSlot.removeAttribute("hidden");
        lbStill.removeAttribute("hidden");
        lbStill.src = still.src;
        lbStill.alt = typeof still.alt === "string" ? still.alt : "";
      } else {
        hideLightboxMedia();
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
      hideLightboxMedia();
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

    /** Native <video> controls live in a UA shadow tree; closest() from the inner target may not reach the host. */
    function shouldKeepLightboxOpenOnShellPointer(e) {
      const t = e.target;
      if (t && typeof t.closest === "function") {
        if (
          t.closest(".context-lightbox__nav") ||
          t.closest("a") ||
          t.closest("button") ||
          t.closest("video") ||
          t.closest("input[type=range]") ||
          t.closest("[role=slider]") ||
          t.closest(".context-lightbox-preview-card") ||
          t.closest(".context-lightbox__desc") ||
          t.closest(".context-lightbox__imgrow") ||
          t.closest(".context-lightbox__media-slot") ||
          t.closest("#context-lb-video") ||
          t.closest("#context-lb-still") ||
          t.closest("#context-lb-twitter-embed")
        ) {
          return true;
        }
      }
      if (typeof e.composedPath === "function") {
        const path = e.composedPath();
        if (lbVideo && path.includes(lbVideo)) return true;
        if (lbStill && path.includes(lbStill)) return true;
        if (mediaSlot && path.includes(mediaSlot)) return true;
        if (imgRow && path.includes(imgRow)) return true;
        if (lbTwitterEmbed && path.includes(lbTwitterEmbed)) return true;
      }
      return false;
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
        if (e.target.closest("video")) return;
        const raw = parseInt(card.getAttribute("data-idx") || "0", 10);
        const i = Number.isNaN(raw) ? 0 : raw;
        openAt(i, card);
      });
      card.addEventListener("keydown", (e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        if (e.target.closest("a[href]")) return;
        if (e.target.closest("video")) return;
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
      if (shouldKeepLightboxOpenOnShellPointer(e)) return;
      close();
    });

    if (mediaSlot) {
      /*
       * Quarantine ALL pointer/mouse/touch interactions inside the media slot so the
       * native <video> scrubber drag cannot bubble up to shell-level swipe/close handlers
       * (current or future). Listeners run in the bubble phase, so the UA shadow DOM
       * controls have already received the event by the time we stop propagation here —
       * this only blocks ancestors, not the native scrubber.
       */
      const SLOT_QUARANTINE_EVENTS = [
        "click",
        "dblclick",
        "pointerdown",
        "pointerup",
        "pointermove",
        "pointercancel",
        "mousedown",
        "mouseup",
        "mousemove",
        "touchstart",
        "touchend",
        "touchmove",
        "touchcancel",
        "dragstart",
      ];
      SLOT_QUARANTINE_EVENTS.forEach((evt) => {
        mediaSlot.addEventListener(evt, (e) => {
          e.stopPropagation();
        });
      });
    }

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
        <td colspan="14">
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
