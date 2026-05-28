const {
  parseRequestBody,
  sendJson,
  normalizeRepoUrl,
} = require("./_lib/storage");
const {
  JUDGE_CONFIG,
  normalizeJudgeResponse,
  aggregateJudgeResponses,
  resolveCanonicalJudgeName,
  buildJudgeNameAudit,
} = require("./_lib/judging");
const { verifyAuth, getJudgeNameFromCookies } = require("./_lib/auth");
const { getJudgeResponses, upsertJudgeResponse } = require("./_lib/db");

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") {
    return sendJson(res, 200, { ok: true });
  }

  const auth = verifyAuth(req);
  if (!auth.valid) {
    return sendJson(res, 401, { error: "Unauthorized" });
  }

  try {
    if (req.method === "GET") {
      const responses = await getJudgeResponses();
      return sendJson(res, 200, {
        ...aggregateJudgeResponses(responses),
        panel_audit: buildJudgeNameAudit(responses),
      });
    }

    if (req.method !== "POST") {
      return sendJson(res, 405, { error: "Method not allowed" });
    }

    const body = parseRequestBody(req) || {};
    const repoUrl = String(body.repo_url || "").trim();
    if (!repoUrl) {
      return sendJson(res, 400, { error: "Missing repo URL" });
    }

    const sessionName = getJudgeNameFromCookies(req);
    const canonical =
      resolveCanonicalJudgeName(sessionName) ||
      resolveCanonicalJudgeName(String(body.judge_name || "").trim());
    if (!canonical) {
      return sendJson(res, 403, {
        error:
          "Scores must be saved under a panel judge name. Re-unlock using your full name (e.g. David Gelberg, Rohit Gupta).",
      });
    }

    const repoKey = normalizeRepoUrl(repoUrl);
    const normalized = normalizeJudgeResponse({
      ...body,
      judge_name: canonical,
      repo_url: repoUrl,
      repo_key: repoKey,
    });

    await upsertJudgeResponse(normalized);
    const allResponses = await getJudgeResponses();
    return sendJson(res, 200, {
      ok: true,
      response: normalized,
      ...aggregateJudgeResponses(allResponses),
      rubric: JUDGE_CONFIG,
    });
  } catch (error) {
    return sendJson(res, 500, { error: error.message || "Unknown error" });
  }
};
