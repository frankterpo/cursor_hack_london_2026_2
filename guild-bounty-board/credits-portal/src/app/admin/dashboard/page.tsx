'use client';

import { useEffect, useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { useRouter } from 'next/navigation';
interface DashboardStats {
  totalCodes: number;
  usedCodes: number;
  totalAttendees: number;
  totalRedemptions: number;
  recentRedemptions: Array<{
    id: string;
    attendeeName: string;
    email: string;
    timestamp: string;
    codeUrl: string;
  }>;
}

export default function AdminDashboard() {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  const router = useRouter();

  useEffect(() => {
    fetchDashboardData();
    const interval = setInterval(fetchDashboardData, 30000);
    return () => clearInterval(interval);
  }, []);

  const fetchDashboardData = async () => {
    try {
      const selectedProjectData = localStorage.getItem('admin_selected_project');
      if (!selectedProjectData) {
        setError('No project selected');
        setIsLoading(false);
        return;
      }

      const selectedProject = JSON.parse(selectedProjectData) as { id: string };
      const response = await fetch(`/credits/api/admin/dashboard?projectId=${selectedProject.id}`);
      if (!response.ok) throw new Error('Failed to fetch data');

      const data = await response.json();
      setStats(data);
      setError('');
    } catch (err) {
      setError('Failed to load dashboard data');
      console.error('Dashboard fetch error:', err);
    } finally {
      setIsLoading(false);
    }
  };

  const openTestRedeem = () => {
    try {
      const raw = localStorage.getItem('admin_selected_project');
      if (!raw) return;
      const { slug } = JSON.parse(raw) as { slug: string };
      window.open(`/credits/event/${slug}/redeem`, '_blank', 'noopener,noreferrer');
    } catch {
      /* ignore */
    }
  };

  if (isLoading) {
    return (
      <div className="space-y-6">
        <h1 className="font-display text-2xl font-semibold text-foreground">Dashboard</h1>
        <div className="grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Card key={i} className="animate-pulse border-border bg-card">
              <CardHeader className="pb-2">
                <div className="h-4 w-3/4 max-w-[12rem] rounded bg-muted" />
              </CardHeader>
              <CardContent>
                <div className="h-8 w-1/2 rounded bg-muted" />
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-6">
        <h1 className="font-display text-2xl font-semibold text-foreground">Dashboard</h1>
        <Card className="border-border bg-card">
          <CardContent className="pt-6">
            <div className="text-center text-destructive">
              <p>{error}</p>
              <Button onClick={fetchDashboardData} className="mt-4">
                Try Again
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="font-display text-2xl font-semibold text-foreground">Dashboard</h1>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => router.push('/admin/uploads')}>
            Upload Data
          </Button>
          <Button onClick={fetchDashboardData}>Refresh</Button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-6 md:grid-cols-3">
        <StatsCard
          title="Total Codes"
          value={stats?.totalCodes || 0}
          description="Available for redemption"
        />
        <StatsCard
          title="Total Attendees"
          value={stats?.totalAttendees || 0}
          description="Registered for event"
        />
        <StatsCard
          title="Redemptions"
          value={stats?.totalRedemptions || 0}
          description={`${stats?.totalRedemptions || 0} of ${stats?.totalCodes || 0} codes redeemed`}
          progress={stats?.totalCodes ? ((stats.totalRedemptions || 0) / stats.totalCodes) * 100 : 0}
        />
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card className="border-border bg-card">
          <CardHeader>
            <CardTitle>Recent Redemptions</CardTitle>
            <CardDescription>Latest code claims (Firebase)</CardDescription>
          </CardHeader>
          <CardContent>
            {stats?.recentRedemptions?.length ? (
              <div className="space-y-3">
                {stats.recentRedemptions.slice(0, 5).map((redemption) => (
                  <div
                    key={redemption.id}
                    className="flex items-start justify-between gap-3 rounded-lg border border-border/60 bg-secondary/50 p-3"
                  >
                    <div>
                      <p className="text-sm font-medium text-foreground">{redemption.attendeeName}</p>
                      <p className="text-xs text-muted-foreground">{redemption.email}</p>
                      <p className="text-xs text-muted-foreground">
                        {new Date(redemption.timestamp).toLocaleString()}
                      </p>
                    </div>
                    <div className="text-xs text-muted-foreground">{redemption.codeUrl.slice(-8)}</div>
                  </div>
                ))}

                {stats.recentRedemptions.length > 5 && (
                  <Button variant="outline" size="sm" className="mt-2 w-full" onClick={() => router.push('/admin/codes')}>
                    View codes & redemptions
                  </Button>
                )}
              </div>
            ) : (
              <p className="py-8 text-center text-muted-foreground">No redemptions yet</p>
            )}
          </CardContent>
        </Card>

        <Card className="border-border bg-card">
          <CardHeader>
            <CardTitle>Quick Actions</CardTitle>
            <CardDescription>Common admin tasks</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <Button className="w-full justify-start" variant="outline" onClick={() => router.push('/admin/uploads')}>
              Upload New Codes
            </Button>
            <Button className="w-full justify-start" variant="outline" onClick={() => router.push('/admin/uploads')}>
              Upload Attendee List
            </Button>
            <Button className="w-full justify-start" variant="outline" onClick={() => router.push('/admin/codes')}>
              View All Codes
            </Button>
            <Button className="w-full justify-start" variant="outline" onClick={openTestRedeem}>
              Test redemption flow
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function StatsCard({
  title,
  value,
  description,
  progress,
}: {
  title: string;
  value: number;
  description: string;
  progress?: number;
}) {
  return (
    <Card className="border-border bg-card">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold tabular-nums text-foreground">{value.toLocaleString()}</div>
        <p className="text-xs text-muted-foreground">{description}</p>
        {progress !== undefined && (
          <div className="mt-2">
            <div className="h-2 w-full rounded-full bg-muted">
              <div
                className="h-2 rounded-full bg-primary transition-all duration-300"
                style={{ width: `${Math.min(progress, 100)}%` }}
              />
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
