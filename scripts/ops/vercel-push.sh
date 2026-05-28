#!/usr/bin/env bash
# Deploy after: vercel login && vercel link (once per project directory).
set -euo pipefail

export PATH="$(npm prefix -g)/bin:${PATH:-}"

if ! command -v vercel >/dev/null 2>&1; then
  echo "Install: npm install -g vercel"
  exit 1
fi

TARGET="${1:-root}"

case "$TARGET" in
  root|board)
    cd "$(dirname "$0")/../.."
    python3 scripts/build_site.py
    vercel --prod
    ;;
  credits)
    cd "$(dirname "$0")/../../guild-bounty-board/credits-portal"
    vercel --prod
    ;;
  *)
    echo "Usage: $0 [root|board|credits]"
    echo "  root|board  — static hackathon site (cusor-hack-london-2026-2)"
    echo "  credits     — Next.js credits portal"
    exit 1
    ;;
esac
