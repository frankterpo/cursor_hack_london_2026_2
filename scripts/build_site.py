#!/usr/bin/env python3
"""Vercel build step: bake the hackathon UI + read-only data into ``dist/``.

Mutable endpoints such as submissions and judge scores are served by Vercel
Functions in ``api/`` so live writes reach Supabase instead of static files.
"""

from __future__ import annotations

import csv
import json
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
APP_DIR = ROOT / "cursor-hackathon-hcmc-2025"
STATIC_SRC = APP_DIR / "ui" / "static"
DATA_DIR = APP_DIR / "data"
WORK_DIR = APP_DIR / "work"
DIST = ROOT / "dist"

# All historical data belongs to the first hack; new activity gets stamped with
# the currently-active hack_id by the client at submit time.
LEGACY_HACK_ID = "cursor-hcmc-2025"


def write_json(path: Path, payload) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def build_summary() -> list[dict]:
    summary_path = WORK_DIR / "summary" / "metrics_summary.csv"
    if not summary_path.exists():
        return []
    with summary_path.open(newline="", encoding="utf-8") as f:
        rows = list(csv.DictReader(f))
    for row in rows:
        row.setdefault("hack_id", LEGACY_HACK_ID)
    return rows


def build_submissions() -> dict:
    submissions_path = DATA_DIR / "submissions-normalized.json"
    if not submissions_path.exists():
        return {"submissions": []}
    payload = json.loads(submissions_path.read_text(encoding="utf-8"))
    for sub in payload.get("submissions", []) or []:
        sub.setdefault("hack_id", LEGACY_HACK_ID)
    return payload


def build_judges() -> dict:
    judges_path = DATA_DIR / "judge-responses-normalized.json"
    if not judges_path.exists():
        return {"judges": []}
    payload = json.loads(judges_path.read_text(encoding="utf-8"))
    by_repo = payload.get("by_repo") or {}
    for entry in by_repo.values():
        entry.setdefault("hack_id", LEGACY_HACK_ID)
        for response in entry.get("responses", []) or []:
            response.setdefault("hack_id", LEGACY_HACK_ID)
    return payload


def build_hacks() -> dict:
    hacks_path = DATA_DIR / "hacks.json"
    if not hacks_path.exists():
        return {"hacks": [], "active_hack_id": None}
    return json.loads(hacks_path.read_text(encoding="utf-8"))


def collect_repo_ids() -> set[str]:
    ids: set[str] = set()
    metrics_dir = WORK_DIR / "metrics"
    if metrics_dir.exists():
        for p in metrics_dir.iterdir():
            if p.suffix == ".json":
                ids.add(p.stem)
            elif p.name.endswith("_commits.csv"):
                ids.add(p.name[: -len("_commits.csv")])
    ai_dir = WORK_DIR / "ai_outputs"
    if ai_dir.exists():
        for p in ai_dir.glob("*.txt"):
            ids.add(p.stem)
    return ids


def build_per_repo(repo_id: str) -> None:
    base = DIST / "api" / "repo" / repo_id

    metrics_path = WORK_DIR / "metrics" / f"{repo_id}.json"
    if metrics_path.exists():
        payload = json.loads(metrics_path.read_text(encoding="utf-8"))
        write_json(base / "metrics", payload)

    commits_path = WORK_DIR / "metrics" / f"{repo_id}_commits.csv"
    if commits_path.exists():
        with commits_path.open(newline="", encoding="utf-8") as f:
            rows = list(csv.DictReader(f))
        write_json(base / "commits", {"rows": rows})

    ai_path = WORK_DIR / "ai_outputs" / f"{repo_id}.txt"
    if ai_path.exists():
        write_text(base / "ai", ai_path.read_text(encoding="utf-8"))


def copy_static() -> None:
    if DIST.exists():
        shutil.rmtree(DIST)
    DIST.mkdir(parents=True)
    for item in STATIC_SRC.iterdir():
        dest = DIST / item.name
        if item.is_dir():
            shutil.copytree(item, dest)
        else:
            shutil.copy2(item, dest)


def main() -> None:
    copy_static()
    write_json(DIST / "api" / "summary", {"rows": build_summary()})
    write_json(DIST / "api" / "hacks", build_hacks())
    # Also expose the event format so future clients can read tracks directly.
    event_format_path = DATA_DIR / "event-format.json"
    if event_format_path.exists():
        write_json(
            DIST / "api" / "event-format",
            json.loads(event_format_path.read_text(encoding="utf-8")),
        )
    repo_ids = collect_repo_ids()
    for repo_id in sorted(repo_ids):
        build_per_repo(repo_id)
    print(f"Built dist/ with {len(repo_ids)} repos and read-only API snapshots.")


if __name__ == "__main__":
    main()
