/**
 * Idempotently ensure a Firestore `projects` doc exists for London 2026 redemption
 * (slug matches /credits/event/cursor-hackathon-london-2026/redeem).
 *
 * Usage (from credits-portal/):
 *   node scripts/provision-london-2026-firebase-project.js
 *
 * Requires .env.local with NEXT_PUBLIC_FIREBASE_* (same as Next app).
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
  addDoc,
  Timestamp,
} = require("firebase/firestore");

const LONDON_SLUG = "cursor-hackathon-london-2026";
const LONDON_NAME = "Cursor × Briefcase — London 2026";
const SUPABASE_HACKATHON_ID = "a0000002-0000-4000-8000-000000000002";

const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
};

async function main() {
  const missing = Object.entries(firebaseConfig)
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length) {
    console.error("Missing env:", missing.join(", "));
    process.exit(1);
  }

  const app = initializeApp(firebaseConfig);
  const db = getFirestore(app);
  const projectsRef = collection(db, "projects");
  const q = query(projectsRef, where("slug", "==", LONDON_SLUG));
  const snap = await getDocs(q);

  if (!snap.empty) {
    const doc = snap.docs[0];
    console.log("Project already exists.");
    console.log("  id:", doc.id);
    console.log("  slug:", doc.data().slug);
    console.log("  supabaseHackathonId:", doc.data().supabaseHackathonId || "(not set)");
    return;
  }

  const now = Timestamp.now();
  const ref = await addDoc(projectsRef, {
    name: LONDON_NAME,
    description: "Cursor credits — London 2026",
    slug: LONDON_SLUG,
    status: "active",
    supabaseHackathonId: SUPABASE_HACKATHON_ID,
    eventDate: null,
    createdAt: now,
    updatedAt: now,
  });

  console.log("Created Firestore project for London 2026.");
  console.log("  id:", ref.id);
  console.log("  slug:", LONDON_SLUG);
  console.log("  supabaseHackathonId:", SUPABASE_HACKATHON_ID);
  console.log("Next: upload codes CSV in /credits/admin/uploads (select this project).");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
