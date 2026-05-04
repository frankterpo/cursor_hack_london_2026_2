let judgeConfig = null;
let submissions = [];
let judgeData = { responses: [], by_repo: {} };
let currentIndex = 0;
let analysisCache = new Map();
/** Set from GET /api/auth after gate; matches HttpOnly cookie. */
let sessionJudgeName = "";

async function fetchJson(url) {
  const response = await fetch(url, { cache: "no-store", credentials: "same-origin" });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || `Failed to fetch ${url}: ${response.status}`);
  }
  return payload;
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text ?? "";
  return div.innerHTML;
}

function normalizeRepoKey(repoUrl = "") {
  return String(repoUrl).trim().replace(/\.git$/i, "").toLowerCase();
}

function getCurrentSubmission() {
  return submissions[currentIndex] || null;
}

function getJudgeName() {
  return String(sessionJudgeName || "").trim();
}

function getOwnResponse(submission) {
  const judgeName = getJudgeName().toLowerCase();
  if (!judgeName || !submission) return null;
  const repoKey = normalizeRepoKey(submission.repo_url);
  return (judgeData.responses || []).find((response) => (
    normalizeRepoKey(response.repo_url || response.repo_key) === repoKey &&
    String(response.judge_name || "").trim().toLowerCase() === judgeName
  )) || null;
}

function getRepoJudgeInfo(submission) {
  if (!submission) return null;
  return judgeData.by_repo?.[normalizeRepoKey(submission.repo_url)] || null;
}

function numberValue(selector) {
  return Array.from(document.querySelectorAll(selector)).reduce((sum, input) => {
    const value = Number.parseInt(input.value || "0", 10);
    return sum + (Number.isNaN(value) ? 0 : value);
  }, 0);
}

function collectScores(selector) {
  const payload = {};
  document.querySelectorAll(selector).forEach((input) => {
    payload[input.dataset.id] = Number.parseInt(input.value || "0", 10) || 0;
  });
  return payload;
}

function setFieldValues(selector, scores) {
  document.querySelectorAll(selector).forEach((input) => {
    input.value = scores?.[input.dataset.id] ?? 0;
  });
}

function renderRubric() {
  const target = document.getElementById("rubric-summary");
  const criteria = judgeConfig.rubric.criteria || [];
  const bonuses = judgeConfig.side_quests || [];
  target.innerHTML = `
    <div class="rubric-total">Total = 10 points</div>
    <div class="rubric-group">
      <div class="rubric-heading">Core: 7 pts</div>
      ${criteria.map((criterion) => `
        <div class="rubric-line">
          <strong>${escapeHtml(criterion.points)} · ${escapeHtml(criterion.name)}</strong>
          <span>${escapeHtml(criterion.description || "")}</span>
        </div>
      `).join("")}
    </div>
    <div class="rubric-group">
      <div class="rubric-heading">Bonus: 3 pts</div>
      ${bonuses.map((quest) => `
        <div class="rubric-line">
          <strong>${escapeHtml(quest.points)} · ${escapeHtml(quest.name)}</strong>
          <span>${escapeHtml(quest.blurb || "")}</span>
        </div>
      `).join("")}
    </div>
  `;
}

function renderScoreFields() {
  document.getElementById("core-fields").innerHTML = judgeConfig.rubric.criteria.map((criterion) => `
    <label class="score-item">
      <span>${escapeHtml(criterion.name)}</span>
      <small>0-${escapeHtml(criterion.points)}</small>
      <input class="score-input core-score" type="number" min="0" max="${escapeHtml(criterion.points)}" value="0" data-id="${escapeHtml(criterion.id)}">
    </label>
  `).join("");

  document.getElementById("bonus-fields").innerHTML = judgeConfig.side_quests.map((quest) => `
    <label class="score-item">
      <span>${escapeHtml(quest.name)}</span>
      <small>0-${escapeHtml(quest.points)}</small>
      <input class="score-input bonus-score" type="number" min="0" max="${escapeHtml(quest.points)}" value="0" data-id="${escapeHtml(quest.id)}">
    </label>
  `).join("");
}

function getValidationState() {
  const coreRaw = numberValue(".core-score");
  const bonusRaw = numberValue(".bonus-score");
  return {
    coreRaw,
    bonusRaw,
    coreValid: coreRaw <= judgeConfig.rubric.core_max_points,
    bonusValid: bonusRaw <= judgeConfig.judge_bonus_bucket.max_points,
    total: coreRaw + Math.min(bonusRaw, judgeConfig.judge_bonus_bucket.max_points),
  };
}

function updateTotals() {
  const { coreRaw, bonusRaw, coreValid, bonusValid, total } = getValidationState();
  const totalEl = document.getElementById("totals-output");
  totalEl.textContent = `Core ${coreRaw}/7 · Bonus ${bonusRaw}/3 · Total ${total}/10`;
  totalEl.classList.toggle("totals-output--error", !coreValid || !bonusValid || total > 10);
}

function setSubmitStatus(message, isError = false) {
  const status = document.getElementById("submit-status");
  status.textContent = message;
  status.classList.toggle("status-text--error", isError);
  status.classList.toggle("status-text--success", !isError && Boolean(message));
}

function toEmbedUrl(url) {
  const value = String(url || "").trim();
  if (!value) return "";
  try {
    const parsed = new URL(value);
    if (parsed.hostname.includes("youtube.com")) {
      const id = parsed.searchParams.get("v");
      return id ? `https://www.youtube.com/embed/${id}` : value;
    }
    if (parsed.hostname === "youtu.be") {
      return `https://www.youtube.com/embed/${parsed.pathname.slice(1)}`;
    }
    if (parsed.hostname.includes("vimeo.com")) {
      const id = parsed.pathname.split("/").filter(Boolean).pop();
      return id ? `https://player.vimeo.com/video/${id}` : value;
    }
    if (parsed.hostname.includes("loom.com") && parsed.pathname.includes("/share/")) {
      return value.replace("/share/", "/embed/");
    }
    return value;
  } catch (_) {
    return value;
  }
}

function renderDemo(submission) {
  const target = document.getElementById("demo-panel");
  const demoUrl = submission?.demo_url || "";
  if (!submission) {
    target.innerHTML = '<div class="empty-demo">No submissions yet.</div>';
    return;
  }
  if (!demoUrl) {
    target.innerHTML = '<div class="empty-demo">No demo URL submitted.</div>';
    return;
  }
  const embedUrl = toEmbedUrl(demoUrl);
  target.innerHTML = `
    <iframe class="demo-frame" src="${escapeHtml(embedUrl)}" title="${escapeHtml(submission.project_name || "Demo video")}" allow="fullscreen; autoplay; encrypted-media; picture-in-picture" loading="lazy"></iframe>
    <div class="demo-actions">
      <a class="repo-link" href="${escapeHtml(demoUrl)}" target="_blank" rel="noreferrer">Open demo in new tab</a>
      ${submission.repo_url ? `<a class="repo-link" href="${escapeHtml(submission.repo_url)}" target="_blank" rel="noreferrer">Open repo</a>` : ""}
    </div>
  `;
}

function responseScoreLine(response) {
  return `${escapeHtml(response.judge_name || "?")} · ${Number(response.total_score || 0)}/10 (core ${Number(response.core_total || 0)}, bonus ${Number(response.bonus_total_capped || 0)})`;
}

async function loadAnalysisFor(submission) {
  if (!submission?.repo_url) return null;
  const key = normalizeRepoKey(submission.repo_url);
  if (analysisCache.has(key)) return analysisCache.get(key);
  const payload = await fetchJson(`/api/analysis?repo_url=${encodeURIComponent(submission.repo_url)}`).catch(() => null);
  const analysis = payload?.analysis || null;
  analysisCache.set(key, analysis);
  return analysis;
}

async function renderDetails(submission) {
  const target = document.getElementById("detail-panel");
  if (!submission) {
    target.innerHTML = '<div class="empty-demo">No submission selected.</div>';
    return;
  }
  target.innerHTML = '<div class="empty-demo">Loading details...</div>';
  const analysis = await loadAnalysisFor(submission);
  const judgeInfo = getRepoJudgeInfo(submission);
  const responses = judgeInfo?.responses || [];
  const summary = analysis?.summary || analysis?.summary_row || {};
  const flags = analysis?.flags || {
    pre_t0: submission.has_commits_before_t0,
    bulk: submission.has_bulk_commits,
    large_initial: submission.has_large_initial_commit_after_t0,
    merge: submission.has_merge_commits,
  };
  const time = analysis?.time_distribution || {};
  const commits = analysis?.commits || [];
  const aiText = submission.ai_text || analysis?.ai_text || submission.ai_error || analysis?.ai_error || "";

  target.innerHTML = `
    <div class="detail-grid">
      <div class="detail-box">
        <h4>Project</h4>
        <p><strong>${escapeHtml(submission.project_name || "Untitled")}</strong></p>
        <p>Team: ${escapeHtml(submission.team_name || "Unknown")}</p>
        <p>Track: ${escapeHtml(submission.chosen_track || "Unassigned")}</p>
        <p>${escapeHtml(submission.description || "")}</p>
      </div>
      <div class="detail-box">
        <h4>Other Judge Scores</h4>
        ${responses.length ? responses.map((response) => `<p>${responseScoreLine(response)}</p>`).join("") : "<p>No judge scores yet.</p>"}
      </div>
      <div class="detail-box detail-box--wide">
        <h4>Analysis</h4>
        <p>${escapeHtml(aiText || "No AI analysis yet.")}</p>
      </div>
      <div class="detail-box">
        <h4>Metric Summary</h4>
        <pre>${escapeHtml(JSON.stringify(summary, null, 2) || "{}")}</pre>
      </div>
      <div class="detail-box">
        <h4>Metric Flags</h4>
        <pre>${escapeHtml(JSON.stringify(flags, null, 2) || "{}")}</pre>
      </div>
      <div class="detail-box">
        <h4>Metric Time</h4>
        <pre>${escapeHtml(JSON.stringify(time, null, 2) || "{}")}</pre>
      </div>
      <div class="detail-box detail-box--wide">
        <h4>Commits</h4>
        ${commits.length ? commits.slice(0, 20).map((commit) => `<p>${escapeHtml(commit.author_time_iso || commit.date || "")} · ${escapeHtml(commit.subject || commit.message || "")}</p>`).join("") : "<p>No commit rows available.</p>"}
      </div>
    </div>
  `;
}

function renderSubmission() {
  const submission = getCurrentSubmission();
  const card = document.getElementById("submission-card");
  card.classList.remove("submission-card--flipped");
  setSubmitStatus("");

  if (!submission) {
    document.getElementById("submission-position").textContent = "0 / 0";
    document.getElementById("submission-title").textContent = "No submissions yet";
    document.getElementById("submission-meta").textContent = "";
    renderDemo(null);
    renderQueue();
    return;
  }

  document.getElementById("submission-position").textContent = `${currentIndex + 1} / ${submissions.length}`;
  document.getElementById("submission-title").textContent = submission.project_name || "Untitled Project";
  document.getElementById("submission-meta").textContent = `Team ${submission.team_name || "Unknown"} · ${submission.chosen_track || "Track not selected"}`;
  renderDemo(submission);
  setFieldValues(".core-score", getOwnResponse(submission)?.core_scores || {});
  setFieldValues(".bonus-score", getOwnResponse(submission)?.bonus_bucket_scores || {});
  document.getElementById("judge-notes").value = getOwnResponse(submission)?.notes || "";
  updateTotals();
  renderQueue();
}

function renderQueue() {
  const target = document.getElementById("score-queue");
  const judgeName = getJudgeName().toLowerCase();
  const ownScored = new Set((judgeData.responses || [])
    .filter((response) => String(response.judge_name || "").trim().toLowerCase() === judgeName)
    .map((response) => normalizeRepoKey(response.repo_url || response.repo_key)));
  const scoredCount = submissions.filter((submission) => ownScored.has(normalizeRepoKey(submission.repo_url))).length;
  const remainingCount = Math.max(0, submissions.length - scoredCount);
  target.innerHTML = `
    <div class="queue-stats">
      <div><strong>${scoredCount}</strong><span>scored by you</span></div>
      <div><strong>${remainingCount}</strong><span>left</span></div>
    </div>
    <div class="queue-list">
      ${submissions.map((submission, index) => {
        const repoKey = normalizeRepoKey(submission.repo_url);
        const mine = ownScored.has(repoKey);
        const judgeCount = getRepoJudgeInfo(submission)?.judge_count || 0;
        return `<button class="queue-item ${index === currentIndex ? "queue-item--active" : ""} ${mine ? "queue-item--done" : ""}" type="button" data-index="${index}">
          <span>${escapeHtml(submission.project_name || submission.repo_url)}</span>
          <small>${mine ? "You scored" : "Needs you"} · ${judgeCount} total judge${judgeCount === 1 ? "" : "s"}</small>
        </button>`;
      }).join("")}
    </div>
  `;
}

function move(delta) {
  if (!submissions.length) return;
  currentIndex = (currentIndex + delta + submissions.length) % submissions.length;
  renderSubmission();
}

async function submitJudgeScore() {
  const judgeName = getJudgeName();
  const submission = getCurrentSubmission();
  const { coreRaw, bonusRaw, coreValid, bonusValid, total } = getValidationState();
  if (!judgeName) {
    setSubmitStatus("Session expired. Sign in again from the judge portal with your name.", true);
    return;
  }
  if (!submission) {
    setSubmitStatus("No submission selected.", true);
    return;
  }
  if (!coreValid) {
    setSubmitStatus(`Core score cannot exceed 7. Current value: ${coreRaw}.`, true);
    return;
  }
  if (!bonusValid) {
    setSubmitStatus(`Bonus score cannot exceed 3. Current value: ${bonusRaw}.`, true);
    return;
  }
  if (total > judgeConfig.rubric.total_cap) {
    setSubmitStatus(`Total score cannot exceed 10. Current value: ${total}.`, true);
    return;
  }

  setSubmitStatus("Saving...");
  const response = await fetch("/api/judges", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      judge_name: judgeName,
      repo_url: submission.repo_url,
      project_name: submission.project_name,
      chosen_track: submission.chosen_track,
      scored_track: submission.chosen_track,
      core_scores: collectScores(".core-score"),
      notes: document.getElementById("judge-notes").value.trim(),
      bonus_bucket_scores: collectScores(".bonus-score"),
    }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    setSubmitStatus(payload.error || "Failed to save score.", true);
    return;
  }
  judgeData = payload;
  setSubmitStatus("Saved. Moving to next project...");
  renderQueue();
  window.setTimeout(() => move(1), 350);
}

async function loadPage() {
  const authPayload = await fetch("/api/auth", { credentials: "same-origin" }).then((r) => r.json()).catch(() => ({}));
  sessionJudgeName = String(authPayload.judge_name || "").trim();
  const displayEl = document.getElementById("judge-display-name");
  if (displayEl) {
    displayEl.innerHTML = sessionJudgeName
      ? `Judging as <strong>${escapeHtml(sessionJudgeName)}</strong>`
      : "";
  }

  judgeConfig = await fetchJson("/judge-config.json");
  const [submissionsPayload, judgesPayload] = await Promise.all([
    fetchJson("/api/submissions"),
    fetchJson("/api/judges"),
  ]);
  submissions = submissionsPayload.submissions || [];
  judgeData = judgesPayload || { responses: [], by_repo: {} };
  renderRubric();
  renderScoreFields();

  renderSubmission();
  document.addEventListener("input", (event) => {
    if (event.target.classList.contains("score-input")) updateTotals();
  });
  document.getElementById("submit-score").addEventListener("click", submitJudgeScore);
  document.getElementById("prev-submission").addEventListener("click", () => move(-1));
  document.getElementById("next-submission").addEventListener("click", () => move(1));
  document.getElementById("prev-submission-bottom").addEventListener("click", () => move(-1));
  document.getElementById("next-submission-bottom").addEventListener("click", () => move(1));
  document.getElementById("flip-details").addEventListener("click", async () => {
    document.getElementById("submission-card").classList.add("submission-card--flipped");
    await renderDetails(getCurrentSubmission());
  });
  document.getElementById("flip-back").addEventListener("click", () => {
    document.getElementById("submission-card").classList.remove("submission-card--flipped");
  });
  document.getElementById("score-queue").addEventListener("click", (event) => {
    const button = event.target.closest(".queue-item");
    if (!button) return;
    currentIndex = Number.parseInt(button.dataset.index || "0", 10) || 0;
    renderSubmission();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "ArrowLeft") move(-1);
    if (event.key === "ArrowRight") move(1);
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => {
    loadPage().catch((error) => setSubmitStatus(error.message, true));
  });
} else {
  loadPage().catch((error) => setSubmitStatus(error.message, true));
}
