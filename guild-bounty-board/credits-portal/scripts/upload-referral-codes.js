#!/usr/bin/env node
/**
 * Bulk-upload referral CSV to Firestore `codes` pool for a Hackathon project doc.
 * Does NOT assign codes to attendees — only seeds the unused pool (`isRedeemed: false`).
 *
 * Prerequisites: credits-portal/.env.local with Firebase Admin (same as connectivity smoke —
 * FIREBASE_SERVICE_ACCOUNT_PATH OR FIREBASE_USE_ADC + gcloud adc login).
 *
 *   cd credits-portal
 *   npm run ops:upload-codes -- "/path/to/Refferal Codes.csv"
 *
 * Flags:
 *   --project-id=ABC   Firestore doc id under projects/ (default: slug cursor-hackathon-london-2026)
 */

const path = require("path");
const fs = require("fs");
require("dotenv").config({ path: path.join(__dirname, "..", ".env.local") });

const { Timestamp, FieldValue } = require("firebase-admin/firestore");
const { parseCodesCSV } = require("./lib/parse-codes-csv.cjs");
const { initFirebaseAdminFirestoreOrNull } = require("./lib/firebase-admin-fs.cjs");

const LONDON_SLUG = "cursor-hackathon-london-2026";
const LONDON_NAME = "Cursor × Briefcase — London 2026";
const SUPABASE_HACKATHON_ID = "a0000002-0000-4000-8000-000000000002";

function parseCli() {
  const args = process.argv.slice(2);
  let projectIdOpt = "";
  const pathPieces = [];
  for (const a of args) {
    if (a.startsWith("--project-id="))
      projectIdOpt = a.slice("--project-id=".length).trim();
    else pathPieces.push(a);
  }
  return { csvRaw: pathPieces.join(" ").trim(), projectIdOpt };
}

async function resolveOrCreateProjectId(db, explicit) {
  if (explicit) {
    const snap = await db.collection("projects").doc(explicit).get();
    if (!snap.exists)
      throw new Error(`projects/${explicit} does not exist.`);
    return explicit;
  }

  const q = await db
    .collection("projects")
    .where("slug", "==", LONDON_SLUG)
    .limit(1)
    .get();

  if (!q.empty) return q.docs[0].id;

  console.log(
    `Creating Firestore project doc slug=${LONDON_SLUG} (first run)`
  );
  const now = Timestamp.now();
  const ref = await db.collection("projects").add({
    name: LONDON_NAME,
    description: "Cursor credits — London 2026",
    slug: LONDON_SLUG,
    status: "active",
    supabaseHackathonId: SUPABASE_HACKATHON_ID,
    eventDate: null,
    createdAt: now,
    updatedAt: now,
  });
  console.log("  Created projects/", ref.id);
  return ref.id;
}

async function main() {
  const { csvRaw, projectIdOpt } = parseCli();

  let csvAbs;
  if (csvRaw) {
    csvAbs = path.isAbsolute(csvRaw)
      ? csvRaw
      : path.resolve(process.cwd(), csvRaw);
  }
  if (!csvAbs || !fs.existsSync(csvAbs)) {
    console.error(
      "Usage: npm run ops:upload-codes -- \"/absolute/or/relative/path.csv\"\n       Optional: --project-id=FIRESTORE_DOC_ID"
    );
    process.exit(1);
  }

  console.log(`CSV file: ${csvAbs}`);

  const db = initFirebaseAdminFirestoreOrNull({ silent: true });
  if (!db) {
    console.error(
      "Firebase Admin unavailable. Use FIREBASE_USE_ADC=1 (+ gcloud auth application-default login) or FIREBASE_SERVICE_ACCOUNT_PATH=… in .env.local."
    );
    process.exit(1);
  }
  console.log("  Connected (Firebase Admin).");

  const projectIdFs = await resolveOrCreateProjectId(db, projectIdOpt || "");
  console.log(`Codes will attach to projectId (Firestore): ${projectIdFs}`);
  console.log("(No attendee pairing — pool only.)");

  const csvContent = fs.readFileSync(csvAbs, "utf-8");
  const parsed = parseCodesCSV(csvContent);
  if (!parsed.length) {
    console.error("CSV has no recognizable cursor.com referral rows.");
    process.exit(1);
  }

  const existingQS = await db
    .collection("codes")
    .where("projectId", "==", projectIdFs)
    .get();
  const existing = new Set(
    existingQS.docs.map((d) => d.data().code).filter(Boolean)
  );

  let added = 0;
  let skippedDup = 0;
  let batchErrors = 0;

  for (const row of parsed) {
    if (existing.has(row.code)) {
      skippedDup += 1;
      continue;
    }
    try {
      await db.collection("codes").add({
        code: row.code,
        cursorUrl: row.cursorUrl,
        ...(row.creator != null && row.creator !== ""
          ? { creator: row.creator }
          : {}),
        ...(row.date != null && row.date !== "" ? { date: row.date } : {}),
        isRedeemed: false,
        projectId: projectIdFs,
        createdAt: FieldValue.serverTimestamp(),
      });
      existing.add(row.code);
      added += 1;
      if (added % 50 === 0)
        console.log(`  Uploaded ${added} new codes…`);
    } catch (e) {
      batchErrors += 1;
      console.error("  Row error:", row.code, e.message || String(e));
    }
  }

  console.log(`
Done.
  Rows in CSV parsed: ${parsed.length}
  New docs added:     ${added}
  Skipped duplicates: ${skippedDup}
  Row errors:         ${batchErrors}
`);
  process.exit(batchErrors ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
