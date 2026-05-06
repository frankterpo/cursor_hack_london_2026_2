"use client";

import { useEffect, useState } from "react";

type Submission = {
  repo_key: string;
  repo_url: string;
  project_name: string;
  chosen_track: string;
  submitted_at: string | null;
  analysis_status: string | null;
};

type RepoJudgeSummary = {
  repo_key: string;
  repo_url: string;
  project_name: string;
  chosen_track: string;
  judge_count: number;
  avg_grand_total: number;
  avg_core: number;
  avg_bonus: number;
};

type SnapshotResponse = {
  configured: boolean;
  submissions: Submission[];
  judgeByRepo: RepoJudgeSummary[];
  message?: string;
  error?: string;
};

type HackathonLiveSnapshotProps = {
  variant?: "landing" | "admin";
};

export function HackathonLiveSnapshot({ variant = "landing" }: HackathonLiveSnapshotProps) {
  const [data, setData] = useState<SnapshotResponse | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/credits/api/hackathon/snapshot");
        const json = (await res.json()) as SnapshotResponse;
        if (!cancelled) setData(json);
      } catch {
        if (!cancelled)
          setData({
            configured: false,
            submissions: [],
            judgeByRepo: [],
            error: "Could not load hackathon data.",
          });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!data) {
    return (
      <div className="panel-event p-6">
        <p className="text-sm text-muted-foreground">Loading hackathon data…</p>
      </div>
    );
  }

  if (!data.configured) {
    return (
      <div className="panel-event p-6">
        <p className="font-display text-sm font-semibold text-foreground">
          {variant === "admin" ? "Hackathon manager feed" : "Live hackathon"}
        </p>
        <p className="mt-2 text-sm text-muted-foreground">
          {data.message ||
            data.error ||
            "Supabase is not configured on this deploy (set SUPABASE_PROJECT_URL + SUPABASE_SERVICE_ROLE_SECRET + DEFAULT_HACKATHON_ID)."}
        </p>
      </div>
    );
  }

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <div className="panel-event p-6">
        <h3 className="font-display text-lg font-semibold text-foreground">Submissions</h3>
        <p className="mt-1 text-xs text-muted-foreground">Latest repos for this hackathon UUID.</p>
        <div className="mt-4 max-h-72 overflow-auto">
          {data.submissions.length ? (
            <table className="w-full text-left text-sm">
              <thead className="sticky top-0 bg-card/95 text-muted-foreground">
                <tr>
                  <th className="pb-2 pr-2 font-medium">Project</th>
                  <th className="pb-2 pr-2 font-medium">Track</th>
                  <th className="pb-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/60">
                {data.submissions.slice(0, 40).map((s) => (
                  <tr key={s.repo_key}>
                    <td className="py-2 pr-2">
                      <a
                        href={s.repo_url}
                        className="text-primary underline-offset-2 hover:underline"
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        {s.project_name}
                      </a>
                    </td>
                    <td className="py-2 pr-2 text-muted-foreground">{s.chosen_track || "—"}</td>
                    <td className="py-2 text-muted-foreground">{s.analysis_status || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="text-sm text-muted-foreground">No submissions yet for this hackathon.</p>
          )}
        </div>
      </div>

      <div className="panel-event p-6">
        <h3 className="font-display text-lg font-semibold text-foreground">Judge averages</h3>
        <p className="mt-1 text-xs text-muted-foreground">Aggregated from judge responses.</p>
        <div className="mt-4 max-h-72 overflow-auto">
          {data.judgeByRepo.length ? (
            <table className="w-full text-left text-sm">
              <thead className="sticky top-0 bg-card/95 text-muted-foreground">
                <tr>
                  <th className="pb-2 pr-2 font-medium">Project</th>
                  <th className="pb-2 pr-2 font-medium">Judges</th>
                  <th className="pb-2 font-medium">Avg total</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/60">
                {data.judgeByRepo.slice(0, 40).map((r) => (
                  <tr key={r.repo_key}>
                    <td className="py-2 pr-2">
                      <a
                        href={r.repo_url}
                        className="text-primary underline-offset-2 hover:underline"
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        {r.project_name}
                      </a>
                    </td>
                    <td className="py-2 pr-2 tabular-nums text-muted-foreground">{r.judge_count}</td>
                    <td className="py-2 tabular-nums font-medium text-foreground">
                      {r.avg_grand_total.toFixed(2)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="text-sm text-muted-foreground">No judge scores yet.</p>
          )}
        </div>
      </div>
    </div>
  );
}
