'use client';

import { useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { ExternalLink, Copy, Check } from 'lucide-react';
import Link from 'next/link';
import { EventMarketingHeader } from '@/components/event/EventMarketingHeader';

export function SuccessContent() {
  const searchParams = useSearchParams();
  const cursorUrl =
    searchParams.get('cursorUrl') ||
    'https://cursor.com/referral?code=SAMPLE-CODE';
  const name = searchParams.get('name') || 'Attendee';
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(cursorUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback: select+copy via temp textarea, works on older Safari/iOS
      const ta = document.createElement('textarea');
      ta.value = cursorUrl;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      try {
        document.execCommand('copy');
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      } catch {
        // give up silently; user can long-press to copy
      }
      document.body.removeChild(ta);
    }
  };

  return (
    <div className="min-h-screen pb-16">
      <EventMarketingHeader />
      <div className="mx-auto max-w-lg px-4 py-12">
        <div className="mb-8 text-center">
          <div className="mx-auto mb-6 flex h-20 w-20 items-center justify-center rounded-full border-2 border-primary/60 bg-primary/10">
            <span className="text-3xl font-semibold text-primary">✓</span>
          </div>
          <h1 className="font-display text-2xl font-semibold text-foreground">
            You&apos;re set, {name}!
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Your Cursor credits link is ready.
          </p>
        </div>

        <div className="panel-event text-center">
          {/* Native anchor — bypasses popup blockers and works on every browser */}
          <a
            href={cursorUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="btn-event-primary inline-flex w-full items-center justify-center gap-2 py-4 text-sm font-semibold"
          >
            <ExternalLink className="h-5 w-5" />
            Open Cursor — claim credits
          </a>

          <div className="mt-4 space-y-2 text-left">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Or copy your link
            </p>
            <div className="flex items-stretch gap-2">
              <input
                type="text"
                readOnly
                value={cursorUrl}
                onFocus={(e) => e.currentTarget.select()}
                className="flex-1 rounded-md border border-input bg-background px-3 py-2 text-xs text-foreground outline-none ring-offset-background focus-visible:ring-2 focus-visible:ring-ring"
              />
              <button
                type="button"
                onClick={handleCopy}
                className="btn-event-ghost inline-flex items-center justify-center gap-1 rounded-md px-3 py-2 text-xs"
                aria-label="Copy credits link"
              >
                {copied ? (
                  <>
                    <Check className="h-4 w-4" /> Copied
                  </>
                ) : (
                  <>
                    <Copy className="h-4 w-4" /> Copy
                  </>
                )}
              </button>
            </div>
          </div>

          <p className="mt-6 text-xs text-muted-foreground">
            Tap the button or copy the link if it doesn&apos;t open. Need help?
            Contact the organizers.
          </p>
        </div>

        <p className="mt-8 text-center text-sm">
          <Link href="/" className="text-primary hover:underline">
            ← Back to credits home
          </Link>
        </p>
      </div>
    </div>
  );
}
