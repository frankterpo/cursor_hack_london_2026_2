#!/usr/bin/env python3
"""
Minimal local web UI server to browse hackathon analysis outputs.
Serves static files from ui/static and JSON/text APIs backed by work/* artifacts.
Usage: python3 ui/server.py --work-dir work --port 8000
"""

import argparse
from urllib.parse import unquote
import csv
import json
import os
import re
import subprocess
import sys
from http.server import HTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import quote
from urllib.request import Request, urlopen

# Resolve relative to project root (parent of ui/)
PROJECT_ROOT = Path(__file__).resolve().parent.parent
JUDGE_RESPONSES_PATH = PROJECT_ROOT / "data" / "judge-responses-normalized.json"
SUBMISSIONS_PATH = PROJECT_ROOT / "data" / "submissions-normalized.json"
EVENT_FORMAT_PATH = PROJECT_ROOT / "data" / "event-format.json"
HACKS_PATH = PROJECT_ROOT / "data" / "hacks.json"
RAW_SUBMISSIONS_PATH = PROJECT_ROOT / "data" / "submissions-raw.csv"
REPOS_PATH = PROJECT_ROOT / "data" / "repos.csv"
PROJECT_MAP_PATH = PROJECT_ROOT / "data" / "project-repo-map.csv"
CONFIG_PATH = PROJECT_ROOT / "config.json"
DEFAULT_HACKATHON_ID = os.environ.get(
    "DEFAULT_HACKATHON_ID",
    "a0000002-0000-4000-8000-000000000002",
)


def supabase_configured():
    return bool(os.environ.get("SUPABASE_PROJECT_URL") and os.environ.get("SUPABASE_SERVICE_ROLE_SECRET"))


def active_hack_slug():
    if HACKS_PATH.exists():
        try:
            return json.loads(HACKS_PATH.read_text(encoding="utf-8")).get("active_hack_id") or "cursor-briefcase-london-2026"
        except Exception:
            pass
    if EVENT_FORMAT_PATH.exists():
        try:
            return json.loads(EVENT_FORMAT_PATH.read_text(encoding="utf-8")).get("hack_id") or "cursor-briefcase-london-2026"
        except Exception:
            pass
    return "cursor-briefcase-london-2026"


def normalize_repo_url(value):
    raw = str(value or "").strip()
    if not raw:
        return ""
    raw = raw.removesuffix(".git")
    return raw.lower()


def repo_id_from_url(value):
    match = re.search(r"github\.com/([^/\s]+/[^/\s]+)", str(value or ""), re.I)
    if match:
        return match.group(1).removesuffix(".git")
    return re.sub(r"[^a-zA-Z0-9._-]+", "-", normalize_repo_url(value)).strip("-")


def supabase_rest(path, method="GET", body=None, prefer="return=representation"):
    url = os.environ["SUPABASE_PROJECT_URL"].rstrip("/")
    key = os.environ["SUPABASE_SERVICE_ROLE_SECRET"]
    data = None if body is None else json.dumps(body).encode("utf-8")
    req = Request(
        f"{url}/rest/v1{path}",
        data=data,
        method=method,
        headers={
            "apikey": key,
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
            "Prefer": prefer,
        },
    )
    try:
        with urlopen(req, timeout=20) as res:
            text = res.read().decode("utf-8")
    except HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Supabase {exc.code}: {detail}") from exc
    return json.loads(text) if text else None


def supabase_submission_to_client(row):
    repo_url = row.get("repo_url") or row.get("repo_key") or ""
    repo_id = row.get("repo_id") or repo_id_from_url(repo_url)
    return {
        **row,
        "submission_id": repo_id,
        "repo": repo_url,
        "repo_url": repo_url,
        "repo_id": repo_id,
        "hack_id": active_hack_slug(),
        "submitted_at": row.get("submitted_at") or row.get("timestamp"),
        "timestamp": row.get("submitted_at") or row.get("timestamp"),
    }


def get_supabase_submissions():
    hid = quote(DEFAULT_HACKATHON_ID, safe="")
    rows = supabase_rest(f"/submissions?hackathon_id=eq.{hid}&order=submitted_at.desc.nullsfirst") or []
    return [supabase_submission_to_client(row) for row in rows]


def upsert_supabase_submission(payload):
    repo_url = str(payload.get("repo_url") or payload.get("github_url") or "").strip()
    repo_key = normalize_repo_url(repo_url)
    if not repo_key:
        raise ValueError("repo_url is required")
    row = {
        "repo_key": repo_key,
        "repo_url": repo_url,
        "repo_id": repo_id_from_url(repo_url),
        "team_name": str(payload.get("team_name") or "").strip(),
        "project_name": str(payload.get("project_name") or "").strip(),
        "chosen_track": str(payload.get("chosen_track") or "").strip(),
        "demo_url": str(payload.get("demo_url") or "").strip(),
        "description": str(payload.get("description") or "").strip(),
        "team_members": str(payload.get("team_members") or "").strip(),
        "notes": str(payload.get("notes") or "").strip(),
        "submitted_at": payload.get("submitted_at") or payload.get("timestamp") or "",
        "analysis_status": payload.get("analysis_status") or "pending",
        "hackathon_id": DEFAULT_HACKATHON_ID,
    }
    if not row["submitted_at"]:
        from datetime import datetime, timezone
        row["submitted_at"] = datetime.now(timezone.utc).isoformat()
    result = supabase_rest(
        "/submissions?on_conflict=hackathon_id,repo_key",
        method="POST",
        body=row,
        prefer="return=representation,resolution=merge-duplicates",
    )
    return supabase_submission_to_client(result[0] if result else row)


def supabase_judge_to_client(row):
    return {
        **row,
        "judge": row.get("judge_name"),
        "timestamp": row.get("submitted_at"),
        "thoughts": row.get("notes", ""),
    }


def average(values):
    nums = [float(v or 0) for v in values]
    return round(sum(nums) / len(nums), 3) if nums else 0


def aggregate_judge_responses(rows):
    responses = [supabase_judge_to_client(row) for row in rows]
    grouped = {}
    for row in responses:
        key = normalize_repo_url(row.get("repo_key") or row.get("repo_url") or "")
        if key:
            grouped.setdefault(key, []).append(row)
    by_repo = {}
    for key, repo_rows in grouped.items():
        base = repo_rows[0]
        by_repo[key] = {
            "repo_url": base.get("repo_url", ""),
            "project_name": base.get("project_name", ""),
            "chosen_track": base.get("chosen_track", ""),
            "judge_count": len(repo_rows),
            "responses": repo_rows,
            "averages": {
                "core_total": average([r.get("core_total") for r in repo_rows]),
                "bonus_total": average([r.get("bonus_total_capped") for r in repo_rows]),
                "grand_total": average([r.get("total_score") for r in repo_rows]),
            },
        }
    return {"responses": responses, "by_repo": by_repo}


def get_supabase_judges():
    hid = quote(DEFAULT_HACKATHON_ID, safe="")
    rows = supabase_rest(f"/judge_responses?hackathon_id=eq.{hid}&order=submitted_at.desc") or []
    return aggregate_judge_responses(rows)


def upsert_supabase_judge(payload):
    repo_url = str(payload.get("repo_url") or "").strip()
    repo_key = normalize_repo_url(payload.get("repo_key") or repo_url)
    judge_name = str(payload.get("judge_name") or "").strip()
    if not repo_key or not judge_name:
        raise ValueError("repo_url and judge_name are required")
    total_score = round(max(0, min(10, float(payload.get("total_score") or 0))) * 10) / 10
    core_total = min(total_score, 7)
    bonus_total = min(max(total_score - 7, 0), 3)
    row = {
        "judge_name": judge_name,
        "repo_key": repo_key,
        "repo_url": repo_url or repo_key,
        "project_name": str(payload.get("project_name") or "").strip(),
        "chosen_track": str(payload.get("chosen_track") or "").strip(),
        "scored_track": str(payload.get("scored_track") or payload.get("chosen_track") or "").strip(),
        "notes": str(payload.get("notes") or payload.get("thoughts") or "").strip(),
        "core_scores": payload.get("core_scores") or {"overall": core_total},
        "bonus_bucket_scores": payload.get("bonus_bucket_scores") or {},
        "core_total": core_total,
        "bonus_total_raw": bonus_total,
        "bonus_total_capped": bonus_total,
        "total_score": total_score,
        "hackathon_id": DEFAULT_HACKATHON_ID,
    }
    result = supabase_rest(
        "/judge_responses?on_conflict=judge_name,repo_key,hackathon_id",
        method="POST",
        body=row,
        prefer="return=representation,resolution=merge-duplicates",
    )
    return supabase_judge_to_client(result[0] if result else row)


class UiHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, work_dir: Path, static_dir: Path, **kwargs):
        self.work_dir = work_dir
        self.static_dir = static_dir
        super().__init__(*args, directory=str(static_dir), **kwargs)

    def _send_json(self, payload, status=200):
        data = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _send_text(self, text, status=200):
        data = text.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        path = unquote(self.path.split("?", 1)[0])
        if path == "/api/summary":
            return self.handle_summary()
        if path == "/api/judges":
            return self.handle_judges()
        if path == "/api/submissions":
            return self.handle_submissions()
        if path == "/api/event-format":
            return self.handle_event_format()
        if path == "/api/hacks":
            return self.handle_hacks()
        if path.startswith("/api/repo/"):
            return self.handle_repo(path)
        return super().do_GET()

    def do_POST(self):
        path = unquote(self.path.split("?", 1)[0])
        if path == "/api/submissions":
            return self.handle_submission_post()
        if path == "/api/judges":
            return self.handle_judge_post()
        return self._send_json({"error": "unknown endpoint"}, status=404)

    def _read_json_body(self):
        length = int(self.headers.get("Content-Length", "0") or "0")
        raw = self.rfile.read(length) if length else b"{}"
        try:
            return json.loads(raw.decode("utf-8") or "{}")
        except json.JSONDecodeError:
            return None

    def handle_summary(self):
        summary_path = self.work_dir / "summary" / "metrics_summary.csv"
        if not summary_path.exists():
            return self._send_json({"error": "summary not found"}, status=404)
        rows = []
        with summary_path.open(newline="", encoding="utf-8") as f:
            reader = csv.DictReader(f)
            for row in reader:
                rows.append(row)
        return self._send_json({"rows": rows})

    def handle_judges(self):
        if supabase_configured():
            try:
                return self._send_json(get_supabase_judges())
            except Exception as exc:
                return self._send_json({"error": f"failed to load Supabase judge data: {exc}"}, status=500)
        if not JUDGE_RESPONSES_PATH.exists():
            return self._send_json({"error": "judge data not found"}, status=404)
        try:
            data = json.loads(JUDGE_RESPONSES_PATH.read_text(encoding="utf-8"))
        except Exception as exc:
            return self._send_json({"error": f"failed to load judge data: {exc}"}, status=500)
        return self._send_json(data)

    def handle_submissions(self):
        if supabase_configured():
            try:
                return self._send_json({"submissions": get_supabase_submissions()})
            except Exception as exc:
                return self._send_json({"error": f"failed to load Supabase submissions: {exc}"}, status=500)
        if not SUBMISSIONS_PATH.exists():
            return self._send_json({"submissions": []})
        try:
            data = json.loads(SUBMISSIONS_PATH.read_text(encoding="utf-8"))
        except Exception as exc:
            return self._send_json({"error": f"failed to load submissions data: {exc}"}, status=500)
        return self._send_json(data)

    def handle_submission_post(self):
        payload = self._read_json_body()
        if not isinstance(payload, dict):
            return self._send_json({"error": "invalid JSON body"}, status=400)
        if not str(payload.get("repo_url", "")).strip():
            return self._send_json({"error": "repo_url is required"}, status=400)

        try:
            if supabase_configured():
                entry = upsert_supabase_submission(payload)
                return self._send_json(
                    {"ok": True, "submission": entry, "submissions": get_supabase_submissions(), "storage": "supabase"},
                    status=201,
                )
            if os.environ.get("HACKATHON_ALLOW_LOCAL_FALLBACK") != "1":
                return self._send_json(
                    {
                        "error": "Supabase is not configured. Set SUPABASE_PROJECT_URL, SUPABASE_SERVICE_ROLE_SECRET, and DEFAULT_HACKATHON_ID before accepting live submissions.",
                    },
                    status=503,
                )
            entry = self.persist_submission(payload)
            self.prepare_submissions()
            scan_started = self.start_scan()
        except Exception as exc:
            return self._send_json({"error": f"failed to save submission: {exc}"}, status=500)

        return self._send_json({"ok": True, "submission": entry, "scan_started": scan_started, "storage": "local"}, status=201)

    def handle_judge_post(self):
        payload = self._read_json_body()
        if not isinstance(payload, dict):
            return self._send_json({"error": "invalid JSON body"}, status=400)
        if not supabase_configured():
            return self._send_json(
                {
                    "error": "Supabase is not configured. Judge scores cannot be stored locally for live judging.",
                },
                status=503,
            )
        try:
            response = upsert_supabase_judge(payload)
            aggregate = get_supabase_judges()
        except Exception as exc:
            return self._send_json({"error": f"failed to save judge score: {exc}"}, status=500)
        return self._send_json({"ok": True, "response": response, **aggregate}, status=201)

    def persist_submission(self, payload):
        RAW_SUBMISSIONS_PATH.parent.mkdir(parents=True, exist_ok=True)
        fieldnames = [
            "Timestamp",
            "Team Name",
            "Project Name",
            "Github URL",
            "Chosen Track",
            "Demo URL",
            "Team Members",
            "Notes",
        ]
        existing_rows = []
        if RAW_SUBMISSIONS_PATH.exists():
            with RAW_SUBMISSIONS_PATH.open(newline="", encoding="utf-8") as f:
                reader = csv.DictReader(f)
                existing_rows = list(reader)

        row = {
            "Timestamp": payload.get("submitted_at", ""),
            "Team Name": payload.get("team_name", ""),
            "Project Name": payload.get("project_name", ""),
            "Github URL": payload.get("repo_url", ""),
            "Chosen Track": payload.get("chosen_track", ""),
            "Demo URL": payload.get("demo_url", ""),
            "Team Members": payload.get("team_members", ""),
            "Notes": payload.get("notes", ""),
        }
        repo_key = str(row["Github URL"]).strip().lower().removesuffix(".git")
        existing_rows = [
            r
            for r in existing_rows
            if str(r.get("Github URL", "")).strip().lower().removesuffix(".git") != repo_key
        ]
        existing_rows.append(row)

        with RAW_SUBMISSIONS_PATH.open("w", newline="", encoding="utf-8") as f:
            writer = csv.DictWriter(f, fieldnames=fieldnames)
            writer.writeheader()
            writer.writerows(existing_rows)
        return row

    def prepare_submissions(self):
        hack_id = "cursor-live-london-q3-2026"
        if HACKS_PATH.exists():
            try:
                hack_id = json.loads(HACKS_PATH.read_text(encoding="utf-8")).get("active_hack_id") or hack_id
            except Exception:
                pass
        subprocess.run(
            [
                sys.executable,
                str(PROJECT_ROOT / "prepare_submissions.py"),
                "--input",
                str(RAW_SUBMISSIONS_PATH),
                "--repos-out",
                str(REPOS_PATH),
                "--project-map-out",
                str(PROJECT_MAP_PATH),
                "--json-out",
                str(SUBMISSIONS_PATH),
                "--hack-id",
                hack_id,
            ],
            cwd=str(PROJECT_ROOT),
            check=True,
        )

    def start_scan(self):
        if not REPOS_PATH.exists():
            return False
        logs_dir = self.work_dir / "logs"
        logs_dir.mkdir(parents=True, exist_ok=True)
        log_file = (logs_dir / "scan-background.log").open("ab")
        cmd = [
            sys.executable,
            str(PROJECT_ROOT / "scan.py"),
            "--repos",
            str(REPOS_PATH),
            "--work-dir",
            str(self.work_dir),
        ]
        if CONFIG_PATH.exists():
            cmd.extend(["--config", str(CONFIG_PATH)])
        subprocess.Popen(
            cmd,
            cwd=str(PROJECT_ROOT),
            stdout=log_file,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )
        return True

    def handle_event_format(self):
        if not EVENT_FORMAT_PATH.exists():
            return self._send_json({"error": "event format not found"}, status=404)
        try:
            data = json.loads(EVENT_FORMAT_PATH.read_text(encoding="utf-8"))
        except Exception as exc:
            return self._send_json({"error": f"failed to load event format: {exc}"}, status=500)
        return self._send_json(data)

    def handle_hacks(self):
        if not HACKS_PATH.exists():
            return self._send_json({"hacks": [], "active_hack_id": None})
        try:
            data = json.loads(HACKS_PATH.read_text(encoding="utf-8"))
        except Exception as exc:
            return self._send_json({"error": f"failed to load hacks: {exc}"}, status=500)
        return self._send_json(data)

    def handle_repo(self, path: str):
        parts = path.split("/")
        if len(parts) < 4:
            return self._send_json({"error": "invalid repo path"}, status=400)
        repo_id = unquote(parts[3])
        suffix = "/".join(parts[4:]) if len(parts) > 4 else ""
        metrics_path = self.work_dir / "metrics" / f"{repo_id}.json"
        commits_path = self.work_dir / "metrics" / f"{repo_id}_commits.csv"
        ai_path = self.work_dir / "ai_outputs" / f"{repo_id}.txt"

        if suffix.startswith("metrics"):
            if not metrics_path.exists():
                return self._send_json({"error": "metrics not found"}, status=404)
            data = json.loads(metrics_path.read_text(encoding="utf-8"))
            return self._send_json(data)

        if suffix.startswith("commits"):
            if not commits_path.exists():
                return self._send_json({"error": "commits not found"}, status=404)
            commits = []
            with commits_path.open(newline="", encoding="utf-8") as f:
                reader = csv.DictReader(f)
                for row in reader:
                    commits.append(row)
            return self._send_json({"rows": commits})

        if suffix.startswith("ai"):
            if not ai_path.exists():
                return self._send_text("AI output not found.", status=404)
            return self._send_text(ai_path.read_text(encoding="utf-8"))

        return self._send_json({"error": "unknown repo endpoint"}, status=404)


def run_server(work_dir: Path, static_dir: Path, port: int):
    handler = lambda *args, **kwargs: UiHandler(*args, work_dir=work_dir, static_dir=static_dir, **kwargs)
    httpd = HTTPServer(("0.0.0.0", port), handler)
    print(f"Serving UI at http://localhost:{port} (work dir: {work_dir})")
    if supabase_configured():
        print(f"Persistence: Supabase (hackathon_id={DEFAULT_HACKATHON_ID})")
    else:
        print("Persistence: NOT CONFIGURED. POST /api/submissions and /api/judges will fail closed.")
    httpd.serve_forever()


def main():
    parser = argparse.ArgumentParser(description="Serve local web UI for hackathon analyzer outputs.")
    parser.add_argument("--work-dir", default="work", help="Work directory containing metrics/summary/ai_outputs")
    parser.add_argument("--port", type=int, default=8000, help="Port to serve on")
    args = parser.parse_args()

    work_dir = Path(args.work_dir).resolve()
    static_dir = Path(__file__).resolve().parent / "static"
    run_server(work_dir, static_dir, args.port)


if __name__ == "__main__":
    main()
