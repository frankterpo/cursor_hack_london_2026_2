/**
 * Minimal Supabase REST for hackathons (service role — ops only).
 */

async function sbRest(method, path, body) {
  const url = process.env.SUPABASE_PROJECT_URL || "";
  const key =
    process.env.SUPABASE_SERVICE_ROLE_SECRET ||
    process.env.SUPABASE_SERVICE_KEY ||
    "";
  if (!url || !key) {
    throw new Error(
      "Set SUPABASE_PROJECT_URL and SUPABASE_SERVICE_ROLE_SECRET in credits-portal/.env.local"
    );
  }

  const res = await fetch(`${url}/rest/v1${path}`, {
    method,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: body != null ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  if (!res.ok)
    throw new Error(`Supabase ${res.status}: ${typeof json === "string" ? json : JSON.stringify(json)}`);

  return json;
}

async function listHackathons() {
  /** Returns newest first-ish by created_at desc */
  return sbRest(
    "GET",
    "/hackathons?select=id,slug,name,starts_at,ends_at,luma_event_api_id,luma_event_name,credits_firestore_project_doc_id&order=created_at.desc",
    undefined
  );
}

async function insertHackathon(row) {
  const rows = await sbRest("POST", "/hackathons", row);
  return Array.isArray(rows) ? rows[0] : rows;
}

async function patchHackathon(id, patch) {
  await sbRest("PATCH", `/hackathons?id=eq.${encodeURIComponent(id)}`, patch);
}

module.exports = { listHackathons, insertHackathon, patchHackathon };
