#!/usr/bin/env bash
# Start local hackathon board + credits portal (requires: npm global vercel, python3, credits-portal deps).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
export PATH="$(npm prefix -g)/bin:${PATH:-}"

cd "$ROOT"
python3 scripts/build_site.py

echo "Board:   http://127.0.0.1:3000  (vercel dev --local)"
echo "Credits: http://127.0.0.1:3001  (next dev in credits-portal)"
echo "Set SUPABASE_* in .env.local for live API writes."

exec vercel dev --local --yes --listen 127.0.0.1:3000
