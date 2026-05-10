import Link from "next/link";
import { CreditsPortalHeader } from "@/components/credits/CreditsPortalHeader";
import { CursorBrandVideoMark } from "@/components/event/CursorBrandVideoMark";

/** Neutral hub — hackathon copy lives on `/hackathon`; redemption on `/redeem`. */
export default function Home() {
  return (
    <div className="min-h-screen pb-16">
      <CreditsPortalHeader />

      <main className="mx-auto max-w-3xl px-4 py-14 sm:px-6 sm:py-20">
        <div className="panel-event p-8 sm:p-10">
          <div className="flex flex-wrap items-center gap-5">
            <CursorBrandVideoMark size="hero" />
            <div>
              <p className="eyebrow-event">Cursor credits</p>
              <h1 className="font-display mt-2 text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
                Claim your code — one route for every hackathon
              </h1>
            </div>
          </div>
          <p className="mt-6 text-base leading-relaxed text-muted-foreground">
            Redemption always lives at <strong className="text-foreground">/redeem</strong>. Configure the active Firebase
            project + Firestore slug via environment variables per deploy. Hackathon-specific judges, tracks, and prizes
            are only on <strong className="text-foreground">/hackathon</strong>.
          </p>
          <div className="mt-10 flex flex-col gap-3 sm:flex-row sm:flex-wrap">
            <Link href="/redeem" className="btn-event-primary inline-flex justify-center px-6 py-3 text-center text-base">
              Start redemption
            </Link>
            <Link href="/hackathon" className="btn-event-ghost inline-flex justify-center px-6 py-3 text-center text-base">
              Hackathon details
            </Link>
            <Link href="/admin" className="btn-event-ghost inline-flex justify-center px-6 py-3 text-center text-base">
              Organizer admin
            </Link>
          </div>
        </div>
      </main>
    </div>
  );
}
