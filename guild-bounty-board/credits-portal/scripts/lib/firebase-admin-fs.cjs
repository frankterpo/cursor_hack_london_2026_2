/**
 * firebase-admin Firestore for Node OPS scripts (.env.local + SA key file or FIREBASE_USE_ADC).
 */
const fs = require("fs");
const path = require("path");

function resolveFirebaseServiceAccountCredential() {
  const admin = require("firebase-admin");

  const jsonInline = process.env.FIREBASE_SERVICE_ACCOUNT_JSON?.trim();
  if (jsonInline) {
    try {
      return admin.credential.cert(JSON.parse(jsonInline));
    } catch (e) {
      console.error(
        "Firebase Admin: FIREBASE_SERVICE_ACCOUNT_JSON not valid JSON —",
        e.message || String(e)
      );
      return null;
    }
  }

  const file =
    process.env.FIREBASE_SERVICE_ACCOUNT_PATH?.trim() ||
    process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim();

  if (!file) return null;

  const absFile = path.isAbsolute(file)
    ? file
    : path.resolve(process.cwd(), file);
  if (!fs.existsSync(absFile)) {
    console.error(`Firebase Admin: credential file not found:\n    ${absFile}`);
    return null;
  }
  return admin.credential.cert(absFile);
}

function wantsApplicationDefaultCredential() {
  const v =
    process.env.FIRESTORE_USE_ADC || process.env.FIREBASE_USE_ADC || "";
  return v === "1" || /^true$/i.test(v.trim());
}

function firebaseProjectIdFromEnv() {
  return (
    process.env.GCLOUD_PROJECT?.trim() ||
    process.env.GOOGLE_CLOUD_PROJECT?.trim() ||
    process.env.FIREBASE_PROJECT_ID?.trim() ||
    process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID?.trim() ||
    ""
  );
}

/**
 * @param {{ silent?: boolean }} [opts]
 * @returns {import('firebase-admin/firestore').Firestore | null}
 */
function initFirebaseAdminFirestoreOrNull(opts = {}) {
  const silent = Boolean(opts.silent);

  try {
    const admin = require("firebase-admin");

    let credential = resolveFirebaseServiceAccountCredential();
    let credentialLabel = "service account file / JSON env";

    if (!credential && wantsApplicationDefaultCredential()) {
      credential = admin.credential.applicationDefault();
      credentialLabel = "application-default (gcloud user — no SA key file)";
      const pid = firebaseProjectIdFromEnv();
      if (!pid) {
        if (!silent)
          console.log(
            "  SKIP Firebase ADC: need FIREBASE_PROJECT_ID or NEXT_PUBLIC_FIREBASE_PROJECT_ID"
          );
        return null;
      }
    }

    if (!credential) return null;

    if (admin.apps.length === 0) {
      const appOpts = { credential };
      const pid = firebaseProjectIdFromEnv();
      if (pid) appOpts.projectId = pid;
      admin.initializeApp(appOpts);
    }

    if (!silent) console.log(`  INFO: Firebase Admin SDK (${credentialLabel})`);
    return admin.firestore();
  } catch (e) {
    console.error("  FAIL (Firebase Admin):", e.message || String(e));
    if (!silent && wantsApplicationDefaultCredential())
      console.error(
        "      Hint: gcloud auth application-default login (+ FIREBASE_USE_ADC=1 in .env.local)"
      );
    return null;
  }
}

module.exports = {
  initFirebaseAdminFirestoreOrNull,
  firebaseProjectIdFromEnv,
};
