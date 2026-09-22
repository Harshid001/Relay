/**
 * Admin authentication UI.
 *
 * - useSession(): resolves the current user from GET /api/auth/me once and
 *   exposes sign-in/sign-out; the workspace renders a login screen while
 *   signed out (legacy token mode still works server-side when no accounts
 *   exist, so the token modal remains as a fallback path).
 * - LoginPage: standalone email/password form with inline validation and
 *   error display, matching the workspace design system.
 */

import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { Loader2, LogOut, ShieldCheck } from 'lucide-react';

import { ApiError, authApi } from './service-api';
import type { SessionUser } from './service-api';

export type SessionState =
  | { status: 'loading' }
  | { status: 'signed-out' }
  | { status: 'signed-in'; user: SessionUser };

/** Resolves the cookie session once on mount. */
export function useSession(): {
  session: SessionState;
  signIn: (user: SessionUser) => void;
  signOut: () => Promise<void>;
} {
  const [session, setSession] = useState<SessionState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    authApi
      .me()
      .then(({ user }) => {
        if (!cancelled) setSession(user ? { status: 'signed-in', user } : { status: 'signed-out' });
      })
      .catch(() => {
        if (!cancelled) setSession({ status: 'signed-out' });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const signIn = useCallback((user: SessionUser) => {
    setSession({ status: 'signed-in', user });
  }, []);

  const signOut = useCallback(async () => {
    try {
      await authApi.logout();
    } catch {
      /* clearing locally regardless */
    }
    setSession({ status: 'signed-out' });
  }, []);

  return { session, signIn, signOut };
}

export function LoginPage({
  onLoggedIn,
  onUseLegacyToken,
  legacyAvailable,
}: {
  onLoggedIn: (user: SessionUser) => void;
  onUseLegacyToken?: () => void;
  legacyAvailable?: boolean;
}) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = email.trim();
    if (!trimmed || !password) {
      setError('Enter your email and password.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { user } = await authApi.login(trimmed, password);
      onLoggedIn(user);
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 401
          ? 'Incorrect email or password.'
          : err instanceof ApiError && err.status === 429
            ? 'Too many attempts — wait a moment and try again.'
            : err instanceof ApiError
              ? err.message
              : 'Sign-in failed. Check that the server is running.',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-shell" role="main">
      <div className="auth-card">
        <div className="auth-brand">
          <svg viewBox="0 0 32 32" width="34" height="34" aria-hidden="true">
            <rect x="1.5" y="1.5" width="29" height="29" rx="8" fill="var(--brand, #4f46e5)" />
            <path
              d="M9 20.5 16 9l7 11.5h-4.2L16 15.8l-2.8 4.7H9Z"
              fill="#fff"
            />
          </svg>
          <span className="brand-word">relay</span>
        </div>
        <h1 className="auth-title">Sign in to the workspace</h1>
        <p className="auth-sub">Agent console for the Relay support assistant.</p>

        <form onSubmit={submit} noValidate>
          <label className="field">
            <span className="label">Email</span>
            <input
              className="input"
              type="email"
              autoComplete="email"
              autoFocus
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="you@company.com"
            />
          </label>
          <label className="field">
            <span className="label">Password</span>
            <input
              className="input"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="••••••••••••"
            />
          </label>

          {error ? (
            <p className="note auth-error" role="alert" style={{ color: 'var(--danger)' }}>
              {error}
            </p>
          ) : null}

          <button className="btn btn-primary auth-submit" type="submit" disabled={busy}>
            {busy ? <Loader2 size={15} className="spin" aria-hidden="true" /> : <ShieldCheck size={15} aria-hidden="true" />}
            Sign in
          </button>
        </form>

        {legacyAvailable && onUseLegacyToken ? (
          <button type="button" className="btn btn-ghost auth-legacy" onClick={onUseLegacyToken}>
            Use an admin token instead
          </button>
        ) : null}
      </div>
    </div>
  );
}

/** Sidebar account card showing the signed-in user with a sign-out action. */
export function AccountCard({ user, onSignOut }: { user: SessionUser; onSignOut: () => void }) {
  const initials = user.name
    .split(/\s+/)
    .map((part) => part[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase();

  return (
    <div className="agent-card">
      <span className="agent-avatar" aria-hidden="true">{initials || '?'}</span>
      <div className="workspace-meta">
        <div className="agent-name">{user.name}</div>
        <div className="agent-role">{user.role === 'admin' ? 'Administrator' : 'Support agent'}</div>
      </div>
      <button
        type="button"
        className="icon-btn"
        title="Sign out"
        aria-label="Sign out"
        onClick={() => void onSignOut()}
      >
        <LogOut size={14} aria-hidden="true" />
      </button>
    </div>
  );
}
