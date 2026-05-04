/**
 * OPS: Verify read + (optional) write access to Luma, Supabase, Firebase.
 *
 *   node scripts/connectivity-smoke-test.js
 *   node scripts/connectivity-smoke-test.js --read-only
 *
 * Loads credits-portal/.env.local — typical needs:
 *   LUMA_COOKIE
 *   SUPABASE_PROJECT_URL + SUPABASE_SERVICE_ROLE_SECRET (Supabase)
 *   Firebase (either):
 *     - FIREBASE_SERVICE_ACCOUNT_PATH or GOOGLE_APPLICATION_CREDENTIALS (JSON path) — same key as Python
 *     - or FIREBASE_SERVICE_ACCOUNT_JSON (inline JSON object string)
 *     - or NEXT_PUBLIC_FIREBASE_* (client SDK fallback for browsers)
 */

const fs = require("fs");
const path = require("path");

const envPath = path.join(__dirname, "..", ".env.local");
const dotResult = require("dotenv").config({ path: envPath });
const envParsedCount =
  dotResult?.parsed ? Object.keys(dotResult.parsed).length : 0;

function warnIfNoEnvSecrets() {
  if (envParsedCount > 0) return;
  console.warn("");
  if (!fs.existsSync(envPath)) {
    console.warn(`⚠  Missing file (create next to package.json):\n    ${envPath}`);
  } else {
    console.warn(
      `⚠  ${envPath} exists but loaded 0 variables — add NAME=value lines (not only comments/blanks).`
    );
  }
  console.warn(
    "    Supabase/Luma same as TENANCY. Firebase CLI check: FIREBASE_SERVICE_ACCOUNT_PATH (or GOOGLE_APPLICATION_CREDENTIALS),\n    or FIREBASE_SERVICE_ACCOUNT_JSON — same service account JSON as firebase_admin/Python; alternatively NEXT_PUBLIC_FIREBASE_*."
  );
  const tenancyDoc = path.join(__dirname, "..", "..", "docs", "TENANCY.md");
  console.warn(`    See: ${tenancyDoc}\n`);
}

const { initializeApp } = require("firebase/app");
const {
  getFirestore,
  collection,
  getDocs,
  getDoc,
  doc,
  setDoc,
  deleteDoc,
  limit,
  query,
} = require("firebase/firestore");

const {
  fetchLumaProfileEvents,
  hostingEventSummaries,
  normalizeLumaCookie,
} = require("./lib/luma-sync-ops.js");

const {
  initFirebaseAdminFirestoreOrNull,
} = require("./lib/firebase-admin-fs.cjs");

function parseArgs() {
  return { readOnly: process.argv.includes("--read-only") };
}

async function sbRest(method, path_, body, extraHeaders = {}) {
  const urlRoot = process.env.SUPABASE_PROJECT_URL || "";
  const key =
    process.env.SUPABASE_SERVICE_ROLE_SECRET ||
    process.env.SUPABASE_SERVICE_KEY ||
    "";
  if (!urlRoot || !key)
    throw new Error("SUPABASE_PROJECT_URL + SUPABASE_SERVICE_ROLE_SECRET missing");

  const headers = {
    apikey: key,
    Authorization: `Bearer ${key}`,
    ...extraHeaders,
  };
  if (method !== "GET") {
    headers["Content-Type"] = "application/json";
    headers.Prefer = "return=representation";
  }
  const res = await fetch(`${urlRoot}/rest/v1${path_}`, {
    method,
    headers,
    body: body != null ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  if (!res.ok) {
    throw new Error(
      `Supabase ${method} ${res.status}: ${typeof json === "string" ? json : JSON.stringify(json)}`
    );
  }
  return json;
}

async function testLuma() {
  const cookie = normalizeLumaCookie(process.env.LUMA_COOKIE);
  const username =
    process.env.LUMA_USERNAME?.trim() || "usr-O4svXJrJEipJn5G";

  console.log("\n--- Luma (api2.luma.com) READ ---");

  if (!cookie) {
    console.log("  SKIP: set LUMA_COOKIE in .env.local");
    return false;
  }

  try {
    const profile = await fetchLumaProfileEvents(username, cookie);
    const rows = hostingEventSummaries(profile);
    const hosting = profile.events_hosting || profile.eventsHosting || [];

    console.log(
      `  OK: authenticated profile/events — events_hosting count≈ ${hosting.length}`
    );
    console.log(
      `  OK: interpreted hosting rows with evt-* id: ${rows.length}`
    );
    return true;
  } catch (e) {
    console.log("  FAIL:", e.message || String(e));
    return false;
  }
}

/** Luma admin guest list is readable if session is valid — tests same cookie as uploads.wizard */

async function testSupabaseReads() {
  console.log("\n--- Supabase READ (REST, service role) ---");
  try {
    const rows = await sbRest(
      "GET",
      "/hackathons?select=id,slug,name&limit=3",
      undefined
    );
    const n = Array.isArray(rows) ? rows.length : 0;
    console.log(`  OK: hackathons readable (sample rows: ${n})`);
    if (n && rows[0]?.slug)
      console.log(`  sample slug: ${rows[0].slug}`);
    return true;
  } catch (e) {
    console.log("  FAIL:", e.message || String(e));
    return false;
  }
}

/** Insert + delete same row via REST — proves INSERT+DELETE policies for service role. */
async function testSupabaseWrites() {
  const ts = Date.now();
  const slug = `zz-ops-connectivity-${ts}`;
  console.log("\n--- Supabase WRITE probe (temporary row) ---");
  console.log(`  slug: ${slug}`);

  let id;
  try {
    const created = await sbRest("POST", "/hackathons", {
      slug,
      name: "ops connectivity smoke (delete ms next)",
      starts_at: "2027-01-01T00:00:00.000Z",
      ends_at: "2027-01-03T23:59:59.999Z",
    });
    id = Array.isArray(created) ? created[0]?.id : created?.id;
    if (!id)
      throw new Error("Insert returned no id");
    console.log(`  OK: INSERT hackathons id=${id}`);

    await sbRest(
      "DELETE",
      `/hackathons?id=eq.${encodeURIComponent(id)}`,
      undefined
    );
    console.log("  OK: DELETE hackathons rolled back probe row");

    const left = await sbRest(
      "GET",
      `/hackathons?id=eq.${encodeURIComponent(id)}&select=id`,
      undefined
    );
    const n = Array.isArray(left) ? left.length : 0;
    console.log(`  VERIFY: rows with id (expected 0): ${n}`);
    return n === 0;
  } catch (e) {
    if (id) {
      console.log(
        "  CLEANUP FAILED — delete probe row manually in Dashboard:",
        id
      );
    }
    console.log("  FAIL:", e.message || String(e));
    return false;
  }
}

async function testFirebaseReads() {
  console.log("\n--- Firebase READ (Firestore) ---");

  const adm = initFirebaseAdminFirestoreOrNull();
  if (adm) {
    try {
      const snap = await adm.collection("projects").limit(1).get();
      console.log(
        `  OK: Admin SDK — projects sample: ${snap.size} doc(s)`
      );
      return { ok: true, firebase: { kind: "admin", adminDb: adm } };
    } catch (e) {
      console.log("  FAIL (Admin SDK read):", e.message || String(e));
      return { ok: false, firebase: null };
    }
  }

  const firebaseConfig = {
    apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
    authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
    projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
    storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
    messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
    appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
  };
  const missing = Object.entries(firebaseConfig)
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length) {
    console.log(
      "  SKIP: no Admin credential and missing client NEXT_PUBLIC_*:",
      missing.join(", ")
    );
    console.log(
      "      Add FIREBASE_SERVICE_ACCOUNT_PATH=…/serviceAccount.json (same file as Python) or paste JSON in FIREBASE_SERVICE_ACCOUNT_JSON."
    );
    return { ok: false, firebase: null };
  }

  try {
    const app = initializeApp(firebaseConfig);
    const db = getFirestore(app);
    console.log("  INFO: Firebase client SDK (NEXT_PUBLIC_* config)");
    const pq = query(collection(db, "projects"), limit(1));
    const snap = await getDocs(pq);
    console.log(`  OK: Firestore reachable — projects/ sample docs: ${snap.size}`);
    return {
      ok: true,
      firebase: { kind: "client", modularDb: db },
    };
  } catch (e) {
    const msg = e.message || String(e);
    console.log("  FAIL:", msg);
    if (/permission|insufficient/i.test(msg)) {
      console.log(
        "      → Client SDK blocked by Firestore Rules — use Firebase Admin:"
      );
      console.log(
        "        EITHER FIREBASE_SERVICE_ACCOUNT_PATH=/ABS/PATH/admin.json"
      );
      console.log(
        "        OR (org blocks key downloads) FIREBASE_USE_ADC=1 plus gcloud:"
      );
      console.log(
        '        gcloud auth application-default login'
      );
    }
    return { ok: false, firebase: null };
  }
}

async function testFirebaseWrites(firebase) {
  console.log("\n--- Firebase WRITE probe (doc + delete) ---");
  if (!firebase) {
    console.log("  SKIP: no Firebase handle");
    return false;
  }
  const id = `_ops_smoke_${Date.now()}`;
  const payload = {
    createdAtIso: new Date().toISOString(),
    probe: true,
    source: "connectivity-smoke-test",
  };

  try {
    if (firebase.kind === "admin") {
      const adb = firebase.adminDb;
      const ref = adb.collection("zz_ops_connectivity_probe").doc(id);
      await ref.set(payload);
      console.log(`  OK: WRITE zz_ops_connectivity_probe/${id} (Admin)`);

      await ref.delete();
      console.log("  OK: DELETE same doc");

      const gone = await adb.collection("zz_ops_connectivity_probe").doc(id).get();
      console.log(`  VERIFY: doc.exists after delete = ${gone.exists}`);
      return gone.exists === false;
    }

    const db = firebase.modularDb;
    const ref = doc(db, "zz_ops_connectivity_probe", id);
    await setDoc(ref, payload);
    console.log(`  OK: WRITE zz_ops_connectivity_probe/${id}`);

    await deleteDoc(ref);
    console.log("  OK: DELETE same doc");

    const gone = await getDoc(ref);
    console.log(`  VERIFY: doc.exists after delete = ${gone.exists}`);
    return gone.exists === false;
  } catch (e) {
    console.log("  FAIL:", e.message || String(e));
    return false;
  }
}

async function main() {
  const { readOnly } = parseArgs();
  console.log("=== Connectivity smoke test ===");
  warnIfNoEnvSecrets();
  if (readOnly) console.log("Mode: --read-only (no Supabase INSERT / Firebase set+delete)");

  let okCount = 0;
  let total = 0;

  total += 1;
  if (await testLuma()) okCount += 1;

  total += 1;
  if (await testSupabaseReads()) okCount += 1;

  total += 1;
  const fbOut = await testFirebaseReads();

  if (fbOut.ok) okCount += 1;

  if (!readOnly) {
    if (process.env.SUPABASE_PROJECT_URL && process.env.SUPABASE_SERVICE_ROLE_SECRET) {
      total += 1;
      if (await testSupabaseWrites()) okCount += 1;
    } else {
      console.log("\n--- Supabase WRITE ---\n  SKIP (no Supabase env)");
    }

    if (fbOut?.ok && fbOut.firebase) {
      total += 1;
      if (await testFirebaseWrites(fbOut.firebase)) okCount += 1;
    }

    console.log(`
--- Luma ---
  Separate write probe N/A — Luma edits use the hosted web app.
`);
  }

  console.log(`\nPASS checks: ${okCount}/${total}`);
  if (okCount !== total) {
    console.log("Some checks failed or were skipped — read sections above.");
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
