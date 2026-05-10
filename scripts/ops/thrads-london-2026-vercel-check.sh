#!/usr/bin/env bash
# Prints Vercel wiring checks for Thrads (requires vercel CLI + VERCEL_TOKEN or interactive login).
set -euo pipefail

CREDITS_HOST="${CREDITS_VERCEL_URL:-https://cursor-thrads-london-2026.vercel.app}"
BOARD_HOST="${BOARD_VERCEL_URL:-https://cusor-hack-london-2026-2.vercel.app}"

echo "Expected public URLs:"
echo "  Credits Next: $CREDITS_HOST/credits/redeem   (set NEXT_PUBLIC_CREDITS_FIRESTORE_PROJECT_SLUG=cursor-thrads-london-2026)"
echo "  Static board:   $BOARD_HOST (CREDITS_APP_URL should point at credits origin, no trailing slash)"
echo ""

if ! command -v vercel >/dev/null 2>&1; then
  echo "Install: npm i -g vercel"
  exit 0
fi

echo "From repo root, link and inspect:"
echo "  cd guild-bounty-board/credits-portal && vercel link && vercel env ls"
echo "  cd ../../ && vercel link   # root static project"
echo ""
echo "Production env (guild static / serverless):"
echo "  DEFAULT_HACKATHON_ID=a0000003-0000-4000-8000-000000000003"
echo "  CREDITS_APP_URL=$CREDITS_HOST"
echo ""
echo "Credits Next project:"
echo "  DEFAULT_HACKATHON_ID=a0000003-0000-4000-8000-000000000003"
echo "  NEXT_PUBLIC_FIREBASE_* from Firebase console (project cursor-thrads-london-2026)"
