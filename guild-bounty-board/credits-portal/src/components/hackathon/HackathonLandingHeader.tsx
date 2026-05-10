"use client";

import Link from "next/link";
import { CursorBrandVideoMark } from "@/components/event/CursorBrandVideoMark";
import type { HackathonLandingConfig } from "@/lib/hackathon-landing";

type Props = {
  cfg: HackathonLandingConfig;
};

/**
 * Only used on `/` — collaborator-themed chrome. Every other route uses `CreditsPortalHeader` (OG Cursor).
 */
export function HackathonLandingHeader({ cfg }: Props) {
  return (
    <header className="hackathon-themed-header border-b border-primary/25 bg-gradient-to-r from-background via-primary/5 to-background backdrop-blur-sm">
      <div className="mx-auto flex max-w-6xl flex-col gap-4 px-4 py-5 sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <div className="flex min-w-0 items-center gap-4">
          <CursorBrandVideoMark size="header" />
          <div className="min-w-0">
            <p className="text-[0.65rem] font-semibold uppercase tracking-[0.2em] text-primary">Hackathon</p>
            <p className="font-display truncate text-lg font-semibold text-foreground sm:text-xl">{cfg.title}</p>
            {cfg.subtitle ? (
              <p className="truncate text-xs text-muted-foreground sm:text-sm">{cfg.subtitle}</p>
            ) : null}
          </div>
        </div>
        <nav className="flex flex-wrap items-center gap-2" aria-label="Hackathon">
          <Link href="/redeem" className="btn-event-ghost px-3 py-2 text-xs sm:text-sm">
            Cursor credits
          </Link>
          <Link href="/submit" className="btn-event-primary px-3 py-2 text-xs sm:text-sm">
            Submit
          </Link>
          <Link href="/judge" className="btn-event-ghost px-3 py-2 text-xs sm:text-sm">
            Judge
          </Link>
          <Link href="/manager" className="btn-event-ghost px-3 py-2 text-xs sm:text-sm">
            Manager
          </Link>
        </nav>
      </div>
    </header>
  );
}
