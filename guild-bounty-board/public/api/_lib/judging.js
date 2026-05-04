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
    side_bonus_cap: 3,
    total_cap: 10,
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
    max_points: 3,
    description:
      "Three sponsor-aligned buckets (1 + 1 + 1 points). Judges score each bucket independently — 3 bonus total.",
  },
  side_quests: [
    {
      id: "best_use_cursor",
      name: "Best use of Cursor",
      points: 1,
      blurb:
        "How effectively the build used Cursor — editor, agents, and workflow — end to end.",
    },
    {
      id: "best_use_specter",
      name: "Best use of Specter",
      points: 1,
      blurb:
        "Standout use of Specter's API, MCP, or data for market intelligence in the product.",
    },
    {
      id: "best_use_llm_models",
      name: "Best use of LLM models",
      points: 1,
      blurb: "Smart or effective use of models — APIs, routing, evals, or multi-model design.",
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

function normalizeJudgeResponse(input) {
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

  const bonusCapped = Math.min(bonusRaw, JUDGE_CONFIG.judge_bonus_bucket.max_points);

  return {
    judge_name: String(input.judge_name || "").trim(),
    repo_url: String(input.repo_url || "").trim(),
    repo_key: String(input.repo_key || "").trim(),
    project_name: String(input.project_name || "").trim(),
    chosen_track: String(input.chosen_track || "").trim(),
    scored_track: String(input.scored_track || input.chosen_track || "").trim(),
    notes: String(input.notes || "").trim(),
    timestamp: new Date().toISOString(),
    core_scores: coreScores,
    bonus_bucket_scores: bonusBucketScores,
    core_total: coreTotal,
    bonus_total_raw: bonusRaw,
    bonus_total_capped: bonusCapped,
    total_score: coreTotal + bonusCapped,
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
  normalizeJudgeResponse,
  aggregateJudgeResponses,
};
