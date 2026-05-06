import Link from "next/link";
import { CursorBrandVideoMark } from "@/components/event/CursorBrandVideoMark";

function boardBase(): string {
  const raw = (
    process.env.NEXT_PUBLIC_BOARD_URL ||
    "https://cusor-hack-london-2026-2.vercel.app"
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
      <div className="event-brand-leading">
        <Link href="/" className="event-brand" aria-label="Credits home">
          <span className="event-brand-mark">
            <CursorBrandVideoMark size="header" />
          </span>
          <span className="event-brand-text">
            <span className="event-brand-title">Cursor × Thrads</span>
            <span className="event-brand-subtitle">
              <span className="event-brand-location">London · 2026 ·</span>
            </span>
          </span>
        </Link>
        <a
          href="https://thrad.ai"
          className="event-brand-thrads-link"
          target="_blank"
          rel="noopener noreferrer"
          aria-label="Thrads — visit thrad.ai"
        >
          thrad.ai
        </a>
      </div>
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
