const fs = require("fs");
const path = require("path");
const { sendJson } = require("./_lib/storage");
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

function findSubmissionByRepoId(submissions, repoId) {
  const needle = slugKey(repoId);
  return submissions.find(
    (row) =>
      row.repo_id === repoId ||
      slugKey(row.repo_id) === needle ||
      slugKey(row.repo_url) === needle
  );
}

function normalizeCommitRows(commits) {
  if (!Array.isArray(commits)) return [];
  return commits.map((row, index) => ({
    repo_id: row.repo_id || "",
    seq_index: row.seq_index != null ? row.seq_index : index,
    sha: row.sha || row.commit_sha || "",
    author_time_iso:
      row.author_time_iso || row.committed_at || row.author_date || "",
    minutes_since_prev_commit: row.minutes_since_prev_commit ?? null,
    minutes_since_t0: row.minutes_since_t0 ?? null,
    insertions: Number(row.insertions) || 0,
    deletions: Number(row.deletions) || 0,
    files_changed: Number(row.files_changed) || 0,
    is_merge: row.is_merge ? 1 : 0,
    is_before_t0: row.is_before_t0 ? 1 : 0,
    is_during_event: row.is_during_event ? 1 : 0,
    is_after_t1: row.is_after_t1 ? 1 : 0,
    flag_bulk_commit: row.flag_bulk_commit ? 1 : 0,
    subject: row.subject || "",
  }));
}

function readStaticCommits(repoId) {
  const candidates = [
    path.join(process.cwd(), "dist", "api", "repo", repoId, "commits"),
    path.join(process.cwd(), "dist", "api", "repo", repoId, "commits.json"),
  ];
  for (const filePath of candidates) {
    try {
      if (!fs.existsSync(filePath)) continue;
      const payload = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      const rows = normalizeCommitRows(payload?.rows || payload);
      if (rows.length) return rows;
    } catch (_error) {
      // try next candidate
    }
  }
  return [];
}

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") {
    return sendJson(res, 200, { ok: true });
  }

  if (req.method !== "GET") {
    return sendJson(res, 405, { error: "Method not allowed" });
  }

  const repoId = decodeRepoIdParam(req.query.repoId);
  if (!repoId) {
    return sendJson(res, 400, { error: "Missing repo id" });
  }

  try {
    const submissions = await getSubmissions();
    const sub = findSubmissionByRepoId(submissions, repoId);

    let rows = [];
    if (sub?.repo_url) {
      const analysis = await getAnalysis(normalizeRepoUrl(sub.repo_url));
      rows = normalizeCommitRows(analysis?.commits);
    }

    if (!rows.length) {
      rows = readStaticCommits(repoId);
    }

    if (!rows.length) {
      return sendJson(res, 404, { error: "commits not found", rows: [] });
    }

    return sendJson(res, 200, { rows });
  } catch (error) {
    return sendJson(res, 500, {
      error: error.message || "Failed to load commits",
    });
  }
};
