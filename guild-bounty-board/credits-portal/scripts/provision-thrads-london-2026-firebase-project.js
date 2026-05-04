/**
 * Idempotently ensure a Firestore `projects` doc exists for the
 * Cursor × Thrads London 2026 redemption flow in the new Firebase project
 * (`cursor-thrads-london-2026`).
 *
 * Also seeds bootstrap docs in `attendees` and `codes` collections so they
 * exist as first-class collections in the Firebase console (Firestore creates
 * them lazily on first write).
 *
 * Usage (from credits-portal/):
 *   node scripts/provision-thrads-london-2026-firebase-project.js
 *
 * Reads NEXT_PUBLIC_FIREBASE_* from .env.local (override per-call to point
 * at the cursor-thrads-london-2026 project).
 */

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env.local") });

const { initializeApp } = require("firebase/app");
const {
  getFirestore,
  collection,
  doc,
  query,
  where,
  getDocs,
  addDoc,
  setDoc,
  Timestamp,
} = require("firebase/firestore");

const THRADS_SLUG = "cursor-thrads-london-2026";
const THRADS_NAME = "Cursor × Thrads — London 2026";
const SUPABASE_HACKATHON_ID = "a0000003-0000-4000-8000-000000000003";

const firebaseConfig = {
  apiKey:
    process.env.THRADS_FIREBASE_API_KEY ||
    "AIzaSyDdTJbnhRNYA_qrWyaU7Me7kQTCyrL6-74",
  authDomain:
    process.env.THRADS_FIREBASE_AUTH_DOMAIN ||
    "cursor-thrads-london-2026.firebaseapp.com",
  projectId:
    process.env.THRADS_FIREBASE_PROJECT_ID || "cursor-thrads-london-2026",
  storageBucket:
    process.env.THRADS_FIREBASE_STORAGE_BUCKET ||
    "cursor-thrads-london-2026.firebasestorage.app",
  messagingSenderId:
    process.env.THRADS_FIREBASE_MESSAGING_SENDER_ID || "300288949807",
  appId:
    process.env.THRADS_FIREBASE_APP_ID ||
    "1:300288949807:web:424ad8ade6f33685bb10da",
};

async function main() {
  const app = initializeApp(firebaseConfig);
  const db = getFirestore(app);
  const now = Timestamp.now();

  // 1. Projects doc — primary record the redemption page reads.
  const projectsRef = collection(db, "projects");
  const existing = await getDocs(
    query(projectsRef, where("slug", "==", THRADS_SLUG)),
  );

  let projectId;
  if (!existing.empty) {
    projectId = existing.docs[0].id;
    console.log("projects/<id> already exists →", projectId);
  } else {
    const ref = await addDoc(projectsRef, {
      name: THRADS_NAME,
      description: "Cursor credits — Cursor × Thrads London 2026",
      slug: THRADS_SLUG,
      status: "active",
      supabaseHackathonId: SUPABASE_HACKATHON_ID,
      eventDate: null,
      createdAt: now,
      updatedAt: now,
    });
    projectId = ref.id;
    console.log("Created projects/<id> →", projectId);
  }

  // 2. Bootstrap documents so attendees + codes appear as collections in the
  //    console immediately. These are flagged `__bootstrap: true` and ignored
  //    by the redemption flow.
  const BOOTSTRAP_ID = "bootstrap-placeholder";

  await setDoc(
    doc(db, "attendees", BOOTSTRAP_ID),
    {
      bootstrap: true,
      projectId,
      createdAt: now,
      note: "Placeholder doc — real attendees written via /credits/event/.../redeem.",
    },
    { merge: true },
  );
  console.log(`Bootstrapped attendees/${BOOTSTRAP_ID}`);

  await setDoc(
    doc(db, "codes", BOOTSTRAP_ID),
    {
      bootstrap: true,
      projectId,
      status: "placeholder",
      createdAt: now,
      note: "Placeholder doc — real codes uploaded via /credits/admin/uploads.",
    },
    { merge: true },
  );
  console.log(`Bootstrapped codes/${BOOTSTRAP_ID}`);

  await setDoc(
    doc(db, "redemptions", BOOTSTRAP_ID),
    {
      bootstrap: true,
      projectId,
      createdAt: now,
      note: "Placeholder doc — real redemptions written when an attendee claims a code.",
    },
    { merge: true },
  );
  console.log(`Bootstrapped redemptions/${BOOTSTRAP_ID}`);

  console.log("\nDone.");
  console.log("  Firebase project:", firebaseConfig.projectId);
  console.log("  Firestore project doc id:", projectId);
  console.log("  Supabase hackathon id:", SUPABASE_HACKATHON_ID);
  console.log(
    "Next: upload codes CSV under /credits/admin/uploads pointed at this project.",
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
