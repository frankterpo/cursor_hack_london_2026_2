-- Run in Supabase SQL Editor or: cd guild-bounty-board && supabase db execute --file ../scripts/ops/thrads-london-2026-supabase-verify.sql
-- (CLI flag names vary by version; Dashboard paste is always safe.)

SELECT id, slug, name, starts_at, ends_at
FROM public.hackathons
WHERE id = 'a0000003-0000-4000-8000-000000000003'
   OR slug = 'thrads-london-2026';

SELECT hackathon_id, event_t0, event_t1
FROM public.analysis_settings
WHERE hackathon_id = 'a0000003-0000-4000-8000-000000000003';
