# Hackathon Manager Toolkit

Local toolkit for hackathon managers to collect competitor submissions, normalize judge scoring, clone GitHub submissions, compute commit/activity metrics, and optionally produce short-form AI observations. Designed for macOS and up to about 100 repositories.

<img width="1649" height="715" alt="image" src="https://github.com/user-attachments/assets/f4973def-5f11-402b-b38d-f94df2ad5bd6" />

## Requirements
- macOS with `python3` (3.10+) and `git` in PATH
- Optional: `codex` CLI in PATH for AI summaries (`codex --yolo exec --sandbox danger-full-access "<PROMPT>"`)

## Layout
```
hackathon-analyzer/
  prepare_submissions.py    # convert submission form export into analyzer inputs
  scan.py               # main metrics CLI
  ai/run_ai.py          # optional AI summaries
  ai/hackathon_context.md
  ai/prompt_template.txt
  data/event-format.json
  data/submissions-template.csv
  data/judge-responses-template.csv
  data/repos.csv        # normalized input list of repos
  work/                 # generated clones, metrics, summaries, ai outputs
```

## Config
- Create `config.json` (see `config.example.json`) to hold global times:
  ```json
  {
    "t0": "2025-12-01T10:00:00Z",
    "t1": "2025-12-02T10:00:00Z",
    "log_level": "INFO"
  }
  ```
- CLI flags can override config values (`--t0/--t1/--log-level`).

## Manager Workflow

For the shortest end-to-end organizer playbook, see `RUN_EVENT.md`.

### 1. Share competitor submissions

Use `data/submissions-template.csv` as the source of truth for the competitor form fields. After exporting form responses, run:

```bash
python3 prepare_submissions.py --input data/submissions-raw.csv
```

This generates:

- `data/repos.csv`
- `data/project-repo-map.csv`
- `data/submissions-normalized.json`

### 2. Share judge scoring

Use `data/judge-responses-template.csv` for the judge form.

The scoring model is:

- `100 core points`
- `30 judge bonus bucket points`
- `130 total max`

Judges may concentrate the full bonus bucket into one side quest or spread the bucket across several side quests. The normalizer caps the combined bonus at `30`.

After exporting judge responses, run:

```bash
python3 normalize_judge_responses.py
```

### 3. Run repo analysis

```bash
python3 scan.py \
  --repos data/repos.csv \
  --config config.json \
  --work-dir work
```

### 4. Open the dashboard

```bash
python3 ui/server.py --work-dir work --port 8000
```

## Input CSV
- You can still use a simple `repo_url[,t0]` file if you do not want the full submission-prep flow
- Export directly from your Google Form with header: `repo_url[,t0]`
  - Accepts: GitHub page URL (`https://github.com/owner/repo`), HTTPS clone (`...repo.git`), or SSH (`git@github.com:owner/repo.git`).
  - Optional `t0` column for per-repo overrides; leave blank otherwise.
- The analyzer derives:
  - `id = owner-repo` (or uses provided `id` column if present).
  - Clone URL (adds `.git` if needed).

## Quick Start
1) Ensure `config.json` has the global T0 (and optional T1).
2) Populate `data/repos.csv` manually or via `prepare_submissions.py`.
3) Run the analyzer:
```bash
python3 scan.py \
  --repos data/repos.csv \
  --config config.json \
  --work-dir work
```
Optional flags:
- `--t1 <ISO>`: hackathon end time
- `--force`: recompute even if metrics already exist
- `--no-update`: skip git fetch/reset for existing clones
- `--log-level DEBUG|INFO|...`

### Web UI (local viewer)
Serve a minimal UI to browse outputs:
```bash
python3 ui/server.py --work-dir work --port 8000
```
Then open http://localhost:8000. It shows the summary table, metrics flags, time distribution, AI notes, and a commit slice (first 100 rows).

## Outputs
Created under `work/` (auto-created if missing):
- `repos/<id>/` cloned repositories (cached)
- `metrics/<id>.json` per-repo summary metrics
- `metrics/<id>_commits.csv` per-commit stats (chronological)
- `summary/metrics_summary.csv` cross-repo table for judges
- `logs/scan.log` run log
- `ai_outputs/<id>.txt` AI notes (only when run_ai is executed)

## Judge Score Normalization

`normalize_judge_responses.py` supports:

- legacy single-score files with `Timestamp,Project,Thoughts,Score`
- the new detailed rubric export in `data/judge-responses-template.csv`

The normalized output at `data/judge-responses-normalized.json` includes:

- per-response totals
- per-criterion averages
- per-bonus-bucket averages
- capped judge totals on the `130-point` scale

## AI Analysis (optional)
1) Fill `ai/hackathon_context.md` with event details/rules.
2) Adjust `ai/prompt_template.txt` if desired.
3) After metrics exist, run:
```bash
python3 ai/run_ai.py \
  --work-dir work \
  --repos-csv data/repos.csv
```
Use `--only-id team-alpha` to limit to one repo.

## Caching & Resuming
- Metrics are skipped if `metrics/<id>.json` exists; use `--force` to recompute.
- Existing clones are refreshed via fetch/reset unless `--no-update` is set.

## Troubleshooting
- Clone failures (auth/private repos) are logged and other repos continue.
- Invalid date strings for `--t0/--t1` or per-row `t0` will be reported and that repo is skipped.
- Missing `codex` CLI will create an error note in `ai_outputs/<id>.txt` and continue.
