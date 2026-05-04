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
    // Public-safe fields only — no judge scores, no AI analysis, no flags
    const safe = submissions.map(s => ({
      project_name: s.project_name || "",
      team_name: s.team_name || "",
      team_members: s.team_members || "",
      description: s.description || "",
      chosen_track: s.chosen_track || "",
      repo_url: s.repo_url || "",
      demo_url: s.demo_url || "",
      uses_specter: s.uses_specter === true,
    }));
    return sendJson(res, 200, { submissions: safe });
  } catch (error) {
    return sendJson(res, 500, { error: error.message || "Unknown error" });
  }
};
