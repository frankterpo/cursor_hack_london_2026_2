-- Cursor × Thrads — London 2026 (Supabase tenant UUID matches credits-portal + Firestore seed scripts.)
-- Adjust starts_at / ends_at in Dashboard or via UPDATE when the final schedule is fixed.

INSERT INTO hackathons (id, slug, name, starts_at, ends_at)
VALUES (
  'a0000003-0000-4000-8000-000000000003',
  'thrads-london-2026',
  'Cursor × Thrads — London 2026',
  '2026-05-06T00:00:00Z',
  '2026-05-08T23:59:59Z'
)
ON CONFLICT (slug) DO UPDATE SET
  name = EXCLUDED.name,
  starts_at = EXCLUDED.starts_at,
  ends_at = EXCLUDED.ends_at,
  updated_at = now();

INSERT INTO analysis_settings (
  hackathon_id,
  event_t0,
  event_t1,
  bulk_insertion_threshold,
  bulk_files_threshold,
  max_commits_to_analyze
)
SELECT
  'a0000003-0000-4000-8000-000000000003'::uuid,
  h.starts_at,
  h.ends_at,
  COALESCE(
    (SELECT s.bulk_insertion_threshold
     FROM analysis_settings s
     WHERE s.hackathon_id = 'a0000001-0000-4000-8000-000000000001'
     LIMIT 1),
    1000
  ),
  COALESCE(
    (SELECT s.bulk_files_threshold
     FROM analysis_settings s
     WHERE s.hackathon_id = 'a0000001-0000-4000-8000-000000000001'
     LIMIT 1),
    50
  ),
  COALESCE(
    (SELECT s.max_commits_to_analyze
     FROM analysis_settings s
     WHERE s.hackathon_id = 'a0000001-0000-4000-8000-000000000001'
     LIMIT 1),
    400
  )
FROM hackathons h
WHERE h.id = 'a0000003-0000-4000-8000-000000000003'
ON CONFLICT (hackathon_id) DO UPDATE SET
  event_t0 = EXCLUDED.event_t0,
  event_t1 = EXCLUDED.event_t1,
  bulk_insertion_threshold = EXCLUDED.bulk_insertion_threshold,
  bulk_files_threshold = EXCLUDED.bulk_files_threshold,
  max_commits_to_analyze = EXCLUDED.max_commits_to_analyze;
