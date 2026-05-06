"use client";

import Link from "next/link";
import { CursorBrandVideoMark } from "@/components/event/CursorBrandVideoMark";
import { boardBaseUrl } from "@/lib/credits-config";

type CreditsPortalHeaderProps = {
  /** When false, omit board shortcuts (e.g. minimal embedded views). Default true. */
  showBoardLinks?: boolean;
};

/** Neutral Cursor credits chrome — shared by redeem, admin, success, and `/`. */
export function CreditsPortalHeader({ showBoardLinks = true }: CreditsPortalHeaderProps) {
  const boardHref = boardBaseUrl();
  const externalBoard = boardHref.startsWith("http");
  const submitHref = externalBoard ? `${boardHref}/?open=submit` : `${boardHref}?open=submit`;
  const judgeHref = externalBoard ? `${boardHref}/?open=judge` : `${boardHref}?open=judge`;
  const managerHref = externalBoard ? `${boardHref}/?open=manager` : `${boardHref}?open=manager`;

  return (
    <header className="credits-site-header">
      <Link href="/" className="credits-brand" aria-label="Credits home">
        <span className="credits-brand-mark">
          <CursorBrandVideoMark size="header" />
        </span>
        <span className="credits-brand-text">
          <span className="credits-brand-title">Cursor credits</span>
          <span className="credits-brand-subtitle text-muted-foreground">
            Distribution portal
          </span>
        </span>
      </Link>
      <nav className="credits-header-actions" aria-label="Primary">
        <Link href="/hackathon" className="credits-header-button credits-header-button-ghost">
          Hackathon
        </Link>
        {showBoardLinks ? (
          <>
            <a href={submitHref} className="credits-header-button credits-header-button-primary">
              Submit project
            </a>
            <a href={judgeHref} className="credits-header-button credits-header-button-ghost">
              Judge panel
            </a>
            <a href={managerHref} className="credits-header-button credits-header-button-ghost">
              Manager
            </a>
          </>
        ) : null}
      </nav>
    </header>
  );
}
