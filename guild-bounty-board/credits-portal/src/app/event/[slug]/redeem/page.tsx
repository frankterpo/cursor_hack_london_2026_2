'use client';

import { useState, useEffect } from 'react';
import { useParams } from 'next/navigation';
import { RedemptionForm } from '@/features/attendees/components/RedemptionForm';
import { EventMarketingHeader } from '@/components/event/EventMarketingHeader';
import Link from 'next/link';

const LONDON_PROJECT = {
  id: 'nynsjuhYRTQhxTNZgywQ',
  name: 'Cursor x Briefcase — London 2026',
  slug: 'cursor-hackathon-london-2026',
};

function isLondonRedeemSlug(slug: string) {
  return [
    'cursor-hackathon-london-2026',
    'cursor-hackathon-london-2026-1',
    'london-2026',
  ].includes(slug);
}

export default function ProjectRedeemPage() {
  const params = useParams();
  const slug = params.slug as string;
  const [project, setProject] = useState<{ id: string; name: string; slug: string } | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    if (isLondonRedeemSlug(slug)) {
      setProject(LONDON_PROJECT);
      setError('');
      setIsLoading(false);
      return;
    }

    fetchProjectBySlug();
  }, [slug]);

  const fetchProjectBySlug = async () => {
    try {
      const response = await fetch(`/credits/api/public/projects/${slug}`);
      if (!response.ok) {
        throw new Error('Project not found');
      }
      const result = await response.json();
      setProject(result.data);
      setError('');
    } catch (err) {
      setError('Event not found or not available for redemption');
      console.error('Project fetch error:', err);
    } finally {
      setIsLoading(false);
    }
  };

  if (isLoading) {
    return (
      <div className="min-h-screen">
        <EventMarketingHeader />
        <div className="mx-auto max-w-md px-4 py-20 text-center">
          <div className="mx-auto h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          <p className="mt-4 text-sm text-muted-foreground">Loading event…</p>
        </div>
      </div>
    );
  }

  if (error || !project) {
    return (
      <div className="min-h-screen">
        <EventMarketingHeader />
        <div className="mx-auto max-w-md px-4 py-20 text-center">
          <h1 className="font-display text-xl font-semibold text-destructive">Event not found</h1>
          <p className="mt-3 text-sm text-muted-foreground">
            {error || 'The event you are looking for is not available for code redemption.'}
          </p>
          <Link href="/" className="mt-6 inline-block text-sm font-medium text-primary hover:underline">
            ← Back to credits home
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen pb-16">
      <EventMarketingHeader />
      <div className="mx-auto max-w-lg px-4 py-12">
        <div className="mb-8 text-center">
          <p className="eyebrow-event">Redeem</p>
          <h1 className="font-display mt-2 text-2xl font-semibold text-foreground">Claim your code</h1>
          <p className="mt-2 text-lg text-foreground/90">{project.name}</p>
          <p className="mt-2 text-sm text-muted-foreground">Enter your details to receive your Cursor credits.</p>
        </div>
        <div className="panel-event">
          <RedemptionForm projectId={project.id} />
        </div>
      </div>
    </div>
  );
}
