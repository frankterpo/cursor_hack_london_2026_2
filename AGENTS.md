# Repository Guidelines

## Project Overview

Workspace for the Cursor hackathon platform containing:
- **guild-bounty-board/credits-portal** — Next.js 16 credits distribution portal (primary app)
- **guild-bounty-board/** — Static board + Vercel serverless APIs (Supabase-backed)
- **cursor-hackathon-hcmc-2025/** — Python CLI analyzer toolkit (stdlib only, no pip deps)

## Cursor Cloud specific instructions

### Credits Portal (primary dev surface)

- **Package manager**: pnpm (lockfile at `guild-bounty-board/credits-portal/pnpm-lock.yaml`)
- **Dev server**: `cd guild-bounty-board/credits-portal && pnpm run dev` — starts on `http://localhost:3000`
- **basePath**: All routes live under `/credits` (configured in `next.config.ts`). The homepage is at `/credits`, admin at `/credits/admin`, redemption at `/credits/redeem`.
- **Lint**: `pnpm run lint` (ESLint 9; pre-existing errors in `scripts/` CJS files are expected)
- **Build**: `pnpm run build`
- **Admin login**: Uses `ADMIN_PASSWORD` env var (falls back to `SITE_PASSWORD`). For local dev, set in `.env.local`.
- **Firebase**: The app requires Firebase env vars (`NEXT_PUBLIC_FIREBASE_*`). In dev mode, the app warns but proceeds with placeholder values — Firestore calls will fail gracefully, but the UI renders and admin auth works.
- **Env setup**: Copy `env.example` to `.env.local` and fill values. For local dev without Firebase, use placeholder values — the UI still loads.

### Gotchas

- The repo has both `pnpm-lock.yaml` and `package-lock.json` in credits-portal. Always use pnpm; the outer `guild-bounty-board/package.json` delegates via `pnpm -C credits-portal`.
- `pnpm install` emits warnings about ignored build scripts (sharp, protobufjs, etc.). These are non-blocking — Next.js image optimization falls back gracefully without sharp native bindings.
- ESLint exits with code 1 due to pre-existing `@typescript-eslint/no-require-imports` errors in CJS ops scripts under `scripts/`. The app `src/` code has only warnings.
- The `next.config.ts` has a deprecated `eslint` key that produces a warning during build/dev. It's harmless.

### Python Analyzer (cursor-hackathon-hcmc-2025/)

- Python 3.10+, no external dependencies (stdlib only).
- See `cursor-hackathon-hcmc-2025/AGENTS.md` for commands.
