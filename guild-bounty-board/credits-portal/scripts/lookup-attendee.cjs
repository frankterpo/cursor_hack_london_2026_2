#!/usr/bin/env node
/**
 * Quick attendee lookup by partial name.
 * Usage: node scripts/lookup-attendee.cjs "catie"
 */
require("dotenv").config({ path: ".env.local" });
const { initFirebaseAdminFirestoreOrNull } = require("./lib/firebase-admin-fs.cjs");
const db = initFirebaseAdminFirestoreOrNull();
if (!db) {
  console.error("No Firestore admin available — check .env.local");
  process.exit(2);
}

async function main() {
  const needle = (process.argv[2] || "").trim().toLowerCase();
  if (!needle) {
    console.error("Usage: node scripts/lookup-attendee.cjs <substring>");
    process.exit(1);
  }
  const snap = await db.collection("attendees").get();
  const hits = [];
  snap.forEach((d) => {
    const x = d.data() || {};
    const name = String(x.name || "");
    const email = String(x.email || "");
    if (
      name.toLowerCase().includes(needle) ||
      email.toLowerCase().includes(needle)
    ) {
      hits.push({
        id: d.id,
        name,
        email,
        projectId: x.projectId,
        hasCheckedIn: x.hasCheckedIn ?? null,
        checkedInAt: x.checkedInAt ?? null,
        hasRedeemedCode: x.hasRedeemedCode ?? false,
        redeemedCodeId: x.redeemedCodeId ?? null,
      });
    }
  });
  console.log(JSON.stringify({ count: hits.length, hits }, null, 2));
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
