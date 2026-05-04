const DATA_BASE = "/admin/data";

let judgeMap = new Map();
let submissionMap = new Map();
let analysisSettings = null;

async function fetchJSONMaybe(url) {
  const res = await fetch(url, { cache: "no-store", credentials: "same-origin" });
  if (!res.ok) return null;
  return res.json();
}

async function fetchTextMaybe(url) {
  const res = await fetch(url, { cache: "no-store", credentials: "same-origin" });
  if (!res.ok) return null;
  return res.text();
}

function normalizeRepoKey(repoUrl = "") {
  return String(repoUrl).trim().replace(/\.git$/i, "").toLowerCase();
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text ?? "";
  return div.innerHTML;
}

function escapeAttr(text) {
  return String(text ?? "").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function humanizeKey(text) {
  return String(text || "").replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function formatNumber(num) {
  const n = Number(num) || 0;
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}

function isoToLocalInputValue(value) {
  if (!value) return "";
  const date = new Date(value);
  const offsetMs = date.getTimezoneOffset() * 60000;
  return new Date(date.getTime() - offsetMs).toISOString().slice(0, 16);
}

function localInputValueToIso(value) {
  return value ? new Date(value).toISOString() : "";
}

function setSettingsStatus(message, type = "") {
  const target = document.getElementById("analysis-settings-status");
  target.textContent = message;
  target.className = "settings-status";
  if (type) {
    target.classList.add(`settings-status--${type}`);
  }
}

function flagChip(value) {
  return Number(value) > 0 ? '<span class="flag danger">Yes</span>' : '<span class="flag ok">No</span>';
}

function hasAnyFlag(row) {
  return (
    Number(row.has_commits_before_t0) > 0 ||
    Number(row.has_bulk_commits) > 0 ||
    Number(row.has_large_initial_commit_after_t0) > 0 ||
    Number(row.has_merge_commits) > 0
  );
}

function trackChip(track) {
  if (!track) return '<span class="track-chip track-chip--empty">Unassigned</span>';
  return `<span class="track-chip">${escapeHtml(track)}</span>`;
}

function statusChip(row) {
  if (row.analysis_status === "analysis_failed") {
    return '<span class="status-chip status-chip--failed">Analysis Failed</span>';
  }
  return row.analysis_status === "analyzed"
    ? '<span class="status-chip status-chip--analyzed">Analyzed</span>'
    : '<span class="status-chip status-chip--pending">Submitted</span>';
}

function getJudgeInfoForRow(row) {
  if (!row) return null;
  return judgeMap.get(normalizeRepoKey(row.repo || row.repo_url || ""));
}

function getSubmissionInfoForRow(row) {
  if (!row) return null;
  const repoKey = normalizeRepoKey(row.repo || row.repo_url || "");
  return submissionMap.get(repoKey) || null;
}

async function loadJudgeData() {
  const data = await fetchJSONMaybe("/api/judges") || await fetchJSONMaybe(`${DATA_BASE}/judge-responses-normalized.json`);
  const map = new Map();
  if (data && data.by_repo) {
    for (const [repoKey, info] of Object.entries(data.by_repo)) {
      map.set(normalizeRepoKey(info.repo_url || repoKey), info);
    }
  }
  judgeMap = map;
}

async function loadAnalysisSettings() {
  const payload = await fetchJSONMaybe("/api/settings");
  analysisSettings = payload?.settings || null;
  if (!analysisSettings) {
    return;
  }

  document.getElementById("settings-event-t0").value = isoToLocalInputValue(analysisSettings.event_t0);
  document.getElementById("settings-event-t1").value = isoToLocalInputValue(analysisSettings.event_t1);
  document.getElementById("settings-bulk-insertions").value = analysisSettings.bulk_insertion_threshold;
  document.getElementById("settings-bulk-files").value = analysisSettings.bulk_files_threshold;
  document.getElementById("settings-max-commits").value = analysisSettings.max_commits_to_analyze;
}

async function loadSubmissionData() {
  const data = await fetchJSONMaybe("/api/submissions") || await fetchJSONMaybe(`${DATA_BASE}/submissions-normalized.json`);
  const map = new Map();
  for (const submission of data?.submissions || []) {
    map.set(normalizeRepoKey(submission.repo_url), submission);
  }
  submissionMap = map;
}

function renderJudgeCell(info) {
  if (!info || !info.responses || info.responses.length === 0) {
    return '<span class="judge-chip judge-chip--empty">No scores</span>';
  }
  const avg = Number((info.averages && info.averages.grand_total) ?? info.average_score ?? 0).toFixed(1);
  const maxScore = info.legacy_mode ? "" : '<span class="judge-chip-max">/10</span>';
  const judgeNames = info.responses.map(r => escapeHtml(r.judge_name || "?")).join(", ");
  const judgeLabel = info.responses.length === 1 ? "1 judge" : `${info.responses.length} judges`;
  return `
    <span class="judge-chip">
      <span class="judge-chip-score">${avg}${maxScore}</span>
      <span class="judge-chip-meta">${judgeLabel}</span>
      <span class="judge-chip-names" style="display:block;font-size:0.7rem;color:#888;margin-top:2px;">${judgeNames}</span>
    </span>
  `;
}

function getAIPreview(aiText) {
  if (!aiText) return '<span class="ai-preview ai-preview--empty">No AI analysis yet</span>';
  const sentences = aiText.split(/(?<=[.!?])\s+/).slice(0, 2).join(" ");
  const preview = sentences.length > 180 ? `${sentences.slice(0, 180)}…` : sentences;
  return `<span class="ai-preview">${escapeHtml(preview)}</span>`;
}

function updateStats(rows) {
  const tracked = rows.filter((row) => row.submission_status === "submitted").length;
  const analyzed = rows.filter((row) => row.analysis_status === "analyzed").length;
  const flagged = rows.filter((row) => row.analysis_status === "analyzed" && hasAnyFlag(row)).length;
  const clean = rows.filter((row) => row.analysis_status === "analyzed" && !hasAnyFlag(row)).length;
  const totalCommits = rows.reduce((sum, row) => sum + (Number(row.total_commits) || 0), 0);

  document.getElementById("stat-total").textContent = rows.length;
  document.getElementById("stat-tracked").textContent = tracked;
  document.getElementById("stat-analyzed").textContent = analyzed;
  document.getElementById("stat-flagged").textContent = flagged;
  document.getElementById("stat-clean").textContent = clean;
  document.getElementById("stat-commits").textContent = formatNumber(totalCommits);
}

function mergeRows(summaryRows, submissions) {
  const byRepo = new Map();

  for (const row of summaryRows) {
    const repoKey = normalizeRepoKey(row.repo || "");
    byRepo.set(repoKey, {
      ...row,
      repo_id: row.repo_id || row.id,
      analysis_status: "analyzed",
      submission_status: "submitted",
    });
  }

  for (const submission of submissions) {
    const repoKey = normalizeRepoKey(submission.repo_url || "");
    if (byRepo.has(repoKey)) {
      byRepo.set(repoKey, {
        ...byRepo.get(repoKey),
        ...submission,
      });
      continue;
    }
    byRepo.set(repoKey, {
      repo_id: submission.repo_id || submission.submission_id,
      repo: submission.repo_url,
      submission_id: submission.submission_id || submission.repo_id,
      project_name: submission.project_name,
      team_name: submission.team_name,
      chosen_track: submission.chosen_track,
      demo_url: submission.demo_url,
      submission_status: "submitted",
      analysis_status: submission.analysis_status || "pending",
      default_branch: submission.default_branch || "",
      analysis_error: submission.analysis_error || "",
      total_commits: Number(submission.total_commits || 0),
      total_commits_before_t0: Number(submission.total_commits_before_t0 || 0),
      total_commits_during_event: Number(submission.total_commits_during_event || 0),
      total_commits_after_t1: Number(submission.total_commits_after_t1 || 0),
      total_loc_added: Number(submission.total_loc_added || 0),
      total_loc_deleted: Number(submission.total_loc_deleted || 0),
      has_commits_before_t0: Number(submission.has_commits_before_t0 || 0),
      has_bulk_commits: Number(submission.has_bulk_commits || 0),
      has_large_initial_commit_after_t0: Number(submission.has_large_initial_commit_after_t0 || 0),
      has_merge_commits: Number(submission.has_merge_commits || 0),
    });
  }

  return Array.from(byRepo.values());
}

function sortRows(rows) {
  const sortMode = document.getElementById("sort-select").value;
  return [...rows].sort((a, b) => {
    if (sortMode === "judge") {
      const scoreA = Number((getJudgeInfoForRow(a)?.averages?.grand_total) ?? getJudgeInfoForRow(a)?.average_score ?? -Infinity);
      const scoreB = Number((getJudgeInfoForRow(b)?.averages?.grand_total) ?? getJudgeInfoForRow(b)?.average_score ?? -Infinity);
      return scoreB - scoreA;
    }
    if (sortMode === "commits") {
      return Number(b.total_commits || 0) - Number(a.total_commits || 0);
    }
    return 0;
  });
}

function filterRows(rows) {
  return rows.filter((row) => {
    if (document.getElementById("filter-preT0").checked && Number(row.has_commits_before_t0) === 0) return false;
    if (document.getElementById("filter-bulk").checked && Number(row.has_bulk_commits) === 0) return false;
    if (document.getElementById("filter-merge").checked && Number(row.has_merge_commits) === 0) return false;
    return true;
  });
}

function repoLinks(row, submission) {
  const links = [];
  const repoUrl = row.repo || submission?.repo_url;
  if (repoUrl) links.push(`<a class="repo-link" href="${escapeAttr(repoUrl)}" target="_blank" rel="noreferrer">Repo</a>`);
  if (submission?.demo_url) links.push(`<a class="repo-link" href="${escapeAttr(submission.demo_url)}" target="_blank" rel="noreferrer">Demo</a>`);
  return links.join("");
}

async function renderSummaryTable(rows) {
  const tbody = document.querySelector("#summary-table tbody");
  tbody.innerHTML = "";

  const filteredRows = sortRows(filterRows(rows));
  updateStats(rows);

  if (filteredRows.length === 0) {
    tbody.innerHTML = `<tr><td colspan="13"><div class="empty-state">No submissions match the current filters.</div></td></tr>`;
    return;
  }

  for (const row of filteredRows) {
    const submission = getSubmissionInfoForRow(row);
    const judgeInfo = getJudgeInfoForRow(row);
    const repoId = row.repo_id || row.submission_id;
    const displayName = submission?.project_name || row.project_name || repoId;
    const teamName = submission?.team_name || row.team_name || "";
    const aiText = submission?.ai_text || row.ai_text || "";

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>
        <div class="repo-cell">
          <span class="repo-name">${escapeHtml(displayName)}</span>
          ${teamName ? `<span class="repo-meta">Team ${escapeHtml(teamName)}</span>` : ""}
          <span class="repo-url">${escapeHtml(row.repo || submission?.repo_url || "")}</span>
          <div class="repo-actions">${repoLinks(row, submission)}</div>
        </div>
      </td>
      <td>${trackChip(submission?.chosen_track || row.chosen_track || "")}</td>
      <td style="text-align:center">${statusChip(row)}</td>
      <td style="text-align:center">${renderJudgeCell(judgeInfo)}</td>
      <td><span class="num-cell">${row.total_commits || 0}</span></td>
      <td><span class="num-cell">${formatNumber(row.total_loc_added || 0)}</span></td>
      <td><span class="num-cell">${formatNumber(row.total_loc_deleted || 0)}</span></td>
      <td style="text-align:center">${flagChip(row.has_commits_before_t0)}</td>
      <td style="text-align:center">${flagChip(row.has_bulk_commits)}</td>
      <td style="text-align:center">${flagChip(row.has_large_initial_commit_after_t0)}</td>
      <td style="text-align:center">${flagChip(row.has_merge_commits)}</td>
      <td style="text-align:center">${(submission?.uses_specter || row.uses_specter) ? '<span style="color:#3dffa3;font-weight:bold;">YES</span>' : '<span style="color:#555;">NO</span>'}</td>
      <td>${getAIPreview(aiText)}</td>
    `;
    tr.addEventListener("click", () => openDrawer(repoId));
    tbody.appendChild(tr);
  }
}

function renderSubmissionDetails(row) {
  const submission = getSubmissionInfoForRow(row) || row;
  const container = document.getElementById("submission-output");
  const items = [
    ["Project", submission?.project_name || row?.repo_id || "—"],
    ["Team", submission?.team_name || "—"],
    ["Track", submission?.chosen_track || "—"],
    ["Submitted", submission?.timestamp || "—"],
    ["Repo", submission?.repo_url || row?.repo || "—"],
    ["Demo", submission?.demo_url || "—"],
  ];
  container.innerHTML = `
    <div class="submission-grid">
      ${items.map(([label, value]) => `<div class="submission-item"><div class="submission-label">${escapeHtml(label)}</div><div class="submission-value">${escapeHtml(value)}</div></div>`).join("")}
    </div>
  `;
}

function renderJudgeDetails(info) {
  const container = document.getElementById("judge-output");
  if (!info || !info.responses || info.responses.length === 0) {
    container.innerHTML = '<div class="empty-state">No judge responses yet.</div>';
    return;
  }
  const grandAvg = Number((info.averages?.grand_total) ?? info.average_score ?? 0).toFixed(1);
  const coreAvg = Number((info.averages?.core_total) ?? info.average_score ?? 0).toFixed(1);
  const bonusAvg = Number((info.averages?.bonus_total) ?? 0).toFixed(1);
  const criteria = info.legacy_mode ? "" : Object.entries(info.averages.core_scores || {}).map(([key, value]) =>
    `<div class="judge-row"><div class="judge-score-pill">${escapeHtml(humanizeKey(key))}</div><div class="judge-thought">${Number(value).toFixed(1)} avg</div></div>`
  ).join("");
  const bonus = info.legacy_mode ? "" : Object.entries(info.averages.bonus_bucket_scores || {}).map(([key, value]) =>
    `<div class="judge-row"><div class="judge-score-pill">${escapeHtml(humanizeKey(key))}</div><div class="judge-thought">${Number(value).toFixed(1)} avg</div></div>`
  ).join("");
  const responses = info.responses.map((response, index) => {
    const scoreLine = info.legacy_mode
      ? `#${index + 1} • ${response.total_score}`
      : `#${index + 1} • ${response.total_score}/10 (core ${response.core_total}, bonus ${response.bonus_total_capped})`;
    return `<div class="judge-row"><div class="judge-score-pill">${scoreLine}</div>${response.notes ? `<div class="judge-thought">${escapeHtml(response.notes)}</div>` : ""}</div>`;
  }).join("");

  container.innerHTML = `
    <div class="judge-summary">
      <div class="judge-score-pill highlight">${grandAvg}${info.legacy_mode ? "" : "/10"}</div>
      <div class="judge-score-pill">Core ${coreAvg}/7</div>
      <div class="judge-score-pill">Bonus ${bonusAvg}/3</div>
    </div>
    ${criteria ? `<div class="judge-list">${criteria}</div>` : ""}
    ${bonus ? `<div class="judge-list">${bonus}</div>` : ""}
    <div class="judge-list">${responses}</div>
  `;
}

function renderJSON(targetId, payload, emptyMessage) {
  document.getElementById(targetId).textContent = payload ? JSON.stringify(payload, null, 2) : emptyMessage;
}

function renderCommits(rows) {
  const tbody = document.querySelector("#commits-table tbody");
  document.querySelector(".commit-count").textContent = `(${rows.length})`;
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="9"><div class="empty-state">No commit data yet.</div></td></tr>`;
    return;
  }
  tbody.innerHTML = rows.slice(0, 100).map((row) => `
    <tr>
      <td>${escapeHtml(row.seq_index)}</td>
      <td>${escapeHtml(row.author_time_iso)}</td>
      <td>${escapeHtml(row.insertions)}</td>
      <td>${escapeHtml(row.deletions)}</td>
      <td>${escapeHtml(row.files_changed)}</td>
      <td style="text-align:center">${flagChip(row.flag_bulk_commit)}</td>
      <td style="text-align:center">${flagChip(row.is_before_t0)}</td>
      <td style="text-align:center">${flagChip(row.is_after_t1)}</td>
      <td title="${escapeAttr(row.subject)}">${escapeHtml(row.subject)}</td>
    </tr>
  `).join("");
}

async function openDrawer(repoId) {
  const rows = window.__summaryRows || [];
  const row = rows.find((item) => (item.repo_id || item.submission_id) === repoId);
  const submission = getSubmissionInfoForRow(row);
  document.getElementById("detail-title").textContent = repoId;
  document.getElementById("details-drawer").classList.remove("hidden");
  document.getElementById("drawer-overlay").classList.remove("hidden");

  renderSubmissionDetails(row);
  renderJudgeDetails(getJudgeInfoForRow(row));

  const [metrics, commits, aiText, liveAnalysis] = await Promise.all([
    fetchJSONMaybe(`${DATA_BASE}/metrics/${repoId}.json`),
    fetchJSONMaybe(`${DATA_BASE}/commits/${repoId}.json`),
    fetchTextMaybe(`${DATA_BASE}/ai/${repoId}.txt`),
    fetchJSONMaybe(`/api/analysis?repo_url=${encodeURIComponent(row?.repo || row?.repo_url || "")}`),
  ]);

  const liveMetrics = liveAnalysis?.analysis || null;
  renderJSON("metrics-summary", metrics?.summary || liveMetrics?.summary, "Analysis not generated yet.");
  renderJSON("metrics-flags", metrics?.flags || liveMetrics?.flags, "Run the analyzer to populate flags.");
  renderJSON("metrics-time", metrics?.time_distribution || liveMetrics?.time_distribution, "Run the analyzer to populate time distribution.");
  document.getElementById("ai-output").textContent =
    submission?.ai_text ||
    row?.ai_text ||
    aiText ||
    liveMetrics?.ai_text ||
    row?.ai_error ||
    liveMetrics?.ai_error ||
    "No AI analysis yet.";
  renderCommits(commits?.rows || liveMetrics?.commits || []);
}

function closeDrawer() {
  document.getElementById("details-drawer").classList.add("hidden");
  document.getElementById("drawer-overlay").classList.add("hidden");
}

async function loadPage() {
  await Promise.all([loadJudgeData(), loadSubmissionData(), loadAnalysisSettings()]);
  const summary = await fetchJSONMaybe(`${DATA_BASE}/summary.json`);
  const rows = mergeRows(summary?.rows || [], [...submissionMap.values()]);
  window.__summaryRows = rows;
  await renderSummaryTable(rows);
}

async function saveAnalysisSettings(event) {
  event.preventDefault();
  setSettingsStatus("Saving analysis settings...");

  const body = {
    event_t0: localInputValueToIso(document.getElementById("settings-event-t0").value),
    event_t1: localInputValueToIso(document.getElementById("settings-event-t1").value),
    bulk_insertion_threshold: Number.parseInt(document.getElementById("settings-bulk-insertions").value || "0", 10),
    bulk_files_threshold: Number.parseInt(document.getElementById("settings-bulk-files").value || "0", 10),
    max_commits_to_analyze: Number.parseInt(document.getElementById("settings-max-commits").value || "0", 10),
  };

  const response = await fetch("/api/settings", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  if (!response.ok) {
    setSettingsStatus(payload.error || "Failed to save settings.", "error");
    return;
  }

  analysisSettings = payload.settings;
  setSettingsStatus("Analysis settings saved. New submissions will use these values.", "success");
}

async function reanalyzeTrackedSubmissions() {
  setSettingsStatus("Reanalyzing tracked submissions...");
  const response = await fetch("/api/reanalyze", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
  });
  const payload = await response.json();
  if (!response.ok) {
    setSettingsStatus(payload.error || "Failed to reanalyze tracked submissions.", "error");
    return;
  }

  setSettingsStatus(`Reanalyzed ${payload.analyzed} submission(s).${payload.failed ? ` ${payload.failed} failed.` : ""}`, payload.failed ? "error" : "success");
  await loadPage();
}

function initPage() {
  ["filter-preT0", "filter-bulk", "filter-merge", "sort-select"].forEach((id) => {
    document.getElementById(id).addEventListener("change", () => renderSummaryTable(window.__summaryRows || []));
  });
  document.getElementById("close-drawer").addEventListener("click", closeDrawer);
  document.getElementById("drawer-overlay").addEventListener("click", closeDrawer);
  document.getElementById("analysis-settings-form").addEventListener("submit", saveAnalysisSettings);
  document.getElementById("reanalyze-submissions").addEventListener("click", reanalyzeTrackedSubmissions);
  loadPage().catch((error) => {
    document.querySelector("#summary-table tbody").innerHTML = `<tr><td colspan="13"><div class="empty-state">Failed to load admin data: ${escapeHtml(error.message)}</div></td></tr>`;
  });
}

function openDemosModal() {
  const modal = document.getElementById("demos-modal");
  const list = document.getElementById("demos-list");
  const subs = [...submissionMap.values()];

  list.innerHTML = subs.map((s) => {
    const repoKey = normalizeRepoKey(s.repo_url || "");
    const judgeInfo = judgeMap.get(repoKey);
    const avg = judgeInfo && judgeInfo.averages ? Number(judgeInfo.averages.grand_total || 0).toFixed(1) : "-";
    const judgeCount = judgeInfo ? judgeInfo.responses.length : 0;
    const judgeNames = judgeInfo ? judgeInfo.responses.map(r => escapeHtml(r.judge_name || "?")).join(", ") : "";
    const demoUrl = s.demo_url || "";

    return `<div style="border:2px solid #282828;padding:12px;display:flex;align-items:center;gap:14px;flex-wrap:wrap;">
      <div style="flex:1;min-width:180px;">
        <div style="color:#3dffa3;font-size:0.55rem;font-family:'Press Start 2P',monospace;margin-bottom:4px;">${escapeHtml(s.project_name || "Untitled")}</div>
        <div style="color:#888;font-size:0.85rem;">Team ${escapeHtml(s.team_name || "?")}</div>
        ${s.description ? `<div style="color:#aaa;font-size:0.8rem;font-style:italic;margin-top:2px;">${escapeHtml(s.description)}</div>` : ""}
      </div>
      <div style="flex:0 0 auto;">
        ${demoUrl ? `<a href="${escapeHtml(demoUrl)}" target="_blank" rel="noreferrer" style="color:#3dffa3;border:1px solid #3dffa3;padding:4px 10px;text-decoration:none;font-size:0.8rem;font-family:'VT323',monospace;">DEMO &rarr;</a>` : '<span style="color:#555;font-size:0.8rem;">No demo</span>'}
      </div>
      <div style="flex:0 0 auto;text-align:center;min-width:100px;">
        <div style="color:#f1c40f;font-size:1.1rem;font-family:'VT323',monospace;">${avg}/10</div>
        <div style="color:#666;font-size:0.75rem;">${judgeCount} judge${judgeCount !== 1 ? "s" : ""}</div>
        ${judgeNames ? `<div style="color:#555;font-size:0.65rem;margin-top:2px;">${judgeNames}</div>` : ""}
      </div>
      <div style="flex:0 0 auto;display:flex;align-items:center;gap:6px;">
        <input type="number" min="0" max="10" placeholder="0-10" data-repo-key="${escapeHtml(repoKey)}" class="demo-score-input" style="width:65px;padding:4px 6px;background:#0b0b0b;border:1px solid #444;color:#f1c40f;font-family:'VT323',monospace;font-size:1rem;text-align:center;">
        <button onclick="submitDemoScore(this)" data-repo-key="${escapeHtml(repoKey)}" data-project-name="${escapeHtml(s.project_name || '')}" data-chosen-track="${escapeHtml(s.chosen_track || '')}" data-repo-url="${escapeHtml(s.repo_url || '')}" style="background:#3dffa3;color:#0b0b0b;border:none;padding:4px 10px;cursor:pointer;font-family:'VT323',monospace;font-size:0.9rem;">GO</button>
      </div>
    </div>`;
  }).join("");

  modal.style.display = "flex";
}

async function submitDemoScore(btn) {
  const repoUrl = btn.dataset.repoUrl;
  const projectName = btn.dataset.projectName;
  const chosenTrack = btn.dataset.chosenTrack;
  const input = btn.parentElement.querySelector(".demo-score-input");
  const score = parseInt(input.value, 10);
  if (isNaN(score) || score < 0 || score > 10) {
    input.style.borderColor = "#ff4444";
    return;
  }
  const judgeName = prompt("Your judge name:");
  if (!judgeName || !judgeName.trim()) return;

  btn.textContent = "...";
  try {
    const coreTotal = Math.min(score, 7);
    const bonusRaw = Math.max(0, score - 7);
    const bonus_bucket_scores = {};
    ["best_use_cursor", "best_use_specter", "best_use_llm_models"].forEach((key, index) => {
      bonus_bucket_scores[key] = index < bonusRaw ? 1 : 0;
    });
    const res = await fetch("/api/judges", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        judge_name: judgeName.trim(),
        repo_url: repoUrl,
        project_name: projectName,
        chosen_track: chosenTrack,
        scored_track: chosenTrack,
        core_total: coreTotal,
        notes: "Scored via demos panel",
        bonus_bucket_scores,
      }),
    });
    if (!res.ok) throw new Error("Failed");
    btn.textContent = "OK";
    btn.style.background = "#f1c40f";
    input.value = "";
    // Reload judge data to update display
    await loadJudgeData();
    openDemosModal();
  } catch (e) {
    btn.textContent = "ERR";
    btn.style.background = "#ff4444";
  }
}

function closeDemosModal() {
  document.getElementById("demos-modal").style.display = "none";
}

function initDemosModal() {
  const openBtn = document.getElementById("open-demos-modal");
  const closeBtn = document.getElementById("close-demos-modal");
  const modal = document.getElementById("demos-modal");
  if (openBtn) openBtn.addEventListener("click", openDemosModal);
  if (closeBtn) closeBtn.addEventListener("click", closeDemosModal);
  if (modal) modal.addEventListener("click", (e) => { if (e.target === modal) closeDemosModal(); });
}

function initPageAndDemos() {
  initPage();
  initDemosModal();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initPageAndDemos);
} else {
  initPageAndDemos();
}
