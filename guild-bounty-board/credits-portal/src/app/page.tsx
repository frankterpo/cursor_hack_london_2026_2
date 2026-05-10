"use client";

import Link from "next/link";
import { HackathonLandingHeader } from "@/components/hackathon/HackathonLandingHeader";
import { HackathonLiveSnapshot } from "@/components/hackathon/HackathonLiveSnapshot";
import { getHackathonLandingConfig } from "@/lib/hackathon-landing";

/**
 * Per-hack Vercel deploy: ONLY this route is collaborator-themed (env-driven).
 * Reuse the same credits + panel infra (`/redeem`, `/submit`, `/judge`, `/manager`) across hacks.
 */
export default function HackathonLandingPage() {
  const cfg = getHackathonLandingConfig();

  return (
    <div className="min-h-screen pb-20">
      <HackathonLandingHeader cfg={cfg} />

      <main className="hackathon-landing-main mx-auto max-w-5xl px-4 py-10 sm:px-6 sm:py-14">
        <header className="panel-event relative overflow-hidden p-8 sm:p-10">
          <p className="eyebrow-event">Overview</p>
          <h1 className="font-display mt-3 text-4xl font-semibold tracking-tight text-foreground sm:text-5xl">
            {cfg.title}
          </h1>
          {cfg.subtitle ? (
            <p className="mt-3 text-lg text-muted-foreground sm:text-xl">{cfg.subtitle}</p>
          ) : null}
          {cfg.partnerLinks?.length ? (
            <ul className="mt-6 flex flex-wrap gap-3">
              {cfg.partnerLinks.map((p) => (
                <li key={p.href}>
                  <a
                    href={p.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex rounded-md border border-primary/35 bg-primary/10 px-4 py-2 text-sm font-semibold text-primary hover:bg-primary/15"
                  >
                    {p.label}
                  </a>
                </li>
              ))}
            </ul>
          ) : null}
          <div className="mt-10 flex flex-wrap gap-3">
            <Link href="/redeem" className="btn-event-primary px-6 py-3 text-sm">
              Cursor credits
            </Link>
            <Link href="/submit" className="btn-event-ghost px-6 py-3 text-sm">
              Submit project
            </Link>
            <Link href="/judge" className="btn-event-ghost px-6 py-3 text-sm">
              Judge panel
            </Link>
            <Link href="/manager" className="btn-event-ghost px-6 py-3 text-sm">
              Manager
            </Link>
          </div>
        </header>

        <div className="mt-10 grid gap-10 lg:grid-cols-3">
          <section className="panel-event p-6 lg:col-span-1">
            <h2 className="font-display text-lg font-semibold text-foreground">Tracks</h2>
            {cfg.tracks?.length ? (
              <ul className="mt-4 list-inside list-disc space-y-2 text-sm text-muted-foreground">
                {cfg.tracks.map((t) => (
                  <li key={t}>{t}</li>
                ))}
              </ul>
            ) : (
              <p className="mt-4 text-sm text-muted-foreground">
                Set <code className="rounded bg-muted px-1 py-0.5 text-xs">NEXT_PUBLIC_HACKATHON_TRACKS</code> (one per
                line) or <code className="rounded bg-muted px-1 py-0.5 text-xs">NEXT_PUBLIC_HACKATHON_LANDING_JSON</code>.
              </p>
            )}
          </section>

          <section className="panel-event p-6 lg:col-span-1">
            <h2 className="font-display text-lg font-semibold text-foreground">Judges</h2>
            {cfg.judges?.length ? (
              <ul className="mt-4 space-y-3 text-sm">
                {cfg.judges.map((j) => (
                  <li key={j.name}>
                    <span className="font-medium text-foreground">{j.name}</span>
                    {j.title ? <span className="text-muted-foreground"> — {j.title}</span> : null}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-4 text-sm text-muted-foreground">
                Set <code className="rounded bg-muted px-1 py-0.5 text-xs">NEXT_PUBLIC_HACKATHON_JUDGES_JSON</code> or{" "}
                <code className="rounded bg-muted px-1 py-0.5 text-xs">NEXT_PUBLIC_HACKATHON_JUDGES</code> (one name per
                line).
              </p>
            )}
          </section>

          <section className="panel-event p-6 lg:col-span-1">
            <h2 className="font-display text-lg font-semibold text-foreground">Prizes</h2>
            {cfg.prizes?.length ? (
              <ul className="mt-4 list-inside list-disc space-y-2 text-sm text-muted-foreground">
                {cfg.prizes.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            ) : (
              <p className="mt-4 text-sm text-muted-foreground">
                Set <code className="rounded bg-muted px-1 py-0.5 text-xs">NEXT_PUBLIC_HACKATHON_PRIZES</code> (one per line)
                or include <code className="rounded bg-muted px-1 py-0.5 text-xs">prizes</code> in the landing JSON blob.
              </p>
            )}
          </section>
        </div>

        <div className="mt-12 space-y-4">
          <div>
            <p className="eyebrow-event">Live board</p>
            <h2 className="font-display mt-2 text-2xl font-semibold text-foreground">
              Submissions & judge scores
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Pulled from Supabase using <code className="rounded bg-muted px-1 py-0.5 text-xs">DEFAULT_HACKATHON_ID</code>{" "}
              on this deployment.
            </p>
          </div>
          <HackathonLiveSnapshot variant="landing" />
        </div>
      </main>
    </div>
  );
}
