/**
 * Delete all codes, attendees, and redemptions for a Firebase projectId.
 * Does NOT delete the projects/{id} document — use for a clean slate before a new code batch.
 *
 * Usage (from credits-portal/):
 *   node scripts/clear-firebase-project-children.js --project-id=XXXX --i-understand
 *
 * Requires .env.local with NEXT_PUBLIC_FIREBASE_*.
 */

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env.local") });

const { initializeApp } = require("firebase/app");
const {
  getFirestore,
  collection,
  query,
  where,
  getDocs,
  writeBatch,
  limit,
} = require("firebase/firestore");

const BATCH = 400;

const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
};

function parseArgs() {
  const out = { projectId: null, understand: false };
  for (const a of process.argv.slice(2)) {
    if (a === "--i-understand") out.understand = true;
    else if (a.startsWith("--project-id="))
      out.projectId = a.slice("--project-id=".length);
  }
  return out;
}

async function deleteWhereProjectId(db, collName, projectId) {
  const coll = collection(db, collName);
  let total = 0;
  for (;;) {
    const q = query(
      coll,
      where("projectId", "==", projectId),
      limit(BATCH)
    );
    const snap = await getDocs(q);
    if (snap.empty) break;
    const batch = writeBatch(db);
    snap.docs.forEach((d) => batch.delete(d.ref));
    await batch.commit();
    total += snap.size;
  }
  return total;
}

async function main() {
  const { projectId, understand } = parseArgs();
  if (!projectId) {
    console.error("Pass --project-id=<Firestore project document id>");
    process.exit(1);
  }
  if (!understand) {
    console.error(
      "This permanently deletes codes, attendees, and redemptions for that project. Re-run with --i-understand"
    );
    process.exit(1);
  }

  const missing = Object.entries(firebaseConfig)
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length) {
    console.error("Missing env:", missing.join(", "));
    process.exit(1);
  }

  const app = initializeApp(firebaseConfig);
  const db = getFirestore(app);

  const codes = await deleteWhereProjectId(db, "codes", projectId);
  const attendees = await deleteWhereProjectId(db, "attendees", projectId);
  const redemptions = await deleteWhereProjectId(db, "redemptions", projectId);

  console.log("Deleted documents:");
  console.log("  codes:", codes);
  console.log("  attendees:", attendees);
  console.log("  redemptions:", redemptions);
  console.log("Project doc at projects/%s was left in place.", projectId);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
