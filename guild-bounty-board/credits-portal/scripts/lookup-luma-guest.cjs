#!/usr/bin/env node
/**
 * Look up Luma guest(s) by partial name/email. Prints exact name and check-in.
 *   node scripts/lookup-luma-guest.cjs "catie"
 */
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env.local") });

const {
  fetchHostingEventApi,
  fetchAllEventGuests,
  isLumaCheckedIn,
  normalizeLumaCookie,
  pick,
} = require("./lib/luma-sync-ops.js");

async function main() {
  const needle = (process.argv[2] || "").trim().toLowerCase();
  if (!needle) {
    console.error("Usage: node scripts/lookup-luma-guest.cjs <substring>");
    process.exit(1);
  }
  const cookie = normalizeLumaCookie(process.env.LUMA_COOKIE);
  if (!cookie) {
    console.error("Set LUMA_COOKIE in .env.local");
    process.exit(1);
  }
  const username = process.env.LUMA_USERNAME?.trim() || "usr-O4svXJrJEipJn5G";
  const evt = await fetchHostingEventApi({
    cookie,
    username,
    matchSubstring: process.env.LUMA_EVENT_MATCH || "London",
  });
  const { entries } = await fetchAllEventGuests(evt, cookie);
  const hits = entries
    .filter((e) => {
      const name = String(pick(e, "name", "user_name", "userName") || "").toLowerCase();
      const email = String(pick(e, "email", "user_email") || "").toLowerCase();
      return name.includes(needle) || email.includes(needle);
    })
    .map((e) => ({
      name: pick(e, "name", "user_name", "userName"),
      email: pick(e, "email", "user_email"),
      approval_status: pick(e, "approval_status", "approvalStatus"),
      checked_in_at: pick(e, "checked_in_at", "checkedInAt"),
      api_id: pick(e, "api_id", "apiId"),
      isLumaCheckedIn: isLumaCheckedIn(e),
    }));
  console.log(JSON.stringify({ event_api_id: evt, count: hits.length, hits }, null, 2));
}

main().catch((e) => {
  console.error(e.message || String(e));
  process.exit(1);
});
