-- Multi-tenant hackathons: segment submissions, analyses, judge scores, and settings per event.

-- gen_random_uuid() default on hackathons (available on Supabase / with pgcrypto)
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS hackathons (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        text NOT NULL UNIQUE,
  name        text NOT NULL,
  starts_at   timestamptz NOT NULL,
  ends_at     timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

INSERT INTO hackathons (id, slug, name, starts_at, ends_at)
VALUES (
  'a0000001-0000-4000-8000-000000000001',
  'legacy-default',
  'Legacy default hackathon (HCMC seed)',
  '2025-11-29T06:00:00Z',
  '2025-11-29T12:00:00Z'
)
ON CONFLICT (slug) DO NOTHING;

-- submissions.hackathon_id
ALTER TABLE submissions
  ADD COLUMN IF NOT EXISTS hackathon_id uuid REFERENCES hackathons (id);

UPDATE submissions SET hackathon_id = 'a0000001-0000-4000-8000-000000000001'
WHERE hackathon_id IS NULL;

ALTER TABLE submissions
  ALTER COLUMN hackathon_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS submissions_hackathon_id_idx ON submissions (hackathon_id);

-- judge_responses: scope uniqueness per hackathon
ALTER TABLE judge_responses
  ADD COLUMN IF NOT EXISTS hackathon_id uuid REFERENCES hackathons (id);

UPDATE judge_responses jr
SET hackathon_id = s.hackathon_id
FROM submissions s
WHERE jr.repo_key = s.repo_key AND jr.hackathon_id IS NULL;

UPDATE judge_responses
SET hackathon_id = 'a0000001-0000-4000-8000-000000000001'
WHERE hackathon_id IS NULL;

ALTER TABLE judge_responses
  ALTER COLUMN hackathon_id SET NOT NULL;

ALTER TABLE judge_responses
  DROP CONSTRAINT IF EXISTS judge_responses_judge_name_repo_key_key;

ALTER TABLE judge_responses
  ADD CONSTRAINT judge_responses_judge_name_repo_key_hack UNIQUE (judge_name, repo_key, hackathon_id);

CREATE INDEX IF NOT EXISTS judge_responses_hackathon_id_idx ON judge_responses (hackathon_id);

-- analyses
ALTER TABLE analyses
  ADD COLUMN IF NOT EXISTS hackathon_id uuid REFERENCES hackathons (id);

UPDATE analyses a
SET hackathon_id = s.hackathon_id
FROM submissions s
WHERE a.repo_key = s.repo_key AND a.hackathon_id IS NULL;

UPDATE analyses
SET hackathon_id = 'a0000001-0000-4000-8000-000000000001'
WHERE hackathon_id IS NULL;

ALTER TABLE analyses
  ALTER COLUMN hackathon_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS analyses_hackathon_id_idx ON analyses (hackathon_id);

-- analysis_settings: one row per hackathon (replaces singleton id = 1)
ALTER TABLE analysis_settings
  ADD COLUMN IF NOT EXISTS hackathon_id uuid REFERENCES hackathons (id);

UPDATE analysis_settings
SET hackathon_id = 'a0000001-0000-4000-8000-000000000001'
WHERE hackathon_id IS NULL AND id = 1;

-- If duplicate rows ever existed, keep id=1 only; this matches original CHECK (id = 1).
DELETE FROM analysis_settings WHERE id IS DISTINCT FROM 1;

ALTER TABLE analysis_settings
  ALTER COLUMN hackathon_id SET NOT NULL;

ALTER TABLE analysis_settings DROP CONSTRAINT IF EXISTS analysis_settings_pkey;
ALTER TABLE analysis_settings DROP CONSTRAINT IF EXISTS analysis_settings_id_check;

ALTER TABLE analysis_settings DROP COLUMN IF EXISTS id;

ALTER TABLE analysis_settings
  ADD CONSTRAINT analysis_settings_pkey PRIMARY KEY (hackathon_id);

ALTER TABLE hackathons ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service_role_all_hackathons" ON hackathons;
CREATE POLICY "service_role_all_hackathons" ON hackathons FOR ALL
  USING (true) WITH CHECK (true);