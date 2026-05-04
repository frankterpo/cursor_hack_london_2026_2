const { sendJson } = require("./_lib/storage");
const {
  getSitePassword,
  createToken,
  verifyAuth,
  setAuthCookie,
  setJudgeNameCookie,
  clearJudgeNameCookie,
  getJudgeNameFromCookies,
} = require("./_lib/auth");

function getBody(req) {
  if (!req.body) return {};
  if (typeof req.body === "object" && !Buffer.isBuffer(req.body)) return req.body;
  try {
    const str = Buffer.isBuffer(req.body) ? req.body.toString("utf-8") : String(req.body);
    return str ? JSON.parse(str) : {};
  } catch (_) {
    return {};
  }
}

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") {
    return sendJson(res, 200, { ok: true });
  }

  try {
    if (req.method === "GET") {
      const result = verifyAuth(req);
      const judgeName = result.valid ? getJudgeNameFromCookies(req) : "";
      return sendJson(res, 200, { authenticated: result.valid, judge_name: judgeName });
    }

    if (req.method === "POST") {
      const body = getBody(req);
      const password = String(body.password || "").trim();
      const judgeName = String(body.judge_name || "").trim().slice(0, 200);
      const judgeProvided = Object.prototype.hasOwnProperty.call(body, "judge_name");

      if (!password) {
        return sendJson(res, 400, { ok: false, error: "Password required" });
      }

      if (judgeProvided && (!judgeName || judgeName.length < 2)) {
        return sendJson(res, 400, { ok: false, error: "Enter your full name (at least 2 characters)" });
      }

      let sitePassword;
      try {
        sitePassword = getSitePassword();
      } catch (_) {
        return sendJson(res, 503, {
          ok: false,
          error: "Server not configured: set SITE_PASSWORD or site_password in Vercel env.",
        });
      }

      if (password !== sitePassword) {
        return sendJson(res, 401, { ok: false, error: "Invalid password" });
      }

      let token;
      try {
        token = createToken();
      } catch (_) {
        return sendJson(res, 503, {
          ok: false,
          error: "Server not configured: set SITE_PASSWORD (or AUTH_SECRET) in Vercel env.",
        });
      }
      setAuthCookie(res, token);
      if (judgeProvided) {
        setJudgeNameCookie(res, judgeName);
      } else {
        clearJudgeNameCookie(res);
      }
      return sendJson(res, 200, {
        ok: true,
        token,
        judge_name: judgeProvided ? judgeName : "",
      });
    }

    return sendJson(res, 405, { error: "Method not allowed" });
  } catch (error) {
    return sendJson(res, 500, { error: error.message || "Unknown error" });
  }
};
