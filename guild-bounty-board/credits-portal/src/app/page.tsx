import Link from "next/link";
import { EventMarketingHeader } from "@/components/event/EventMarketingHeader";
import { CursorBrandVideoMark } from "@/components/event/CursorBrandVideoMark";

const redeemHref = "/event/cursor-hackathon-london-2026/redeem";

const readiness = [
  { label: "Event", value: "London 2026" },
  { label: "Flow", value: "Name + email match" },
];

const steps = [
  "Start redemption from this page.",
  "Choose the exact name you checked in with.",
  "Confirm the matching email and claim your Cursor code.",
];

/** Credits landing — Cursor-first; hack board / judge links stay in the header. */
export default function Home() {
  return (
    <div className="min-h-screen pb-16">
      <EventMarketingHeader />

      <main className="mx-auto max-w-5xl px-4 py-10 sm:px-6 sm:py-16">
        <section className="grid gap-6 lg:grid-cols-[1.08fr_0.92fr] lg:items-stretch">
          <div className="panel-event flex min-h-[520px] flex-col justify-between p-7 sm:p-9">
            <div>
              <div className="mb-8 flex items-center gap-4">
                <CursorBrandVideoMark size="hero" />
                <div>
                  <p className="eyebrow-event">Cursor credits</p>
                </div>
              </div>

              <h1 className="font-display max-w-2xl text-4xl font-semibold tracking-tight text-foreground sm:text-5xl">
                Claim the Cursor credits reserved for you.
              </h1>
              <p className="mt-5 max-w-xl text-base leading-7 text-muted-foreground sm:text-lg">
                Use the same name and email you used at check-in. If your name does not appear, ask the event team to sync
                the latest attendee list before trying again.
              </p>
            </div>

            <div className="mt-10">
              <div className="grid gap-3 sm:grid-cols-2">
                {readiness.map((item) => (
                  <div key={item.label} className="rounded-lg border border-border/80 bg-background/45 px-4 py-3">
                    <div className="text-[0.68rem] font-semibold uppercase tracking-[0.18em] text-primary">
                      {item.label}
                    </div>
                    <div className="mt-1 text-sm font-medium text-foreground">{item.value}</div>
                  </div>
                ))}
              </div>

              <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:items-center">
                <Link href={redeemHref} className="btn-event-primary w-full py-3 text-base sm:w-auto">
                  Start redemption
                </Link>
                <Link href="/admin" className="btn-event-ghost w-full py-3 text-base sm:w-auto">
                  Organizer admin
                </Link>
              </div>
            </div>
          </div>

          <aside className="panel-event p-7 sm:p-8">
            <p className="eyebrow-event">Before you start</p>
            <h2 className="font-display mt-2 text-2xl font-semibold text-foreground">A clean 60-second flow</h2>
            <ol className="mt-7 space-y-5">
              {steps.map((step, index) => (
                <li key={step} className="flex gap-4">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-primary/40 bg-primary/10 text-sm font-semibold text-primary">
                    {index + 1}
                  </span>
                  <p className="pt-1 text-sm leading-6 text-muted-foreground">{step}</p>
                </li>
              ))}
            </ol>

            <div className="mt-8 rounded-lg border border-primary/25 bg-primary/10 p-4">
              <h3 className="font-display text-sm font-semibold text-foreground">For organizers</h3>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">
                Codes are already loaded. The last thing to verify before doors open is that checked-in Luma attendees
                have been synced into this event.
              </p>
            </div>
          </aside>
        </section>
      </main>
    </div>
  );
}
