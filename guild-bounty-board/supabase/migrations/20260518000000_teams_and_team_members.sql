-- Structured team + member model for submissions.
-- Replaces the freeform submissions.team_members text column for new submissions;
-- legacy column is kept until the rollout is verified.

CREATE TABLE IF NOT EXISTS public.teams (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id uuid NOT NULL REFERENCES public.submissions(id) ON DELETE CASCADE,
  name text DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT teams_submission_id_unique UNIQUE (submission_id)
);

CREATE INDEX IF NOT EXISTS teams_submission_id_idx ON public.teams(submission_id);

CREATE TABLE IF NOT EXISTS public.team_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id uuid NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,
  full_name text NOT NULL,
  luma_profile text DEFAULT '',
  cursor_email text DEFAULT '',
  social_url text DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS team_members_team_id_idx ON public.team_members(team_id);

ALTER TABLE public.teams ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.team_members ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service_role_all" ON public.teams;
CREATE POLICY "service_role_all" ON public.teams FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "service_role_all" ON public.team_members;
CREATE POLICY "service_role_all" ON public.team_members FOR ALL USING (true) WITH CHECK (true);

COMMENT ON TABLE public.teams IS 'Structured team metadata for a submission (1:1 with submissions.id).';
COMMENT ON TABLE public.team_members IS 'Individual roster entries for a team (replaces free-form submissions.team_members).';
