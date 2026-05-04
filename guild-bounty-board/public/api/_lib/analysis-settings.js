const db = require("./db");

const DEFAULT_ANALYSIS_SETTINGS = {
  event_t0: "2025-11-29T06:00:00Z",
  event_t1: "2025-11-29T12:00:00Z",
  bulk_insertion_threshold: 1000,
  bulk_files_threshold: 50,
  max_commits_to_analyze: 400,
};

function parseIsoDate(value, fieldName) {
  const date = new Date(String(value || ""));
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid ${fieldName}`);
  }
  return date.toISOString();
}

function parsePositiveInt(value, fieldName) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${fieldName}`);
  }
  return parsed;
}

function normalizeAnalysisSettings(input = {}) {
  const settings = {
    event_t0: parseIsoDate(input.event_t0 || DEFAULT_ANALYSIS_SETTINGS.event_t0, "event_t0"),
    event_t1: parseIsoDate(input.event_t1 || DEFAULT_ANALYSIS_SETTINGS.event_t1, "event_t1"),
    bulk_insertion_threshold: parsePositiveInt(
      input.bulk_insertion_threshold ?? DEFAULT_ANALYSIS_SETTINGS.bulk_insertion_threshold,
      "bulk_insertion_threshold"
    ),
    bulk_files_threshold: parsePositiveInt(
      input.bulk_files_threshold ?? DEFAULT_ANALYSIS_SETTINGS.bulk_files_threshold,
      "bulk_files_threshold"
    ),
    max_commits_to_analyze: parsePositiveInt(
      input.max_commits_to_analyze ?? DEFAULT_ANALYSIS_SETTINGS.max_commits_to_analyze,
      "max_commits_to_analyze"
    ),
  };

  if (new Date(settings.event_t1).getTime() < new Date(settings.event_t0).getTime()) {
    throw new Error("event_t1 must be after event_t0");
  }

  return settings;
}

async function getAnalysisSettings() {
  const current = await db.getAnalysisSettings();
  return normalizeAnalysisSettings({ ...DEFAULT_ANALYSIS_SETTINGS, ...current });
}

async function saveAnalysisSettings(input) {
  const settings = normalizeAnalysisSettings(input);
  await db.upsertAnalysisSettings(settings);
  return settings;
}

module.exports = {
  DEFAULT_ANALYSIS_SETTINGS,
  normalizeAnalysisSettings,
  getAnalysisSettings,
  saveAnalysisSettings,
};
