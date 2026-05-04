-- Submissions table
CREATE TABLE IF NOT EXISTS submissions (
  repo_key         text PRIMARY KEY,
  repo_url         text NOT NULL,
  repo_id          text DEFAULT '',
  team_name        text DEFAULT '',
  project_name     text DEFAULT '',
  chosen_track     text DEFAULT '',
  demo_url         text DEFAULT '',
  team_members     text DEFAULT '',
  notes            text DEFAULT '',
  submitted_at     timestamptz DEFAULT now(),
  analysis_status  text DEFAULT 'pending',
  analyzed_at      timestamptz,
  analysis_error   text DEFAULT '',
  ai_text          text DEFAULT '',
  ai_model         text DEFAULT '',
  ai_generated_at  timestamptz,
  ai_error         text DEFAULT '',
  total_commits                       integer DEFAULT 0,
  total_commits_before_t0             integer DEFAULT 0,
  total_commits_during_event          integer DEFAULT 0,
  total_commits_after_t1              integer DEFAULT 0,
  total_loc_added                     integer DEFAULT 0,
  total_loc_deleted                   integer DEFAULT 0,
  has_commits_before_t0               integer DEFAULT 0,
  has_bulk_commits                    integer DEFAULT 0,
  has_large_initial_commit_after_t0   integer DEFAULT 0,
  has_merge_commits                   integer DEFAULT 0,
  default_branch   text DEFAULT ''
);

-- Judge responses table
CREATE TABLE IF NOT EXISTS judge_responses (
  id                  serial PRIMARY KEY,
  judge_name          text NOT NULL,
  repo_key            text NOT NULL REFERENCES submissions(repo_key) ON DELETE CASCADE,
  repo_url            text DEFAULT '',
  project_name        text DEFAULT '',
  chosen_track        text DEFAULT '',
  scored_track        text DEFAULT '',
  notes               text DEFAULT '',
  submitted_at        timestamptz DEFAULT now(),
  core_scores         jsonb DEFAULT '{}',
  bonus_bucket_scores jsonb DEFAULT '{}',
  core_total          integer DEFAULT 0,
  bonus_total_raw     integer DEFAULT 0,
  bonus_total_capped  integer DEFAULT 0,
  total_score         integer DEFAULT 0,
  UNIQUE(judge_name, repo_key)
);

-- Analyses table (full GitHub analysis blob)
CREATE TABLE IF NOT EXISTS analyses (
  repo_key       text PRIMARY KEY REFERENCES submissions(repo_key) ON DELETE CASCADE,
  analysis_data  jsonb,
  analyzed_at    timestamptz DEFAULT now()
);

-- Analysis settings (singleton row)
CREATE TABLE IF NOT EXISTS analysis_settings (
  id                       integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  event_t0                 timestamptz,
  event_t1                 timestamptz,
  bulk_insertion_threshold  integer DEFAULT 1000,
  bulk_files_threshold      integer DEFAULT 50,
  max_commits_to_analyze    integer DEFAULT 400
);

-- Seed default settings row
INSERT INTO analysis_settings (id, event_t0, event_t1)
VALUES (1, '2025-11-29T06:00:00Z', '2025-11-29T12:00:00Z')
ON CONFLICT (id) DO NOTHING;

-- Enable PostgREST access via anon/service role
ALTER TABLE submissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE judge_responses ENABLE ROW LEVEL SECURITY;
ALTER TABLE analyses ENABLE ROW LEVEL SECURITY;
ALTER TABLE analysis_settings ENABLE ROW LEVEL SECURITY;

-- Allow service role full access (used by API)
CREATE POLICY "service_role_all" ON submissions FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "service_role_all" ON judge_responses FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "service_role_all" ON analyses FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "service_role_all" ON analysis_settings FOR ALL USING (true) WITH CHECK (true);
