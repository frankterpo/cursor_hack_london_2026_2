const BUCKET_NAME = process.env.SUPABASE_STORAGE_BUCKET || "cursor-hackathon-manager";

function getEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing environment variable: ${name}`);
  }
  return value;
}

function getSupabaseConfig() {
  return {
    url: getEnv("SUPABASE_PROJECT_URL"),
    serviceRole: getEnv("SUPABASE_SERVICE_ROLE_SECRET"),
    anonKey: getEnv("SUPABASE_ANON_PUBLIC_KEY"),
    bucket: BUCKET_NAME,
  };
}

async function supabaseFetch(path, options = {}) {
  const { url, serviceRole } = getSupabaseConfig();
  const headers = {
    apikey: serviceRole,
    Authorization: `Bearer ${serviceRole}`,
    ...options.headers,
  };
  return fetch(`${url}${path}`, {
    ...options,
    headers,
  });
}

async function ensureBucket() {
  const { bucket } = getSupabaseConfig();
  const response = await supabaseFetch("/storage/v1/bucket");
  if (!response.ok) {
    throw new Error(`Failed to list storage buckets: ${response.status}`);
  }

  const buckets = await response.json();
  const existing = buckets.find((entry) => entry.id === bucket || entry.name === bucket);
  if (existing) {
    return bucket;
  }

  const createResponse = await supabaseFetch("/storage/v1/bucket", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      id: bucket,
      name: bucket,
      public: false,
      file_size_limit: null,
      allowed_mime_types: ["application/json"],
    }),
  });

  if (!createResponse.ok) {
    const body = await createResponse.text();
    throw new Error(`Failed to create storage bucket: ${createResponse.status} ${body}`);
  }

  return bucket;
}

async function readJsonObject(objectPath, fallbackValue) {
  const { bucket } = getSupabaseConfig();
  await ensureBucket();

  const response = await supabaseFetch(`/storage/v1/object/authenticated/${bucket}/${objectPath}`);
  if (response.status === 400 || response.status === 404) {
    return fallbackValue;
  }
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Failed to read storage object: ${response.status} ${body}`);
  }
  const text = await response.text();
  return text ? JSON.parse(text) : fallbackValue;
}

async function writeJsonObject(objectPath, payload) {
  const { bucket } = getSupabaseConfig();
  await ensureBucket();

  const response = await supabaseFetch(`/storage/v1/object/${bucket}/${objectPath}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-upsert": "true",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Failed to write storage object: ${response.status} ${body}`);
  }

  return payload;
}

function parseRequestBody(req) {
  if (!req.body) {
    return null;
  }
  if (typeof req.body === "string") {
    return req.body ? JSON.parse(req.body) : null;
  }
  return req.body;
}

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.end(JSON.stringify(payload));
}

function normalizeRepoUrl(repoUrl) {
  return String(repoUrl || "").trim().replace(/\.git$/i, "").toLowerCase();
}

module.exports = {
  getSupabaseConfig,
  readJsonObject,
  writeJsonObject,
  parseRequestBody,
  sendJson,
  normalizeRepoUrl,
};
