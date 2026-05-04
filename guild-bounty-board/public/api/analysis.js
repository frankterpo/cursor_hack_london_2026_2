const { sendJson, normalizeRepoUrl } = require("./_lib/storage");
const { verifyAuth } = require("./_lib/auth");
const { getAnalysis } = require("./_lib/db");

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
    const requestUrl = new URL(req.url, "http://localhost");
    const repoUrl = requestUrl.searchParams.get("repo_url") || requestUrl.searchParams.get("repo") || "";
    const repoKey = normalizeRepoUrl(repoUrl);

    if (!repoKey) {
      return sendJson(res, 400, { error: "Missing repo_url parameter" });
    }

    const analysis = await getAnalysis(repoKey);
    return sendJson(res, 200, { repo_key: repoKey, analysis: analysis || null });
  } catch (error) {
    return sendJson(res, 500, { error: error.message || "Unknown error" });
  }
};
