/**
 * OPS ONLY — Thin CLI over scripts/lib/luma-sync-ops.js
 *
 *   node scripts/luma-firebase-checked-in-sync.js --project-id=<projects/{id}>
 */

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env.local") });

const {
  runLumaCreditsSync,
  firebaseApp,
  parseCliArgsSync,
} = require("./lib/luma-sync-ops.js");

async function main() {
  const cli = parseCliArgsSync();
  cli.firebaseDeps = firebaseApp();

  if (!cli.projectId) {
    console.error("Required: --project-id=<Firestore project document id>");
    process.exit(1);
  }
  if (!cli.dryRun && cli.firebaseDeps.missing?.length) {
    console.error("Missing Firebase env:", cli.firebaseDeps.missing.join(", "));
    process.exit(1);
  }

  try {
    await runLumaCreditsSync(cli);
  } catch (e) {
    console.error(e.message || e);
    process.exit(1);
  }
}

main();
