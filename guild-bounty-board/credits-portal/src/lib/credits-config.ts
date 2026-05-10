/**
 * Canonical credits routing + Firebase project selection.
 * Per deploy: set NEXT_PUBLIC_CREDITS_FIRESTORE_PROJECT_SLUG to the Firestore `projects.slug`
 * for this batch (codes + attendees). Supabase scope stays on DEFAULT_HACKATHON_ID server-side.
 */

export function getCreditsFirestoreProjectSlug(): string {
  const raw =
    process.env.NEXT_PUBLIC_CREDITS_FIRESTORE_PROJECT_SLUG?.trim() ||
    process.env.NEXT_PUBLIC_CREDITS_EVENT_SLUG?.trim();
  return raw || "cursor-thrads-london-2026";
}

export function boardBaseUrl(): string {
  const raw = (
    process.env.NEXT_PUBLIC_BOARD_URL || "https://cusor-hack-london-2026-2.vercel.app"
  ).replace(/\/$/, "");
  return raw || "/";
}
