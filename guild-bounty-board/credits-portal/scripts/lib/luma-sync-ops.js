/**
 * Shared Luma → Firestore attendee import + Cursor code assignment (ops tooling).
 */

const LUMA_ORIGIN = "https://api2.luma.com";

const { initializeApp } = require("firebase/app");
const {
  getFirestore,
  collection,
  query,
  where,
  getDocs,
  doc,
  addDoc,
  runTransaction,
  updateDoc,
  Timestamp,
} = require("firebase/firestore");

function pick(obj, ...keys) {
  if (!obj) return undefined;
  for (const k of keys) {
    if (obj[k] != null && obj[k] !== "") return obj[k];
  }
  return undefined;
}

/** Strip outer quotes from .env paste; Luma admin API requires the full Cookie header string. */
function normalizeLumaCookie(raw) {
  let c = String(raw ?? "").trim();
  if (
    (c.startsWith("'") && c.endsWith("'")) ||
    (c.startsWith('"') && c.endsWith('"'))
  )
    c = c.slice(1, -1).trim();
  return c;
}

async function lumaFetch(url, cookieHeader) {
  const origin =
    process.env.LUMA_ORIGIN_HEADER || "https://luma.com";
  const referer =
    process.env.LUMA_REFERER ||
    `${origin.replace(/\/$/, "")}/`;
  const res = await fetch(url, {
    headers: {
      accept: "application/json",
      ...(cookieHeader
        ? { cookie: cookieHeader, Cookie: cookieHeader }
        : {}),
      "accept-language": process.env.LUMA_ACCEPT_LANGUAGE || "en-US,en;q=0.9",
      "user-agent":
        process.env.LUMA_USER_AGENT ||
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      referer,
      origin,
    },
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = null;
  }
  if (!res.ok) {
    let hint = "";
    if (res.status === 401 && String(url).includes("/event/admin/")) {
      hint =
        "\n\nHint: /user/profile/events may work without a session, but /event/admin/get-guests does not.\n" +
        "Use the FULL Cookie string from DevTools on an api2.luma.com request (or pnpm ops:luma:cookie-from-chrome).\n" +
        "In .env.local use LUMA_COOKIE=... with no surrounding quotes, or a single double-quoted value.\n" +
        "Re-copy from a tab open at https://luma.com/event/manage/.../guests while logged in as host, then run sync immediately (cf_bm cookies expire).";
    }
    const err = new Error(
      `Luma HTTP ${res.status} ${res.statusText} for ${url}\n${text.slice(0, 500)}${hint}`
    );
    err.status = res.status;
    throw err;
  }
  return json;
}

/** Extract evt-* from arbitrary hosting blob */
function extractEventApiCandidates(entry, depth = 0) {
  if (!entry || depth > 6) return [];
  const out = [];
  if (typeof entry === "object") {
    for (const k of ["api_id", "event_api_id", "eventId"]) {
      const v = entry[k];
      if (typeof v === "string" && v.startsWith("evt-")) out.push(v);
    }
    if (entry.event)
      out.push(...extractEventApiCandidates(entry.event, depth + 1));
    if (entry.calendar)
      out.push(...extractEventApiCandidates(entry.calendar, depth + 1));
  }
  return [...new Set(out)];
}

function stringifyEntry(entry) {
  try {
    return JSON.stringify(entry);
  } catch {
    return "";
  }
}

function hostingEventSummaries(profile) {
  const hosting =
    profile.events_hosting || profile.eventsHosting || [];
  const rows = [];
  for (let i = 0; i < hosting.length; i++) {
    const h = hosting[i];
    const evtIds = extractEventApiCandidates(h);
    const evt = evtIds[0] || null;
    const name =
      pick(h, "name") ||
      pick(h?.event || {}, "name") ||
      pick(h?.calendar || {}, "name") ||
      (evtIds[0]
        ? `Event (${evtIds[0]})`
        : "(unknown title)");
    if (evt) rows.push({ index: rows.length + 1, eventApiId: evt, name, raw: h });
  }
  return rows;
}

async function fetchLumaProfileEvents(username, cookie) {
  const u = `${LUMA_ORIGIN}/user/profile/events?username=${encodeURIComponent(
    username
  )}`;
  return lumaFetch(u, cookie);
}

async function fetchLumaEventGet(eventApiId, cookie) {
  const url = `${LUMA_ORIGIN}/event/get?event_api_id=${encodeURIComponent(
    eventApiId
  )}`;
  return lumaFetch(url, cookie);
}

function pickHostingEventApiId(profile, matchSubstring) {
  const hosting = profile.events_hosting || profile.eventsHosting || [];
  if (!hosting.length)
    throw new Error("No events_hosting entries in profile/events response");

  if (matchSubstring) {
    const needle = matchSubstring.toLowerCase();
    for (const h of hosting) {
      const blob = stringifyEntry(h).toLowerCase();
      if (blob.includes(needle)) {
        const c = extractEventApiCandidates(h);
        if (c[0]) return c[0];
      }
    }
    throw new Error(
      `--match-hosting="${matchSubstring}" did not match any events_hosting entry with an evt-* id`
    );
  }

  for (const h of hosting) {
    const c = extractEventApiCandidates(h);
    if (c[0]) return c[0];
  }
  throw new Error(
    "Could not resolve an evt-* id from events_hosting[]. Pass --event-api-id=evt-..."
  );
}

async function fetchHostingEventApi(opts) {
  const { cookie, eventApiId } = opts;
  if (eventApiId) return eventApiId;
  const profile = await fetchLumaProfileEvents(opts.username, cookie);
  return pickHostingEventApiId(profile, opts.matchSubstring);
}

function isLumaCheckedIn(entry) {
  const checkedRaw = pick(entry, "checked_in_at", "checkedInAt");
  if (checkedRaw == null || checkedRaw === "") return false;
  if (typeof checkedRaw === "string" && checkedRaw.startsWith("0001"))
    return false;
  return true;
}

async function fetchAllCheckedInGuests(eventApiId, cookie, limitGuests) {
  const out = [];
  let paginationCursor = null;
  let pages = 0;

  for (;;) {
    const url = new URL(`${LUMA_ORIGIN}/event/admin/get-guests`);
    url.searchParams.set("event_api_id", eventApiId);
    url.searchParams.set("pagination_limit", "100");
    if (paginationCursor)
      url.searchParams.set("pagination_cursor", paginationCursor);
    url.searchParams.set("query", "");
    url.searchParams.set("sort_column", "registered_or_created_at");
    url.searchParams.set("sort_direction", "desc");

    const chunk = await lumaFetch(url.toString(), cookie);
    pages += 1;
    const entries = chunk.entries || [];
    for (const e of entries) {
      if (!isLumaCheckedIn(e)) continue;
      out.push(e);
      if (out.length >= limitGuests) return { checkedIn: out, pages };
    }

    paginationCursor =
      chunk.next_cursor ??
      chunk.nextCursor ??
      chunk.pagination_cursor ??
      null;
    const hasMore = chunk.has_more === true || chunk.hasMore === true;
    if (entries.length === 0 || (!paginationCursor && !hasMore)) break;
    if (entries.length < 100 && !paginationCursor) break;
    if (!paginationCursor) break;
  }

  return { checkedIn: out, pages };
}

/** All guest rows from admin get-guests (paginated). */
async function fetchAllEventGuests(eventApiId, cookie) {
  const out = [];
  let paginationCursor = null;
  let pages = 0;

  for (;;) {
    const url = new URL(`${LUMA_ORIGIN}/event/admin/get-guests`);
    url.searchParams.set("event_api_id", eventApiId);
    url.searchParams.set("pagination_limit", "100");
    if (paginationCursor)
      url.searchParams.set("pagination_cursor", paginationCursor);
    url.searchParams.set("query", "");
    url.searchParams.set("sort_column", "registered_or_created_at");
    url.searchParams.set("sort_direction", "desc");

    const chunk = await lumaFetch(url.toString(), cookie);
    pages += 1;
    const entries = chunk.entries || [];
    for (const e of entries) out.push(e);

    paginationCursor =
      chunk.next_cursor ??
      chunk.nextCursor ??
      chunk.pagination_cursor ??
      null;
    const hasMore = chunk.has_more === true || chunk.hasMore === true;
    if (entries.length === 0 || (!paginationCursor && !hasMore)) break;
    if (entries.length < 100 && !paginationCursor) break;
    if (!paginationCursor) break;
  }

  return { entries: out, pages };
}

function normEmail(em) {
  return String(em || "")
    .trim()
    .toLowerCase();
}

function displayName(entry) {
  const fn = pick(entry, "first_name", "firstName", "FirstName") || "";
  const ln = pick(entry, "last_name", "lastName", "LastName") || "";
  const glued = `${fn} ${ln}`.trim();
  const n = pick(entry, "name", "full_name") || glued;
  return String(n || "unknown").slice(0, 200);
}

/** Previous Firestore doc had meaningful check-in (not first time today). */
function priorHadCheckedInFirestore(prior) {
  const c = prior?.checkedInAt;
  if (c == null || c === "") return false;
  if (typeof c?.toDate === "function") {
    const d = c.toDate();
    if (!d || Number.isNaN(d.getTime())) return false;
    if (d.getFullYear() < 1900) return false;
    return true;
  }
  if (typeof c === "string") {
    if (c.startsWith("0001")) return false;
    return c.length > 4;
  }
  return !!c;
}

async function upsertAttendeeFromLuma(db, projectId, g, dry) {
  const email = normEmail(pick(g, "email", "user_email"));
  if (!email) return { skipped: true, reason: "no-email" };

  const name = displayName(g);
  const attendeesRef = collection(db, "attendees");

  const q = query(
    attendeesRef,
    where("projectId", "==", projectId),
    where("email", "==", email)
  );

  const existing = await getDocs(q);
  const row = {
    name,
    email,
    projectId,
    firstName: pick(g, "first_name", "firstName") || "",
    lastName: pick(g, "last_name", "lastName") || "",
    checkedInAt: pick(g, "checked_in_at", "checkedInAt") || null,
    approvalStatus: pick(g, "approval_status", "approvalStatus") || "",
    source: "luma",
    lumaGuestApiId: pick(g, "api_id", "guest_api_id") || null,
    lumaEligibleCheckedIn: true,
    importedAtIso: new Date().toISOString(),
    hasRedeemedCode: false,
  };

  /** True if this attendee *newly became* checked-in vs our last stored checkedInAt — for late-joiner code assignment scope. */
  let newCheckedInEligible = false;

  if (existing.empty) {
    newCheckedInEligible = true;
    if (!dry)
      await addDoc(attendeesRef, {
        ...row,
        createdAt: Timestamp.now(),
      });
    return {
      inserted: true,
      newCheckedInEligible,
      merged: false,
      emailNorm: email,
    };
  }

  const d = existing.docs[0];
  const prior = d.data();
  /** First Firestore-recorded check-in transitions null → timestamp */
  const transCheckIn =
    !priorHadCheckedInFirestore(prior) &&
    !!(row.checkedInAt || pick(g, "checked_in_at"));

  /** Do not downgrade redemption state via sync. */
  if (prior.hasRedeemedCode === true || prior.redeemedAt) {
    if (!dry) {
      await updateDoc(doc(db, "attendees", d.id), {
        firstName: row.firstName,
        lastName: row.lastName,
        checkedInAt: row.checkedInAt,
        approvalStatus: row.approvalStatus,
        lumaGuestApiId: row.lumaGuestApiId,
        lumaEligibleCheckedIn: true,
        importedAtIso: row.importedAtIso,
      });
    }
    return {
      merged: true,
      alreadyRedeemed: true,
      newCheckedInEligible: false,
      emailNorm: email,
    };
  }

  newCheckedInEligible = transCheckIn || false;

  if (!dry) {
    await updateDoc(doc(db, "attendees", d.id), {
      name: row.name,
      firstName: row.firstName,
      lastName: row.lastName,
      checkedInAt: row.checkedInAt,
      approvalStatus: row.approvalStatus,
      lumaGuestApiId: row.lumaGuestApiId,
      lumaEligibleCheckedIn: true,
      importedAtIso: row.importedAtIso,
    });
  }
  return {
    merged: true,
    alreadyRedeemed: false,
    newCheckedInEligible,
    emailNorm: email,
  };
}

async function countPool(db, projectId) {
  const codesRef = collection(db, "codes");
  const all = await getDocs(
    query(codesRef, where("projectId", "==", projectId))
  );
  let total = 0;
  let available = 0;
  for (const d of all.docs) {
    total += 1;
    const isR = !!d.data().isRedeemed;
    if (!isR) available += 1;
  }
  return { totalCodes: total, availableCodes: available };
}

async function assignCodesForEligibleAttendees(
  db,
  projectId,
  options
) {
  const { dry, emailAllowlist } = options;
  const attendeesRef = collection(db, "attendees");
  const snap = await getDocs(
    query(attendeesRef, where("projectId", "==", projectId))
  );

  let pendingDocs = [];
  for (const d of snap.docs) {
    const x = d.data();
    const unredeemed = !x.hasRedeemedCode;
    const eligibleFlag =
      x.lumaEligibleCheckedIn === true ||
      x.source === "luma" ||
      !!x.lumaGuestApiId;
    if (!unredeemed) continue;
    if (!eligibleFlag) continue;
    /** Only pair Cursor referral links with people who actually checked in (Luma or Firebase). */
    if (!priorHadCheckedInFirestore(x)) continue;
    const em = normEmail(x.email);
    if (emailAllowlist && !emailAllowlist.has(em)) continue;
    pendingDocs.push(d);
  }

  pendingDocs.sort((a, b) =>
    String(a.data().email).localeCompare(b.data().email)
  );

  if (dry) return pendingDocs.length;

  let assigned = 0;
  const codesRef = collection(db, "codes");
  const codeQuery = query(
    codesRef,
    where("projectId", "==", projectId),
    where("isRedeemed", "==", false)
  );

  for (const attendeeDoc of pendingDocs) {
    const attendeeRef = attendeeDoc.ref;

    for (;;) {
      const codeSnap = await getDocs(codeQuery);
      if (codeSnap.empty) return assigned;

      const codeDoc = codeSnap.docs[0];
      const codeDataPrefetch = codeDoc.data();

      let finishedThisAttendee = false;
      try {
        await runTransaction(db, async (tx) => {
          const attendeeSnapFresh = await tx.get(attendeeRef);
          const adata = attendeeSnapFresh.data();
          if (!adata || adata.hasRedeemedCode) {
            finishedThisAttendee = true;
            return;
          }

          const codeSnapFresh = await tx.get(codeDoc.ref);
          const cd = codeSnapFresh.data();
          if (!cd || cd.isRedeemed) return;

          const redemptionRef = doc(collection(db, "redemptions"));

          tx.update(codeDoc.ref, {
            isRedeemed: true,
            redeemedBy: attendeeRef.id,
            redeemedAt: new Date(),
          });

          tx.update(attendeeRef, {
            hasRedeemedCode: true,
            redeemedCodeId: codeDoc.id,
            redeemedAt: new Date(),
            assignedByOps: true,
            assignedAtOps: new Date().toISOString(),
          });

          tx.set(redemptionRef, {
            projectId,
            attendeeName: String(adata.name || "").trim(),
            attendeeEmail: String(adata.email || "").trim(),
            attendeeId: attendeeRef.id,
            codeId: codeDoc.id,
            codeValue: codeDataPrefetch.code || "",
            codeUrl: cd.cursorUrl || cd.cursor_url || "",
            redeemedAt: new Date(),
            timestamp: new Date(),
            ipAddress: "luma-checked-in-sync",
            userAgent: "luma-firebase-checked-in-sync",
          });

          assigned += 1;
          finishedThisAttendee = true;
        });
      } catch (e) {
        throw e;
      }
      if (finishedThisAttendee) break;
    }
  }

  return assigned;
}

async function computeAttendeeBalances(db, projectId) {
  const snap = await getDocs(
    query(collection(db, "attendees"), where("projectId", "==", projectId))
  );
  let redeemed = 0;
  let notRed = 0;
  let lumaUnredeemed = 0;
  for (const d of snap.docs) {
    const x = d.data();
    if (x.hasRedeemedCode) redeemed += 1;
    else {
      notRed += 1;
      const lumaTagged =
        x.lumaEligibleCheckedIn === true ||
        x.source === "luma" ||
        !!x.lumaGuestApiId;
      if (lumaTagged && priorHadCheckedInFirestore(x)) lumaUnredeemed += 1;
    }
  }
  return {
    attendeeDocs: snap.size,
    redeemedCount: redeemed,
    unattributed: notRed,
    lumaUnredeemed,
  };
}

/**
 * Full sync run (printed summary to stdout). Options align with CLI.
 */
async function runLumaCreditsSync(cli) {
  const deps = cli.firebaseDeps || firebaseApp();
  const { firebaseConfig, missing } = deps;
  if (!cli.projectId)
    throw new Error("--project-id=<Firestore projects doc id>");
  if (!cli.dryRun && missing?.length)
    throw new Error("Missing Firebase env: " + missing.join(", "));
  const cookie = normalizeLumaCookie(process.env.LUMA_COOKIE);
  if (!cookie) throw new Error("Set LUMA_COOKIE in credits-portal/.env.local");
  if (cookie.length < 80) {
    console.warn(
      `Warning: LUMA_COOKIE is only ${cookie.length} characters — expected a long browser Cookie header.\n` +
        `If sync fails with 401, paste the full string from DevTools (Request Headers → cookie), not just luma.auth-session-key.\n`
    );
  }

  let app = cli.firebaseAppInstance || null;
  if (
    !app &&
    firebaseConfig?.apiKey &&
    !(cli.dryRun === true && (missing?.length || 0) > 0)
  ) {
    app = initializeApp(firebaseConfig);
  }
  const db = app ? getFirestore(app) : null;

  console.log("");
  console.log("=== Luma → Firebase Cursor credits sync (CLI, ops-only) ===\n");

  const eventApiId = await fetchHostingEventApi({
    cookie,
    username: cli.username || process.env.LUMA_USERNAME || "usr-O4svXJrJEipJn5G",
    eventApiId: cli.eventApiId,
    matchSubstring: cli.matchSubstring,
  });
  console.log("Luma event_api_id:", eventApiId);

  const gf = await fetchAllCheckedInGuests(
    eventApiId,
    cookie,
    cli.limitGuests || Infinity
  );
  const checkedIn = gf.checkedIn;
  console.log(
    `Luma guest fetch: ${gf.pages} page(s), checked-in-eligible rows: ${checkedIn.length}`
  );

  let inserted = 0;
  let merged = 0;
  const lateJoinerEmails =
    cli.assignScope === "late_joiners_only"
      ? new Set()
      : null;

  if (!cli.skipUpsert && db) {
    for (const guest of checkedIn) {
      const r = await upsertAttendeeFromLuma(db, cli.projectId, guest, cli.dryRun);
      if (r.inserted) inserted += 1;
      if (r.merged) merged += 1;
      if (lateJoinerEmails && r.newCheckedInEligible && r.emailNorm)
        lateJoinerEmails.add(r.emailNorm);
    }
  } else if (cli.skipUpsert)
    console.log("--skip-upsert: attendee upsert skipped");

  const poolBefore = db
    ? await countPool(db, cli.projectId)
    : { totalCodes: "?", availableCodes: "?" };
  let assignedThisRun = 0;

  const emailAllow =
    cli.assignScope === "late_joiners_only" &&
    cli.skipUpsert !== true &&
    db
      ? lateJoinerEmails
      : null;

  if (!cli.skipAssign && db) {
    assignedThisRun = await assignCodesForEligibleAttendees(
      db,
      cli.projectId,
      {
        dry: cli.dryRun,
        emailAllowlist: emailAllow,
      }
    );
  } else if (cli.skipAssign) console.log("--skip-assign: code assignment skipped");

  const poolAfter =
    db && !cli.skipAssign && !cli.dryRun
      ? await countPool(db, cli.projectId)
      : poolBefore;
  const bal = db ? await computeAttendeeBalances(db, cli.projectId) : null;

  console.log("");
  console.log("--- Summary ---");
  console.log(`Firestore projectId (codes/attendees): ${cli.projectId}`);
  if (cli.assignScope === "late_joiners_only") {
    console.log("Assignment scope: late joiners only (new check-ins vs stored checkedInAt)");
    console.log(
      `Distinct late‑join emails tracked this run (for allowance): ${lateJoinerEmails ? lateJoinerEmails.size : 0}`
    );
  } else
    console.log(
      "Assignment scope: all unredeemed Luma-eligible attendees with checkedInAt set"
    );
  console.log(`Luma checked-in guests considered: ${checkedIn.length}`);
  if (!cli.skipUpsert && !cli.dryRun && db) {
    console.log(`Inserted attendees (new docs): ${inserted}`);
    console.log(`Merged / touched docs: ${merged}`);
  }
  if (!cli.skipUpsert && cli.dryRun)
    console.log(
      `(dry-run) would insert/merge attendee rows (${inserted + merged} previews)`
    );

  console.log("");
  console.log("Code pool:");
  console.log(`  Codes total for project (before summary): ${poolBefore.totalCodes}`);
  console.log(`  Available unredeemed (before run): ${poolBefore.availableCodes}`);

  if (!cli.skipAssign && db !== null) {
    const label = cli.dryRun
      ? "eligible attendees (dry-run count)"
      : "codes redeemed this run";
    console.log(`  ${label}: ${assignedThisRun}`);
  } else console.log(`  Assignment: skipped or no Firebase`);

  console.log(`  Codes available after run: ${poolAfter.availableCodes}`);

  if (bal) {
    console.log("");
    console.log("Attendees:");
    console.log(`  Total attendee docs under projectId: ${bal.attendeeDocs}`);
    console.log(`  Already redeemed flag: ${bal.redeemedCount}`);
    console.log(`  Unredeemed (any origin): ${bal.unattributed}`);
    console.log(
      `  Unredeemed with Luma import flags (eligible for courtesy): ${bal.lumaUnredeemed}`
    );
  }

  console.log("");
  console.log(
    "Done. This script is not routed from the credits UI — run only from ops."
  );

  return {
    eventApiId,
    checkedInTotal: checkedIn.length,
    inserted,
    merged,
    assignedThisRun,
    poolBefore,
    poolAfter,
    balances: bal,
  };
}

function firebaseApp() {
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
  return { firebaseConfig, missing };
}

function parseCliArgsSync() {
  const out = {
    projectId: null,
    eventApiId: null,
    username: process.env.LUMA_USERNAME || "usr-O4svXJrJEipJn5G",
    matchSubstring: null,
    dryRun: false,
    skipUpsert: false,
    skipAssign: false,
    limitGuests: Infinity,
    assignScope: "all",
  };
  for (const a of process.argv.slice(2)) {
    if (a === "--dry-run") out.dryRun = true;
    else if (a === "--skip-upsert") out.skipUpsert = true;
    else if (a === "--skip-assign") out.skipAssign = true;
    else if (a.startsWith("--project-id="))
      out.projectId = a.slice("--project-id=".length).trim();
    else if (a.startsWith("--event-api-id="))
      out.eventApiId = a.slice("--event-api-id=".length).trim();
    else if (a.startsWith("--username="))
      out.username = a.slice("--username=".length).trim();
    else if (a.startsWith("--match-hosting="))
      out.matchSubstring = a.slice("--match-hosting=".length).trim();
    else if (a.startsWith("--limit="))
      out.limitGuests = Number(a.slice("--limit=".length).trim()) || Infinity;
    else if (a.startsWith("--assign-scope=")) {
      const v = a.slice("--assign-scope=".length).trim();
      if (v === "late_joiners_only" || v === "all") out.assignScope = v;
      else console.warn("Ignoring unknown --assign-scope (use all|late_joiners_only)");
    } else if (a === "--help" || a === "-h") {
      console.log(`Usage:
  node scripts/luma-firebase-checked-in-sync.js --project-id=<Firestore projects/{id}> [options]

Options:
  --event-api-id=evt-...           Skip discovery; use this Luma event id
  --username=usr-...               Luma username for profile/events
  --match-hosting=Substring       Pick events_hosting entry whose JSON includes substring
  --assign-scope=all|late_joiners_only  Default all — late_joiners_only only assigns unredeemed
                                     emails that *newly* gained checkedInAt vs prior Firestore
  --dry-run                        No Firestore writes
  --skip-upsert                   Skip attendee upsert
  --skip-assign                   Skip code assignment
  --limit=N

Env: LUMA_COOKIE (required)`);
      process.exit(0);
    }
  }
  return out;
}

module.exports = {
  LUMA_ORIGIN,
  normalizeLumaCookie,
  lumaFetch,
  fetchHostingEventApi,
  fetchLumaProfileEvents,
  hostingEventSummaries,
  fetchAllCheckedInGuests,
  fetchAllEventGuests,
  isLumaCheckedIn,
  upsertAttendeeFromLuma,
  assignCodesForEligibleAttendees,
  countPool,
  computeAttendeeBalances,
  runLumaCreditsSync,
  firebaseApp,
  parseCliArgsSync,
  normEmail,
  pick,
  fetchLumaEventGet,
};
