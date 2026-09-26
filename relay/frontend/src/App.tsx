/**
 * Relay frontend root: landing page, customer chat and admin workspace.
 *
 * Routing (client-side, pushState):
 *   /            → marketing landing page
 *   /chat        → customer chat (also kept: /?view=chat for old links)
 *   /app         → admin workspace (session-gated)
 */

import { Suspense, lazy, useCallback, useEffect, useMemo, useState } from 'react';

import { LoginPage, useSession } from './Auth';
import ErrorBoundary from './ErrorBoundary';
import Landing from './Landing';
import { Spinner } from './ui/shared';

/**
 * Route-level code splitting: the landing page (first paint for every
 * visitor) ships without the chat or admin workspace bundles. Each surface
 * loads on demand when its route is entered.
 */
const CustomerCenter = lazy(() => import('./customer/CustomerCenter'));
const AdminApp = lazy(() => import('./admin/AdminApp'));

function RouteFallback({ label }: { label: string }) {
  return (
    <div className="auth-shell" role="status" aria-live="polite">
      <div className="auth-card" style={{ alignItems: 'center', textAlign: 'center' }}>
        <div className="loading-block"><Spinner />Loading {label}…</div>
      </div>
    </div>
  );
}

type Route =
  | { view: 'landing' }
  | { view: 'workspace' }
  | { view: 'chat'; fresh: boolean };

function parseRoute(): Route {
  if (typeof window === 'undefined') return { view: 'landing' };
  const path = window.location.pathname.replace(/\/+$/, '') || '/';
  const params = new URLSearchParams(window.location.search);

  if (path === '/chat' || params.get('view') === 'chat') {
    return { view: 'chat', fresh: params.get('new') === '1' };
  }
  if (path === '/app') return { view: 'workspace' };
  return { view: 'landing' };
}

export default function App() {
  const [route, setRoute] = useState<Route>(parseRoute);

  useEffect(() => {
    const onPop = () => setRoute(parseRoute());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const go = useCallback((url: string) => {
    window.history.pushState(null, '', url);
    setRoute(parseRoute());
    window.scrollTo(0, 0);
  }, []);

  return (
    <ErrorBoundary>
      {route.view === 'chat' ? (
        <Suspense fallback={<RouteFallback label="the chat" />}>
          <CustomerCenter fresh={route.fresh} onExit={() => go('/')} />
        </Suspense>
      ) : route.view === 'workspace' ? (
        <WorkspaceRoot onPreviewChat={() => go('/chat')} onNewConversation={() => go('/chat?new=1')} />
      ) : (
        <Landing
          onOpenWorkspace={() => go('/app')}
          onOpenChat={() => go('/chat')}
        />
      )}
    </ErrorBoundary>
  );
}

/**
 * Workspace entry: resolves the cookie session, shows the login page while
 * signed out, and renders the admin app when a user (or the legacy token
 * path) is available.
 */
function WorkspaceRoot({ onPreviewChat, onNewConversation }: {
  onPreviewChat: () => void;
  onNewConversation: () => void;
}) {
  const { session, signIn, signOut } = useSession();
  const [legacyMode, setLegacyMode] = useState(false);

  const legacyAvailable = useMemo(() => {
    try {
      return Boolean(sessionStorage.getItem('relay-admin-token'));
    } catch {
      return false;
    }
  }, []);

  if (session.status === 'loading') {
    return (
      <div className="auth-shell" role="status" aria-live="polite">
        <div className="auth-card" style={{ alignItems: 'center', textAlign: 'center' }}>
          <div className="loading-block"><Spinner />Checking your session…</div>
        </div>
      </div>
    );
  }

  if (session.status === 'signed-out' && !legacyMode) {
    return (
      <LoginPage
        onLoggedIn={signIn}
        legacyAvailable={legacyAvailable}
        onUseLegacyToken={() => setLegacyMode(true)}
      />
    );
  }

  return (
    <Suspense fallback={<RouteFallback label="the workspace" />}>
      <ErrorBoundary>
        <AdminApp
          session={session.status === 'signed-in' ? session.user : null}
          onSignOut={signOut}
          onPreviewChat={onPreviewChat}
          onNewConversation={onNewConversation}
        />
      </ErrorBoundary>
    </Suspense>
  );
}
