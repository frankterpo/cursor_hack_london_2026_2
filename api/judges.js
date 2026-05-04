const {
  parseRequestBody,
  sendJson,
  normalizeRepoUrl,
} = require("../guild-bounty-board/public/api/_lib/storage");
const {
  JUDGE_CONFIG,
  normalizeJudgeResponse,
  aggregateJudgeResponses,
} = require("../guild-bounty-board/public/api/_lib/judging");
const {
  getJudgeResponses,
  upsertJudgeResponse,
} = require("../guild-bounty-board/public/api/_lib/db");

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") {
    return sendJson(res, 200, { ok: true });
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
    const message = error.message || "Unknown error";
    const status = message.includes("Missing environment variable") ? 503 : 500;
    return sendJson(res, status, { error: message });
  }
};
