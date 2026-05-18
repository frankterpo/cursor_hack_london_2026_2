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
    // Public-safe fields only — no judge scores, no AI analysis, no flags, no emails.
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
      };
    });
    return sendJson(res, 200, { submissions: safe });
  } catch (error) {
    return sendJson(res, 500, { error: error.message || "Unknown error" });
  }
};
