# cusor_hack_london_2026_2

Workspace for the Cursor hackathon board, submission manager, judging flow, and supporting artifacts.

## Folders

- `guild-bounty-board`: live Vercel-deployed board, admin manager, and judge portal
- `cursor-hackathon-hcmc-2025`: analyzer toolkit and related event scripts
- `artifacts`: hackathon briefs and supporting docs
- `scripts`: helper scripts for publishing admin snapshots

## Environment variables

Two deploy surfaces:

1. **Guild board + serverless APIs** (`guild-bounty-board` on Vercel): copy `guild-bounty-board/.env.example` to `guild-bounty-board/.env.local` and fill values, or set them in the Vercel project. Judge/admin gate: `SITE_PASSWORD` (also reads `site_password`). `AUTH_SECRET` is optional if omitted (derived from `SITE_PASSWORD`). Set **`CREDITS_APP_URL`** to your credits Next deployment origin (no trailing slash). **Cursor × Thrads London 2026:** `https://cursor-thrads-london-2026.vercel.app`, **`DEFAULT_HACKATHON_ID`** `a0000003-0000-4000-8000-000000000003`. Full checklist: `guild-bounty-board/docs/TENANCY.md`.

2. **Cursor credits (Next.js)** (`guild-bounty-board/credits-portal`, reached as `/credits` on the board host when `CREDITS_APP_URL` is set): copy `guild-bounty-board/credits-portal/env.example` to `guild-bounty-board/credits-portal/.env.local` for Firebase + `ADMIN_PASSWORD` (falls back to `SITE_PASSWORD` / `site_password` if unset).

**Repo scripts** (`scripts/build_bounties_opencode.mjs`): optional `OPENCODE_API_KEY`, `OPENCODE_CHAT_COMPLETIONS_URL`, `X_BEARER_TOKEN` when generating bounties.
