-- Link Cursor credits tooling (Firestore project id), Luma event metadata, optional notes.

ALTER TABLE hackathons
  ADD COLUMN IF NOT EXISTS luma_event_api_id text,
  ADD COLUMN IF NOT EXISTS luma_event_name text,
  ADD COLUMN IF NOT EXISTS credits_firestore_project_doc_id text;

COMMENT ON COLUMN hackathons.luma_event_api_id IS 'Luma evt-* api id hosting this hack for credits attendee sync.';
COMMENT ON COLUMN hackathons.luma_event_name IS 'Display label from Luma (calendar/event name).';
COMMENT ON COLUMN hackathons.credits_firestore_project_doc_id IS 'Firestore projects/{docId} for Cursor redemption codes tied to this Supabase hackathon.';
