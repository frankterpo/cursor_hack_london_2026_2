# Multi-hackathon tenancy (Supabase + Firebase)

## Supabase (source of truth for builds, judges, analysis)

- `**hackathons**` — one row per event: `id` (UUID), `slug`, `name`, `starts_at`, `ends_at`, optional `**luma_event_api_id**` / `**luma_event_name**`, `**credits_firestore_project_doc_id**` (links credits CLI to guild hack row), `created_at`, `updated_at`.
- **Child tables** carry `hackathon_id` → `hackathons.id`:
  - `submissions` — **primary key `(hackathon_id, repo_key)`** so the same GitHub repo can enter a later event.
  - `judge_responses` — unique `(judge_name, repo_key, hackathon_id)`.
  - `analyses` — **primary key `(hackathon_id, repo_key)`**.
  - `analysis_settings` — **primary key `hackathon_id`** (one settings row per event).

### Deploy migrations

```bash
cd guild-bounty-board
# Linked project: applies pending SQL in supabase/migrations/
npx supabase db push
# Or paste migrations into Supabase Dashboard → SQL Editor
```

Migrations to apply in order (names may vary):

1. `20260402000000_create_tables.sql` …
2. `20260427150000_hackathons_multitenant.sql` — adds `hackathons` + `hackathon_id` columns.
3. `20260428120000_hackathon_composite_pk_and_london_2026.sql` — composite PKs + seeds **London 2026**.
4. `20260429120000_london_2026_analysis_settings_backfill.sql` — `analysis_settings` row for London (event window + analysis thresholds).

### Environment


| Variable                       | Purpose                                  |
| ------------------------------ | ---------------------------------------- |
| `SUPABASE_PROJECT_URL`         | `https://xxx.supabase.co`                |
| `SUPABASE_SERVICE_ROLE_SECRET` | Service role key (server only)           |
| `DEFAULT_HACKATHON_ID`         | UUID of the active event for this deploy |


Seeded rows (run migrations):


| `slug`           | `id` (example)                         | Notes                                       |
| ---------------- | -------------------------------------- | ------------------------------------------- |
| `legacy-default` | `a0000001-0000-4000-8000-000000000001` | HCMC seed data                              |
| `london-2026`    | `a0000002-0000-4000-8000-000000000002` | London 2026 (adjust dates in SQL if needed) |


Set `**DEFAULT_HACKATHON_ID`** to the UUID for the hack you are running **on that Vercel project** (e.g. London → `a0000002-…`).

**Judge rubric:** Live scoring uses `public/api/_lib/judging.js` (`JUDGE_CONFIG`). The judge UI loads `public/judge-config.json`. Keep both in sync with the event rubric (for London, mirror `cursor-hackathon-hcmc-2025/data/event-format.json`). The public board’s `public/eric-bounties.json` → `hackathon_format` drives the submission track `<select>` and on-page copy — update it when tracks or bonus buckets change.

### New event checklist

1. `INSERT` a row into `hackathons` (or use the Dashboard) with a new `slug` and window.
2. `INSERT` into `analysis_settings` for that `hackathon_id` (copy from a prior event, then set `event_t0` / `event_t1`).
3. Set `**DEFAULT_HACKATHON_ID`** in production env to the new UUID.
4. Redeploy the guild static API and credits portal (both read the same var where applicable).

---

## Firebase (Cursor credits: codes, attendees, redemptions)

- **Partition key today:** `projectId` — the Firestore document id under `projects/`.
- **Config for this repo:**
  - **Next.js UI (browser):** Firebase Console → **Project settings** (gear) → **Your apps** → add/register a Web app (`</>`) if needed → copy **`apiKey`** and friends into **`NEXT_PUBLIC_FIREBASE_*`** in `credits-portal/.env.local`.
  - **CLI / smoke tests (`ops:smoke:test-connectivity`):** you **do not** need the web SDK keys if you use the **Admin** credential file instead (same JSON as Python `credentials.Certificate(...)`) — Firebase Console → **Project settings** → **Service accounts** tab → **Generate new private key** → save **`FIREBASE_SERVICE_ACCOUNT_PATH`** (or standard **`GOOGLE_APPLICATION_CREDENTIALS`**) pointing at that **`*.json`**. Optional **`FIREBASE_SERVICE_ACCOUNT_JSON`** = whole JSON pasted on one line (CI only — never commit it).
- **Optional cross-link:** set `**supabaseHackathonId`** on a project document to the same UUID as `hackathons.id` for documentation and future automation (e.g. dashboard labels). Codes and redemptions **stay filtered by `projectId`**; one Firestore “project” per hackathon is the usual model.

To add the field: Firebase Console → `projects` → document → add field `supabaseHackathonId` (string) = UUID, or pass it in the admin “create project” API body when supported in UI.

---

## What’s *not* merged

We do not sync Supabase and Firebase in real time. They remain:

- **Supabase** — repos, rubric, judge JSON, commit analysis.
- **Firebase** — credit URLs, attendees, redemptions.

Link them in ops via `**DEFAULT_HACKATHON_ID`** (Supabase) and `**supabaseHackathonId*`* (Firebase project doc).

---

## London 2026 cutover (empty Supabase event + new Firebase code batch)

**Supabase (submissions, judges, analyses = scoped to the event UUID)**

1. Apply migrations (includes `20260429120000_london_2026_analysis_settings_backfill.sql` — backfills `analysis_settings` for `london-2026` from `hackathons.starts_at/ends_at` and legacy thresholds):
  ```bash
   cd guild-bounty-board && npx supabase db push
  ```
2. Set production `**DEFAULT_HACKATHON_ID**` to London:
  - `a0000002-0000-4000-8000-000000000002`
3. Redeploy the static guild board API and anything that embeds the Supabase key + this var.
  With the London UUID, API reads return **no rows** for that event until new submissions and judge scores are inserted — legacy HCMC data remains under the legacy `hackathon_id`.

**Firebase (Cursor credit codes — stays per Firestore `projectId`)**

1. With `credits-portal/.env.local` configured (Firebase keys), from `**guild-bounty-board/`** (repo root) or from `**credits-portal/`**:
  ```bash
   pnpm run ops:firebase:provision-london
  ```
   (Runs `credits-portal` script; or: `cd credits-portal && node scripts/provision-london-2026-firebase-project.js`.)
2. If an older event left codes or attendees on that project, wipe children only, then re-upload a fresh codes CSV in `/credits/admin/uploads`:
  ```bash
   pnpm run ops:firebase:clear-project-children -- --project-id=YOUR_DOC_ID --i-understand
  ```
   (From `guild-bounty-board/`, or add `--` after `run` when using pnpm: same command from `credits-portal/`.)
3. Upload the new batch: **Admin → Uploads** → type **codes** → select the project → CSV of `cursor.com` URLs (same as before).
4. **Luma ↔ Firebase (CLI only, not in credits UI)** — bulk-import checked-in attendees and assign leftover unredeemed codes to eligible Luma-sourced attendees (same transactional shape as redemption):
  - Add `LUMA_COOKIE` (full `Cookie` header from DevTools while logged in, copying an authenticated `api2.luma.com` request) alongside the usual Firebase `NEXT_PUBLIC_`* keys in `credits-portal/.env.local`.
  - From `guild-bounty-board/` or `credits-portal/`:
    ```bash
    pnpm run ops:luma:sync-checked-in -- --project-id=YOUR_FIRESTORE_PROJECT_DOC_ID
    ```
  - Optional flags: `--event-api-id=evt-...`, `--dry-run`, `--skip-upsert`, `--skip-assign`, `--help`.
  - The script resolves the hackathon host event via `GET /user/profile/events` (or uses `--event-api-id`), pulls `/event/admin/get-guests` with pagination, **keeps rows where `checked_in_at` is set**, upserts Firestore `attendees` (email, firstName, lastName, metadata), then assigns available `codes` to Luma-eligible unredeemed attendees until the pool is exhausted.
  - `**--assign-scope=late_joiners_only`** — only emits codes for attendees whose **Firestore `checkedInAt` was unset on the prior merge** but Luma now reports check-in (net new walk-ins vs last sync).
5. **Interactive hackathon wizard (Supabase + Luma + CSV + Firebase, CLI only)** — apply migration `20260430153000_hackathons_luma_and_credits_firestore.sql`, then configure `SUPABASE_PROJECT_URL` + `**SUPABASE_SERVICE_ROLE_SECRET`** in `credits-portal/.env.local` beside Firebase + `LUMA_COOKIE`:
  ```bash
   cd guild-bounty-board && npx supabase db push   # picks up hackathons link columns if missing
   pnpm run ops:hackathon-credits-wizard
  ```
   Prompts: **create vs update**, **hosted Luma event** (*evt-* + title*), `**starts_at`/`ends_at` when creating**, **Cursor CSV path**, Firestore `**projects`** pick on updates. Writes `hackathons`, `projects/` (codes pool), attendee sync, and assigns codes (**all checked-in on create**, **late joiners only** on update paths).

The credits landing page CTA is `/credits/event/cursor-hackathon-london-2026/redeem` — it resolves the Firestore project by `slug`, not the document id.