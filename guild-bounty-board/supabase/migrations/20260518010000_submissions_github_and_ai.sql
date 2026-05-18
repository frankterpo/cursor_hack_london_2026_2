-- Split GitHub-API-derived and OpenCode/AI-derived columns out of
-- public.submissions into 1:1 satellite tables. Legacy columns on
-- submissions are retained for one release so old readers keep working.

CREATE TABLE IF NOT EXISTS public.submissions_github (
  submission_id uuid PRIMARY KEY REFERENCES public.submissions(id) ON DELETE CASCADE,
  analysis_status text NOT NULL DEFAULT 'pending',
  analyzed_at timestamptz,
  analysis_error text NOT NULL DEFAULT '',
  default_branch text NOT NULL DEFAULT '',
  total_commits integer NOT NULL DEFAULT 0,
  total_commits_before_t0 integer NOT NULL DEFAULT 0,
  total_commits_during_event integer NOT NULL DEFAULT 0,
  total_commits_after_t1 integer NOT NULL DEFAULT 0,
  total_loc_added integer NOT NULL DEFAULT 0,
  total_loc_deleted integer NOT NULL DEFAULT 0,
  has_commits_before_t0 integer NOT NULL DEFAULT 0,
  has_bulk_commits integer NOT NULL DEFAULT 0,
  has_large_initial_commit_after_t0 integer NOT NULL DEFAULT 0,
  has_merge_commits integer NOT NULL DEFAULT 0,
  raw_repo jsonb,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS submissions_github_submission_id_idx
  ON public.submissions_github(submission_id);

CREATE TABLE IF NOT EXISTS public.submissions_ai (
  submission_id uuid PRIMARY KEY REFERENCES public.submissions(id) ON DELETE CASCADE,
  ai_text text NOT NULL DEFAULT '',
  ai_model text NOT NULL DEFAULT '',
  ai_generated_at timestamptz,
  ai_error text NOT NULL DEFAULT '',
  code_signal jsonb,
  raw_opencode jsonb,
  generated_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS submissions_ai_submission_id_idx
  ON public.submissions_ai(submission_id);

ALTER TABLE public.submissions_github ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.submissions_ai ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service_role_all" ON public.submissions_github;
CREATE POLICY "service_role_all" ON public.submissions_github
  FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "service_role_all" ON public.submissions_ai;
CREATE POLICY "service_role_all" ON public.submissions_ai
  FOR ALL USING (true) WITH CHECK (true);

COMMENT ON TABLE public.submissions_github IS
  'GitHub-API-derived metrics for a submission (1:1 with submissions.id). '
  'Legacy mirror columns on public.submissions are kept for one release.';
COMMENT ON TABLE public.submissions_ai IS
  'OpenCode/AI-derived insights for a submission (1:1 with submissions.id). '
  'Legacy mirror columns on public.submissions are kept for one release.';

-- Backfill: every existing submission gets a github + ai row mirroring
-- whatever lives on submissions today. Idempotent via ON CONFLICT DO NOTHING.
INSERT INTO public.submissions_github (
  submission_id,
  analysis_status,
  analyzed_at,
  analysis_error,
  default_branch,
  total_commits,
  total_commits_before_t0,
  total_commits_during_event,
  total_commits_after_t1,
  total_loc_added,
  total_loc_deleted,
  has_commits_before_t0,
  has_bulk_commits,
  has_large_initial_commit_after_t0,
  has_merge_commits,
  fetched_at,
  updated_at
)
SELECT
  id,
  COALESCE(analysis_status, 'pending'),
  analyzed_at,
  COALESCE(analysis_error, ''),
  COALESCE(default_branch, ''),
  COALESCE(total_commits, 0),
  COALESCE(total_commits_before_t0, 0),
  COALESCE(total_commits_during_event, 0),
  COALESCE(total_commits_after_t1, 0),
  COALESCE(total_loc_added, 0),
  COALESCE(total_loc_deleted, 0),
  COALESCE(has_commits_before_t0, 0),
  COALESCE(has_bulk_commits, 0),
  COALESCE(has_large_initial_commit_after_t0, 0),
  COALESCE(has_merge_commits, 0),
  COALESCE(analyzed_at, submitted_at, now()),
  now()
FROM public.submissions
ON CONFLICT (submission_id) DO NOTHING;

INSERT INTO public.submissions_ai (
  submission_id,
  ai_text,
  ai_model,
  ai_generated_at,
  ai_error,
  generated_at,
  updated_at
)
SELECT
  id,
  COALESCE(ai_text, ''),
  COALESCE(ai_model, ''),
  ai_generated_at,
  COALESCE(ai_error, ''),
  COALESCE(ai_generated_at, submitted_at, now()),
  now()
FROM public.submissions
ON CONFLICT (submission_id) DO NOTHING;
