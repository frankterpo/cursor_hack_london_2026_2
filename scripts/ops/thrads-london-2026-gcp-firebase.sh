#!/usr/bin/env bash
# Idempotent GCP project + API enablement for Cursor × Thrads London 2026 Firebase.
# Firebase Console still needs a one-time "Add Firebase to Google Cloud project" (or firebase CLI login flow).
#
# Prerequisites: gcloud auth login, billing enabled on the org (link billing manually if create fails).
#
# Usage:
#   chmod +x scripts/ops/thrads-london-2026-gcp-firebase.sh
#   ./scripts/ops/thrads-london-2026-gcp-firebase.sh
#
set -euo pipefail

PROJECT_ID="${GCP_PROJECT_ID:-cursor-thrads-london-2026}"
DISPLAY_NAME="${GCP_PROJECT_NAME:-Cursor Thrads London 2026}"

if ! command -v gcloud >/dev/null 2>&1; then
  echo "error: gcloud not found. Install Google Cloud SDK."
  exit 1
fi

if gcloud projects describe "$PROJECT_ID" >/dev/null 2>&1; then
  echo "ok: GCP project already exists: $PROJECT_ID"
else
  echo "creating GCP project $PROJECT_ID ..."
  gcloud projects create "$PROJECT_ID" --name="$DISPLAY_NAME"
  echo "note: attach billing if required: gcloud billing projects link $PROJECT_ID --billing-account=YOUR_BILLING_ACCOUNT_ID"
fi

gcloud config set project "$PROJECT_ID"

echo "enabling core Firebase / Firestore APIs..."
gcloud services enable firebase.googleapis.com --project="$PROJECT_ID"
gcloud services enable firestore.googleapis.com --project="$PROJECT_ID"
gcloud services enable appengine.googleapis.com --project="$PROJECT_ID" || true

echo "done. Next:"
echo "  1) Firebase Console → Add Firebase to this Cloud project (project id: $PROJECT_ID)"
echo "     OR: npm i -g firebase-tools && firebase login && firebase projects:list"
echo "  2) Register a Web app; copy keys into credits-portal/.env.local (NEXT_PUBLIC_FIREBASE_*)."
echo "  3) cd guild-bounty-board/credits-portal && node scripts/provision-thrads-london-2026-firebase-project.js"
