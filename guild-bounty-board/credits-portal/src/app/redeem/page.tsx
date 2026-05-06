"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { CreditsPortalHeader } from "@/components/credits/CreditsPortalHeader";
import { RedemptionForm } from "@/features/attendees/components/RedemptionForm";
import { getCreditsFirestoreProjectSlug } from "@/lib/credits-config";

export default function RedeemPage() {
  const slug = getCreditsFirestoreProjectSlug();
  const [project, setProject] = useState<{ id: string; name: string; slug: string } | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch(`/credits/api/public/projects/${encodeURIComponent(slug)}`);
        if (!response.ok) throw new Error("Project not found");
        const result = await response.json();
        if (!cancelled) {
          setProject(result.data);
          setError("");
        }
      } catch (err) {
        console.error(err);
        if (!cancelled) {
          setError(
            `Could not load Firestore project for slug "${slug}". Set NEXT_PUBLIC_CREDITS_FIRESTORE_PROJECT_SLUG or provision the matching projects/ document.`,
          );
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [slug]);

  return (
    <div className="min-h-screen pb-16">
      <CreditsPortalHeader />

      {isLoading ? (
        <div className="mx-auto max-w-md px-4 py-20 text-center">
          <div className="mx-auto h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          <p className="mt-4 text-sm text-muted-foreground">Loading redemption…</p>
        </div>
      ) : error || !project ? (
        <div className="mx-auto max-w-lg px-4 py-16">
          <div className="panel-event text-center">
            <h1 className="font-display text-xl font-semibold text-destructive">Redemption unavailable</h1>
            <p className="mt-3 text-sm text-muted-foreground">{error}</p>
            <Link href="/" className="btn-event-primary mt-8 inline-block px-6 py-2.5 text-sm">
              Back to credits home
            </Link>
          </div>
        </div>
      ) : (
        <div className="mx-auto max-w-lg px-4 py-12">
          <div className="mb-8 text-center">
            <p className="eyebrow-event">Redeem</p>
            <h1 className="font-display mt-2 text-2xl font-semibold text-foreground">Claim your code</h1>
            <p className="mt-2 text-lg text-foreground/90">{project.name}</p>
            <p className="mt-2 text-sm text-muted-foreground">
              Use the same name and email you used at check-in.
            </p>
          </div>
          <div className="panel-event">
            <RedemptionForm projectId={project.id} />
          </div>
        </div>
      )}
    </div>
  );
}
