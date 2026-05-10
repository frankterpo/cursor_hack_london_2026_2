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

/** Guild static board deep-link for submit / judge / manager panels (OG Cursor UI lives behind this URL). */
export function boardPanelUrl(panel: "submit" | "judge" | "manager"): string {
  const raw = boardBaseUrl();
  const base = raw.startsWith("http")
    ? raw
    : "https://cusor-hack-london-2026-2.vercel.app";
  const param =
    panel === "submit" ? "open=submit" : panel === "judge" ? "open=judge" : "open=manager";
  const origin = base.replace(/\/$/, "");
  return `${origin}/?${param}`;
}
