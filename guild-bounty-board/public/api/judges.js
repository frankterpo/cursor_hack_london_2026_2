const {
  parseRequestBody,
  sendJson,
  normalizeRepoUrl,
} = require("./_lib/storage");
const {
  JUDGE_CONFIG,
  normalizeJudgeResponse,
  aggregateJudgeResponses,
} = require("./_lib/judging");
const { verifyAuth } = require("./_lib/auth");
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
      return sendJson(res, 200, aggregateJudgeResponses(responses));
    }

    if (req.method !== "POST") {
      return sendJson(res, 405, { error: "Method not allowed" });
    }

    const body = parseRequestBody(req) || {};
    const repoUrl = String(body.repo_url || "").trim();
    const judgeName = String(body.judge_name || "").trim();
    if (!repoUrl || !judgeName) {
      return sendJson(res, 400, { error: "Missing judge name or repo URL" });
    }

    const repoKey = normalizeRepoUrl(repoUrl);
    const normalized = normalizeJudgeResponse({
      ...body,
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
