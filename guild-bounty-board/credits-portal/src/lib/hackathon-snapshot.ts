/**
 * Server-only Supabase reads for hackathon submissions + judge scores.
 * Mirrors guild-bounty-board/public/api/_lib/db.js + judging aggregation.
 */

type JudgeRow = {
  repo_key: string;
  repo_url: string;
  project_name: string;
  chosen_track: string;
  judge_name: string;
  core_scores: Record<string, number> | null;
  bonus_bucket_scores: Record<string, number> | null;
  core_total: number;
  bonus_total_capped: number;
  total_score: number;
};

type SubmissionRow = {
  repo_key: string;
  repo_url: string;
  project_name: string;
  chosen_track: string;
  submitted_at: string | null;
  analysis_status: string | null;
};

function getEnv(name: string): string | undefined {
  return process.env[name]?.trim();
}

/** Same as guild `public/api/_lib/db.js` — scopes submissions / judges to one event */
const DEFAULT_HACKATHON_ID =
  getEnv("DEFAULT_HACKATHON_ID") || "a0000001-0000-4000-8000-000000000001";

export function isHackathonDbConfigured(): boolean {
  return Boolean(getEnv("SUPABASE_PROJECT_URL") && getEnv("SUPABASE_SERVICE_ROLE_SECRET"));
}

async function supabaseRest<T>(path: string): Promise<T | null> {
  const url = getEnv("SUPABASE_PROJECT_URL");
  const key = getEnv("SUPABASE_SERVICE_ROLE_SECRET");
  if (!url || !key) return null;

  const response = await fetch(`${url}/rest/v1${path}`, {
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
  });

  const text = await response.text();
  if (!response.ok) {
    console.error("[hackathon-snapshot] Supabase error", response.status, text.slice(0, 200));
    return null;
  }
  return text ? (JSON.parse(text) as T) : null;
}

function average(values: number[]): number {
  if (!values.length) return 0;
  return Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 1000) / 1000;
}

export type PublicSubmission = {
  repo_key: string;
  repo_url: string;
  project_name: string;
  chosen_track: string;
  submitted_at: string | null;
  analysis_status: string | null;
};

export type RepoJudgeSummary = {
  repo_key: string;
  repo_url: string;
  project_name: string;
  chosen_track: string;
  judge_count: number;
  avg_grand_total: number;
  avg_core: number;
  avg_bonus: number;
};

export async function fetchPublicSubmissions(): Promise<PublicSubmission[]> {
  const hid = encodeURIComponent(DEFAULT_HACKATHON_ID);
  const rows = await supabaseRest<SubmissionRow[]>(
    `/submissions?hackathon_id=eq.${hid}&select=repo_key,repo_url,project_name,chosen_track,submitted_at,analysis_status&order=submitted_at.desc.nullsfirst`
  );
  if (!rows) return [];
  return rows.map((r) => ({
    repo_key: r.repo_key,
    repo_url: r.repo_url,
    project_name: r.project_name || "Untitled",
    chosen_track: r.chosen_track || "",
    submitted_at: r.submitted_at,
    analysis_status: r.analysis_status,
  }));
}

export async function fetchJudgeSummariesByRepo(): Promise<RepoJudgeSummary[]> {
  const hid = encodeURIComponent(DEFAULT_HACKATHON_ID);
  const rows = await supabaseRest<JudgeRow[]>(
    `/judge_responses?hackathon_id=eq.${hid}&select=repo_key,repo_url,project_name,chosen_track,judge_name,core_scores,bonus_bucket_scores,core_total,bonus_total_capped,total_score&order=submitted_at.desc`
  );
  if (!rows?.length) return [];

  const grouped = new Map<string, JudgeRow[]>();
  for (const row of rows) {
    const key = row.repo_key;
    if (!key) continue;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(row);
  }

  const out: RepoJudgeSummary[] = [];
  for (const [repo_key, repoResponses] of grouped) {
    const base = repoResponses[0];
    out.push({
      repo_key,
      repo_url: base.repo_url,
      project_name: base.project_name || "Untitled",
      chosen_track: base.chosen_track || "",
      judge_count: repoResponses.length,
      avg_grand_total: average(repoResponses.map((r) => Number(r.total_score) || 0)),
      avg_core: average(repoResponses.map((r) => Number(r.core_total) || 0)),
      avg_bonus: average(repoResponses.map((r) => Number(r.bonus_total_capped) || 0)),
    });
  }

  out.sort((a, b) => b.avg_grand_total - a.avg_grand_total);
  return out;
}
