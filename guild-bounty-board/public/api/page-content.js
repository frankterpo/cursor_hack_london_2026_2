const { sendJson } = require("./_lib/storage");
const { verifyAuth } = require("./_lib/auth");
const judgeHtml = require("./_lib/page-judge");
const adminHtml = require("./_lib/page-admin");

const PAGES = {
  judge: { html: judgeHtml, scripts: ["/judge/script.js"] },
  admin: { html: adminHtml, scripts: ["/admin/script.js"] },
};

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") {
    return sendJson(res, 200, { ok: true });
  }

  if (req.method !== "GET") {
    return sendJson(res, 405, { error: "Method not allowed" });
  }

  const auth = verifyAuth(req);
  if (!auth.valid) {
    return sendJson(res, 401, { error: "Unauthorized" });
  }

  const page = (req.query && req.query.page) || "";
  const entry = PAGES[page];
  if (!entry) {
    return sendJson(res, 400, { error: "Invalid page. Use ?page=judge or ?page=admin" });
  }

  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
  res.end(JSON.stringify({ html: entry.html, scripts: entry.scripts }));
};
