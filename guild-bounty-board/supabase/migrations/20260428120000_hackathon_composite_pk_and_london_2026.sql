-- True per-hackathon rows: composite PKs on submissions + analyses,
-- composite FKs from judge_responses and analyses, so the same GitHub repo
-- can resubmit in a different event.

-- 1) Drop child foreign keys to submissions (repo_key-only)
ALTER TABLE judge_responses
  DROP CONSTRAINT IF EXISTS judge_responses_repo_key_fkey;

ALTER TABLE analyses
  DROP CONSTRAINT IF EXISTS analyses_repo_key_fkey;

-- 2) submissions: switch primary key to (hackathon_id, repo_key)
ALTER TABLE submissions
  DROP CONSTRAINT IF EXISTS submissions_pkey;

ALTER TABLE submissions
  ADD PRIMARY KEY (hackathon_id, repo_key);

-- 3) Reattach judge_responses with matching composite key
ALTER TABLE judge_responses
  ADD CONSTRAINT judge_responses_submission_fk
  FOREIGN KEY (hackathon_id, repo_key)
  REFERENCES submissions (hackathon_id, repo_key)
  ON DELETE CASCADE;

-- 4) analyses: composite PK + FK
ALTER TABLE analyses
  DROP CONSTRAINT IF EXISTS analyses_pkey;

ALTER TABLE analyses
  ADD PRIMARY KEY (hackathon_id, repo_key);

ALTER TABLE analyses
  ADD CONSTRAINT analyses_submission_fk
  FOREIGN KEY (hackathon_id, repo_key)
  REFERENCES submissions (hackathon_id, repo_key)
  ON DELETE CASCADE;

-- 5) London 2026 (adjust dates in dashboard if needed)
INSERT INTO hackathons (id, slug, name, starts_at, ends_at)
VALUES (
  'a0000002-0000-4000-8000-000000000002',
  'london-2026',
  'Cursor × Briefcase — London 2026',
  '2026-04-26T00:00:00Z',
  '2026-04-28T23:59:59Z'
)
ON CONFLICT (slug) DO UPDATE SET
  name = EXCLUDED.name,
  starts_at = EXCLUDED.starts_at,
  ends_at = EXCLUDED.ends_at,
  updated_at = now();

-- 6) Keep updated_at in sync
CREATE OR REPLACE FUNCTION public.tg_hackathons_set_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS tr_hackathons_set_updated_at ON public.hackathons;
CREATE TRIGGER tr_hackathons_set_updated_at
  BEFORE UPDATE ON public.hackathons
  FOR EACH ROW
  EXECUTE FUNCTION public.tg_hackathons_set_updated_at();
