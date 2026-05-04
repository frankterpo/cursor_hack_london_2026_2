'use client';

import { useEffect, useState } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import Link from 'next/link';

interface SelectedProject {
  id: string;
  name: string;
  slug: string;
}

export default function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [selectedProject, setSelectedProject] = useState<SelectedProject | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const router = useRouter();
  const pathname = usePathname();
  const normalizedPathname = pathname.replace(/^\/credits(?=\/|$)/, '') || '/';

  useEffect(() => {
    const checkAuth = () => {
      const authenticated = localStorage.getItem('admin_authenticated') === 'true';
      setIsAuthenticated(authenticated);

      const projectData = localStorage.getItem('admin_selected_project');
      if (projectData) {
        try {
          setSelectedProject(JSON.parse(projectData));
        } catch {
          localStorage.removeItem('admin_selected_project');
          setSelectedProject(null);
        }
      }

      setIsLoading(false);

      if (!authenticated && normalizedPathname !== '/admin') {
        router.push('/admin');
      } else if (authenticated && !projectData && normalizedPathname !== '/admin' && normalizedPathname !== '/admin/projects') {
        router.push('/admin/projects');
      }
    };

    checkAuth();
  }, [router, normalizedPathname]);

  const handleLogout = () => {
    localStorage.removeItem('admin_authenticated');
    localStorage.removeItem('admin_selected_project');
    setIsAuthenticated(false);
    setSelectedProject(null);
    router.push('/admin');
  };

  const handleProjectSwitch = () => {
    router.push('/admin/projects');
  };

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <div className="text-center">
          <div className="mx-auto h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          <p className="mt-4 text-sm text-muted-foreground">Loading…</p>
        </div>
      </div>
    );
  }

  if (!isAuthenticated || normalizedPathname === '/admin') {
    return children;
  }

  if (normalizedPathname === '/admin/projects') {
    return children;
  }

  if (!selectedProject) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background px-4">
        <div className="panel-event max-w-md text-center">
          <h2 className="font-display text-lg font-semibold text-foreground">No project selected</h2>
          <p className="mt-2 text-sm text-muted-foreground">Select a credits project to continue.</p>
          <button type="button" onClick={handleProjectSwitch} className="btn-event-primary mt-6">
            Select project
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border bg-card/80 backdrop-blur-sm">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-4 px-4 py-4 sm:px-6 lg:px-8">
          <div>
            <h1 className="font-display text-sm font-semibold text-primary">Credits admin</h1>
            {selectedProject && <p className="mt-0.5 text-sm text-muted-foreground">{selectedProject.name}</p>}
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={handleProjectSwitch} className="btn-event-ghost text-xs">
              Switch project
            </button>
            <Link href={`/event/${selectedProject.slug}/redeem`} className="btn-event-ghost text-xs">
              Public redeem
            </Link>
            <button type="button" onClick={handleLogout} className="btn-event-ghost text-xs">
              Logout
            </button>
          </div>
        </div>
      </header>

      <nav className="border-b border-border bg-card/40">
        <div className="mx-auto flex max-w-7xl gap-1 px-4 sm:px-6 lg:px-8">
          {[
            { href: '/admin/dashboard', label: 'Dashboard' },
            { href: '/admin/codes', label: 'Codes' },
            { href: '/admin/attendees', label: 'Attendees' },
            { href: '/admin/uploads', label: 'Upload' },
          ].map(({ href, label }) => (
            <button
              key={href}
              type="button"
              onClick={() => router.push(href)}
              className={`border-b-2 px-3 py-3 text-sm transition-colors ${
                normalizedPathname === href
                  ? 'border-primary font-medium text-primary'
                  : 'border-transparent text-muted-foreground hover:text-foreground'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </nav>

      <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">{children}</main>
    </div>
  );
}
