/**
 * Luma event guest counts from api2.luma.com/event/admin/get-guests (host session).
 *
 *   node scripts/luma-guest-stats.js
 *   node scripts/luma-guest-stats.js --event-api-id=evt-xxxxxxxx
 *   node scripts/luma-guest-stats.js --match-hosting=London
 *
 * Env: LUMA_COOKIE (required), optional LUMA_USERNAME
 */
const path = require("path");
require("dotenv").config({
  path: path.join(__dirname, "..", ".env.local"),
});

const {
  fetchHostingEventApi,
  fetchAllEventGuests,
  isLumaCheckedIn,
  normalizeLumaCookie,
  pick,
} = require("./lib/luma-sync-ops.js");

function parseArgs() {
  const out = {};
  for (const a of process.argv.slice(2)) {
    if (a.startsWith("--event-api-id="))
      out.eventApiId = a.slice("--event-api-id=".length).trim();
    else if (a.startsWith("--match-hosting="))
      out.matchSubstring = a.slice("--match-hosting=".length).trim();
    else if (a.startsWith("--username="))
      out.username = a.slice("--username=".length).trim();
  }
  return out;
}

function main() {
  const cli = parseArgs();
  const cookie = normalizeLumaCookie(process.env.LUMA_COOKIE);
  const username =
    cli.username ||
    process.env.LUMA_USERNAME?.trim() ||
    "usr-O4svXJrJEipJn5G";

  const { eventApiId, matchSubstring } = cli;

  if (!cookie) {
    console.error("Set LUMA_COOKIE in credits-portal/.env.local");
    process.exit(1);
  }

  (async () => {
    const evt = await fetchHostingEventApi({
      cookie,
      username,
      eventApiId,
      matchSubstring,
    });
    console.log(`event_api_id: ${evt}\n`);

    const { entries, pages } = await fetchAllEventGuests(evt, cookie);

    /** @type {Record<string, number>} */
    const byStatus = {};
    let checkedIn = 0;
    for (const e of entries) {
      const s = String(
        pick(e, "approval_status", "approvalStatus") ?? ""
      ).trim();
      const key = s || "(empty)";
      byStatus[key] = (byStatus[key] || 0) + 1;
      if (isLumaCheckedIn(e)) checkedIn += 1;
    }

    const sorted = Object.entries(byStatus).sort((a, b) => b[1] - a[1]);

    const approvedNorm = (k) =>
      /^approved$/i.test(k) ||
      /^accepted$/i.test(k) ||
      k.toLowerCase() === "going";

    const acceptedLike = sorted
      .filter(([k]) => approvedNorm(k))
      .reduce((acc, [, n]) => acc + n, 0);

    console.log(`API pages fetched: ${pages}`);
    console.log(`Total guests (rows): ${entries.length}`);
    console.log(
      `Guests checked in (non-empty checked_in_at): ${checkedIn}`
    );
    console.log(
      `\nSubset "accepted-like" (approval_status approved|accepted|going): ${acceptedLike}`
    );
    console.log("\napproval_status breakdown:");
    for (const [status, n] of sorted) {
      console.log(`  ${status}: ${n}`);
    }
  })().catch((e) => {
    console.error(e.message || String(e));
    process.exit(1);
  });
}

main();
