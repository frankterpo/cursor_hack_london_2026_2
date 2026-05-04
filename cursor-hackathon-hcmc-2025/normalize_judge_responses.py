from __future__ import annotations

import csv
import json
import re
from collections import defaultdict
from difflib import get_close_matches
from pathlib import Path
from typing import Dict, List, Optional


RAW_RESPONSES_PATH = Path("data/judge-responses-raw.csv")
PROJECT_MAP_PATH = Path("data/project-repo-map.csv")
EVENT_FORMAT_PATH = Path("data/event-format.json")
OUTPUT_PATH = Path("data/judge-responses-normalized.json")
LEGACY_JUDGE_OVERRIDE_PATH = Path("data/legacy-response-judge-overrides.json")

LEGACY_SCORE_FIELD = "Score"
LEGACY_NOTES_FIELD = "Thoughts"


def clean_project_name(name: str) -> str:
    return re.sub(r"\s+", " ", str(name).strip()).lower()


def extract_first_url(text: str) -> Optional[str]:
    if not isinstance(text, str):
        return None
    match = re.search(r"https?://[^\s,]+", text)
    return match.group(0).strip() if match else None


def load_event_format() -> dict:
    return json.loads(EVENT_FORMAT_PATH.read_text(encoding="utf-8"))


def load_project_repo_map() -> Dict[str, str]:
    mapping: Dict[str, str] = {}
    if not PROJECT_MAP_PATH.exists():
        return mapping

    with PROJECT_MAP_PATH.open(newline="", encoding="utf-8") as f:
        reader = csv.reader(f, delimiter="\t")
        for row in reader:
            if len(row) < 2:
                continue
            project_raw, repo_raw = row[0], row[1]
            repo_url = extract_first_url(repo_raw)
            if not repo_url:
                continue
            mapping[clean_project_name(project_raw)] = repo_url
    return mapping


def build_manual_aliases(mapping_keys: List[str]) -> Dict[str, str]:
    aliases = {
        clean_project_name("BaeFit"): clean_project_name("BaeFit - Megumin Virtual Assistant"),
        clean_project_name("BillionaireTwin"): clean_project_name("BillionaireTwin (Thanh/Giang/Dung)"),
        clean_project_name("Eduflow"): clean_project_name("Eduflow by Kody"),
        clean_project_name("HISTORYLENS"): clean_project_name("HISTORYLENS - LĂNG KÍNH LỊCH SỬ"),
        clean_project_name("IDB Team - Odoo + Cursor"): clean_project_name("IDB Team"),
        clean_project_name("Quantum Bug ; Product name: AirDraw"): clean_project_name("Team: Quantum Bug ; Product name: AirDraw"),
        clean_project_name("World Bias AI"): clean_project_name("World Bias"),
        clean_project_name("finance Flow"): clean_project_name("FinancialFriend"),
        clean_project_name("AI personal finance assistant"): clean_project_name("FinancialFriend"),
        clean_project_name("off clock"): clean_project_name("Off Clock"),
    }
    return {k: v for k, v in aliases.items() if v in mapping_keys}


def resolve_project_repo(project_clean: str, mapping: Dict[str, str], aliases: Dict[str, str]) -> Optional[str]:
    if project_clean in mapping:
        return mapping[project_clean]
    if project_clean in aliases:
        target = aliases[project_clean]
        return mapping.get(target)
    close = get_close_matches(project_clean, mapping.keys(), n=1, cutoff=0.9)
    if close:
        return mapping[close[0]]
    return None


def parse_int(value: str) -> int:
    if value is None:
        return 0
    stripped = str(value).strip()
    if not stripped:
        return 0
    try:
        return int(float(stripped))
    except ValueError:
        return 0


def average(values: List[float]) -> float:
    if not values:
        return 0.0
    return round(sum(values) / len(values), 3)


def get_core_fields(event_format: dict) -> List[dict]:
    return event_format["rubric"]["criteria"]


def get_bonus_fields(event_format: dict) -> List[dict]:
    return event_format["side_quests"]


def build_bonus_column_map(event_format: dict) -> Dict[str, str]:
    return {
        "best_cursor_native_workflow": "Best Cursor-Native Workflow Bonus (0-30)",
        "best_developer_tool": "Best Developer Tool Bonus (0-30)",
        "best_reliability_system": "Best Reliability System Bonus (0-30)",
        "most_technically_ambitious": "Most Technically Ambitious Bonus (0-30)",
        "best_demo": "Best Demo Bonus (0-30)",
        "best_use_of_ai_safety": "Best Use of AI Safety Bonus (0-30)",
        "best_use_of_open_claw": "Best Use of Open Claw Bonus (0-30)",
    }


def build_core_column_map(event_format: dict) -> Dict[str, str]:
    return {
        "concrete_workflow_value": "Concrete Workflow Value (0-30)",
        "track_fit": "Track Fit (0-25)",
        "reliability_and_verification": "Reliability And Verification (0-20)",
        "technical_execution": "Technical Execution (0-15)",
        "demo_clarity": "Demo Clarity (0-10)",
    }


def normalize_legacy_row(row: Dict[str, str]) -> dict:
    score = parse_int(row.get(LEGACY_SCORE_FIELD, 0))
    return {
        "timestamp": row.get("Timestamp", ""),
        "judge": row.get("Judge", "") or None,
        "track": row.get("Chosen Track", "") or None,
        "core_scores": {},
        "bonus_bucket_scores": {},
        "core_total": score,
        "bonus_total_raw": 0,
        "bonus_total_capped": 0,
        "total_score": score,
        "notes": row.get(LEGACY_NOTES_FIELD, "") or None,
        "validation": {
            "bonus_bucket_overflow": False,
            "core_score_overflow": False,
        },
    }


def normalize_detailed_row(row: Dict[str, str], event_format: dict) -> dict:
    core_column_map = build_core_column_map(event_format)
    bonus_column_map = build_bonus_column_map(event_format)
    core_fields = get_core_fields(event_format)
    bonus_fields = get_bonus_fields(event_format)
    side_bonus_cap = int(event_format["judge_bonus_bucket"]["max_points"])

    core_scores = {
        field["id"]: parse_int(row.get(core_column_map[field["id"]], 0))
        for field in core_fields
    }
    bonus_scores = {
        field["id"]: parse_int(row.get(bonus_column_map[field["id"]], 0))
        for field in bonus_fields
    }

    core_total = sum(core_scores.values())
    bonus_total_raw = sum(bonus_scores.values())
    bonus_total_capped = min(bonus_total_raw, side_bonus_cap)
    core_score_overflow = any(core_scores[field["id"]] > int(field["points"]) for field in core_fields)

    return {
        "timestamp": row.get("Timestamp", ""),
        "judge": row.get("Judge", "") or None,
        "track": row.get("Chosen Track", "") or None,
        "core_scores": core_scores,
        "bonus_bucket_scores": bonus_scores,
        "core_total": core_total,
        "bonus_total_raw": bonus_total_raw,
        "bonus_total_capped": bonus_total_capped,
        "total_score": core_total + bonus_total_capped,
        "notes": row.get("Notes", "") or None,
        "validation": {
            "bonus_bucket_overflow": bonus_total_raw > side_bonus_cap,
            "core_score_overflow": core_score_overflow,
        },
    }


def load_legacy_response_judge_overrides() -> dict:
    if not LEGACY_JUDGE_OVERRIDE_PATH.exists():
        return {}
    try:
        raw = json.loads(LEGACY_JUDGE_OVERRIDE_PATH.read_text(encoding="utf-8"))
        if not isinstance(raw, dict):
            return {}
        return raw
    except Exception:
        return {}


def apply_legacy_response_judge_overrides(
    repo_url: str, responses: List[dict], overrides: dict
) -> None:
    """Fill missing judge labels for legacy CSV rows when source had no Judge column."""
    raw_by_ts = overrides.get(repo_url)
    by_ts = raw_by_ts if isinstance(raw_by_ts, dict) else {}
    if not by_ts:
        return
    for r in responses:
        if r.get("judge"):
            continue
        ts = (r.get("timestamp") or "").strip()
        if not ts:
            continue
        name = by_ts.get(ts)
        if isinstance(name, str) and name.strip():
            r["judge"] = name.strip()


def aggregate_repo(project: str, raw_names: set[str], responses: List[dict], event_format: dict) -> dict:
    core_fields = get_core_fields(event_format)
    bonus_fields = get_bonus_fields(event_format)

    core_averages = {
        field["id"]: average([response["core_scores"].get(field["id"], 0) for response in responses])
        for field in core_fields
    }
    bonus_averages = {
        field["id"]: average([response["bonus_bucket_scores"].get(field["id"], 0) for response in responses])
        for field in bonus_fields
    }
    core_total_avg = average([response["core_total"] for response in responses])
    bonus_total_avg = average([response["bonus_total_capped"] for response in responses])
    grand_total_avg = average([response["total_score"] for response in responses])

    legacy_responses = all(not response["core_scores"] for response in responses)
    payload = {
        "project": project,
        "raw_project_names": sorted(raw_names),
        "responses": responses,
        "judge_count": len(responses),
        "legacy_mode": legacy_responses,
        "averages": {
            "core_scores": core_averages,
            "bonus_bucket_scores": bonus_averages,
            "core_total": core_total_avg,
            "bonus_total": bonus_total_avg,
            "grand_total": grand_total_avg,
        },
    }
    if legacy_responses:
        payload["average_score"] = grand_total_avg
    return payload


def normalize_responses() -> Dict[str, dict]:
    event_format = load_event_format()
    project_repo_map = load_project_repo_map()
    aliases = build_manual_aliases(list(project_repo_map.keys()))

    with RAW_RESPONSES_PATH.open(newline="", encoding="utf-8") as f:
        responses = list(csv.DictReader(f))

    normalized: Dict[str, dict] = {}
    unmapped: List[dict] = []
    aggregator: Dict[str, dict] = defaultdict(
        lambda: {"project": None, "responses": [], "raw_project_names": set()}
    )

    detailed_mode = responses and "Concrete Workflow Value (0-30)" in responses[0]

    for row in responses:
        project_raw = row.get("Project", "").strip()
        project_clean = clean_project_name(project_raw)
        repo_url = row.get("Repo URL", "").strip() or resolve_project_repo(project_clean, project_repo_map, aliases)
        entry = normalize_detailed_row(row, event_format) if detailed_mode else normalize_legacy_row(row)

        if repo_url:
            agg = aggregator[repo_url]
            agg["project"] = agg["project"] or project_raw
            agg["raw_project_names"].add(project_raw)
            agg["responses"].append(entry)
        else:
            unmapped.append({"project": project_raw, **entry})

    judge_overrides = load_legacy_response_judge_overrides()
    for repo_url, data in aggregator.items():
        apply_legacy_response_judge_overrides(repo_url, data["responses"], judge_overrides)
        normalized[repo_url] = aggregate_repo(
            project=data["project"],
            raw_names=data["raw_project_names"],
            responses=data["responses"],
            event_format=event_format,
        )

    return {
        "event_format": event_format,
        "by_repo": normalized,
        "unmapped_responses": unmapped,
    }


def main() -> None:
    result = normalize_responses()
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    with OUTPUT_PATH.open("w", encoding="utf-8") as f:
        json.dump(result, f, indent=2, ensure_ascii=False)
    print(f"Wrote normalized responses to {OUTPUT_PATH}")
    if result["unmapped_responses"]:
        print("Unmapped projects:")
        for entry in result["unmapped_responses"]:
            print(f"- {entry['project']}")


if __name__ == "__main__":
    main()
