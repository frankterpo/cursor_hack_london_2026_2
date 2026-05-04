const {
  getAnalysisSettings,
} = require("./analysis-settings");

function parseIsoDatetime(value) {
  const normalized = String(value || "").endsWith("Z")
    ? String(value).replace(/Z$/, "+00:00")
    : value;
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid ISO datetime: ${value}`);
  }
  return date;
}

function normalizeRepoUrl(repoUrl) {
  return String(repoUrl || "").trim().replace(/\.git$/i, "").replace(/\/+$/g, "").toLowerCase();
}

function parseRepoUrl(repoUrl) {
  const trimmed = String(repoUrl || "").trim();
  if (!trimmed) {
    throw new Error("Missing GitHub repository URL");
  }

  let pathPart = "";
  if (trimmed.startsWith("git@github.com:")) {
    pathPart = trimmed.split(":", 2)[1] || "";
  } else if (trimmed.includes("://")) {
    const url = new URL(trimmed);
    if (!/github\.com$/i.test(url.hostname)) {
      throw new Error("Only github.com repositories are supported");
    }
    pathPart = url.pathname;
  } else {
    pathPart = trimmed;
  }

  const cleaned = pathPart.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
  const [owner, repo] = cleaned.split("/");
  if (!owner || !repo) {
    throw new Error("Could not parse owner/repo from GitHub URL");
  }

  return {
    owner,
    repo,
    slug: `${owner}/${repo}`,
    normalizedUrl: `https://github.com/${owner}/${repo}`,
    repoId: `${owner}-${repo}`.replace(/[^a-zA-Z0-9._-]/g, "-"),
  };
}

function getGitHubHeaders() {
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "cursor-guild-hackathon-manager",
  };
  const token = process.env.GITHUB_TOKEN || process.env.GITHUB_PAT || process.env.GH_TOKEN;
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

async function fetchGitHubJson(url) {
  const response = await fetch(url, { headers: getGitHubHeaders() });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub API ${response.status}: ${body || url}`);
  }
  return response.json();
}

async function fetchCommitDetail(owner, repo, sha) {
  const detail = await fetchGitHubJson(`https://api.github.com/repos/${owner}/${repo}/commits/${sha}`);
  return {
    sha,
    author_time: new Date(detail.commit?.author?.date || detail.commit?.committer?.date || Date.now()),
    subject: detail.commit?.message?.split("\n")[0] || sha,
    is_merge: Array.isArray(detail.parents) && detail.parents.length > 1,
    insertions: Number(detail.stats?.additions || 0),
    deletions: Number(detail.stats?.deletions || 0),
    files_changed: Array.isArray(detail.files) ? detail.files.length : 0,
  };
}

async function mapWithConcurrency(items, mapper, concurrency) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await mapper(items[currentIndex], currentIndex);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length || 1) }, () => worker());
  await Promise.all(workers);
  return results;
}

async function listBranchCommits(owner, repo, defaultBranch, maxCommitsToAnalyze) {
  const commits = [];
  for (let page = 1; page <= 10; page += 1) {
    const pageItems = await fetchGitHubJson(
      `https://api.github.com/repos/${owner}/${repo}/commits?sha=${encodeURIComponent(defaultBranch)}&per_page=100&page=${page}`
    );
    if (!Array.isArray(pageItems) || pageItems.length === 0) {
      break;
    }
    commits.push(...pageItems);
    if (pageItems.length < 100 || commits.length >= maxCommitsToAnalyze) {
      break;
    }
  }
  return commits.slice(0, maxCommitsToAnalyze).reverse();
}

function computeMetrics(commits, t0, t1, settings) {
  const commitsEnriched = [];
  const minutesBetweenAll = [];
  const minutesBetweenEvent = [];
  let eventPrevTime = null;

  for (let index = 0; index < commits.length; index += 1) {
    const commit = commits[index];
    const prevTime = index > 0 ? commits[index - 1].author_time : null;
    let minutesSincePrev = null;
    if (prevTime) {
      minutesSincePrev = (commit.author_time.getTime() - prevTime.getTime()) / 60000;
      minutesBetweenAll.push(minutesSincePrev);
    }

    const isBeforeT0 = commit.author_time < t0;
    const isDuringEvent = commit.author_time >= t0 && (!t1 || commit.author_time <= t1);
    const isAfterT1 = !!t1 && commit.author_time > t1;

    if (isDuringEvent && eventPrevTime) {
      minutesBetweenEvent.push((commit.author_time.getTime() - eventPrevTime.getTime()) / 60000);
    }
    if (isDuringEvent) {
      eventPrevTime = commit.author_time;
    }

    const flagBulkCommit = commit.insertions >= settings.bulk_insertion_threshold || commit.files_changed >= settings.bulk_files_threshold;

    commitsEnriched.push({
      ...commit,
      author_time_iso: commit.author_time.toISOString(),
      minutes_since_prev_commit: minutesSincePrev,
      minutes_since_t0: (commit.author_time.getTime() - t0.getTime()) / 60000,
      is_before_t0: isBeforeT0,
      is_during_event: isDuringEvent,
      is_after_t1: isAfterT1,
      flag_bulk_commit: flagBulkCommit,
    });
  }

  const totalCommits = commitsEnriched.length;
  const totalCommitsBeforeT0 = commitsEnriched.filter((commit) => commit.is_before_t0).length;
  const totalCommitsDuringEvent = commitsEnriched.filter((commit) => commit.is_during_event).length;
  const totalCommitsAfterT1 = commitsEnriched.filter((commit) => commit.is_after_t1).length;
  const totalLocAdded = commitsEnriched.reduce((sum, commit) => sum + commit.insertions, 0);
  const totalLocDeleted = commitsEnriched.reduce((sum, commit) => sum + commit.deletions, 0);
  const maxLocAddedSingleCommit = Math.max(0, ...commitsEnriched.map((commit) => commit.insertions));
  const maxFilesChangedSingleCommit = Math.max(0, ...commitsEnriched.map((commit) => commit.files_changed));

  const timeDistribution = {
    commits_0_3h: 0,
    commits_3_6h: 0,
    commits_6_12h: 0,
    commits_12_24h: 0,
    commits_after_24h: 0,
  };

  for (const commit of commitsEnriched) {
    if (!commit.is_during_event) {
      continue;
    }
    const hours = (commit.author_time.getTime() - t0.getTime()) / 3600000;
    if (hours >= 0 && hours < 3) {
      timeDistribution.commits_0_3h += 1;
    } else if (hours < 6) {
      timeDistribution.commits_3_6h += 1;
    } else if (hours < 12) {
      timeDistribution.commits_6_12h += 1;
    } else if (hours < 24) {
      timeDistribution.commits_12_24h += 1;
    } else {
      timeDistribution.commits_after_24h += 1;
    }
  }

  const firstDuringEvent = commitsEnriched.find((commit) => commit.is_during_event) || null;
  const safeMedian = (values) => {
    if (!values.length) {
      return null;
    }
    const sorted = [...values].sort((left, right) => left - right);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
      ? (sorted[middle - 1] + sorted[middle]) / 2
      : sorted[middle];
  };

  return {
    summary: {
      total_commits: totalCommits,
      total_commits_before_t0: totalCommitsBeforeT0,
      total_commits_during_event: totalCommitsDuringEvent,
      total_commits_after_t1: totalCommitsAfterT1,
      total_loc_added: totalLocAdded,
      total_loc_deleted: totalLocDeleted,
      max_loc_added_single_commit: maxLocAddedSingleCommit,
      max_files_changed_single_commit: maxFilesChangedSingleCommit,
      median_minutes_between_commits: safeMedian(minutesBetweenAll),
      median_minutes_between_commits_during_event: safeMedian(minutesBetweenEvent),
    },
    time_distribution: timeDistribution,
    flags: {
      has_commits_before_t0: totalCommitsBeforeT0 > 0,
      has_bulk_commits: commitsEnriched.some((commit) => commit.flag_bulk_commit && commit.is_during_event),
      has_large_initial_commit_after_t0: !!(firstDuringEvent && firstDuringEvent.flag_bulk_commit),
      has_merge_commits: commitsEnriched.some((commit) => commit.is_merge),
    },
    commits: commitsEnriched.map((commit, index) => ({
      repo_id: "",
      seq_index: index,
      sha: commit.sha,
      author_time_iso: commit.author_time_iso,
      minutes_since_prev_commit: commit.minutes_since_prev_commit,
      minutes_since_t0: commit.minutes_since_t0,
      insertions: commit.insertions,
      deletions: commit.deletions,
      files_changed: commit.files_changed,
      is_merge: commit.is_merge ? 1 : 0,
      is_before_t0: commit.is_before_t0 ? 1 : 0,
      is_during_event: commit.is_during_event ? 1 : 0,
      is_after_t1: commit.is_after_t1 ? 1 : 0,
      flag_bulk_commit: commit.flag_bulk_commit ? 1 : 0,
      subject: commit.subject,
    })),
  };
}

function buildSummaryRow(repoId, repoUrl, defaultBranch, metrics, t0, t1) {
  return {
    repo_id: repoId,
    repo: repoUrl,
    default_branch: defaultBranch,
    t0: t0.toISOString(),
    t1: t1 ? t1.toISOString() : null,
    total_commits: metrics.summary.total_commits,
    total_commits_before_t0: metrics.summary.total_commits_before_t0,
    total_commits_during_event: metrics.summary.total_commits_during_event,
    total_commits_after_t1: metrics.summary.total_commits_after_t1,
    total_loc_added: metrics.summary.total_loc_added,
    total_loc_deleted: metrics.summary.total_loc_deleted,
    max_loc_added_single_commit: metrics.summary.max_loc_added_single_commit,
    max_files_changed_single_commit: metrics.summary.max_files_changed_single_commit,
    median_minutes_between_commits: metrics.summary.median_minutes_between_commits,
    median_minutes_between_commits_during_event: metrics.summary.median_minutes_between_commits_during_event,
    commits_0_3h: metrics.time_distribution.commits_0_3h,
    commits_3_6h: metrics.time_distribution.commits_3_6h,
    commits_6_12h: metrics.time_distribution.commits_6_12h,
    commits_12_24h: metrics.time_distribution.commits_12_24h,
    commits_after_24h: metrics.time_distribution.commits_after_24h,
    has_commits_before_t0: metrics.flags.has_commits_before_t0 ? 1 : 0,
    has_bulk_commits: metrics.flags.has_bulk_commits ? 1 : 0,
    has_large_initial_commit_after_t0: metrics.flags.has_large_initial_commit_after_t0 ? 1 : 0,
    has_merge_commits: metrics.flags.has_merge_commits ? 1 : 0,
  };
}

/** Heuristic: repo references Specter (TrySpecter API, MCP, or branding). */
async function searchRepoForSpecter(owner, repo) {
  try {
    const treeRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/trees/HEAD?recursive=1`, { headers: getGitHubHeaders() });
    if (!treeRes.ok) return false;
    const treeData = await treeRes.json();
    const files = (treeData.tree || []).filter(t => t.type === "blob").map(t => t.path);

    const filePat = /tryspecter|specterhq|specter[_-]?mcp|api\.tryspecter/i;
    for (const f of files) {
      if (filePat.test(f)) return true;
    }

    const codeExts = /\.(py|js|ts|tsx|jsx|md|json|yml|yaml|env|toml|txt|sh)$/i;
    const toCheck = files.filter(f => codeExts.test(f)).slice(0, 50);

    const contentPat =
      /tryspecter\.com|api\.tryspecter|specterhq|specter\s*mcp|\bmcp\b[^\n]{0,120}specter|specter[^\n]{0,120}\bmcp\b/i;
    for (const path of toCheck) {
      try {
        const fileRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`, { headers: getGitHubHeaders() });
        if (!fileRes.ok) continue;
        const fileData = await fileRes.json();
        if (fileData.content) {
          const content = Buffer.from(fileData.content, "base64").toString("utf-8");
          if (contentPat.test(content)) return true;
        }
      } catch (_) {}
    }
    return false;
  } catch (_) {
    return false;
  }
}

async function analyzeGitHubRepo(repoUrl, settingsOverride = null) {
  const settings = settingsOverride || await getAnalysisSettings();
  const parsedRepo = parseRepoUrl(repoUrl);
  const repoData = await fetchGitHubJson(`https://api.github.com/repos/${parsedRepo.owner}/${parsedRepo.repo}`);
  const defaultBranch = repoData.default_branch;
  const branchCommits = await listBranchCommits(parsedRepo.owner, parsedRepo.repo, defaultBranch, settings.max_commits_to_analyze);
  const commitDetails = await mapWithConcurrency(
    branchCommits,
    async (commit) => fetchCommitDetail(parsedRepo.owner, parsedRepo.repo, commit.sha),
    6
  );
  const t0 = parseIsoDatetime(settings.event_t0);
  const t1 = parseIsoDatetime(settings.event_t1);
  const metrics = computeMetrics(commitDetails, t0, t1, settings);
  const commits = metrics.commits.map((commit) => ({ ...commit, repo_id: parsedRepo.repoId }));
  const usesSpecter = await searchRepoForSpecter(parsedRepo.owner, parsedRepo.repo);

  return {
    repo_id: parsedRepo.repoId,
    repo: parsedRepo.normalizedUrl,
    remote_url: repoData.clone_url || `${parsedRepo.normalizedUrl}.git`,
    default_branch: defaultBranch,
    t0: t0.toISOString(),
    t1: t1.toISOString(),
    generated_at: new Date().toISOString(),
    repo_metadata: {
      full_name: repoData.full_name,
      description: repoData.description,
      homepage: repoData.homepage,
      language: repoData.language,
      stargazers_count: repoData.stargazers_count,
      default_branch: defaultBranch,
    },
    summary: metrics.summary,
    time_distribution: metrics.time_distribution,
    flags: metrics.flags,
    analysis_settings: settings,
    commits,
    uses_specter: usesSpecter,
    summary_row: buildSummaryRow(parsedRepo.repoId, parsedRepo.normalizedUrl, defaultBranch, metrics, t0, t1),
  };
}

module.exports = {
  analyzeGitHubRepo,
  buildRepoId: (repoUrl) => parseRepoUrl(repoUrl).repoId,
  normalizeRepoUrl,
  parseRepoUrl,
};
