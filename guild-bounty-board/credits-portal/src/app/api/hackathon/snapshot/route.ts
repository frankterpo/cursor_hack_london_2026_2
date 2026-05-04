import { NextResponse } from "next/server";
import {
  fetchJudgeSummariesByRepo,
  fetchPublicSubmissions,
  isHackathonDbConfigured,
} from "@/lib/hackathon-snapshot";

export async function GET() {
  try {
    if (!isHackathonDbConfigured()) {
      return NextResponse.json({
        configured: false,
        submissions: [] as unknown[],
        judgeByRepo: [] as unknown[],
        message: "Set SUPABASE_PROJECT_URL and SUPABASE_SERVICE_ROLE_SECRET to show live data.",
      });
    }

    const [submissions, judgeByRepo] = await Promise.all([
      fetchPublicSubmissions(),
      fetchJudgeSummariesByRepo(),
    ]);

    return NextResponse.json({
      configured: true,
      submissions,
      judgeByRepo,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ configured: false, error: message, submissions: [], judgeByRepo: [] }, { status: 500 });
  }
}
