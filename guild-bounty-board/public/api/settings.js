const {
  parseRequestBody,
  sendJson,
} = require("./_lib/storage");
const {
  DEFAULT_ANALYSIS_SETTINGS,
  getAnalysisSettings,
  saveAnalysisSettings,
} = require("./_lib/analysis-settings");
const { verifyAuth } = require("./_lib/auth");

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
      const settings = await getAnalysisSettings();
      return sendJson(res, 200, { ok: true, settings, defaults: DEFAULT_ANALYSIS_SETTINGS });
    }

    if (req.method !== "POST") {
      return sendJson(res, 405, { error: "Method not allowed" });
    }

    const body = parseRequestBody(req) || {};
    const settings = await saveAnalysisSettings(body);
    return sendJson(res, 200, { ok: true, settings });
  } catch (error) {
    return sendJson(res, 500, { error: error.message || "Unknown error" });
  }
};
