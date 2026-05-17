# API routes inventory

Generated from the repository (Python UI, root `api/*.js`, `guild-bounty-board/public/api`, and `vercel.json` files). **Route count:** **11** handler families on the local Python UI (including three `/api/repo/:id/...` resource paths), plus **9** Vercel serverless routes at repo root (`/api/*.js`). Deployments that mount `guild-bounty-board/public/api` use the **same** filenames and logic as those re-exported from root `api/*.js` (with one intentional difference: see submissions GET).

---

## 1. Route tables

### 1a. `cursor-hackathon-hcmc-2025/ui/server.py` (local dev, typically `/api/*`)

| Route | Methods | Purpose | Request body / params | Success response | Common errors | Notes |
|-------|---------|---------|------------------------|------------------|---------------|------|
| `/api/summary` | GET | Metrics summary CSV as JSON | — | `{"rows":[...]}` (CSV dict rows) | `404` `{"error":"summary not found"}` | No OPTIONS before fix; CORS not needed for same-origin. |
| `/api/judges` | GET | Judge scores aggregate | — | File: legacy JSON shape **or** Supabase: not identical to Vercel aggregate (see §3). | `404` / `500` | Uses `data/judge-responses-normalized.json` if Supabase env missing. |
| `/api/submissions` | GET | Submissions list | — | `{"submissions":[...]}` or legacy file shape | `500` | Supabase filters by `DEFAULT_HACKATHON_ID` only (no `EVENT_CUTOFF_AT`). |
| `/api/event-format` | GET | Event + tracks JSON | — | Full `event-format` object | `404` / `500` | |
| `/api/hacks` | GET | Hack list + active id | — | `{"hacks":[],"active_hack_id":...}` | `500` | |
| `/api/technologies` | GET | Technology checklist for forms | — | `{"technologies":[...]}` | `500` | **Static** from `event-format.json` → `technology_partners`. Not Supabase. |
| `/api/repo/:repo_id/metrics` | GET | Per-repo metrics JSON | Path: `repo_id` URL-encoded | Metrics object | `400` invalid path; `404` not found | |
| `/api/repo/:repo_id/commits` | GET | Commit rows | — | `{"rows":[...]}` | `404` | |
| `/api/repo/:repo_id/ai` | GET | AI summary text | — | `text/plain` body | `404` plain text | |
| `/api/submissions` | POST | Live submission | JSON (see §2) | `201` `{"ok", "submission", "storage", ...}` | `400` invalid JSON / missing `repo_url` / no sponsor tech when Supabase on; `503` Supabase off (unless `HACKATHON_ALLOW_LOCAL_FALLBACK=1`); `500` | Accepts `repo_url` **or** `github_url`. |
| `/api/judges` | POST | Upsert judge row | JSON | `201` `{"ok","response",...aggregate}` | `400` bad JSON; `503` if Supabase off; `500` | No auth; relies on env. |
| `/api/*` | OPTIONS | CORS/preflight for API | — | `204` no body | `501` non-API paths | Added for parity with Vercel handlers. |

### 1b. Repo root `api/*.js` (Vercel serverless — production hackathon site)

Wrappers in `api/` `require` the implementation under `guild-bounty-board/public/api/` except `submissions.js` and `judges.js`, which are **full copies** of that logic but live at repo root (`api/submissions.js` / `api/judges.js`) so the main deploy can depend on `_lib` without duplicating paths.

| Route | Methods | Purpose | Request body / params | Success response | Common errors | Notes |
|-------|---------|---------|------------------------|------------------|---------------|------|
| `/api/auth` | GET, POST, OPTIONS | Session gate + judge name cookie | POST: `{ password, judge_name? }` | GET: `{ authenticated, judge_name }`; POST: `{ ok, token?, judge_name? }` | `400` / `401` / `503` | Uses cookies; `storage.js` sends CORS `*`. |
| `/api/submissions` | GET, POST, OPTIONS | List + submit (GitHub analyze + AI + DB) | POST: see §2 | GET: `{ submissions }`; POST: `200` `{ ok, submission, submissions }` | `400` validation; `401` GET on **guild** handler only; `405`; `500`/`503` | **Root** `api/submissions.js`: GET is **public**. **Guild** `public/api/submissions.js`: GET requires **auth**. |
| `/api/judges` | GET, POST, OPTIONS | Aggregate + save score | POST: §2 | `200` `{ ok, response, ...aggregate, rubric }` | `400` / `401` / `500` | Requires auth (guild judges + admin). |
| `/api/technologies` | GET, OPTIONS | Sponsor tech from Supabase | — | `{ technologies }` | `405`; `500`/`503` | Overrides static `dist/api/technologies` when both exist (function wins on Vercel). |
| `/api/public-submissions` | GET, OPTIONS | Public-safe slice | — | `{ submissions }` stripped fields | `405`; `500` | Used by `guild-bounty-board/public/index.html`. |
| `/api/settings` | GET, POST, OPTIONS | Analysis window + thresholds | POST: `event_t0`, `event_t1`, `bulk_*`, `max_commits_to_analyze` | `{ ok, settings, defaults? }` | `401` | Auth required. |
| `/api/reanalyze` | POST, OPTIONS | Re-run GitHub+AI for all submissions | — | `{ ok, results, analyzed, failed, settings }` | `401` / `405` / `500` | Auth required. |
| `/api/analysis` | GET, OPTIONS | Fetch stored analysis blob | Query: `repo_url` or `repo` | `{ repo_key, analysis }` | `400` missing param; `401`; `500` | Auth required. |
| `/api/page-content` | GET, OPTIONS | HTML snippets for judge/admin apps | Query: `page=judge` or `page=admin` | `{ html, scripts }` | `400` invalid page; `401` | Auth required. |

### 1c. Static API snapshots (`scripts/build_site.py` → `dist/api/...`)

Not separate HTTP handlers: files written at build time for **GET** only (same paths as Python UI):

- `/api/summary`, `/api/hacks`, `/api/event-format`, `/api/technologies` (object shape `{ technologies: [...] }` from JSON), `/api/repo/:id/{metrics,commits,ai}`.

On Vercel, **mutable** routes are implemented by `api/*.js` functions; static files fill gaps for read-only data.

### 1d. Rewrites in `vercel.json`

| File | Mapping | Effect |
|------|---------|--------|
| Repo root `vercel.json` | `/credits-portal` → external credits app; headers for `/api/*` (JSON, no-store) | No path rewrite for `/api/*` to another origin. |
| `guild-bounty-board/vercel.json` and `public/vercel.json` | `/credits/*` → `${CREDITS_APP_URL}` | Credits only. |

---

## 2. Frontend callers (file → endpoint → payload)

### Hackathon viewer — `ui/static/script.js`

| Location | Endpoint | Payload / notes |
|----------|----------|-----------------|
| L322 | GET `/api/judges` | — |
| L341 | GET `/api/submissions` | — |
| L365 | GET `/api/repo/:seg/ai` | `seg` = encoded `repo_id` |
| L836 | GET `/api/summary` | — |
| L1117–1119 | GET `/api/repo/:apiSeg/metrics`, `/ai`, `/commits` | — |
| L1305 | GET `/api/hacks` | — |
| L1313 | GET `/api/event-format` | — |
| L1345 | GET `/api/technologies` (fallback `/api/technologies.json`) | — |
| L2009 | POST `/api/submissions` | `submitted_at`, `hack_id`, `team_name`, `project_name`, `repo_url` (from form `github_url`), `chosen_track`, `demo_url`, `team_members`, `description`, `notes`, `technology_ids` |
| L2808–2809 | GET `/api/repo/:apiSeg/...` | — |
| L3282 | POST `/api/judges` | `scored_at`, `hack_id`, `judge_name`, `submission_id`, `repo_url`, `project_name`, `chosen_track`, `scored_track`, `core_scores`, `core_total`, `bonus_bucket_scores`, `bonus_total`, `bonus_total_capped`, `total_score`, `thoughts`, `notes` |

### Judge app — `guild-bounty-board/public/judge/script.js`

| Location | Endpoint | Payload |
|----------|----------|---------|
| L10 | `fetch(url)` | helpers |
| L197 | GET `/api/analysis?repo_url=` | query |
| L346 | POST `/api/judges` | `judge_name`, `repo_url`, `project_name`, `chosen_track`, `scored_track`, `core_scores`, `notes`, `bonus_bucket_scores` |
| L373 | GET `/api/auth` | — |
| L384–385 | GET `/api/submissions`, `/api/judges` | — |

### Admin app — `guild-bounty-board/public/admin/script.js`

| Location | Endpoint | Payload |
|----------|----------|---------|
| L103–128 | GET `/api/judges`, `/api/settings`, `/api/submissions` (fallback static JSON) | — |
| L398 | GET `/api/analysis?repo_url=` | — |
| L441 | POST `/api/settings` | `event_t0`, `event_t1`, `bulk_insertion_threshold`, `bulk_files_threshold`, `max_commits_to_analyze` |
| L459 | POST `/api/reanalyze` | empty body |
| L545 | POST `/api/judges` | demos panel: `judge_name`, `repo_url`, `project_name`, `chosen_track`, `scored_track`, `core_total`, `notes`, `bonus_bucket_scores` |

### Public board — `guild-bounty-board/public/index.html`

| Location | Endpoint | Payload |
|----------|----------|---------|
| L1666 | GET `/api/public-submissions` | `{ cache: "no-store" }` |

---

## 3. curl smoke tests (local Python UI)

Server: `python3 cursor-hackathon-hcmc-2025/ui/server.py --work-dir cursor-hackathon-hcmc-2025/work --port 9777`  
Host: `http://127.0.0.1:9777`  
Environment: Supabase **not** set unless noted.

```bash
curl -sS -o /tmp/b.txt -w "HTTP %{http_code}\n" http://127.0.0.1:9777/api/summary
# HTTP 200 | first line: {"rows": [{"repo_id": ...

curl -sS -o /tmp/b.txt -w "HTTP %{http_code}\n" http://127.0.0.1:9777/api/event-format
# HTTP 200 | {"event_name": ...

curl -sS -o /tmp/b.txt -w "HTTP %{http_code}\n" http://127.0.0.1:9777/api/technologies
# HTTP 200 | {"technologies": [{"id": ...

curl -sS -o /tmp/b.txt -w "HTTP %{http_code}\n" http://127.0.0.1:9777/api/hacks
# HTTP 200 | {"active_hack_id": ...

curl -sS -o /tmp/b.txt -w "HTTP %{http_code}\n" http://127.0.0.1:9777/api/submissions
# HTTP 200 | {"submissions": [...

curl -sS -o /tmp/b.txt -w "HTTP %{http_code}\n" http://127.0.0.1:9777/api/judges
# HTTP 200 | (legacy file shape; not same keys as Vercel `aggregateJudgeResponses`)

curl -sS -o /tmp/b.txt -w "HTTP %{http_code}\n" -X POST http://127.0.0.1:9777/api/submissions \
  -H "Content-Type: application/json" -d '{}'
# HTTP 400 | {"error": "repo_url is required"}

curl -sS -o /tmp/b.txt -w "HTTP %{http_code}\n" -X POST http://127.0.0.1:9777/api/submissions \
  -H "Content-Type: application/json" -d 'not-json'
# HTTP 400 | {"error": "invalid JSON body"}

curl -sS -o /tmp/b.txt -w "HTTP %{http_code}\n" -X POST http://127.0.0.1:9777/api/judges \
  -H "Content-Type: application/json" -d 'nope'
# HTTP 400 | {"error": "invalid JSON body"}

curl -sS -o /tmp/b.txt -w "HTTP %{http_code}\n" -X POST http://127.0.0.1:9777/api/judges \
  -H "Content-Type: application/json" \
  -d '{"repo_url":"https://github.com/a/b","judge_name":"x"}'
# HTTP 503 | {"error": "Supabase is not configured. Judge scores cannot be stored locally for live judging."}

curl -sS -o /dev/null -w "HTTP %{http_code}\n" -X OPTIONS http://127.0.0.1:9777/api/submissions
# HTTP 204 (after OPTIONS handler added)
```

With `SUPABASE_PROJECT_URL` and `SUPABASE_SERVICE_ROLE_SECRET` set, **POST** `/api/submissions` with a real GitHub URL and non-empty `technology_ids` may return **201**; empty `technology_ids` returns **400** on the Python server.

Vercel routes were **not** curled here (need deployment URL + auth cookies for protected endpoints).

---

## 4. `upsertSubmission` vs `submissions` table

Migrations define `submissions` columns including `description` and `uses_white_circle` (legacy name in DB). Server code and UI use **`uses_specter`** in application objects.

- `guild-bounty-board/public/api/_lib/db.js` `upsertSubmission` now sends **`uses_white_circle`** derived from `row.uses_specter` / `row.uses_white_circle`.
- `withClientHackFields` exposes **`uses_specter: true`** when either column is true so the viewer and admin keep working.

Other payload fields in `upsertSubmission` align with the table: `repo_key`, `repo_url`, `repo_id`, names, team, tracks, demo, description, notes, timestamps, analysis/AI fields, commit counters, `hackathon_id`.

---

## 5. Fixes applied in this pass

1. **`judging.js`**: When `bonus_bucket_scores` contribute **no** points, honor `bonus_total_capped` / `bonus_total`, or derive bonus from `total_score` and `core_total` — fixes hackathon viewer single-slider scores (previously `total_score` could drop bonus).
2. **`db.js`**: Map **`uses_specter` ↔ `uses_white_circle`** on read/write for Supabase compatibility.
3. **`api/submissions.js`** and **`guild-bounty-board/public/api/submissions.js`**: Accept **`github_url`** in `normalizeSubmission` (parity with Python + forms).
4. **`server.py`**: **`do_OPTIONS`** for `/api/*` returning **204** with CORS headers (was **501**).

If none of these matched your deployment, treat the list above as **"fixes applied (May 2026 inventory)"**; skip any that were already shipped elsewhere.
