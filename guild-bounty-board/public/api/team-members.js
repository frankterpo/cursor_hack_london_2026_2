const { sendJson } = require("./_lib/storage");
const { verifyAuth } = require("./_lib/auth");
const { deleteTeamMember } = require("./_lib/db");

/**
 * Admin-only DELETE for a single team_member.
 *
 * Path is `/api/team-members` (Vercel rewrites `/api/team-members/:id` to this
 * function via the `?id=` query in production routing). Accepts either:
 *   - DELETE /api/team-members?id=<uuid>
 *   - DELETE /api/team-members  with JSON body `{ id: "<uuid>" }`
 *
 * Always requires a valid auth token (organizer/judge cookie). Returns
 * `{ ok: true, deleted: <count> }`.
 */
module.exports = async (req, res) => {
  if (req.method === "OPTIONS") {
    return sendJson(res, 200, { ok: true });
  }
  if (req.method !== "DELETE") {
    return sendJson(res, 405, { error: "Method not allowed" });
  }

  const auth = verifyAuth(req);
  if (!auth.valid) {
    return sendJson(res, 401, { error: "Unauthorized" });
  }

  try {
    let id = "";
    if (req.query && typeof req.query.id === "string") {
      id = req.query.id.trim();
    }
    if (!id && req.url) {
      try {
        const url = new URL(req.url, "http://placeholder.local");
        id =
          url.searchParams.get("id") ||
          // Support a trailing /api/team-members/<id> path if a rewrite sends it through.
          (url.pathname.match(/\/team-members\/([^/?#]+)/) || [])[1] ||
          "";
        id = String(id || "").trim();
      } catch (_error) {
        id = "";
      }
    }
    if (!id && req.body) {
      try {
        const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
        if (body && typeof body === "object" && body.id) id = String(body.id).trim();
      } catch (_error) {
        id = "";
      }
    }
    if (!id) {
      return sendJson(res, 400, { error: "Missing team member id" });
    }
    const result = await deleteTeamMember(id);
    return sendJson(res, 200, { ok: true, ...result });
  } catch (error) {
    return sendJson(res, 500, { error: error.message || "Unknown error" });
  }
};
