#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = process.cwd();
const DATA_PATH = path.join(ROOT, 'guild-bounty-board/public/data.json');
const THREADS_PATH = path.join(ROOT, 'artifacts/eric_tweets.json');
const OUTPUT_PATH = path.join(ROOT, 'guild-bounty-board/public/bounties.json');
const ENV_PATH = path.join(ROOT, '.env');

const MAIN_TRACKS = [
  {
    id: 'Agent-Orchestration',
    name: 'Agent Orchestration',
    description: 'Subagents, parallel execution, model routing, and tool composition.'
  },
  {
    id: 'Autonomous-Cloud',
    name: 'Autonomous Cloud',
    description: 'Long-running agents, background workflows, PR loops, and reliability at scale.'
  },
  {
    id: 'DevEx-JIT',
    name: 'DevEx + JIT Tools',
    description: 'Context-aware developer UX, proactive assistants, and high-leverage workflow tools.'
  },
  {
    id: 'Verification-Trace',
    name: 'Verification + Trace',
    description: 'Observability, evals, provenance, safety checks, and anti-hallucination systems.'
  }
];

const SIDE_CHALLENGES = [
  {
    id: 'Golden-Buzzer',
    name: 'Golden Buzzer',
    bonus_points: 15,
    description: 'Standout wow-factor project selected by judges.'
  },
  {
    id: 'Zero-Manual-Run',
    name: 'Zero Manual Run',
    bonus_points: 10,
    description: 'End-to-end build/test loop with near-zero manual edits.'
  },
  {
    id: 'Community-Choice',
    name: 'Community Choice',
    bonus_points: 10,
    description: 'Participant vote winner.'
  },
  {
    id: 'Best-Newcomer',
    name: 'Best Newcomer Team',
    bonus_points: 5,
    description: 'Best submission from first-time hackathon participants.'
  }
];

const RUBRIC = {
  core_max_points: 100,
  side_bonus_cap: 30,
  criteria: [
    { name: 'Implementation Quality', points: 30 },
    { name: 'Challenge Fit', points: 25 },
    { name: 'Innovation', points: 20 },
    { name: 'Demo Clarity', points: 15 },
    { name: 'Open Source Readiness', points: 10 }
  ]
};

const ORGANIZER_LEARNINGS = [
  'Team size: 1-4 builders. Require individual registration for fair credit assignment.',
  'Best event length for this format: around 3 hours of build time plus demos.',
  'Demo format: strict 3-5 minute cap per team with AV check before presentations.',
  'For larger cohorts, shortlist using pairwise comparisons to reduce judge bias.',
  'Use a Golden Buzzer mechanic for exceptional outlier projects.',
  'Setup support is critical; pair beginners with experienced builders early.'
];

const ORGANIZER_TOOLS = [
  { name: 'Slido', use: 'Participant voting and community choice.' },
  { name: 'Cursor Credits CSV Mailer', use: 'Credit distribution for <=100 attendees.' },
  { name: 'Cursor Credits Portal', use: 'Scalable credit redemption workflow.' },
  { name: 'Cursor QR Distributor', use: 'Offline check-in + per-user credit handoff.' },
  { name: 'Hackathon Integrity Toolkit', use: 'Detect likely pre-built submissions.' }
];

function parseDotEnv(envText) {
  const result = {};
  for (const raw of envText.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf('=');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    result[key] = value;
  }
  return result;
}

function normalizeModelList(env) {
  if (env.OPENCODE_FREE_MODELS) {
    const parsed = env.OPENCODE_FREE_MODELS.split(',').map((s) => s.trim()).filter(Boolean);
    if (parsed.length) return parsed;
  }
  return [
    'opencode/minimax-m2.5-free',
    'opencode/glm-4.7-free',
    'opencode/deepseek-v3.1-free'
  ];
}

function cleanTweetText(text) {
  return (text || '').replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').trim();
}

function computeTrackByHeuristic(text) {
  const t = text.toLowerCase();
  if (/(trace|verify|hallucin|eval|debug|quality|security|health)/.test(t)) return 'Verification-Trace';
  if (/(long-running|cloud|overnight|background|pr|autonomous|commit)/.test(t)) return 'Autonomous-Cloud';
  if (/(subagent|orchestr|model|mcp|tool|api|skill|parallel)/.test(t)) return 'Agent-Orchestration';
  return 'DevEx-JIT';
}

function computeDifficulty(text) {
  const t = text.toLowerCase();
  if (/(rust|engine|distributed|autonomous|multi-agent|1000 commits|week-long)/.test(t)) return 'Hard';
  if (/(workflow|debug|trace|mcp|browser|subagent|parallel)/.test(t)) return 'Medium';
  return 'Easy';
}

function heuristicClassification(tweet, replies) {
  const text = cleanTweetText(tweet.text);
  const lower = text.toLowerCase();

  const announceOnly = /(now available|is now available|launched|through february|limits|usage)/.test(lower)
    && !/(build|idea|what if|should|we should|tool|agent|system)/.test(lower);

  const isNewIdea = announceOnly ? 'No' : 'Yes';
  const bestTrack = computeTrackByHeuristic(text);
  const side = [];
  if (/(wow|wild|incredible|future)/.test(lower)) side.push('Golden-Buzzer');
  if (/(without human intervention|while i was sleeping|autonomous)/.test(lower)) side.push('Zero-Manual-Run');

  return {
    is_new_idea: isNewIdea,
    idea_theme: text.split('.').slice(0, 1)[0].slice(0, 120) || 'General AI coding workflow improvement',
    best_track: bestTrack,
    task_brief: isNewIdea === 'Yes'
      ? `Build a working prototype inspired by this tweet and Eric's replies. Focus on a concrete developer workflow and ship a demoable end-to-end flow.`
      : `Turn this product signal into a practical build challenge by creating tooling that improves developer outcomes around the announced capability.`,
    acceptance_criteria: [
      'Repository with runnable code and README',
      '3-5 minute demo covering problem, approach, and results',
      'At least one measurable quality signal (tests, evals, latency, or bug reduction)'
    ],
    side_challenges: side,
    confidence: 0.45,
    notes: replies.length ? 'Thread context included from Eric replies.' : 'No thread replies found; classified from root tweet only.'
  };
}

function safeJsonParse(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenceMatch) {
      return JSON.parse(fenceMatch[1].trim());
    }
  }
  return null;
}

function runCurlJson({ url, headers, body }) {
  const args = ['-sS', '-X', 'POST', url];
  for (const [k, v] of Object.entries(headers || {})) {
    args.push('-H', `${k}: ${v}`);
  }
  args.push('--data-binary', body);

  const res = spawnSync('curl', args, { encoding: 'utf8' });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    throw new Error(`curl failed: ${res.stderr || res.stdout || 'unknown error'}`);
  }
  const parsed = safeJsonParse(res.stdout.trim());
  if (!parsed) throw new Error(`Unable to parse curl JSON response: ${res.stdout.slice(0, 300)}`);
  return parsed;
}

function runCurlGetJson({ url, headers }) {
  const args = ['-sS', url];
  for (const [k, v] of Object.entries(headers || {})) {
    args.push('-H', `${k}: ${v}`);
  }
  const res = spawnSync('curl', args, { encoding: 'utf8' });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    throw new Error(`curl failed: ${res.stderr || res.stdout || 'unknown error'}`);
  }
  const parsed = safeJsonParse(res.stdout.trim());
  if (!parsed) throw new Error(`Unable to parse curl JSON response: ${res.stdout.slice(0, 300)}`);
  return parsed;
}

function fetchEricThreadsViaXApi(bearerToken) {
  if (!bearerToken) return [];
  const headers = { Authorization: `Bearer ${bearerToken}` };
  const user = runCurlGetJson({
    url: 'https://api.twitter.com/2/users/by/username/ericzakariasson',
    headers
  });
  const userId = user?.data?.id;
  if (!userId) return [];

  const timeline = runCurlGetJson({
    url: `https://api.twitter.com/2/users/${userId}/tweets?max_results=100&exclude=retweets&tweet.fields=created_at,author_id,conversation_id,public_metrics,referenced_tweets,text`,
    headers
  });

  const posts = timeline?.data || [];
  const map = new Map();
  for (const tweet of posts.sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')))) {
    const convId = String(tweet.conversation_id || tweet.id);
    if (!map.has(convId)) {
      map.set(convId, {
        id: convId,
        created_at: tweet.created_at,
        text: tweet.text || '',
        metrics: tweet.public_metrics || {},
        thread: []
      });
    } else {
      map.get(convId).thread.push(tweet.text || '');
    }
  }
  return Array.from(map.values());
}

function classifyWithOpencode({ apiKey, endpoint, model, tweet, replies }) {
  const prompt = [
    'You are classifying hackathon bounty opportunities from Eric Zakariasson posts.',
    'Return JSON only with keys:',
    'is_new_idea, idea_theme, best_track, task_brief, acceptance_criteria, side_challenges, confidence, notes.',
    '',
    'Rules:',
    '- is_new_idea must be "Yes" or "No".',
    '- best_track must be one of: Agent-Orchestration, Autonomous-Cloud, DevEx-JIT, Verification-Trace.',
    '- acceptance_criteria must have exactly 3 short bullet strings.',
    '- side_challenges can include only: Golden-Buzzer, Zero-Manual-Run, Community-Choice, Best-Newcomer.',
    '- task_brief must explicitly state what participants should build.',
    '',
    'Hackathon structure constraints from organizers:',
    '- 3-4 main tracks plus side challenges.',
    '- Favor concrete, demoable project definitions over broad themes.',
    '',
    `Root tweet:\n${cleanTweetText(tweet.text) || ''}`,
    '',
    `Thread replies from Eric (same conversation):\n${replies.length ? replies.map((r, i) => `${i + 1}. ${cleanTweetText(r)}`).join('\n') : 'None found.'}`,
    '',
    'Now classify.'
  ].join('\n');

  const body = {
    model,
    temperature: 0.1,
    messages: [
      { role: 'system', content: 'You are a strict JSON classifier.' },
      { role: 'user', content: prompt }
    ]
  };

  const json = runCurlJson({
    url: endpoint,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify(body)
  });
  const content = json?.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error('OpenCode response missing choices[0].message.content');
  }

  const parsed = safeJsonParse(content);
  if (!parsed) {
    throw new Error('Failed to parse JSON from OpenCode output');
  }
  return parsed;
}

function mapThreads(threadsData) {
  const out = new Map();
  for (const item of threadsData) {
    if (item?.id) out.set(String(item.id), Array.isArray(item.thread) ? item.thread : []);
  }
  return out;
}

function viewCount(metrics) {
  if (!metrics) return 0;
  const raw = String(metrics.views ?? '0').replace(/,/g, '');
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : 0;
}

function computeBountyPoints(tweet, classification) {
  const likes = Number.parseInt(String(tweet?.metrics?.likes ?? '0'), 10) || 0;
  const views = viewCount(tweet.metrics);
  const base = Math.min(100, Math.round(35 + (likes * 0.02) + (views / 25000)));
  const difficulty = computeDifficulty(tweet.text || '');
  const diffBoost = difficulty === 'Hard' ? 15 : difficulty === 'Medium' ? 8 : 0;
  const ideaBoost = classification.is_new_idea === 'Yes' ? 8 : 3;
  const core = Math.min(100, base + diffBoost + ideaBoost);

  const sideBonus = (classification.side_challenges || [])
    .map((id) => SIDE_CHALLENGES.find((s) => s.id === id)?.bonus_points || 0)
    .reduce((a, b) => a + b, 0);

  return {
    difficulty,
    core_points: core,
    bonus_points: Math.min(RUBRIC.side_bonus_cap, sideBonus),
    total_recommended_points: core + Math.min(RUBRIC.side_bonus_cap, sideBonus)
  };
}

function buildFallbackTaskTitle(classification, tweet) {
  const stem = cleanTweetText(tweet.text).slice(0, 85);
  if (classification.is_new_idea === 'Yes') return `Build: ${stem}`;
  return `Ship Improvement: ${stem}`;
}

async function main() {
  const env = fs.existsSync(ENV_PATH) ? parseDotEnv(fs.readFileSync(ENV_PATH, 'utf8')) : {};
  const apiKey = env.OPENCODE_API_KEY || process.env.OPENCODE_API_KEY || '';
  const endpoint = env.OPENCODE_CHAT_COMPLETIONS_URL || process.env.OPENCODE_CHAT_COMPLETIONS_URL || 'https://api.opencode.ai/v1/chat/completions';
  const models = normalizeModelList({ ...env, ...process.env });

  const tweets = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
  let threadsData = fs.existsSync(THREADS_PATH) ? JSON.parse(fs.readFileSync(THREADS_PATH, 'utf8')) : [];
  const xBearer = env.X_BEARER_TOKEN || process.env.X_BEARER_TOKEN || '';
  try {
    const liveThreads = fetchEricThreadsViaXApi(xBearer);
    if (liveThreads.length) {
      threadsData = liveThreads;
      fs.writeFileSync(THREADS_PATH, `${JSON.stringify(liveThreads, null, 2)}\n`, 'utf8');
    }
  } catch (err) {
    // Keep generation resilient if X API is unavailable in the environment.
  }
  const threadMap = mapThreads(threadsData);

  const candidateTweets = tweets
    .map((tweet) => ({ ...tweet, _likes: Number.parseInt(String(tweet?.metrics?.likes ?? '0'), 10) || 0 }))
    .filter((tweet) => cleanTweetText(tweet.text).length >= 30)
    .sort((a, b) => b._likes - a._likes)
    .slice(0, 80);

  const bounties = [];
  const logs = [];

  for (const tweet of candidateTweets) {
    const replies = threadMap.get(String(tweet.id)) || [];
    let classification = null;

    if (apiKey) {
      for (const model of models) {
        try {
          classification = classifyWithOpencode({ apiKey, endpoint, model, tweet, replies });
          classification._model_used = model;
          break;
        } catch (err) {
          logs.push(`[warn] tweet ${tweet.id} model ${model}: ${err.message}`);
        }
      }
    }

    if (!classification) {
      classification = heuristicClassification(tweet, replies);
      classification._model_used = 'heuristic-fallback';
    }

    const trackValid = MAIN_TRACKS.some((t) => t.id === classification.best_track);
    if (!trackValid) {
      classification.best_track = computeTrackByHeuristic(tweet.text || '');
    }

    if (!Array.isArray(classification.acceptance_criteria) || classification.acceptance_criteria.length !== 3) {
      classification.acceptance_criteria = heuristicClassification(tweet, replies).acceptance_criteria;
    }

    if (classification.is_new_idea !== 'Yes' && classification.is_new_idea !== 'No') {
      classification.is_new_idea = heuristicClassification(tweet, replies).is_new_idea;
    }

    const points = computeBountyPoints(tweet, classification);
    const tweetText = cleanTweetText(tweet.text);

    const bounty = {
      id: String(tweet.id),
      tweet_url: `https://x.com/ericzakariasson/status/${tweet.id}`,
      tweet_text: tweetText,
      tweet_created_at: tweet.created_at,
      media: tweet.media || [],
      thread_replies_from_eric: replies,
      analysis: {
        is_new_idea: classification.is_new_idea,
        idea_theme: classification.idea_theme || tweetText.slice(0, 120),
        best_track: classification.best_track,
        task_brief: classification.task_brief || 'Build a concrete prototype inspired by this signal.',
        acceptance_criteria: classification.acceptance_criteria,
        side_challenges: Array.isArray(classification.side_challenges)
          ? classification.side_challenges.filter((id) => SIDE_CHALLENGES.some((s) => s.id === id))
          : [],
        confidence: Number(classification.confidence || 0),
        notes: classification.notes || '',
        model_used: classification._model_used
      },
      points,
      title: buildFallbackTaskTitle(classification, tweet)
    };

    bounties.push(bounty);
  }

  const curated = bounties
    .filter((b) => b.analysis.is_new_idea === 'Yes')
    .sort((a, b) => b.points.total_recommended_points - a.points.total_recommended_points)
    .slice(0, 36);

  const output = {
    generated_at: new Date().toISOString(),
    source: {
      data_path: 'guild-bounty-board/public/data.json',
      thread_path: fs.existsSync(THREADS_PATH) ? 'artifacts/eric_tweets.json' : null,
      opencode_endpoint: endpoint,
      opencode_models_priority: models
    },
    hackathon_format: {
      main_tracks: MAIN_TRACKS,
      side_challenges: SIDE_CHALLENGES,
      rubric: RUBRIC,
      organizer_learnings: ORGANIZER_LEARNINGS,
      organizer_tools: ORGANIZER_TOOLS,
      judging_format: {
        demo_length_minutes: 3,
        suggested_shortlisting: 'Pairwise comparison for large volumes; golden buzzer for standout projects.'
      }
    },
    bounties: curated,
    logs
  };

  fs.writeFileSync(OUTPUT_PATH, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  console.log(`Wrote ${curated.length} bounties to ${OUTPUT_PATH}`);
  if (logs.length) {
    console.log('--- generation warnings ---');
    logs.slice(0, 20).forEach((l) => console.log(l));
    if (logs.length > 20) console.log(`... ${logs.length - 20} more warnings`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
