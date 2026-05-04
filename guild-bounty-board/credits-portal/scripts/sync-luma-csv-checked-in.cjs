#!/usr/bin/env node
/**
 * Read a Luma admin CSV, find every checked-in guest that isn't already in the
 * London Firestore project, create the attendee doc, and assign one of the
 * unredeemed codes (transactional). Prints a summary at the end.
 *
 *   node scripts/sync-luma-csv-checked-in.cjs <path-to-csv>
 *
 * Safe to re-run; per-attendee transactions guarantee one code per guest.
 */
require("dotenv").config({ path: ".env.local" });
const fs = require("fs");
const path = require("path");
const {
  initFirebaseAdminFirestoreOrNull,
} = require("./lib/firebase-admin-fs.cjs");

const PROJECT_ID = "nynsjuhYRTQhxTNZgywQ";

function parseCsv(text) {
  // Minimal RFC-4180 parser (handles quoted fields with commas/newlines/escapes).
  const rows = [];
  let row = [];
  let cell = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      continue;
    }
    if (ch === ",") {
      row.push(cell);
      cell = "";
      continue;
    }
    if (ch === "\r") continue;
    if (ch === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      continue;
    }
    cell += ch;
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

function buildHeaderIndex(headerRow) {
  const idx = {};
  headerRow.forEach((h, i) => {
    idx[h.trim()] = i;
  });
  return idx;
}

function get(row, idx, key) {
  const i = idx[key];
  if (i == null) return "";
  return (row[i] ?? "").trim();
}

function isCheckedIn(row, idx) {
  const v = get(row, idx, "checked_in_at");
  if (!v) return false;
  if (v.startsWith("0001")) return false;
  if (["false", "no", "null", "undefined"].includes(v.toLowerCase())) return false;
  return true;
}

async function main() {
  const csvPath = process.argv[2];
  if (!csvPath) {
    console.error("Usage: node scripts/sync-luma-csv-checked-in.cjs <csv>");
    process.exit(1);
  }
  const abs = path.isAbsolute(csvPath)
    ? csvPath
    : path.resolve(process.cwd(), csvPath);
  if (!fs.existsSync(abs)) {
    console.error("CSV not found:", abs);
    process.exit(1);
  }
  const text = fs.readFileSync(abs, "utf8");
  const rows = parseCsv(text).filter((r) => r.length > 1);
  if (rows.length < 2) {
    console.error("CSV has no data rows");
    process.exit(1);
  }
  const idx = buildHeaderIndex(rows[0]);
  const data = rows.slice(1).filter((r) => get(r, idx, "api_id"));

  const checkedIn = data.filter((r) => isCheckedIn(r, idx));
  console.log(
    `CSV total rows: ${data.length}  |  checked in: ${checkedIn.length}`
  );

  const db = initFirebaseAdminFirestoreOrNull({ silent: false });
  if (!db) {
    console.error("No Firestore admin available");
    process.exit(2);
  }

  const FieldValue = require("firebase-admin").firestore.FieldValue;

  // Existing London attendees keyed by lowercase email
  const existing = new Map();
  const attendeesSnap = await db
    .collection("attendees")
    .where("projectId", "==", PROJECT_ID)
    .get();
  attendeesSnap.forEach((d) => {
    const x = d.data() || {};
    const e = String(x.email || "").trim().toLowerCase();
    if (e) existing.set(e, { id: d.id, data: x });
  });

  // Existing attendees keyed by lower-cased lumaApiId so we can update repeats
  const byLuma = new Map();
  attendeesSnap.forEach((d) => {
    const x = d.data() || {};
    const a = String(x.lumaApiId || "").trim();
    if (a) byLuma.set(a, { id: d.id, data: x });
  });

  // Free codes for the project
  const codesSnap = await db
    .collection("codes")
    .where("projectId", "==", PROJECT_ID)
    .where("isRedeemed", "==", false)
    .get();
  const freeCodes = codesSnap.docs.filter(
    (d) => !d.data().redeemedBy && !d.data().assignedTo
  );
  console.log(`Free codes in pool: ${freeCodes.length}`);

  let added = 0;
  let updatedCheckin = 0;
  let assignedCodes = 0;
  let alreadyHadCode = 0;
  let skippedNoCode = 0;
  const newRows = [];

  for (const r of checkedIn) {
    const name = get(r, idx, "name");
    const email = get(r, idx, "email").toLowerCase();
    const lumaApiId = get(r, idx, "api_id");
    const checkedAt = get(r, idx, "checked_in_at");
    if (!name || !email) continue;

    let attendeeRef;
    let attendeeData;
    const hit = existing.get(email) || byLuma.get(lumaApiId);
    if (hit) {
      attendeeRef = db.collection("attendees").doc(hit.id);
      attendeeData = { ...hit.data };
      // Bring check-in fields up to date
      const update = {
        checkedInAt: checkedAt,
        hasCheckedIn: true,
        lumaApiId,
        updatedAt: FieldValue.serverTimestamp(),
      };
      await attendeeRef.set(update, { merge: true });
      attendeeData = { ...attendeeData, ...update };
      updatedCheckin++;
    } else {
      attendeeRef = db.collection("attendees").doc();
      attendeeData = {
        projectId: PROJECT_ID,
        name,
        email,
        firstName: get(r, idx, "first_name"),
        lastName: get(r, idx, "last_name"),
        lumaApiId,
        approvalStatus: get(r, idx, "approval_status"),
        checkedInAt: checkedAt,
        hasCheckedIn: true,
        hasRedeemedCode: false,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      };
      await attendeeRef.set(attendeeData);
      added++;
      newRows.push({ attendeeId: attendeeRef.id, name, email });
    }

    if (attendeeData.hasRedeemedCode || attendeeData.redeemedCodeId) {
      alreadyHadCode++;
      continue;
    }

    const codeDoc = freeCodes.shift();
    if (!codeDoc) {
      skippedNoCode++;
      continue;
    }
    try {
      await db.runTransaction(async (tx) => {
        const codeRef = db.collection("codes").doc(codeDoc.id);
        const fresh = await tx.get(codeRef);
        const cd = fresh.data() || {};
        if (cd.isRedeemed || cd.redeemedBy) {
          throw new Error(`Code ${codeDoc.id} already taken`);
        }
        tx.update(codeRef, {
          isRedeemed: true,
          redeemedBy: attendeeRef.id,
          redeemedAt: FieldValue.serverTimestamp(),
        });
        tx.update(attendeeRef, {
          hasRedeemedCode: true,
          redeemedCodeId: codeDoc.id,
          redeemedAt: FieldValue.serverTimestamp(),
        });
        const redemptionRef = db.collection("redemptions").doc();
        tx.set(redemptionRef, {
          projectId: PROJECT_ID,
          attendeeId: attendeeRef.id,
          attendeeName: name,
          attendeeEmail: email,
          codeId: codeDoc.id,
          codeValue: cd.code,
          codeUrl: cd.cursorUrl,
          redeemedAt: FieldValue.serverTimestamp(),
          source: "csv-sync",
        });
      });
      assignedCodes++;
    } catch (e) {
      console.error(
        `  fail assign code for ${name} <${email}>:`,
        e.message || e
      );
      skippedNoCode++;
    }
  }

  console.log("\n=== sync summary ===");
  console.log(`  attendees added         : ${added}`);
  console.log(`  attendees check-in upd  : ${updatedCheckin}`);
  console.log(`  codes assigned          : ${assignedCodes}`);
  console.log(`  attendees w/ prior code : ${alreadyHadCode}`);
  console.log(`  skipped (no free code)  : ${skippedNoCode}`);
  if (newRows.length) {
    console.log("\nNew attendees:");
    for (const n of newRows) {
      console.log(`  + ${n.name} <${n.email}>`);
    }
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
