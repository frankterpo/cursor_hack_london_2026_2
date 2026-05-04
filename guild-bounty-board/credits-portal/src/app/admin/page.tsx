'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { EventMarketingHeader } from '@/components/event/EventMarketingHeader';

export default function AdminPage() {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const router = useRouter();

  useEffect(() => {
    const isAuthenticated = localStorage.getItem('admin_authenticated') === 'true';
    if (isAuthenticated) {
      const selectedProject = localStorage.getItem('admin_selected_project');
      if (selectedProject) {
        router.push('/admin/dashboard');
      } else {
        router.push('/admin/projects');
      }
    }
  }, [router]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setError('');

    try {
      const response = await fetch('/credits/api/admin/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });

      const result = await response.json();

      if (result.success) {
        localStorage.setItem('admin_authenticated', 'true');
        router.push('/admin/projects');
      } else {
        setError('Invalid password');
      }
    } catch {
      setError('Authentication failed. Please try again.');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen">
      <EventMarketingHeader />
      <div className="mx-auto flex min-h-[60vh] max-w-md items-center px-4 py-12">
        <div className="panel-event w-full">
          <h2 className="font-display text-center text-lg font-semibold text-foreground">Admin access</h2>
          <p className="mt-2 text-center text-sm text-muted-foreground">Enter the admin password for the credits portal.</p>
          <form onSubmit={handleSubmit} className="mt-6 space-y-4">
            <div>
              <label htmlFor="password" className="mb-2 block text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Password
              </label>
              <input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Admin password"
                required
                autoFocus
                className="w-full rounded-md border border-input bg-background px-4 py-3 text-sm text-foreground outline-none ring-offset-background focus-visible:ring-2 focus-visible:ring-ring"
              />
            </div>

            {error && (
              <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-center text-sm text-destructive">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={isLoading || !password.trim()}
              className="btn-event-primary w-full disabled:opacity-50"
            >
              {isLoading ? 'Signing in…' : 'Access dashboard'}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
