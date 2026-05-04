-- Backfill analysis_settings for London 2026 so commit analysis / metrics use the correct event window.
-- Thresholds default to the same as the original singleton seed; copy from legacy hackathon if present.

INSERT INTO analysis_settings (
  hackathon_id,
  event_t0,
  event_t1,
  bulk_insertion_threshold,
  bulk_files_threshold,
  max_commits_to_analyze
)
SELECT
  'a0000002-0000-4000-8000-000000000002'::uuid,
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
WHERE h.id = 'a0000002-0000-4000-8000-000000000002'
ON CONFLICT (hackathon_id) DO UPDATE SET
  event_t0 = EXCLUDED.event_t0,
  event_t1 = EXCLUDED.event_t1,
  bulk_insertion_threshold = EXCLUDED.bulk_insertion_threshold,
  bulk_files_threshold = EXCLUDED.bulk_files_threshold,
  max_commits_to_analyze = EXCLUDED.max_commits_to_analyze;
