const { sendJson, normalizeRepoUrl } = require("./_lib/storage");
const { getAnalysisSettings } = require("./_lib/analysis-settings");
const { analyzeGitHubRepo } = require("./_lib/github-analysis");
const { generateAiSummary } = require("./_lib/ai-analysis");
const { verifyAuth } = require("./_lib/auth");
const { getSubmissions, upsertSubmission, upsertAnalysis } = require("./_lib/db");

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") {
    return sendJson(res, 200, { ok: true });
  }

  const auth = verifyAuth(req);
  if (!auth.valid) {
    return sendJson(res, 401, { error: "Unauthorized" });
  }

  if (req.method !== "POST") {
    return sendJson(res, 405, { error: "Method not allowed" });
  }

  try {
    const settings = await getAnalysisSettings();
    const submissions = await getSubmissions();
    const results = [];

    for (const submission of submissions) {
      try {
        const analysis = await analyzeGitHubRepo(submission.repo_url, settings);
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

        const repoKey = normalizeRepoUrl(submission.repo_url);
        await upsertAnalysis(repoKey, analysis);

        const summaryRow = analysis.summary_row || {};
        await upsertSubmission({
          ...submission,
          repo_id: analysis.repo_id || submission.repo_id,
          analysis_status: "analyzed",
          analyzed_at: analysis.generated_at,
          analysis_error: "",
          ai_text: analysis.ai_text || "",
          ai_model: analysis.ai_model || "",
          ai_generated_at: analysis.ai_generated_at || null,
          ai_error: analysis.ai_error || "",
          default_branch: analysis.default_branch || "",
          uses_specter: analysis.uses_specter === true,
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
        });

        results.push({ repo_url: submission.repo_url, ok: true });
      } catch (error) {
        await upsertSubmission({
          ...submission,
          analysis_status: "analysis_failed",
          analysis_error: error.message || "GitHub analysis failed",
        });
        results.push({ repo_url: submission.repo_url, ok: false, error: error.message || "GitHub analysis failed" });
      }
    }

    return sendJson(res, 200, {
      ok: true,
      results,
      analyzed: results.filter((item) => item.ok).length,
      failed: results.filter((item) => !item.ok).length,
      settings,
    });
  } catch (error) {
    return sendJson(res, 500, { error: error.message || "Unknown error" });
  }
};
