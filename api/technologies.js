const { sendJson } = require("../guild-bounty-board/public/api/_lib/storage");
const { getTechnologies } = require("../guild-bounty-board/public/api/_lib/db");

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") {
    return sendJson(res, 200, { ok: true });
  }
  if (req.method !== "GET") {
    return sendJson(res, 405, { error: "Method not allowed" });
  }

  try {
    const technologies = await getTechnologies();
    return sendJson(res, 200, { technologies });
  } catch (error) {
    const message = error.message || "Unknown error";
    const status = message.includes("Missing environment variable") ? 503 : 500;
    return sendJson(res, status, { error: message });
  }
};
