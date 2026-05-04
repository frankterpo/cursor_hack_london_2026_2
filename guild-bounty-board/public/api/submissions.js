const {
  parseRequestBody,
  sendJson,
  normalizeRepoUrl,
} = require("./_lib/storage");
const {
  analyzeGitHubRepo,
  buildRepoId,
} = require("./_lib/github-analysis");
const {
  generateAiSummary,
} = require("./_lib/ai-analysis");
const { verifyAuth } = require("./_lib/auth");
const { getSubmissions, upsertSubmission, upsertAnalysis } = require("./_lib/db");

const TEMPLATE_REPO_KEY = "https://github.com/example/example-project";

function normalizeSubmission(input) {
  const repoUrl = String(input.repo_url || input["Github URL"] || input["GitHub URL"] || "").trim();
  const repoKey = normalizeRepoUrl(repoUrl);
  let repoId = "";
  if (repoKey) {
    try {
      repoId = buildRepoId(repoUrl);
    } catch (_error) {
      repoId = repoKey.replace(/^https?:\/\//, "").replace(/[^a-zA-Z0-9._-]/g, "-");
    }
  }
  return {
    repo_url: repoUrl,
    repo_key: repoKey,
    repo_id: repoId,
    team_name: String(input.team_name || input["Team Name"] || "").trim(),
    project_name: String(input.project_name || input["Project Name"] || "").trim(),
    chosen_track: String(input.chosen_track || input["Chosen Track"] || "").trim(),
    demo_url: String(input.demo_url || input["Demo URL"] || "").trim(),
    description: String(input.description || "").trim(),
    team_members: String(input.team_members || input["Team Members"] || "").trim(),
    notes: String(input.notes || input["Notes"] || "").trim(),
    timestamp: new Date().toISOString(),
  };
}

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") {
    return sendJson(res, 200, { ok: true });
  }

  try {
    if (req.method === "GET") {
      const auth = verifyAuth(req);
      if (!auth.valid) {
        return sendJson(res, 401, { error: "Unauthorized" });
      }
      const submissions = await getSubmissions();
      return sendJson(res, 200, { submissions });
    }

    if (req.method !== "POST") {
      return sendJson(res, 405, { error: "Method not allowed" });
    }

    const body = parseRequestBody(req);
    const submission = normalizeSubmission(body || {});
    if (!submission.repo_url || !submission.repo_key) {
      return sendJson(res, 400, { error: "Missing Github URL" });
    }
    if (submission.repo_key === TEMPLATE_REPO_KEY) {
      return sendJson(res, 400, { error: "Please replace the example/template repository URL with your real project repository." });
    }
    if (!submission.demo_url) {
      return sendJson(res, 400, {
        error: "Demo URL is required — paste a YouTube/Loom/recording link.",
      });
    }
    try {
      const u = new URL(submission.demo_url);
      if (!/^https?:$/.test(u.protocol)) {
        return sendJson(res, 400, {
          error: "Demo URL must be a full https:// link.",
        });
      }
    } catch (_e) {
      return sendJson(res, 400, {
        error: "Demo URL must be a valid URL (e.g. https://youtu.be/xxxx).",
      });
    }

    let nextSubmission = {
      ...submission,
      analysis_status: "pending",
      analyzed_at: null,
      analysis_error: "",
      ai_text: "",
      ai_model: "",
      ai_generated_at: null,
      ai_error: "",
      total_commits: 0,
      total_commits_before_t0: 0,
      total_commits_during_event: 0,
      total_commits_after_t1: 0,
      total_loc_added: 0,
      total_loc_deleted: 0,
      has_commits_before_t0: 0,
      has_bulk_commits: 0,
      has_large_initial_commit_after_t0: 0,
      has_merge_commits: 0,
      default_branch: "",
    };

    try {
      const analysis = await analyzeGitHubRepo(submission.repo_url);
      try {
        const aiSummary = await generateAiSummary({
          repoUrl: submission.repo_url,
          track: submission.chosen_track,
          metrics: analysis,
          repoMetadata: analysis.repo_metadata,
        });
        analysis.ai_text = aiSummary.text;
        analysis.ai_model = aiSummary.model;
        analysis.ai_generated_at = aiSummary.generated_at;
      } catch (aiError) {
        analysis.ai_text = "";
        analysis.ai_error = aiError.message || "AI analysis failed";
      }

      const summaryRow = analysis.summary_row || {};
      nextSubmission = {
        ...nextSubmission,
        repo_id: analysis.repo_id || nextSubmission.repo_id,
        analysis_status: "analyzed",
        analyzed_at: analysis.generated_at,
        analysis_error: "",
        default_branch: analysis.default_branch || "",
        uses_specter: analysis.uses_specter === true,
        ai_text: analysis.ai_text || "",
        ai_model: analysis.ai_model || "",
        ai_generated_at: analysis.ai_generated_at || null,
        ai_error: analysis.ai_error || "",
        _analysisData: analysis,
        total_commits: summaryRow.total_commits || 0,
        total_commits_before_t0: summaryRow.total_commits_before_t0 || 0,
        total_commits_during_event: summaryRow.total_commits_during_event || 0,
        total_commits_after_t1: summaryRow.total_commits_after_t1 || 0,
        total_loc_added: summaryRow.total_loc_added || 0,
        total_loc_deleted: summaryRow.total_loc_deleted || 0,
        has_commits_before_t0: summaryRow.has_commits_before_t0 || 0,
        has_bulk_commits: summaryRow.has_bulk_commits || 0,
        has_large_initial_commit_after_t0: summaryRow.has_large_initial_commit_after_t0 || 0,
        has_merge_commits: summaryRow.has_merge_commits || 0,
      };
    } catch (analysisError) {
      nextSubmission = {
        ...nextSubmission,
        analysis_status: "analysis_failed",
        analysis_error: analysisError.message || "GitHub analysis failed",
      };
    }

    const saved = await upsertSubmission(nextSubmission);
    // Save analysis after submission exists (FK constraint)
    if (nextSubmission._analysisData) {
      try { await upsertAnalysis(submission.repo_key, nextSubmission._analysisData); } catch (_) {}
    }
    const submissions = await getSubmissions();
    return sendJson(res, 200, { ok: true, submission: saved, submissions });
  } catch (error) {
    return sendJson(res, 500, { error: error.message || "Unknown error" });
  }
};
