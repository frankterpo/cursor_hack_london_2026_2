# Repository Guidelines

Workspace for Cursor hackathon management: bounty board, credits portal, and analyzer toolkit.

## Cursor Cloud specific instructions

### Services overview

| Service | Path | Run command | Notes |
|---------|------|-------------|-------|
| Credits Portal (Next.js 16) | `guild-bounty-board/credits-portal/` | `pnpm dev` | Main app; serves under `/credits` basePath |
| Guild Bounty Board (static) | `guild-bounty-board/public/` | Static files; served via Vercel or `npx serve` | Admin/judge HTML pages |
| Hackathon Analyzer (Python) | `cursor-hackathon-hcmc-2025/` | `python3 ui/server.py --work-dir work --port 8000` | Optional CLI tool |

### Credits Portal — key gotchas

- **basePath is `/credits`**: All routes are at `http://localhost:3000/credits/...` not root. This applies in dev and production.
- **Package manager**: Use `pnpm` (lockfile present). The parent `guild-bounty-board/package.json` uses `pnpm -C credits-portal` for ops scripts.
- **Turbopack warning**: Dev server warns about multiple lockfiles — this is harmless (both `pnpm-lock.yaml` and `package-lock.json` exist in credits-portal).
- **Build scripts warning**: pnpm warns about ignored build scripts for `@firebase/util`, `protobufjs`, `sharp`, `unrs-resolver` — these don't affect dev/build.
- **Firebase required**: Real Firestore credentials are needed for full functionality (redeem flow, admin project management). Without them, `/credits/redeem` shows "Redemption unavailable" and admin dashboard has empty state.
- **Admin auth**: Password-based via `ADMIN_PASSWORD` env var (falls back to `SITE_PASSWORD`).

### Standard commands (credits-portal)

See `guild-bounty-board/credits-portal/package.json` scripts:
- `pnpm dev` — Next.js dev server with Turbopack
- `pnpm build` — production build
- `pnpm lint` — ESLint (pre-existing warnings/errors in codebase)

### Environment variables

Copy `.env.example` files to `.env.local`:
- `guild-bounty-board/.env.example` → `guild-bounty-board/.env.local`
- `guild-bounty-board/credits-portal/env.example` → `guild-bounty-board/credits-portal/.env.local`

Minimum for dev server startup: `NEXT_PUBLIC_FIREBASE_*` placeholders + `ADMIN_PASSWORD`.
