#!/usr/bin/env python3
"""
Minimal local web UI to browse hackathon analysis outputs.

Serves static files from ui/static and JSON APIs backed by work/* artifacts.

**Live submissions:** POST /api/submissions and POST /api/judges are implemented
only by this server.

**Do not** use ``python -m http.server`` for this site — it only supports GET/HEAD
and returns **501 Unsupported method ('POST')** for POST. Run instead::

    python3 cursor-hackathon-hcmc-2025/ui/server.py --work-dir work --port 8765

Set ``SUPABASE_PROJECT_URL`` and ``SUPABASE_SERVICE_ROLE_SECRET`` (and optionally
``DEFAULT_HACKATHON_ID``) for Supabase-backed submits, matching production. On startup,
loads ``guild-bounty-board/.env.local`` then repo-root ``.env.local`` (root overrides
shared keys; existing shell exports win). Resolves ``hackathon_id`` from ``ACTIVE_HACK_SLUG``
/ ``hacks.json`` via Supabase when configured. ``SUPABASE_SERVICE_ROLE_KEY`` is accepted as
an alias for the secret.
"""

import argparse
import csv
import json
import os
import re
import subprocess
import sys
from http.server import HTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import quote, unquote, urlparse
from urllib.request import Request, urlopen


def _parse_dotenv_line(line: str) -> tuple[str, str] | None:
    line = line.strip()
    if not line or line.startswith("#"):
        return None
    if line.startswith("export "):
        line = line[7:].strip()
    if "=" not in line:
        return None
    key, _, raw = line.partition("=")
    key = key.strip()
    if not key:
        return None
    value = raw.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
        value = value[1:-1]
    return key, value


def _load_dotenv_file(path: Path, *, override: bool = False) -> None:
    if not path.is_file():
        return
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return
    for line in text.splitlines():
        parsed = _parse_dotenv_line(line)
        if not parsed:
            continue
        key, value = parsed
        if override or key not in os.environ:
            os.environ[key] = value


def load_local_env() -> None:
    """Load guild then repo-root .env.local; root overrides shared keys (e.g. DEFAULT_HACKATHON_ID)."""
    ui_dir = Path(__file__).resolve().parent
    repo_root = ui_dir.parent.parent
    _load_dotenv_file(repo_root / "guild-bounty-board" / ".env.local", override=False)
    _load_dotenv_file(repo_root / ".env.local", override=True)
    if not (os.environ.get("SUPABASE_SERVICE_ROLE_SECRET") or "").strip():
        alt = (os.environ.get("SUPABASE_SERVICE_ROLE_KEY") or "").strip()
        if alt:
            os.environ["SUPABASE_SERVICE_ROLE_SECRET"] = alt


load_local_env()


class SupabaseNetworkError(RuntimeError):
    """Raised when Supabase REST calls fail due to low-level network/DNS/connectivity."""

    detail = "supabase_network"


def _exception_errno(exc: BaseException) -> int | None:
    n = getattr(exc, "errno", None)
    if isinstance(n, int):
        return n
    reason = getattr(exc, "reason", None)
    if isinstance(reason, BaseException):
        rn = getattr(reason, "errno", None)
        if isinstance(rn, int):
            return rn
    return None


def supabase_project_url_parsed_host() -> str | None:
    raw = (os.environ.get("SUPABASE_PROJECT_URL") or "").strip()
    if not raw:
        return None
    try:
        parsed = urlparse(raw)
    except Exception:
        return None
    host = (parsed.hostname or "").strip()
    return host or None


def supabase_project_url_host_hint() -> str:
    h = supabase_project_url_parsed_host()
    if h:
        return h
    return "SUPABASE_PROJECT_URL missing or invalid (no host)"


def log_supabase_error(operation: str, exc: BaseException, *, url_hint: str | None = None) -> None:
    parts = [
        f"[hackathon-ui] {operation}",
        f"type={type(exc).__name__}",
        f"msg={exc!s}",
    ]
    errno_val = _exception_errno(exc)
    if errno_val is not None:
        parts.append(f"errno={errno_val}")
    cause = exc.__cause__
    if cause is not None:
        c_errno = getattr(cause, "errno", None)
        extra = f"cause_type={type(cause).__name__} cause_msg={cause!s}"
        if isinstance(c_errno, int):
            extra += f" cause_errno={c_errno}"
        parts.append(extra)
    if url_hint:
        parts.append(f"url_hint={url_hint!s}")
    print(": ".join(parts), file=sys.stderr, flush=True)

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
    op = f"supabase_rest {method} {path}"
    hint = supabase_project_url_host_hint()
    try:
        with urlopen(req, timeout=20) as res:
            text = res.read().decode("utf-8")
    except HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Supabase {exc.code}: {detail}") from exc
    except URLError as exc:
        log_supabase_error(op, exc, url_hint=hint)
        raise SupabaseNetworkError(
            "Unable to reach Supabase (network/DNS). Check SUPABASE_PROJECT_URL, connectivity, and DNS."
        ) from exc
    except OSError as exc:
        log_supabase_error(op, exc, url_hint=hint)
        raise SupabaseNetworkError(
            "Unable to reach Supabase (network/DNS). Check SUPABASE_PROJECT_URL, connectivity, and DNS."
        ) from exc
    return json.loads(text) if text else None


_resolved_hackathon_id: str | None = None


def resolve_hackathon_id() -> str:
    """UUID for this deployment: slug lookup in hackathons, else DEFAULT_HACKATHON_ID env."""
    global _resolved_hackathon_id
    if _resolved_hackathon_id is not None:
        return _resolved_hackathon_id
    env_id = (os.environ.get("DEFAULT_HACKATHON_ID") or "").strip()
    if not supabase_configured():
        _resolved_hackathon_id = env_id or DEFAULT_HACKATHON_ID
        return _resolved_hackathon_id
    slug = (os.environ.get("ACTIVE_HACK_SLUG") or active_hack_slug() or "").strip()
    if slug:
        try:
            slug_q = quote(slug, safe="")
            rows = supabase_rest(f"/hackathons?slug=eq.{slug_q}&select=id&limit=1") or []
            if rows and rows[0].get("id"):
                _resolved_hackathon_id = str(rows[0]["id"])
                return _resolved_hackathon_id
        except Exception as exc:
            print(
                f"[hackathon-ui] hackathon slug lookup failed ({slug!r}): {exc}",
                file=sys.stderr,
                flush=True,
            )
    _resolved_hackathon_id = env_id or DEFAULT_HACKATHON_ID
    return _resolved_hackathon_id


def supabase_submission_to_client(row):
    repo_url = row.get("repo_url") or row.get("repo_key") or ""
    repo_id = row.get("repo_id") or repo_id_from_url(repo_url)
    legacy_members = str(
        row.get("team_members_legacy_text") or row.get("team_members") or ""
    )
    demo_coalesced = (
        str(row.get("demo_url") or "").strip()
        or str(row.get("demo_link") or "").strip()
        or str(row.get("video_url") or "").strip()
    )
    return {
        **row,
        "demo_url": demo_coalesced or row.get("demo_url"),
        "submission_id": repo_id,
        "repo": repo_url,
        "repo_url": repo_url,
        "repo_id": repo_id,
        "hack_id": active_hack_slug(),
        "submitted_at": row.get("submitted_at") or row.get("timestamp"),
        "timestamp": row.get("submitted_at") or row.get("timestamp"),
        "team_members_legacy_text": legacy_members,
    }


SUBMISSION_GITHUB_FIELDS = (
    "analysis_status",
    "analyzed_at",
    "analysis_error",
    "default_branch",
    "total_commits",
    "total_commits_before_t0",
    "total_commits_during_event",
    "total_commits_after_t1",
    "total_loc_added",
    "total_loc_deleted",
    "has_commits_before_t0",
    "has_bulk_commits",
    "has_large_initial_commit_after_t0",
    "has_merge_commits",
)

SUBMISSION_AI_FIELDS = (
    "ai_text",
    "ai_model",
    "ai_generated_at",
    "ai_error",
)


def get_supabase_submissions():
    hid = quote(resolve_hackathon_id(), safe="")
    rows = supabase_rest(f"/submissions?hackathon_id=eq.{hid}&order=submitted_at.desc.nullsfirst") or []
    _attach_technologies_to_submission_rows(rows, hid)
    _attach_team_to_submission_rows(rows)
    _attach_github_data_to_submission_rows(rows)
    _attach_ai_data_to_submission_rows(rows)
    return [supabase_submission_to_client(row) for row in rows]


def _attach_technologies_to_submission_rows(rows, hackathon_id_quoted: str):
    """Populate each row's ``technologies`` like Node ``getSubmissionTechnologiesMap``."""
    if not rows or not supabase_configured():
        return
    try:
        path = (
            "/submission_technologies?select=submission_id,technologies"
            "!inner(slug,name,sort_order,hackathon_id)"
            f"&technologies.hackathon_id=eq.{hackathon_id_quoted}"
        )
        link_rows = supabase_rest(path) or []
    except Exception:
        for row in rows:
            row["technologies"] = []
        return
    by_sub = {}
    for lr in link_rows:
        sid = lr.get("submission_id")
        tech = lr.get("technologies")
        if not sid or not tech:
            continue
        by_sub.setdefault(sid, []).append(
            {
                "slug": tech.get("slug"),
                "name": tech.get("name"),
                "_sort": tech.get("sort_order") or 0,
            }
        )
    for lst in by_sub.values():
        lst.sort(key=lambda x: x.get("_sort") or 0)
        for item in lst:
            item.pop("_sort", None)
    for row in rows:
        sid = row.get("id")
        row["technologies"] = list(by_sub.get(sid, [])) if sid else []


def _attach_team_to_submission_rows(rows):
    """Populate each row's ``team`` (name + members) from teams + team_members tables.

    Failures degrade silently so the submissions list still renders without team data.
    """
    if not rows or not supabase_configured():
        return
    submission_ids = [str(r.get("id") or "").strip() for r in rows if r.get("id")]
    submission_ids = [s for s in submission_ids if s]
    if not submission_ids:
        for row in rows:
            row["team"] = None
        return
    try:
        in_filter = ",".join(submission_ids)
        teams = supabase_rest(
            f"/teams?submission_id=in.({in_filter})&select=id,submission_id,name"
        ) or []
    except Exception as exc:
        print(
            f"[hackathon-ui] _attach_team_to_submission_rows teams fetch failed: {exc}",
            file=sys.stderr,
            flush=True,
        )
        for row in rows:
            row["team"] = None
        return
    teams_by_sub = {}
    team_ids = []
    for t in teams:
        sid = t.get("submission_id")
        if not sid:
            continue
        teams_by_sub[sid] = {
            "id": t.get("id"),
            "name": t.get("name") or "",
            "members": [],
        }
        if t.get("id"):
            team_ids.append(str(t["id"]))
    if team_ids:
        try:
            tin = ",".join(team_ids)
            members = supabase_rest(
                f"/team_members?team_id=in.({tin})&select=id,team_id,full_name,luma_profile,cursor_email,social_url,created_at&order=created_at.asc"
            ) or []
        except Exception as exc:
            print(
                f"[hackathon-ui] _attach_team_to_submission_rows members fetch failed: {exc}",
                file=sys.stderr,
                flush=True,
            )
            members = []
        by_team = {}
        for m in members:
            tid = m.get("team_id")
            if not tid:
                continue
            by_team.setdefault(tid, []).append(
                {
                    "id": m.get("id"),
                    "full_name": m.get("full_name") or "",
                    "luma_profile": m.get("luma_profile") or "",
                    "cursor_email": m.get("cursor_email") or "",
                    "social_url": m.get("social_url") or "",
                }
            )
        for team in teams_by_sub.values():
            tid = team.get("id")
            team["members"] = by_team.get(tid, [])
    for row in rows:
        sid = row.get("id")
        row["team"] = teams_by_sub.get(sid)


def _attach_github_data_to_submission_rows(rows):
    """Populate each row's ``github`` from submissions_github (1:1 satellite)."""
    if not rows or not supabase_configured():
        for row in rows or []:
            row["github"] = None
        return
    submission_ids = [str(r.get("id") or "").strip() for r in rows if r.get("id")]
    submission_ids = [s for s in submission_ids if s]
    if not submission_ids:
        for row in rows:
            row["github"] = None
        return
    try:
        in_filter = ",".join(submission_ids)
        gh_rows = supabase_rest(
            f"/submissions_github?submission_id=in.({in_filter})&select=*"
        ) or []
    except Exception as exc:
        print(
            f"[hackathon-ui] _attach_github_data_to_submission_rows fetch failed: {exc}",
            file=sys.stderr,
            flush=True,
        )
        for row in rows:
            row["github"] = None
        return
    by_sub = {}
    for gr in gh_rows:
        sid = gr.get("submission_id")
        if sid:
            by_sub[sid] = gr
    for row in rows:
        sid = row.get("id")
        row["github"] = by_sub.get(sid) if sid else None


def _attach_ai_data_to_submission_rows(rows):
    """Populate each row's ``ai`` from submissions_ai (1:1 satellite)."""
    if not rows or not supabase_configured():
        for row in rows or []:
            row["ai"] = None
        return
    submission_ids = [str(r.get("id") or "").strip() for r in rows if r.get("id")]
    submission_ids = [s for s in submission_ids if s]
    if not submission_ids:
        for row in rows:
            row["ai"] = None
        return
    try:
        in_filter = ",".join(submission_ids)
        ai_rows = supabase_rest(
            f"/submissions_ai?submission_id=in.({in_filter})&select=*"
        ) or []
    except Exception as exc:
        print(
            f"[hackathon-ui] _attach_ai_data_to_submission_rows fetch failed: {exc}",
            file=sys.stderr,
            flush=True,
        )
        for row in rows:
            row["ai"] = None
        return
    by_sub = {}
    for ar in ai_rows:
        sid = ar.get("submission_id")
        if sid:
            by_sub[sid] = ar
    for row in rows:
        sid = row.get("id")
        row["ai"] = by_sub.get(sid) if sid else None


def persist_submission_github(submission_uuid, payload):
    """Upsert the submissions_github satellite for ``submission_uuid``.

    Mirrors fields from a combined submission/analysis payload. Returns the
    persisted row or ``None`` if no id was supplied.
    """
    sid = str(submission_uuid or "").strip()
    if not sid:
        return None
    if not isinstance(payload, dict):
        payload = {}
    numeric_keys = {
        "total_commits",
        "total_commits_before_t0",
        "total_commits_during_event",
        "total_commits_after_t1",
        "total_loc_added",
        "total_loc_deleted",
        "has_commits_before_t0",
        "has_bulk_commits",
        "has_large_initial_commit_after_t0",
        "has_merge_commits",
    }
    text_keys = {"analysis_status", "analysis_error", "default_branch"}
    body = {"submission_id": sid}
    for key in SUBMISSION_GITHUB_FIELDS:
        v = payload.get(key)
        if key in numeric_keys:
            try:
                body[key] = int(v) if v is not None else 0
            except (TypeError, ValueError):
                body[key] = 0
        elif key in text_keys:
            body[key] = "" if v is None else str(v)
        elif key == "analyzed_at":
            body[key] = v or None
        else:
            body[key] = v
    if "raw_repo" in payload:
        body["raw_repo"] = payload.get("raw_repo") or None
    from datetime import datetime, timezone
    body["updated_at"] = datetime.now(timezone.utc).isoformat()
    return supabase_rest(
        "/submissions_github?on_conflict=submission_id",
        method="POST",
        body=body,
        prefer="return=representation,resolution=merge-duplicates",
    )


def persist_submission_ai(submission_uuid, payload):
    """Upsert the submissions_ai satellite for ``submission_uuid``."""
    sid = str(submission_uuid or "").strip()
    if not sid:
        return None
    if not isinstance(payload, dict):
        payload = {}
    body = {"submission_id": sid}
    for key in SUBMISSION_AI_FIELDS:
        v = payload.get(key)
        if key == "ai_generated_at":
            body[key] = v or None
        else:
            body[key] = "" if v is None else str(v)
    if "code_signal" in payload:
        body["code_signal"] = payload.get("code_signal") or None
    if "raw_opencode" in payload:
        body["raw_opencode"] = payload.get("raw_opencode") or None
    from datetime import datetime, timezone
    body["updated_at"] = datetime.now(timezone.utc).isoformat()
    return supabase_rest(
        "/submissions_ai?on_conflict=submission_id",
        method="POST",
        body=body,
        prefer="return=representation,resolution=merge-duplicates",
    )


def _team_member_validation_error(members_raw):
    """Return an error message if any roster member is missing required fields."""
    if not isinstance(members_raw, list):
        return None
    for m in members_raw:
        if not isinstance(m, dict):
            continue
        full_name = str(m.get("full_name") or "").strip()
        if not full_name:
            continue
        if not str(m.get("cursor_email") or "").strip():
            return "Each team member needs an email for Cursor."
        if not str(m.get("luma_profile") or "").strip():
            return "Each team member needs a Luma profile URL."
        if not str(m.get("social_url") or "").strip():
            return "Each team member needs a LinkedIn or X URL."
    return None


def _normalize_team_payload(payload):
    """Pull ``team`` from a submit payload and return a sanitized dict or ``None``."""
    team_raw = payload.get("team") if isinstance(payload, dict) else None
    if not isinstance(team_raw, dict):
        return None
    members_raw = team_raw.get("members") if isinstance(team_raw.get("members"), list) else []
    members = []
    for m in members_raw:
        if not isinstance(m, dict):
            continue
        full_name = str(m.get("full_name") or "").strip()
        cursor_email = str(m.get("cursor_email") or "").strip()
        luma_profile = str(m.get("luma_profile") or "").strip()
        social_url = str(m.get("social_url") or "").strip()
        if not full_name:
            continue
        if not cursor_email or not luma_profile or not social_url:
            continue
        members.append(
            {
                "full_name": full_name,
                "cursor_email": cursor_email,
                "luma_profile": luma_profile,
                "social_url": social_url,
            }
        )
    name = str(team_raw.get("name") or "").strip()
    if not name and not members:
        return None
    return {"name": name, "members": members}


def persist_team(submission_uuid, team, *, fallback_name=""):
    """Upsert a team row + replace its members. Best-effort: logs and re-raises specific failures."""
    submission_uuid = str(submission_uuid or "").strip()
    if not submission_uuid:
        return None
    name = (team.get("name") or "").strip() if isinstance(team, dict) else ""
    if not name:
        name = (fallback_name or "").strip()
    members = team.get("members") if isinstance(team, dict) else []
    if not isinstance(members, list):
        members = []
    team_row = supabase_rest(
        "/teams?on_conflict=submission_id",
        method="POST",
        body={"submission_id": submission_uuid, "name": name},
        prefer="return=representation,resolution=merge-duplicates",
    )
    team_id = None
    if isinstance(team_row, list) and team_row:
        team_id = team_row[0].get("id")
    if not team_id:
        sid_q = quote(submission_uuid, safe="")
        existing = supabase_rest(f"/teams?submission_id=eq.{sid_q}&select=id") or []
        if existing:
            team_id = existing[0].get("id")
    if not team_id:
        print(
            f"[hackathon-ui] persist_team: no team id for submission={submission_uuid}",
            file=sys.stderr,
            flush=True,
        )
        return None
    tid_q = quote(str(team_id), safe="")
    supabase_rest(
        f"/team_members?team_id=eq.{tid_q}",
        method="DELETE",
        prefer="return=minimal",
    )
    if members:
        body = [
            {
                "team_id": team_id,
                "full_name": str(m.get("full_name") or "").strip(),
                "cursor_email": str(m.get("cursor_email") or "").strip(),
                "luma_profile": str(m.get("luma_profile") or "").strip(),
                "social_url": str(m.get("social_url") or "").strip(),
            }
            for m in members
            if isinstance(m, dict) and str(m.get("full_name") or "").strip()
        ]
        if body:
            supabase_rest(
                "/team_members",
                method="POST",
                body=body,
                prefer="return=minimal",
            )
    print(
        f"[hackathon-ui] persist_team: submission={submission_uuid} team_id={team_id} members={len(members)}",
        flush=True,
    )
    return team_id


def parse_technology_ids(payload):
    raw = payload.get("technology_ids")
    if not isinstance(raw, list):
        return []
    out = []
    for x in raw:
        s = str(x or "").strip()
        if s:
            out.append(s)
    # dedupe, preserve order
    return list(dict.fromkeys(out))


def set_submission_technologies(submission_id_a, technology_ids):
    """Replace join rows in submission_technologies (matches Node db.js)."""
    submission_id_a = str(submission_id_a or "").strip()
    if not submission_id_a:
        return
    sid = quote(submission_id_a, safe="")
    supabase_rest(
        f"/submission_technologies?submission_id=eq.{sid}",
        method="DELETE",
        prefer="return=minimal",
    )
    if not technology_ids:
        return
    rows = [
        {"submission_id": submission_id_a, "technology_id": tid}
        for tid in technology_ids
    ]
    supabase_rest(
        "/submission_technologies",
        method="POST",
        body=rows,
        prefer="return=minimal",
    )


def upsert_supabase_submission(payload):
    repo_url = str(payload.get("repo_url") or payload.get("github_url") or "").strip()
    repo_key = normalize_repo_url(repo_url)
    if not repo_key:
        raise ValueError("repo_url is required")
    project_name = str(payload.get("project_name") or "").strip()
    team_name = str(payload.get("team_name") or "").strip()
    title_in = str(payload.get("title") or "").strip()
    title = title_in or project_name or team_name
    if not title:
        rid = repo_id_from_url(repo_url)
        title = (rid or repo_key or "Untitled submission").strip() or "Untitled submission"
    # Mirror full_name list into the legacy comma-joined `team_members` text so older readers
    # (CSV exports, prepare_submissions) keep working until they migrate to `team.members`.
    structured_team = _normalize_team_payload(payload)
    derived_legacy_members = ""
    if structured_team:
        derived_legacy_members = ", ".join(
            m["full_name"] for m in structured_team["members"] if m.get("full_name")
        )
    team_members_legacy = (
        derived_legacy_members
        or str(payload.get("team_members") or "").strip()
    )
    row = {
        "repo_key": repo_key,
        "repo_url": repo_url,
        "repo_id": repo_id_from_url(repo_url),
        "title": title,
        "team_name": team_name or (structured_team["name"] if structured_team else ""),
        "project_name": project_name,
        "chosen_track": str(payload.get("chosen_track") or "").strip(),
        "demo_url": str(payload.get("demo_url") or "").strip(),
        "description": str(payload.get("description") or "").strip(),
        "team_members": team_members_legacy,
        "notes": str(payload.get("notes") or "").strip(),
        "submitted_at": payload.get("submitted_at") or payload.get("timestamp") or "",
        "analysis_status": payload.get("analysis_status") or "pending",
        "hackathon_id": resolve_hackathon_id(),
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
    hid = quote(resolve_hackathon_id(), safe="")
    rows = supabase_rest(f"/judge_responses?hackathon_id=eq.{hid}&order=submitted_at.desc") or []
    return aggregate_judge_responses(rows)


def judge_db_int(value, minimum=0, maximum=100):
    """Postgres judge_responses score columns are integer — coerce before REST upsert."""
    try:
        n = float(value if value is not None and value != "" else 0)
    except (TypeError, ValueError):
        n = 0.0
    return int(max(minimum, min(maximum, round(n))))


def judge_sanitize_score_map(scores, maximum=100):
    """Coerce jsonb score maps to integer values (never 3.0 floats/strings)."""
    if not isinstance(scores, dict):
        return {}
    out = {}
    for key, value in scores.items():
        if key is None:
            continue
        out[str(key)] = judge_db_int(value, 0, maximum)
    return out


def judge_sanitize_supabase_row(row, score_cap=100):
    """Defense-in-depth: coerce all judge_responses score columns/maps to int before REST."""
    sanitized = dict(row)
    for key in ("core_total", "bonus_total_raw", "bonus_total_capped", "total_score"):
        if key in sanitized:
            sanitized[key] = judge_db_int(sanitized[key], 0, score_cap)
    sanitized["core_scores"] = judge_sanitize_score_map(sanitized.get("core_scores"), score_cap)
    sanitized["bonus_bucket_scores"] = judge_sanitize_score_map(
        sanitized.get("bonus_bucket_scores"), score_cap
    )
    return sanitized


def upsert_supabase_judge(payload):
    repo_url = str(payload.get("repo_url") or "").strip()
    repo_key = normalize_repo_url(payload.get("repo_key") or repo_url)
    judge_name = str(payload.get("judge_name") or "").strip()
    if not repo_key or not judge_name:
        raise ValueError("repo_url and judge_name are required")
    score_cap = 100
    raw_total = payload.get("total_score")
    if raw_total is None or raw_total == "":
        raw_total = payload.get("core_total")
    total_score = judge_db_int(raw_total, 0, score_cap)
    core_scores = judge_sanitize_score_map(payload.get("core_scores"), score_cap)
    bonus_bucket_scores = judge_sanitize_score_map(payload.get("bonus_bucket_scores"), score_cap)
    # 0–100 holistic slider: keep the entered total as-is (never cap at legacy 0–11).
    if total_score > 11:
        core_total = judge_db_int(payload.get("core_total"), 0, score_cap)
        if core_total <= 0:
            core_total = core_scores.get("overall", total_score)
        bonus_total = judge_db_int(
            payload.get("bonus_total_capped")
            if payload.get("bonus_total_capped") not in (None, "")
            else payload.get("bonus_total_raw"),
            0,
            score_cap,
        )
    else:
        # Legacy 0–11 imports / old CSV rows
        core_total = min(total_score, 7)
        bonus_total = min(max(total_score - 7, 0), 4)
    if not core_scores:
        core_scores = {"overall": core_total}
    row = judge_sanitize_supabase_row(
        {
            "judge_name": judge_name,
            "repo_key": repo_key,
            "repo_url": repo_url or repo_key,
            "project_name": str(payload.get("project_name") or "").strip(),
            "chosen_track": str(payload.get("chosen_track") or "").strip(),
            "scored_track": str(payload.get("scored_track") or payload.get("chosen_track") or "").strip(),
            "notes": str(payload.get("notes") or payload.get("thoughts") or "").strip(),
            "core_scores": core_scores,
            "bonus_bucket_scores": bonus_bucket_scores,
            "core_total": core_total,
            "bonus_total_raw": bonus_total,
            "bonus_total_capped": bonus_total,
            "total_score": total_score,
            "hackathon_id": resolve_hackathon_id(),
        },
        score_cap=score_cap,
    )
    print(
        f"[judge-save] {judge_name!r} repo={repo_key!r} "
        f"total_score={row['total_score']} ({type(row['total_score']).__name__})",
        file=sys.stderr,
        flush=True,
    )
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
        if path == "/api/technologies":
            return self.handle_technologies()
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

    def do_DELETE(self):
        path = unquote(self.path.split("?", 1)[0])
        if path == "/api/team-members" or path.startswith("/api/team-members/"):
            return self.handle_team_member_delete(path)
        return self._send_json({"error": "unknown endpoint"}, status=404)

    def do_OPTIONS(self):
        path = unquote(self.path.split("?", 1)[0])
        if not path.startswith("/api/"):
            self.send_error(501, "Unsupported method")
            return
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Max-Age", "86400")
        self.end_headers()

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
            except SupabaseNetworkError as exc:
                return self._send_json({"error": str(exc), "detail": exc.detail}, status=500)
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
            except SupabaseNetworkError as exc:
                return self._send_json({"error": str(exc), "detail": exc.detail}, status=500)
            except Exception as exc:
                return self._send_json({"error": f"failed to load Supabase submissions: {exc}"}, status=500)
        if not SUBMISSIONS_PATH.exists():
            return self._send_json({"submissions": []})
        try:
            data = json.loads(SUBMISSIONS_PATH.read_text(encoding="utf-8"))
        except Exception as exc:
            return self._send_json({"error": f"failed to load submissions data: {exc}"}, status=500)
        return self._send_json(data)

    def handle_technologies(self):
        """Sponsor tech catalog for the submit form (mirrors GET /api/technologies on Vercel)."""
        if not EVENT_FORMAT_PATH.exists():
            return self._send_json({"technologies": []})
        try:
            data = json.loads(EVENT_FORMAT_PATH.read_text(encoding="utf-8"))
            tech = data.get("technology_partners") or []
            if not isinstance(tech, list):
                tech = []
            return self._send_json({"technologies": tech})
        except Exception as exc:
            return self._send_json({"error": f"failed to load technologies: {exc}"}, status=500)

    def handle_submission_post(self):
        payload = self._read_json_body()
        if not isinstance(payload, dict):
            return self._send_json({"error": "invalid JSON body"}, status=400)
        repo_in = str(payload.get("repo_url") or payload.get("github_url") or "").strip()
        if not repo_in:
            return self._send_json({"error": "repo_url is required"}, status=400)

        technology_ids = parse_technology_ids(payload)
        if supabase_configured() and len(technology_ids) == 0:
            return self._send_json(
                {
                    "error": "Pick at least one technology partner you used.",
                },
                status=400,
            )

        team_raw = payload.get("team") if isinstance(payload, dict) else None
        members_raw = (
            team_raw.get("members")
            if isinstance(team_raw, dict) and isinstance(team_raw.get("members"), list)
            else []
        )
        team_err = _team_member_validation_error(members_raw)
        if team_err:
            return self._send_json({"error": team_err}, status=400)

        try:
            if supabase_configured():
                entry = upsert_supabase_submission(payload)
                sub_uuid = entry.get("id")
                if sub_uuid:
                    try:
                        set_submission_technologies(sub_uuid, technology_ids)
                    except SupabaseNetworkError as tech_exc:
                        return self._send_json(
                            {
                                "error": f"Submission saved but failed to link technologies: {tech_exc}",
                                "detail": tech_exc.detail,
                            },
                            status=500,
                        )
                    except Exception as tech_exc:
                        return self._send_json(
                            {
                                "error": f"Submission saved but failed to link technologies: {tech_exc}",
                            },
                            status=500,
                        )
                    team_payload = _normalize_team_payload(payload)
                    if team_payload:
                        try:
                            persist_team(
                                sub_uuid,
                                team_payload,
                                fallback_name=entry.get("project_name")
                                or entry.get("team_name")
                                or "",
                            )
                        except SupabaseNetworkError as team_exc:
                            print(
                                f"[hackathon-ui] persist_team network error (submission saved): {team_exc}",
                                file=sys.stderr,
                                flush=True,
                            )
                        except Exception as team_exc:
                            print(
                                f"[hackathon-ui] persist_team failed (submission saved): {team_exc}",
                                file=sys.stderr,
                                flush=True,
                            )
                    try:
                        persist_submission_github(sub_uuid, payload)
                    except SupabaseNetworkError as gh_exc:
                        print(
                            f"[hackathon-ui] persist_submission_github network error: {gh_exc}",
                            file=sys.stderr,
                            flush=True,
                        )
                    except Exception as gh_exc:
                        print(
                            f"[hackathon-ui] persist_submission_github failed: {gh_exc}",
                            file=sys.stderr,
                            flush=True,
                        )
                    try:
                        persist_submission_ai(sub_uuid, payload)
                    except SupabaseNetworkError as ai_exc:
                        print(
                            f"[hackathon-ui] persist_submission_ai network error: {ai_exc}",
                            file=sys.stderr,
                            flush=True,
                        )
                    except Exception as ai_exc:
                        print(
                            f"[hackathon-ui] persist_submission_ai failed: {ai_exc}",
                            file=sys.stderr,
                            flush=True,
                        )
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
        except SupabaseNetworkError as exc:
            return self._send_json({"error": str(exc), "detail": exc.detail}, status=500)
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
        except SupabaseNetworkError as exc:
            return self._send_json({"error": str(exc), "detail": exc.detail}, status=500)
        except Exception as exc:
            return self._send_json({"error": f"failed to save judge score: {exc}"}, status=500)
        return self._send_json({"ok": True, "response": response, **aggregate}, status=201)

    def handle_team_member_delete(self, path: str):
        """Admin-only DELETE for a single team_member by id.

        Accepts either ``/api/team-members/<id>`` or ``/api/team-members?id=<id>``.
        Local dev has no auth gate (matches existing local-dev judge POST flow); the
        Vercel route handler still enforces ``verifyAuth``.
        """
        if not supabase_configured():
            return self._send_json({"error": "Supabase not configured."}, status=503)
        member_id = ""
        if path.startswith("/api/team-members/"):
            member_id = path[len("/api/team-members/") :].strip("/")
        if not member_id:
            try:
                _, _, query = self.path.partition("?")
                for part in query.split("&"):
                    if part.startswith("id="):
                        member_id = unquote(part[3:]).strip()
                        break
            except Exception:
                member_id = ""
        if not member_id:
            return self._send_json({"error": "Missing team member id"}, status=400)
        try:
            mid = quote(member_id, safe="")
            result = supabase_rest(
                f"/team_members?id=eq.{mid}",
                method="DELETE",
                prefer="return=representation",
            )
        except SupabaseNetworkError as exc:
            return self._send_json({"error": str(exc), "detail": exc.detail}, status=500)
        except Exception as exc:
            return self._send_json({"error": f"failed to delete team member: {exc}"}, status=500)
        deleted = len(result) if isinstance(result, list) else 0
        return self._send_json({"ok": True, "deleted": deleted})

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
        resolved = resolve_hackathon_id()
        print(
            f"Persistence: Supabase (hackathon_id={resolved}, "
            f"slug={os.environ.get('ACTIVE_HACK_SLUG') or active_hack_slug()})"
        )
        host = supabase_project_url_parsed_host()
        if host:
            print(f"Supabase endpoint host: {host}")
        else:
            print(
                "[hackathon-ui] WARNING: SUPABASE_PROJECT_URL missing hostname or invalid; "
                "REST calls may fail (e.g. DNS errno 8).",
                file=sys.stderr,
                flush=True,
            )
    else:
        print(
            "Persistence: NOT CONFIGURED — POST /api/submissions and /api/judges return 503.\n"
            "  Export credentials in this shell, then restart:\n"
            f"    export SUPABASE_PROJECT_URL='https://YOUR_PROJECT.supabase.co'\n"
            f"    export SUPABASE_SERVICE_ROLE_SECRET='your-service-role-key'\n"
            f"    export DEFAULT_HACKATHON_ID='{DEFAULT_HACKATHON_ID}'  # must match your hackathons.id row\n"
            "  Offline-only (CSV, no Supabase): export HACKATHON_ALLOW_LOCAL_FALLBACK=1"
        )
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
