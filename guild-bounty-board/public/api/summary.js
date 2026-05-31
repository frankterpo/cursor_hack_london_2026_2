const { sendJson } = require("./_lib/storage");
const { verifyAuth } = require("./_lib/auth");
const { getSubmissions } = require("./_lib/db");
const { buildRepoId } = require("./_lib/github-analysis");

function metricsFromSubmission(sub) {
  const gh = sub?.github && typeof sub.github === "object" ? sub.github : null;
  const num = (key, fallback = 0) => {
    if (sub && sub[key] != null && sub[key] !== "") {
      const n = Number(sub[key]);
      return Number.isFinite(n) ? n : fallback;
    }
    if (gh && gh[key] != null && gh[key] !== "") {
      const n = Number(gh[key]);
      return Number.isFinite(n) ? n : fallback;
    }
    return fallback;
  };
  const text = (key, fallback = "") => {
    const v = sub?.[key] ?? gh?.[key];
    return v == null ? fallback : String(v);
  };
  return {
    total_commits: num("total_commits"),
    total_commits_before_t0: num("total_commits_before_t0"),
    total_commits_during_event: num("total_commits_during_event"),
    total_commits_after_t1: num("total_commits_after_t1"),
    total_loc_added: num("total_loc_added"),
    total_loc_deleted: num("total_loc_deleted"),
    has_commits_before_t0: num("has_commits_before_t0"),
    has_bulk_commits: num("has_bulk_commits"),
    has_large_initial_commit_after_t0: num("has_large_initial_commit_after_t0"),
    has_merge_commits: num("has_merge_commits"),
    default_branch: text("default_branch"),
    analysis_status: text("analysis_status", "pending"),
    analysis_error: text("analysis_error"),
  };
}

function submissionToSummaryRow(sub) {
  const repoUrl = String(sub.repo_url || "").trim();
  let repoId = String(sub.repo_id || "").trim();
  if (!repoId && repoUrl) {
    try {
      repoId = buildRepoId(repoUrl);
    } catch (_error) {
      repoId = repoUrl.replace(/^https?:\/\//, "").replace(/[^a-zA-Z0-9._-]/g, "-");
    }
  }
  return {
    repo_id: repoId,
    repo: repoUrl,
    repo_url: repoUrl,
    submission_id: sub.id || sub.submission_id || "",
    project_name: sub.project_name || "",
    team_name: sub.team_name || "",
    chosen_track: sub.chosen_track || "",
    demo_url: sub.demo_url || "",
    submission_status: "submitted",
    ...metricsFromSubmission(sub),
  };
}

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") {
    return sendJson(res, 200, { ok: true });
  }

  const auth = verifyAuth(req);
  if (!auth.valid) {
    return sendJson(res, 401, { error: "Unauthorized" });
  }

  if (req.method !== "GET") {
    return sendJson(res, 405, { error: "Method not allowed" });
  }

  try {
    const submissions = await getSubmissions();
    const rows = submissions
      .filter((s) => String(s.repo_url || "").trim())
      .map(submissionToSummaryRow);
    return sendJson(res, 200, { rows, source: "supabase" });
  } catch (error) {
    return sendJson(res, 500, { error: error.message || "Unknown error" });
  }
};
