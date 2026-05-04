/**
 * OPS: Import Luma “Guests” CSV export — rows with non-empty checked_in_at → Firestore attendees
 * (same upsert shape as Luma API sync) + optional automatic code assignment.
 *
 *   node scripts/luma-csv-checked-in-import.js \
 *     --project-id=<Firestore projects doc id> \
 *     --csv="/path/to/Guests Export.csv"
 *
 * Options: --dry-run, --skip-assign
 */

const fs = require("fs");
const path = require("path");
const { parse } = require("csv-parse/sync");
const { initializeApp } = require("firebase/app");
const { getFirestore } = require("firebase/firestore");

require("dotenv").config({ path: path.join(__dirname, "..", ".env.local") });

const {
  firebaseApp,
  upsertAttendeeFromLuma,
  assignCodesForEligibleAttendees,
  countPool,
  computeAttendeeBalances,
  normEmail,
} = require("./lib/luma-sync-ops.js");

function parseCli(argv) {
  const out = {
    projectId: "",
    csvPath: "",
    dryRun: false,
    skipAssign: false,
  };
  for (const a of argv) {
    if (a === "--dry-run") out.dryRun = true;
    else if (a === "--skip-assign") out.skipAssign = true;
    else if (a.startsWith("--project-id="))
      out.projectId = a.slice("--project-id=".length).trim();
    else if (a.startsWith("--csv=")) out.csvPath = a.slice("--csv=".length).trim();
  }
  if (out.csvPath.startsWith('"') && out.csvPath.endsWith('"'))
    out.csvPath = out.csvPath.slice(1, -1);
  return out;
}

function rowToGuest(row) {
  return {
    api_id: row.api_id || "",
    name: row.name || "",
    first_name: row.first_name ?? "",
    last_name: row.last_name ?? "",
    email: row.email || "",
    checked_in_at: row.checked_in_at || null,
    approval_status: row.approval_status || "",
  };
}

async function main() {
  const cli = parseCli(process.argv.slice(2));
  if (!cli.projectId) {
    console.error("Required: --project-id=<Firestore project document id>");
    process.exit(1);
  }
  if (!cli.csvPath) {
    console.error("Required: --csv=/path/to/luma-guests-export.csv");
    process.exit(1);
  }
  const abs = path.isAbsolute(cli.csvPath)
    ? cli.csvPath
    : path.resolve(process.cwd(), cli.csvPath);
  if (!fs.existsSync(abs)) {
    console.error("CSV not found:", abs);
    process.exit(1);
  }

  const { firebaseConfig, missing } = firebaseApp();
  if (!cli.dryRun && missing?.length) {
    console.error("Missing Firebase env:", missing.join(", "));
    process.exit(1);
  }

  const raw = fs.readFileSync(abs, "utf8");
  /** @type {Record<string,string>[]} */
  const rows = parse(raw, {
    columns: true,
    skip_empty_lines: true,
    relax_column_count: true,
    trim: true,
    bom: true,
  });

  const checkedIn = [];
  for (const row of rows) {
    const ts = String(row.checked_in_at || "").trim();
    if (!ts) continue;
    const g = rowToGuest(row);
    if (!normEmail(g.email)) {
      console.warn("Skip row (no email):", g.api_id || g.name || "(unknown)");
      continue;
    }
    checkedIn.push(g);
  }

  console.log("");
  console.log("=== Luma CSV → Firebase checked-in import (ops) ===");
  console.log(`CSV: ${abs}`);
  console.log(`Total CSV rows (with header excluded): ${rows.length}`);
  console.log(`Rows with checked_in_at + email: ${checkedIn.length}`);
  console.log(`projectId: ${cli.projectId}`);
  console.log(cli.dryRun ? "(dry-run: no writes)" : "");

  let app = null;
  let db = null;
  if (!cli.dryRun && firebaseConfig?.apiKey) {
    app = initializeApp(firebaseConfig);
    db = getFirestore(app);
  }

  let inserted = 0;
  let merged = 0;
  let skipped = 0;

  if (db) {
    for (const guest of checkedIn) {
      const r = await upsertAttendeeFromLuma(db, cli.projectId, guest, cli.dryRun);
      if (r.skipped) skipped += 1;
      else if (r.inserted) inserted += 1;
      else if (r.merged) merged += 1;
    }
  } else if (cli.dryRun) {
    console.log("(dry-run: would upsert", checkedIn.length, "guests)");
  }

  const poolBefore = db
    ? await countPool(db, cli.projectId)
    : { totalCodes: "?", availableCodes: "?" };
  let assignedThisRun = 0;
  if (!cli.skipAssign && db && !cli.dryRun) {
    assignedThisRun = await assignCodesForEligibleAttendees(db, cli.projectId, {
      dry: false,
      emailAllowlist: null,
    });
  } else if (cli.skipAssign) console.log("--skip-assign: code assignment skipped");

  const poolAfter =
    db && !cli.skipAssign && !cli.dryRun
      ? await countPool(db, cli.projectId)
      : poolBefore;
  const bal = db ? await computeAttendeeBalances(db, cli.projectId) : null;

  console.log("");
  console.log("--- Summary ---");
  if (!cli.dryRun && db) {
    console.log(`Inserted (new attendee docs): ${inserted}`);
    console.log(`Merged / updated: ${merged}`);
    console.log(`Skipped: ${skipped}`);
  }
  if (!cli.skipAssign && !cli.dryRun && db) {
    console.log(`Codes assigned this run: ${assignedThisRun}`);
    console.log(
      `Code pool: ${poolAfter.availableCodes} available / ${poolAfter.totalCodes} total`
    );
  }
  if (bal) {
    console.log(
      `Attendees: ${bal.attendeeDocs} docs — redeemed: ${bal.redeemedCount}, unredeemed Luma-eligible: ${bal.lumaUnredeemed}`
    );
  }
  console.log("");
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
