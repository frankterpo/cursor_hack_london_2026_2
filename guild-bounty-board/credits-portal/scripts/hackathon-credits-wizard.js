/**
 * OPS-ONLY interactive flow: ties together
 * — Luma (event + checked-in guests)
 * — Supabase hackathons row (segments guild submissions/judges)
 * — Firebase projects/{id} codes + attendees
 * — Cursor-provided CSV of referral URLs
 *
 * Run from credits-portal/:
 *   node scripts/hackathon-credits-wizard.js
 *
 * Requires credits-portal/.env.local:
 * NEXT_PUBLIC_FIREBASE_*, LUMA_COOKIE, SUPABASE_PROJECT_URL, SUPABASE_SERVICE_ROLE_SECRET
 */

const path = require("path");
const fs = require("fs");
require("dotenv").config({ path: path.join(__dirname, "..", ".env.local") });

const readline = require("node:readline/promises");
const { stdin: input, stdout: output } = require("node:process");

const { initializeApp } = require("firebase/app");
const {
  getFirestore,
  collection,
  getDocs,
  addDoc,
  query,
  where,
  doc,
  updateDoc,
  Timestamp,
} = require("firebase/firestore");

const {
  firebaseApp,
  runLumaCreditsSync,
  fetchLumaProfileEvents,
  hostingEventSummaries,
  fetchLumaEventGet,
  normalizeLumaCookie,
} = require("./lib/luma-sync-ops.js");
const { parseCodesCSV } = require("./lib/parse-codes-csv.cjs");
const { insertHackathon, patchHackathon } = require("./lib/supabase-hackathons.cjs");

function slugFromName(name) {
  let s = String(name || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  if (!s) s = `hack-${Date.now()}`;
  return s;
}

async function rlQuestion(rli, prompt) {
  const a = (await rli.question(prompt)).trim();
  return a;
}

async function promptIndex(rli, prompt, max) {
  for (;;) {
    const raw = await rlQuestion(rli, prompt);
    const n = Number.parseInt(raw, 10);
    if (
      Number.isFinite(n) &&
      n >= 1 &&
      n <= max &&
      String(n) === raw.trim()
    )
      return n - 1;
    console.log(`Enter a number 1–${max}.`);
  }
}

async function uploadCodesCsvFile(db, projectId, csvPath) {
  const abs = path.isAbsolute(csvPath)
    ? csvPath
    : path.join(process.cwd(), csvPath);
  if (!fs.existsSync(abs)) throw new Error(`CSV not found: ${abs}`);
  const fileContent = fs.readFileSync(abs, "utf-8");
  const parsedCodes = parseCodesCSV(fileContent);
  if (!parsedCodes.length)
    throw new Error("CSV has no recognizable cursor.com/referral?code= rows");

  const existingSnap = await getDocs(
    query(collection(db, "codes"), where("projectId", "==", projectId))
  );
  const existing = new Set(
    existingSnap.docs.map((d) => d.data().code).filter(Boolean)
  );
  const newCodes = parsedCodes.filter((c) => !existing.has(c.code));
  let added = 0;
  for (const row of newCodes) {
    await addDoc(collection(db, "codes"), {
      code: row.code,
      cursorUrl: row.cursorUrl,
      creator: row.creator,
      date: row.date,
      isRedeemed: false,
      projectId,
      createdAt: new Date(),
    });
    added += 1;
  }
  return {
    totalParsed: parsedCodes.length,
    added,
    skippedDup: parsedCodes.length - newCodes.length,
  };
}

async function listFirestoreProjects(app) {
  const db = getFirestore(app);
  const snap = await getDocs(collection(db, "projects"));
  const rows = [];
  for (const d of snap.docs) {
    const x = d.data();
    rows.push({
      id: d.id,
      name: x.name || "(unnamed)",
      slug: x.slug || "",
      supabaseHackathonId: x.supabaseHackathonId || "",
      status: x.status || "",
      lumaEventApiId: x.lumaEventApiId || "",
    });
  }
  rows.sort((a, b) => String(a.name).localeCompare(b.name));
  return { db, rows };
}

async function main() {
  const cookie = normalizeLumaCookie(process.env.LUMA_COOKIE);
  const { firebaseConfig, missing } = firebaseApp();
  if (!cookie)
    throw new Error(
      "Set LUMA_COOKIE in credits-portal/.env.local (authenticated api2.luma.com request Cookie)."
    );

  console.log(`
=== Cursor hackathon credits wizard (CLI, ops-only) ===
Links: Luma check-ins → Firebase codes/attendees → Supabase hackathons row.

`);

  const rli = readline.createInterface({ input, output });
  try {
    const modeAns = (
      await rlQuestion(
        rli,
        "Create NEW hackathon or UPDATE existing credits project?\n  [n] New  |  [u] Update : "
      )
    ).toLowerCase();
    const isNew = modeAns.startsWith("n");

    const lmUser = await rlQuestion(
      rli,
      `Luma profile username (${process.env.LUMA_USERNAME || "usr-…"} — Enter=luna env default): `
    );
    const username =
      lmUser ||
      process.env.LUMA_USERNAME?.trim() ||
      "usr-O4svXJrJEipJn5G";

    console.log("\nFetching Luma events_hosting...");
    const profile = await fetchLumaProfileEvents(username, cookie);

    const rows = hostingEventSummaries(profile);
    if (!rows.length && cookie)
      throw new Error(
        "No events_hosting with evt-* ids returned — verify LUMA_COOKIE and username."
      );
    rows.forEach((r, i) => {
      console.log(
        `  [${r.index}] ${r.eventApiId}\n       ${r.name}`
      );
    });

    let chosen = rows[await promptIndex(rli, "\nPick Luma event number: ", rows.length)];
    let eventTitle = chosen.name;
    try {
      const evt = await fetchLumaEventGet(chosen.eventApiId, cookie);
      const t =
        evt?.event?.name ||
        evt?.calendar?.name ||
        evt?.guest_data?.guests?.event?.name ||
        eventTitle;
      if (typeof t === "string" && t) eventTitle = t;
    } catch {
      /** keep heuristic title from hosting blob */
    }

    let projectIdFs = null;
    let hackathonId = null;
    let slug = null;

    if (isNew) {
      console.log("\n--- New Supabase hackathon + Firebase credits project ---\n");

      const defName =
        (await rlQuestion(rli, `Hackathon title [${eventTitle}]: `)) ||
        eventTitle;
      slug =
        (await rlQuestion(rli, `URL slug (lowercase hyphenated) [${slugFromName(defName)}]: `)) ||
        slugFromName(defName);

      const startsRaw =
        (await rlQuestion(
          rli,
          `starts_at ISO (${new Date().toISOString().slice(0, 16)}Z style): `
        )) || `${new Date(Date.now()).toISOString().slice(0, 10)}T00:00:00.000Z`;
      const endsRaw =
        (await rlQuestion(rli, "ends_at ISO: ")) ||
        `${new Date(Date.now() + 86400000 * 2).toISOString().slice(0, 16)}Z`;

      console.log("\nCreating hackathon row in Supabase...");
      let hRow;
      try {
        hRow = await insertHackathon({
          slug,
          name: defName,
          starts_at: startsRaw,
          ends_at: endsRaw,
          luma_event_api_id: chosen.eventApiId,
          luma_event_name: eventTitle,
        });
      } catch (e) {
        console.error(String(e.message || e));
        throw new Error(
          'Supabase INSERT failed — run migration 20260430153000_hackathons_luma_and_credits_firestore.sql (e.g. `npx supabase db push`).'
        );
      }
      hackathonId = hRow.id;

      console.log("\nProvisioning Firestore `projects/` doc...");
      if (missing.length) throw new Error("Missing Firebase env: " + missing.join(", "));
      const app = initializeApp(firebaseConfig);

      const projectRef = await addDoc(collection(getFirestore(app), "projects"), {
        name: defName,
        description: `Cursor credits — ${defName}`,
        slug: `cursor-${slug}`.slice(0, 120),
        status: "active",
        supabaseHackathonId: hackathonId,
        lumaEventApiId: chosen.eventApiId,
        lumaEventName: eventTitle,
        creditsSource: "hackathon-wizard",
        createdAt: Timestamp.now(),
        updatedAt: Timestamp.now(),
      });
      projectIdFs = projectRef.id;

      await patchHackathon(hackathonId, {
        credits_firestore_project_doc_id: projectIdFs,
        luma_event_api_id: chosen.eventApiId,
        luma_event_name: eventTitle,
      });

      console.log("\nFirestore project:", projectIdFs, `(slug preview cursor-${slug})`);
      console.log("Supabase hackathon id:", hackathonId);

      const csvFirst = await rlQuestion(
        rli,
        "\nPath to Cursor credit CSV (cursor.com/referral links). Enter to skip: "
      );
      const dbNew = getFirestore(app);
      if (csvFirst) {
        const u = await uploadCodesCsvFile(dbNew, projectIdFs, csvFirst);
        console.log(
          `Codes CSV: parsed=${u.totalParsed} added=${u.added} skipped_dup_existing_db=${u.skippedDup}`
        );
      }

      console.log("\nRunning Luma → attendees import + assigning codes (checked-in)...");

      await runLumaCreditsSync({
        firebaseAppInstance: app,
        projectId: projectIdFs,
        eventApiId: chosen.eventApiId,
        username,
        dryRun: false,
        skipUpsert: false,
        skipAssign: false,
        limitGuests: Infinity,
        assignScope: "all",
        firebaseDeps: { firebaseConfig, missing: [] },
      });

      console.log(
        "\nNext: optionally add analysis_settings row in Supabase for this hackathon (copy from sql seed), set DEFAULT_HACKATHON_ID on guild deploy."
      );
    } else {
      console.log("\n--- Update existing Firebase credits project ---\n");
      if (missing.length)
        throw new Error("Missing Firebase env: " + missing.join(", "));

      const app = initializeApp(firebaseConfig);
      const lp = await listFirestoreProjects(app);
      if (!lp.rows.length) throw new Error("No entries in Firestore projects/ collection.");

      lp.rows.forEach((r, i) => {
        console.log(
          `  [${i + 1}] ${r.name}  |  slug=${r.slug}\n       Firestore id=${r.id}`
        );
        if (r.supabaseHackathonId)
          console.log(`       Supabase hackathon_id=${r.supabaseHackathonId}`);
        if (r.lumaEventApiId) console.log(`       Luma ${r.lumaEventApiId}`);
      });

      const idxProj = await promptIndex(
        rli,
        `Pick Firebase project number (1-${lp.rows.length}): `,
        lp.rows.length
      );
      const pickP = lp.rows[idxProj];

      projectIdFs = pickP.id;
      hackathonId = pickP.supabaseHackathonId || null;

      const csvPath = await rlQuestion(
        rli,
        "\nPath to additional Cursor CSV (optional — Enter skip): "
      );

      if (csvPath) {
        const u = await uploadCodesCsvFile(lp.db, projectIdFs, csvPath);
        console.log(
          `Codes CSV: parsed=${u.totalParsed} added=${u.added} dup_skipped=${u.skippedDup}`
        );
      }

      if (hackathonId) {
        await patchHackathon(hackathonId, {
          luma_event_api_id: chosen.eventApiId,
          luma_event_name: eventTitle,
          credits_firestore_project_doc_id: projectIdFs,
        }).catch(() =>
          console.log(
            "Note: Could not PATCH hackathons row (run migrations or verify UUID)."
          )
        );
      }

      await updateDoc(doc(lp.db, "projects", projectIdFs), {
        lumaEventApiId: chosen.eventApiId,
        lumaEventName: eventTitle,
        updatedAt: Timestamp.now(),
      }).catch(() => {});

      console.log("\nSyncing attendees + assigning only NEW check-ins vs prior Firestore (late joiners)...");
      await runLumaCreditsSync({
        firebaseAppInstance: app,
        projectId: projectIdFs,
        eventApiId: chosen.eventApiId,
        username,
        dryRun: false,
        skipUpsert: false,
        skipAssign: false,
        limitGuests: Infinity,
        assignScope: "late_joiners_only",
        firebaseDeps: { firebaseConfig, missing: [] },
      });
    }
  } finally {
    await rli.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
