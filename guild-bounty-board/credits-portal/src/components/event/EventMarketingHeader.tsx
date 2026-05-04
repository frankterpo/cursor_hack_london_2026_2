import Link from "next/link";
import { CursorBrandVideoMark } from "@/components/event/CursorBrandVideoMark";

function boardBase(): string {
  const raw = (
    process.env.NEXT_PUBLIC_BOARD_URL || "https://cusor-hack-london-2026-1.vercel.app"
  ).replace(/\/$/, "");
  return raw || "/";
}

export function EventMarketingHeader() {
  const boardHref = boardBase();
  const externalBoard = boardHref.startsWith("http");
  const submitHref = externalBoard ? `${boardHref}/?open=submit` : `${boardHref}?open=submit`;
  const judgeHref = externalBoard ? `${boardHref}/?open=judge` : `${boardHref}?open=judge`;
  const managerHref = externalBoard ? `${boardHref}/?open=manager` : `${boardHref}?open=manager`;

  return (
    <header className="event-site-header">
      <Link href="/" className="event-brand" aria-label="Credits home">
        <span className="event-brand-mark">
          <CursorBrandVideoMark size="header" />
        </span>
        <span className="event-brand-text">
          <span className="event-brand-title">Cursor × Briefcase</span>
          <span className="event-brand-subtitle">
            <span className="event-brand-location">London · 2026 ·</span>
            <span className="event-brand-halkin" aria-label="Halkin">
              <span className="event-brand-halkin-inner" aria-hidden="true">
                <svg
                  className="event-brand-halkin-svg"
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 178 40"
                  overflow="visible"
                  focusable="false"
                >
                  <g fill="currentColor">
                    <path className="event-brand-halkin-rule" d="M 0 34.995 L 177.801 34.995 L 177.801 40 L 0 40 Z" />
                    <path d="M 161.799 0.443 L 161.799 18.567 L 166.457 18.567 L 166.457 7.87 L 174.152 18.566 L 178 18.566 L 178 0.443 L 173.625 0.443 L 173.625 10.574 L 166.457 0.443 Z" />
                    <path d="M 137.796 0 L 137.796 18.406 L 142.819 18.406 L 142.819 0 Z" />
                    <path d="M 103.569 18.203 L 103.569 0.001 L 108.591 0.001 L 108.591 7.306 L 114.991 0 L 120.823 0 L 113.735 7.79 L 121.187 18.203 L 115.315 18.203 L 110.131 11.059 L 108.591 12.592 L 108.591 18.203 Z" />
                    <path d="M 71.607 0 L 71.607 18.406 L 85.7 18.406 L 85.7 14.208 L 76.628 14.208 L 76.628 0 Z M 41.757 0.203 L 34.628 18.406 L 39.49 18.406 L 40.867 14.894 L 48.156 14.894 L 49.533 18.406 L 54.393 18.406 L 47.265 0.204 L 41.757 0.204 Z M 44.511 5.288 L 46.739 11.222 L 42.283 11.222 Z M 0 0.182 L 0 18.406 L 5.021 18.406 L 5.021 11.141 L 12.333 11.141 L 12.333 18.406 L 17.334 18.406 L 17.334 0.182 L 12.333 0.182 L 12.333 7.104 L 5.021 7.104 L 5.021 0.182 Z" />
                  </g>
                </svg>
              </span>
            </span>
          </span>
        </span>
      </Link>
      <nav className="event-header-actions" aria-label="Primary">
        <a href={submitHref} className="event-header-button event-header-button-primary">
          Submit project
        </a>
        <a href={judgeHref} className="event-header-button event-header-button-ghost">
          Judge panel
        </a>
        <a href={managerHref} className="event-header-button event-header-button-ghost">
          Manager
        </a>
      </nav>
    </header>
  );
}
