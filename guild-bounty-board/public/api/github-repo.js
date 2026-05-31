const { sendJson } = require("./_lib/storage");
const { verifyAuth } = require("./_lib/auth");
const { parseRepoUrl } = require("./_lib/github-analysis");

function getGitHubHeaders() {
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "cursor-guild-hackathon-manager",
  };
  const token =
    process.env.GITHUB_TOKEN || process.env.GITHUB_PAT || process.env.GH_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
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
    const requestUrl = new URL(req.url, "http://localhost");
    const repoUrl =
      requestUrl.searchParams.get("repo_url") ||
      requestUrl.searchParams.get("repo") ||
      "";
    const parsed = parseRepoUrl(repoUrl);
    const ghRes = await fetch(
      `https://api.github.com/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}`,
      { headers: getGitHubHeaders() }
    );
    const bodyText = await ghRes.text();
    if (!ghRes.ok) {
      return sendJson(res, ghRes.status === 404 ? 404 : 502, {
        error: `GitHub API ${ghRes.status}`,
        detail: bodyText.slice(0, 400),
        status: "unknown",
        fork: false,
      });
    }
    let data;
    try {
      data = JSON.parse(bodyText);
    } catch (_error) {
      return sendJson(res, 502, { error: "Invalid GitHub response", status: "unknown" });
    }
    const fork = data.fork === true;
    return sendJson(res, 200, {
      repo_url: parsed.normalizedUrl,
      owner: parsed.owner,
      repo: parsed.repo,
      fork,
      status: fork ? "fork" : "new",
      parent_full_name: data.parent?.full_name || null,
      created_at: data.created_at || null,
      private: data.private === true,
      has_token: Boolean(
        process.env.GITHUB_TOKEN || process.env.GITHUB_PAT || process.env.GH_TOKEN
      ),
    });
  } catch (error) {
    return sendJson(res, 400, {
      error: error.message || "Unknown error",
      status: "unknown",
      fork: false,
    });
  }
};
