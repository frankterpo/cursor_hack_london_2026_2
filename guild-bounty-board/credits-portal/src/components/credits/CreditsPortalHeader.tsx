"use client";

import Link from "next/link";
import { CursorBrandVideoMark } from "@/components/event/CursorBrandVideoMark";

type CreditsPortalHeaderProps = {
  /** When false, omit hack landing + panel shortcuts. Default true. */
  showNav?: boolean;
};

/**
 * OG Cursor shell — used on `/redeem`, `/submit`, `/judge`, `/manager`, admin, success.
 * Collaborator-themed UI exists only on `/` (`HackathonLandingHeader`).
 */
export function CreditsPortalHeader({ showNav = true }: CreditsPortalHeaderProps) {
  return (
    <header className="credits-site-header">
      <Link href="/redeem" className="credits-brand" aria-label="Cursor credits">
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
      {showNav ? (
        <nav className="credits-header-actions" aria-label="Primary">
          <Link href="/" className="credits-header-button credits-header-button-ghost">
            Hackathon home
          </Link>
          <Link href="/redeem" className="credits-header-button credits-header-button-primary">
            Redeem
          </Link>
          <Link href="/submit" className="credits-header-button credits-header-button-ghost">
            Submit
          </Link>
          <Link href="/judge" className="credits-header-button credits-header-button-ghost">
            Judge
          </Link>
          <Link href="/manager" className="credits-header-button credits-header-button-ghost">
            Manager
          </Link>
        </nav>
      ) : null}
    </header>
  );
}
