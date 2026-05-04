const crypto = require("crypto");

const TOKEN_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

function getSitePasswordRaw() {
  return (
    process.env.SITE_PASSWORD ||
    process.env.site_password ||
    process.env.Site_Password ||
    ""
  ).trim();
}

/** Stable signing secret: explicit AUTH_SECRET, else derived from site password (single-env deploys). */
function getAuthSecret() {
  const explicit = (process.env.AUTH_SECRET || process.env.auth_secret || "").trim();
  if (explicit) return explicit;
  const sitePw = getSitePasswordRaw();
  if (!sitePw) return "";
  return crypto.createHash("sha256").update(`guild-bounty-board:auth:v1:${sitePw}`, "utf8").digest("hex");
}

function getSitePassword() {
  const password = getSitePasswordRaw();
  if (!password) {
    throw new Error("Missing environment variable: SITE_PASSWORD (or site_password)");
  }
  return password;
}

function createToken() {
  const secret = getAuthSecret();
  if (!secret) {
    throw new Error("Missing AUTH_SECRET / SITE_PASSWORD for token signing");
  }
  const timestamp = Date.now().toString();
  const hmac = crypto.createHmac("sha256", secret).update(timestamp).digest("hex");
  return `${timestamp}.${hmac}`;
}

function verifyToken(token) {
  if (!token || typeof token !== "string") {
    return { valid: false, error: "No token provided" };
  }

  const parts = token.split(".");
  if (parts.length !== 2) {
    return { valid: false, error: "Invalid token format" };
  }

  const [timestamp, providedHmac] = parts;
  const secret = getAuthSecret();
  if (!secret) {
    return { valid: false, error: "Server not configured" };
  }
  const expectedHmac = crypto.createHmac("sha256", secret).update(timestamp).digest("hex");

  if (!crypto.timingSafeEqual(Buffer.from(providedHmac, "hex"), Buffer.from(expectedHmac, "hex"))) {
    return { valid: false, error: "Invalid token signature" };
  }

  const tokenAge = Date.now() - parseInt(timestamp, 10);
  if (tokenAge > TOKEN_MAX_AGE_MS) {
    return { valid: false, error: "Token expired" };
  }

  return { valid: true };
}

function parseCookies(req) {
  const header = req.headers.cookie || "";
  const cookies = {};
  header.split(";").forEach((pair) => {
    const [name, ...rest] = pair.trim().split("=");
    if (name) {
      cookies[name.trim()] = decodeURIComponent(rest.join("=").trim());
    }
  });
  return cookies;
}

function verifyAuth(req) {
  // Check Authorization header first
  const authHeader = req.headers.authorization || "";
  if (authHeader.startsWith("Bearer ")) {
    const token = authHeader.slice(7);
    const result = verifyToken(token);
    if (result.valid) return result;
  }

  // Fall back to cookie
  const cookies = parseCookies(req);
  const cookieToken = cookies.auth_token;
  if (cookieToken) {
    return verifyToken(cookieToken);
  }

  return { valid: false, error: "No authentication provided" };
}

function setAuthCookie(res, token) {
  const maxAge = Math.floor(TOKEN_MAX_AGE_MS / 1000);
  res.setHeader(
    "Set-Cookie",
    `auth_token=${encodeURIComponent(token)}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${maxAge}`
  );
}

function appendSetCookie(res, cookieLine) {
  const prev = res.getHeader("Set-Cookie");
  if (prev) {
    const list = Array.isArray(prev) ? [...prev, cookieLine] : [prev, cookieLine];
    res.setHeader("Set-Cookie", list);
  } else {
    res.setHeader("Set-Cookie", cookieLine);
  }
}

/** Session-scoped judge display name (same Max-Age as auth). HttpOnly; UI reads via GET /api/auth. */
function setJudgeNameCookie(res, judgeName) {
  const maxAge = Math.floor(TOKEN_MAX_AGE_MS / 1000);
  const safe = String(judgeName || "").trim().slice(0, 200);
  const encoded = encodeURIComponent(safe);
  const judgeCookie = `judge_name=${encoded}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${maxAge}`;
  appendSetCookie(res, judgeCookie);
}

function clearJudgeNameCookie(res) {
  appendSetCookie(res, "judge_name=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0");
}

function getJudgeNameFromCookies(req) {
  const cookies = parseCookies(req);
  const raw = cookies.judge_name;
  if (!raw || typeof raw !== "string") return "";
  try {
    return decodeURIComponent(raw).trim();
  } catch (_) {
    return String(raw).trim();
  }
}

module.exports = {
  getSitePassword,
  getAuthSecret,
  createToken,
  verifyToken,
  verifyAuth,
  parseCookies,
  setAuthCookie,
  setJudgeNameCookie,
  clearJudgeNameCookie,
  getJudgeNameFromCookies,
};
