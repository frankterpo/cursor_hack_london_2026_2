/**
 * One-time migration: Supabase Storage JSON → PostgreSQL tables
 * Run from guild-bounty-board/: node migrations/migrate-storage-to-db.js
 */
const path = require("path");
// Load env from the public directory's .env.production
require("dotenv").config({ path: path.join(__dirname, "../.env.production") });

const { readJsonObject } = require("../public/api/_lib/storage");
const db = require("../public/api/_lib/db");

async function migrate() {
  console.log("Starting migration...\n");

  // 1. Submissions
  const subData = await readJsonObject("submissions.json", { submissions: [] });
  const submissions = subData.submissions || [];
  console.log(`Found ${submissions.length} submissions`);
  for (const s of submissions) {
    try {
      await db.upsertSubmission(s);
      console.log(`  + ${s.project_name || s.repo_key}`);
    } catch (err) {
      console.error(`  ! Failed: ${s.repo_key}: ${err.message}`);
    }
  }

  // 2. Judge responses
  const judgeData = await readJsonObject("judges.json", { responses: [] });
  const responses = judgeData.responses || [];
  console.log(`\nFound ${responses.length} judge responses`);
  for (const r of responses) {
    try {
      await db.upsertJudgeResponse(r);
      console.log(`  + ${r.judge_name} → ${r.project_name}`);
    } catch (err) {
      console.error(`  ! Failed: ${r.judge_name}/${r.repo_key}: ${err.message}`);
    }
  }

  // 3. Analyses
  const analysisData = await readJsonObject("analysis.json", { by_repo: {} });
  const repos = Object.entries(analysisData.by_repo || {});
  console.log(`\nFound ${repos.length} analyses`);
  for (const [repoKey, data] of repos) {
    try {
      await db.upsertAnalysis(repoKey, data);
      console.log(`  + ${repoKey}`);
    } catch (err) {
      console.error(`  ! Failed: ${repoKey}: ${err.message}`);
    }
  }

  // 4. Settings
  const settings = await readJsonObject("analysis-settings.json", null);
  if (settings) {
    console.log("\nMigrating settings...");
    try {
      await db.upsertAnalysisSettings(settings);
      console.log("  + Settings saved");
    } catch (err) {
      console.error(`  ! Settings failed: ${err.message}`);
    }
  }

  console.log("\nMigration complete!");
  process.exit(0);
}

migrate().catch(err => {
  console.error("Migration failed:", err);
  process.exit(1);
});
