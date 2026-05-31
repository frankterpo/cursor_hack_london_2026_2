const { getSubmissions, getAnalysis } = require("./_lib/db");
const { normalizeRepoUrl } = require("./_lib/storage");

function decodeRepoIdParam(raw) {
  try {
    return decodeURIComponent(String(raw || "").trim());
  } catch (_error) {
    return String(raw || "").trim();
  }
}

function slugKey(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function submissionAiText(sub) {
  if (!sub) return "";
  const inline = String(sub.ai_text || "").trim();
  if (inline) return inline;
  return String(sub.ai?.ai_text || "").trim();
}

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.status(204).end();
    return;
  }

  if (req.method !== "GET") {
    res.status(405).send("Method not allowed");
    return;
  }

  const repoId = decodeRepoIdParam(req.query.repoId);
  if (!repoId) {
    res.status(400).send("Missing repo id");
    return;
  }

  try {
    const submissions = await getSubmissions();
    const needle = slugKey(repoId);
    const sub = submissions.find(
      (row) =>
        row.repo_id === repoId ||
        slugKey(row.repo_id) === needle ||
        slugKey(row.repo_url) === needle
    );

    let aiText = submissionAiText(sub);
    if (!aiText && sub?.repo_url) {
      const analysis = await getAnalysis(normalizeRepoUrl(sub.repo_url));
      aiText = String(analysis?.ai_text || "").trim();
    }

    if (!aiText) {
      res.status(404).send("");
      return;
    }

    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.status(200).send(aiText);
  } catch (error) {
    res.status(500).send(error.message || "Failed to load AI summary");
  }
};
