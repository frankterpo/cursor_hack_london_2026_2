#!/usr/bin/env python3
"""
Convert a competitor submission export into the analyzer inputs used by scan.py.

Inputs:
- A CSV exported from your submission form using the fields in data/submissions-template.csv

Outputs:
- data/repos.csv
- data/project-repo-map.csv
- data/submissions-normalized.json

Usage:
  python3 prepare_submissions.py \
    --input data/submissions-raw.csv \
    --repos-out data/repos.csv \
    --project-map-out data/project-repo-map.csv \
    --json-out data/submissions-normalized.json
"""

from __future__ import annotations

import argparse
import csv
import json
import re
from pathlib import Path
from typing import Dict, List, Optional, Tuple


REPO_URL_KEYS = (
    "Github URL",
    "GitHub URL",
    "Please provide the Github URL of your project (should be publicly accessible)",
    "repo_url",
    "repo",
)
TEAM_NAME_KEYS = ("Team Name", "team_name", "team", "name")
PROJECT_NAME_KEYS = ("Project Name", "project_name", "project", "product_name")
TRACK_KEYS = ("Chosen Track", "chosen_track", "track")
DEMO_KEYS = ("Demo URL", "demo_url", "demo")
MEMBER_KEYS = ("Team Members", "team_members", "members")
NOTES_KEYS = ("Notes", "notes")
TIMESTAMP_KEYS = ("Timestamp", "timestamp")


def first_non_empty(row: Dict[str, str], keys: Tuple[str, ...]) -> str:
    for key in keys:
        val = row.get(key, "")
        if val and str(val).strip():
            return str(val).strip()
    return ""


def parse_repo_url(raw: str) -> Tuple[str, str]:
    trimmed = raw.strip()
    if trimmed.startswith("git@github.com:"):
        path_part = trimmed.split(":", 1)[1]
    elif "://" in trimmed:
        after_scheme = trimmed.split("://", 1)[1]
        if "/" not in after_scheme:
            raise ValueError(f"Could not parse repo URL: {raw}")
        path_part = after_scheme.split("/", 1)[1]
    else:
        path_part = trimmed

    path_part = path_part.strip("/")
    if path_part.endswith(".git"):
        path_part = path_part[:-4]
    parts = path_part.split("/")
    if len(parts) < 2:
        raise ValueError(f"Could not extract owner/repo from: {raw}")
    owner, repo = parts[0], parts[1]
    slug = f"{owner}/{repo}"
    clone_url = raw if ("://" in trimmed or trimmed.startswith("git@")) else f"https://github.com/{slug}.git"
    return slug, clone_url


def slugify(value: str) -> str:
    compact = re.sub(r"[^a-zA-Z0-9]+", "-", value.strip().lower()).strip("-")
    return compact or "submission"


def normalize_rows(input_path: Path, hack_id: str) -> List[Dict[str, str]]:
    with input_path.open(newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        rows = list(reader)

    cohort = (hack_id or "").strip()
    normalized = []
    for idx, row in enumerate(rows, start=1):
        repo_url = first_non_empty(row, REPO_URL_KEYS)
        if not repo_url:
            continue
        try:
            slug, clone_url = parse_repo_url(repo_url)
        except ValueError:
            continue

        team_name = first_non_empty(row, TEAM_NAME_KEYS)
        project_name = first_non_empty(row, PROJECT_NAME_KEYS) or team_name or slug.replace("/", "-")
        submission_id = slugify(project_name or team_name or slug.replace("/", "-"))

        normalized.append(
            {
                "submission_id": submission_id,
                "hack_id": cohort,
                "team_name": team_name or project_name,
                "project_name": project_name,
                "repo_slug": slug,
                "repo_url": clone_url,
                "chosen_track": first_non_empty(row, TRACK_KEYS),
                "demo_url": first_non_empty(row, DEMO_KEYS),
                "team_members": first_non_empty(row, MEMBER_KEYS),
                "notes": first_non_empty(row, NOTES_KEYS),
                "timestamp": first_non_empty(row, TIMESTAMP_KEYS),
            }
        )
    return normalized


def write_repos_csv(path: Path, rows: List[Dict[str, str]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=["id", "repo"])
        writer.writeheader()
        seen = set()
        for row in rows:
            if row["repo_url"] in seen:
                continue
            seen.add(row["repo_url"])
            writer.writerow({"id": row["submission_id"], "repo": row["repo_url"]})


def write_project_map(path: Path, rows: List[Dict[str, str]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f, delimiter="\t")
        writer.writerow(
            [
                "What is your team or product name? (will be used when announcing winners)",
                "Please provide the Github URL of your project (should be publicly accessible)",
            ]
        )
        for row in rows:
            writer.writerow([row["project_name"], row["repo_url"]])


def write_json(path: Path, rows: List[Dict[str, str]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        json.dump({"submissions": rows}, f, indent=2, ensure_ascii=False)


def main() -> int:
    parser = argparse.ArgumentParser(description="Prepare analyzer inputs from a competitor submissions export.")
    parser.add_argument("--input", required=True, type=Path, help="Path to raw submissions CSV export")
    parser.add_argument("--repos-out", default="data/repos.csv", type=Path, help="Output repos.csv path")
    parser.add_argument(
        "--project-map-out",
        default="data/project-repo-map.csv",
        type=Path,
        help="Output project-repo map path",
    )
    parser.add_argument(
        "--json-out",
        default="data/submissions-normalized.json",
        type=Path,
        help="Output normalized submissions JSON path",
    )
    parser.add_argument(
        "--hack-id",
        default="cursor-live-london-q3-2026",
        help="Cohort id on each submission (must match hacks.json active_hack_id)",
    )
    args = parser.parse_args()

    rows = normalize_rows(args.input, args.hack_id)
    write_repos_csv(args.repos_out, rows)
    write_project_map(args.project_map_out, rows)
    write_json(args.json_out, rows)

    print(f"Prepared {len(rows)} submissions")
    print(f"- Repos CSV: {args.repos_out}")
    print(f"- Project map: {args.project_map_out}")
    print(f"- Normalized JSON: {args.json_out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
