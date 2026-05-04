#!/usr/bin/env python3
from __future__ import annotations

import csv
import json
import shutil
from pathlib import Path


WORKSPACE_ROOT = Path("/Users/franciscoterpolilli/Projects/cusor_hack_london_2026_0")
SOURCE_ROOT = WORKSPACE_ROOT / "cursor-hackathon-hcmc-2025"
TARGET_ROOT = WORKSPACE_ROOT / "guild-bounty-board" / "public" / "admin" / "data"


def ensure_dir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)


def write_json(path: Path, payload: object) -> None:
    ensure_dir(path.parent)
    path.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")


def load_summary_csv(path: Path) -> list[dict]:
    if not path.exists():
        return []
    with path.open(newline="", encoding="utf-8") as handle:
        return list(csv.DictReader(handle))


def copy_tree_contents(source_dir: Path, target_dir: Path) -> int:
    ensure_dir(target_dir)
    copied = 0
    for source_path in sorted(source_dir.iterdir()):
        if not source_path.is_file():
            continue
        shutil.copy2(source_path, target_dir / source_path.name)
        copied += 1
    return copied


def export_commit_jsons(source_dir: Path, target_dir: Path) -> int:
    ensure_dir(target_dir)
    count = 0
    for source_path in sorted(source_dir.glob("*_commits.csv")):
        with source_path.open(newline="", encoding="utf-8") as handle:
            rows = list(csv.DictReader(handle))
        target_name = source_path.name.replace("_commits.csv", ".json")
        write_json(target_dir / target_name, {"rows": rows})
        count += 1
    return count


def main() -> int:
    ensure_dir(TARGET_ROOT)

    summary_rows = load_summary_csv(SOURCE_ROOT / "work" / "summary" / "metrics_summary.csv")
    write_json(TARGET_ROOT / "summary.json", {"rows": summary_rows})

    judges_path = SOURCE_ROOT / "data" / "judge-responses-normalized.json"
    if judges_path.exists():
        shutil.copy2(judges_path, TARGET_ROOT / "judge-responses-normalized.json")
    else:
        write_json(TARGET_ROOT / "judge-responses-normalized.json", {"by_repo": {}, "unmapped_responses": []})

    submissions_path = SOURCE_ROOT / "data" / "submissions-normalized.json"
    if submissions_path.exists():
        shutil.copy2(submissions_path, TARGET_ROOT / "submissions-normalized.json")
    else:
        write_json(TARGET_ROOT / "submissions-normalized.json", {"submissions": []})

    metrics_count = copy_tree_contents(
        SOURCE_ROOT / "work" / "metrics",
        TARGET_ROOT / "metrics",
    )
    commit_count = export_commit_jsons(
        SOURCE_ROOT / "work" / "metrics",
        TARGET_ROOT / "commits",
    )
    ai_count = copy_tree_contents(SOURCE_ROOT / "work" / "ai_outputs", TARGET_ROOT / "ai")

    print(f"Published admin snapshot to {TARGET_ROOT}")
    print(f"- Summary rows: {len(summary_rows)}")
    print(f"- Metrics files: {metrics_count}")
    print(f"- Commit files: {commit_count}")
    print(f"- AI files: {ai_count}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
