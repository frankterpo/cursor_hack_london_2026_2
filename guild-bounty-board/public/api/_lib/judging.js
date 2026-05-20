/**
 * Live judging config — keep in sync with `cursor-hackathon-hcmc-2025/data/event-format.json`
 * and `public/judge-config.json`. Server uses this for normalize/aggregate; judge UI loads JSON.
 */
const JUDGE_CONFIG = {
  event_name: "Cursor Live · London · Q3 2026",
  hack_id: "cursor-live-london-q3-2026",
  main_tracks: [
    {
      id: "Money-Movement",
      name: "Money Movement",
      label: "Money Movement",
      description:
        "Agents that actually move money. A wrong action means real money is gone.",
    },
    {
      id: "Financial-Intelligence",
      name: "Financial Intelligence",
      label: "Financial Intelligence",
      description:
        "Agents that read, interpret, and explain. A wrong answer means a wrong decision downstream.",
    },
  ],
  rubric: {
    core_max_points: 7,
    side_bonus_cap: 4,
    total_cap: 100,
    criteria: [
      {
        id: "concrete_workflow_value",
        name: "Concrete Workflow Value",
        points: 2,
        description:
          "Does it replace or compress a real finance workflow a human does today?",
      },
      {
        id: "track_fit",
        name: "Track Fit",
        points: 2,
        description:
          "How purely does the submission embody its chosen track (money movement vs financial intelligence)?",
      },
      {
        id: "human_in_the_loop_decision",
        name: "Human-in-the-Loop Decision",
        points: 1,
        description:
          "Does the system know when a human should be in the loop vs not? Thresholds, confidence gates, escalation paths.",
      },
      {
        id: "technical_execution",
        name: "Technical Execution",
        points: 1,
        description:
          "Architecture quality, tool design, latency, integrations that actually work.",
      },
      {
        id: "demo_clarity",
        name: "Demo Clarity",
        points: 1,
        description:
          "Can the judge, in 90 seconds, see exactly what this agent does and why it matters?",
      },
    ],
  },
  judge_bonus_bucket: {
    name: "Judge Bonus Bucket",
    max_points: 4,
    description:
      "Four sponsor-aligned buckets (1 + 1 + 1 + 1 points). Judges score each bucket independently — 4 bonus total.",
  },
  side_quests: [
    {
      id: "best_use_tavily",
      name: "Best use of Tavily",
      points: 1,
      blurb:
        "Standout use of Tavily for agent-grade search, retrieval, or live research in the product.",
    },
    {
      id: "best_use_overmind",
      name: "Best use of Overmind",
      points: 1,
      blurb:
        "Clearest integration or workflow where Overmind does real work — not a surface-level mention.",
    },
    {
      id: "best_use_cursor_sdk",
      name: "Best use of Cursor",
      points: 1,
      blurb:
        "Strong use of the Cursor SDK — programmatic agents, tools, and patterns judges can reproduce from docs or the examples repo.",
    },
    {
      id: "best_use_alpic",
      name: "Best use of Alpic",
      points: 1,
      blurb:
        "Standout use of Alpic for hosting, deploying, or routing MCP servers and agent tools in the product.",
    },
  ],
};

function bonusMaxForQuest(quest) {
  const p = quest && quest.points;
  if (typeof p === "number" && Number.isFinite(p) && p > 0) {
    return p;
  }
  return JUDGE_CONFIG.judge_bonus_bucket.max_points;
}

function clampInteger(value, minimum, maximum) {
  const parsed = Number.parseInt(String(value ?? "0"), 10);
  if (Number.isNaN(parsed)) {
    return minimum;
  }
  return Math.max(minimum, Math.min(maximum, parsed));
}

function clampJudgeTotal(value) {
  const cap = JUDGE_CONFIG.rubric.total_cap;
  const n = Number(value);
  if (!Number.isFinite(n)) {
    return 0;
  }
  return Math.round(Math.max(0, Math.min(cap, n)) * 10) / 10;
}

/** Postgres judge_responses score columns are integer — never send 3.0-style floats. */
function judgeDbInteger(value, minimum = 0, maximum = JUDGE_CONFIG.rubric.total_cap) {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    return minimum;
  }
  return Math.max(minimum, Math.min(maximum, Math.round(n)));
}

/** Workbench single-slider saves: one 0–100 score, no per-criterion breakdown. */
function isHolisticJudgePayload(input) {
  if (JUDGE_CONFIG.rubric.total_cap <= 15) {
    return false;
  }
  const rawTotal = Number(input.total_score);
  if (!Number.isFinite(rawTotal)) {
    return false;
  }
  const buckets = input.bonus_bucket_scores || {};
  const bucketSum = Object.values(buckets).reduce(
    (sum, value) => sum + Number(value || 0),
    0,
  );
  if (bucketSum > 0) {
    return false;
  }
  const criteria = JUDGE_CONFIG.rubric.criteria || [];
  const detailedCore = criteria.some(
    (criterion) => Number(input.core_scores?.[criterion.id] || 0) > 0,
  );
  if (detailedCore) {
    return false;
  }
  return true;
}

function normalizeJudgeResponse(input) {
  if (isHolisticJudgePayload(input)) {
    const raw =
      input.total_score !== undefined && input.total_score !== null && input.total_score !== ""
        ? input.total_score
        : input.core_total;
    const total = judgeDbInteger(raw);
    const sideQuests = JUDGE_CONFIG.side_quests || [];
    const bonusBucketScores = {};
    for (const quest of sideQuests) {
      bonusBucketScores[quest.id] = 0;
    }
    return {
      judge_name: String(input.judge_name || "").trim(),
      repo_url: String(input.repo_url || "").trim(),
      repo_key: String(input.repo_key || "").trim(),
      project_name: String(input.project_name || "").trim(),
      chosen_track: String(input.chosen_track || "").trim(),
      scored_track: String(input.scored_track || input.chosen_track || "").trim(),
      notes: String(input.notes || "").trim(),
      timestamp: new Date().toISOString(),
      core_scores: { overall: total },
      bonus_bucket_scores: bonusBucketScores,
      core_total: total,
      bonus_total_raw: 0,
      bonus_total_capped: 0,
      total_score: total,
    };
  }

  const criteria = JUDGE_CONFIG.rubric.criteria;
  const sideQuests = JUDGE_CONFIG.side_quests;
  const directCoreTotal = input.core_total;

  const coreScores = {};
  let coreTotal = 0;
  if (directCoreTotal !== undefined && directCoreTotal !== null && directCoreTotal !== "") {
    coreTotal = clampInteger(directCoreTotal, 0, JUDGE_CONFIG.rubric.core_max_points);
  } else {
    for (const criterion of criteria) {
      const score = clampInteger(input.core_scores?.[criterion.id], 0, criterion.points);
      coreScores[criterion.id] = score;
      coreTotal += score;
    }
  }

  const bonusBucketScores = {};
  let bonusRaw = 0;
  for (const quest of sideQuests) {
    const cap = bonusMaxForQuest(quest);
    const score = clampInteger(input.bonus_bucket_scores?.[quest.id], 0, cap);
    bonusBucketScores[quest.id] = score;
    bonusRaw += score;
  }

  let bonusCapped = Math.min(bonusRaw, JUDGE_CONFIG.judge_bonus_bucket.max_points);

  // Single-slider clients (hackathon viewer) send core_total + bonus_total_capped with
  // bonus_bucket_scores all zero; honor explicit bonus when buckets did not contribute.
  if (bonusRaw === 0) {
    const explicitBonus =
      input.bonus_total_capped !== undefined &&
      input.bonus_total_capped !== null &&
      input.bonus_total_capped !== ""
        ? input.bonus_total_capped
        : input.bonus_total;
    if (explicitBonus !== undefined && explicitBonus !== null && explicitBonus !== "") {
      bonusCapped = clampInteger(explicitBonus, 0, JUDGE_CONFIG.judge_bonus_bucket.max_points);
    } else if (
      input.total_score !== undefined &&
      input.total_score !== null &&
      input.total_score !== ""
    ) {
      const want = Number(input.total_score);
      if (Number.isFinite(want)) {
        const cap =
          JUDGE_CONFIG.rubric.core_max_points + JUDGE_CONFIG.judge_bonus_bucket.max_points;
        const clamped = Math.max(0, Math.min(want, cap));
        bonusCapped = Math.min(
          Math.max(clamped - coreTotal, 0),
          JUDGE_CONFIG.judge_bonus_bucket.max_points,
        );
      }
    }
  }

  const total_score = judgeDbInteger(coreTotal + bonusCapped);

  return {
    judge_name: String(input.judge_name || "").trim(),
    repo_url: String(input.repo_url || "").trim(),
    repo_key: String(input.repo_key || "").trim(),
    project_name: String(input.project_name || "").trim(),
    chosen_track: String(input.chosen_track || "").trim(),
    scored_track: String(input.scored_track || input.chosen_track || "").trim(),
    notes: String(input.notes || "").trim(),
    timestamp: new Date().toISOString(),
    core_scores: Object.fromEntries(
      Object.entries(coreScores).map(([key, value]) => [key, judgeDbInteger(value)]),
    ),
    bonus_bucket_scores: Object.fromEntries(
      Object.entries(bonusBucketScores).map(([key, value]) => [key, judgeDbInteger(value)]),
    ),
    core_total: judgeDbInteger(coreTotal),
    bonus_total_raw: judgeDbInteger(bonusRaw),
    bonus_total_capped: judgeDbInteger(bonusCapped),
    total_score,
  };
}

function average(values) {
  if (!values.length) {
    return 0;
  }
  return Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 1000) / 1000;
}

function aggregateJudgeResponses(responses) {
  const grouped = new Map();

  for (const response of responses) {
    const key = response.repo_key;
    if (!grouped.has(key)) {
      grouped.set(key, []);
    }
    grouped.get(key).push(response);
  }

  const byRepo = {};
  for (const [repoKey, repoResponses] of grouped.entries()) {
    const base = repoResponses[0];
    const hasDetailedCoreScores = repoResponses.some((response) =>
      Object.keys(response.core_scores || {}).some((k) => Number(response.core_scores[k]) > 0),
    );
    const coreAverages = {};
    if (hasDetailedCoreScores) {
      for (const criterion of JUDGE_CONFIG.rubric.criteria) {
        coreAverages[criterion.id] = average(
          repoResponses.map((response) => response.core_scores[criterion.id] || 0),
        );
      }
    }
    const bonusAverages = {};
    for (const quest of JUDGE_CONFIG.side_quests) {
      bonusAverages[quest.id] = average(
        repoResponses.map((response) => response.bonus_bucket_scores[quest.id] || 0),
      );
    }

    byRepo[repoKey] = {
      repo_url: base.repo_url,
      project_name: base.project_name,
      chosen_track: base.chosen_track,
      judge_count: repoResponses.length,
      responses: repoResponses,
      averages: {
        core_scores: coreAverages,
        bonus_bucket_scores: bonusAverages,
        core_total: average(repoResponses.map((response) => response.core_total)),
        bonus_total: average(repoResponses.map((response) => response.bonus_total_capped)),
        grand_total: average(repoResponses.map((response) => response.total_score)),
      },
    };
  }

  return {
    event_format: JUDGE_CONFIG,
    responses,
    by_repo: byRepo,
  };
}

module.exports = {
  JUDGE_CONFIG,
  judgeDbInteger,
  normalizeJudgeResponse,
  aggregateJudgeResponses,
};
