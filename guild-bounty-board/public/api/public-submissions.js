const { sendJson } = require("./_lib/storage");
const { getSubmissions } = require("./_lib/db");

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") {
    return sendJson(res, 200, { ok: true });
  }

  if (req.method !== "GET") {
    return sendJson(res, 405, { error: "Method not allowed" });
  }

  try {
    const submissions = await getSubmissions();
    // Public-safe fields only — no judge scores, no emails.
    // github + ai surfaces are exposed with raw_* blobs stripped.
    const safe = submissions.map((s) => {
      const team = s.team && typeof s.team === "object" ? s.team : null;
      const safeTeam = team
        ? {
            name: team.name || "",
            members: (Array.isArray(team.members) ? team.members : []).map(
              (m) => ({
                full_name: m.full_name || "",
                luma_profile: m.luma_profile || "",
                social_url: m.social_url || "",
              })
            ),
          }
        : null;
      const gh =
        s.github && typeof s.github === "object" ? s.github : null;
      const safeGithub = gh
        ? {
            analysis_status: gh.analysis_status || "",
            analyzed_at: gh.analyzed_at || null,
            default_branch: gh.default_branch || "",
            total_commits: Number(gh.total_commits || 0),
            total_commits_before_t0: Number(gh.total_commits_before_t0 || 0),
            total_commits_during_event: Number(gh.total_commits_during_event || 0),
            total_commits_after_t1: Number(gh.total_commits_after_t1 || 0),
            total_loc_added: Number(gh.total_loc_added || 0),
            total_loc_deleted: Number(gh.total_loc_deleted || 0),
            has_commits_before_t0: Number(gh.has_commits_before_t0 || 0),
            has_bulk_commits: Number(gh.has_bulk_commits || 0),
            has_large_initial_commit_after_t0: Number(
              gh.has_large_initial_commit_after_t0 || 0
            ),
            has_merge_commits: Number(gh.has_merge_commits || 0),
          }
        : null;
      const ai =
        s.ai && typeof s.ai === "object" && (s.ai.ai_text || s.ai.ai_generated_at)
          ? {
              ai_text: s.ai.ai_text || "",
              ai_model: s.ai.ai_model || "",
              ai_generated_at: s.ai.ai_generated_at || null,
            }
          : null;
      return {
        project_name: s.project_name || "",
        team_name: s.team_name || "",
        // Legacy free-form roster string (deprecated; mirrored from team.members).
        team_members: s.team_members || "",
        team_members_legacy_text: String(
          s.team_members_legacy_text || s.team_members || ""
        ),
        team: safeTeam,
        description: s.description || "",
        chosen_track: s.chosen_track || "",
        repo_url: s.repo_url || "",
        demo_url: s.demo_url || "",
        uses_specter: s.uses_specter === true,
        github: safeGithub,
        ai,
      };
    });
    return sendJson(res, 200, { submissions: safe });
  } catch (error) {
    return sendJson(res, 500, { error: error.message || "Unknown error" });
  }
};
