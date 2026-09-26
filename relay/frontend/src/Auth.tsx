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
import { Loader2, LogOut, Mail, RefreshCw, ShieldCheck } from 'lucide-react';

declare global {
  interface Window {
    google?: {
      accounts: {
        id: {
          initialize: (config: { client_id: string; callback: (res: { credential: string }) => void }) => void;
          prompt: () => void;
          renderButton: (element: HTMLElement, options: Record<string, unknown>) => void;
        };
      };
    };
  }
}

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
  const [tab, setTab] = useState<'email-code' | 'password'>('email-code');
  const [step, setStep] = useState<'input' | 'verify'>('input');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [googleClientId, setGoogleClientId] = useState<string | null>(null);

  // Check for configuration on mount
  useEffect(() => {
    let cancelled = false;
    authApi.getConfig().then((cfg) => {
      if (!cancelled) setGoogleClientId(cfg.googleClientId);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // Check for magic link verify_token in URL query params on mount
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    const verifyToken = params.get('verify_token');
    const paramEmail = params.get('email');
    if (verifyToken && paramEmail) {
      setBusy(true);
      setError(null);
      authApi.verifyEmail(paramEmail, undefined, verifyToken)
        .then(({ user }) => {
          const cleanUrl = window.location.pathname;
          window.history.replaceState(null, '', cleanUrl);
          onLoggedIn(user);
        })
        .catch((err) => {
          setError(err instanceof ApiError ? err.message : 'Invalid or expired magic sign-in link.');
          setBusy(false);
        });
    }
  }, [onLoggedIn]);

  // Load Google Identity Services script if googleClientId is configured
  useEffect(() => {
    if (!googleClientId) return;
    if (document.getElementById('google-gsi-client')) return;
    const script = document.createElement('script');
    script.id = 'google-gsi-client';
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.defer = true;
    script.onload = () => {
      if (window.google?.accounts?.id) {
        window.google.accounts.id.initialize({
          client_id: googleClientId,
          callback: (response: { credential: string }) => {
            setBusy(true);
            setError(null);
            authApi.loginWithGoogle(response.credential)
              .then(({ user }) => onLoggedIn(user))
              .catch((err) => {
                setError(err instanceof ApiError ? err.message : 'Google sign-in failed.');
                setBusy(false);
              });
          },
        });
      }
    };
    document.head.appendChild(script);
  }, [googleClientId, onLoggedIn]);

  const handleGoogleClick = () => {
    setError(null);
    if (!googleClientId) {
      setError('Google Sign-In requires GOOGLE_CLIENT_ID in your environment variables. Sign in with Email Verification below.');
      return;
    }
    if (window.google?.accounts?.id) {
      window.google.accounts.id.prompt();
    } else {
      setError('Google Sign-In is still loading. Please try again in a second.');
    }
  };

  // Submit Password Form
  const submitPassword = async (event: FormEvent) => {
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

  // Step 1: Send verification code to email
  const handleSendCode = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = email.trim();
    if (!trimmed || !trimmed.includes('@')) {
      setError('Enter a valid email address.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await authApi.sendEmailCode(trimmed);
      setStep('verify');
      const devNote = res.debugCode ? ` (Dev code: ${res.debugCode})` : '';
      setInfo(`We sent a 6-digit code to ${trimmed}.${devNote}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not send verification code. Try again.');
    } finally {
      setBusy(false);
    }
  };

  // Step 2: Verify code and sign in
  const handleVerifyCode = async (event: FormEvent) => {
    event.preventDefault();
    const trimmedCode = code.trim();
    if (!trimmedCode || trimmedCode.length < 6) {
      setError('Enter the 6-digit code sent to your email.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { user } = await authApi.verifyEmail(email.trim(), trimmedCode);
      onLoggedIn(user);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Invalid or expired verification code.');
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

        {/* Google Sign-In Button */}
        <button
          type="button"
          className="btn-google"
          onClick={handleGoogleClick}
          disabled={busy}
          aria-label="Continue with Google"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
            <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
            <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
            <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z" />
            <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z" />
          </svg>
          Continue with Google
        </button>

        <div className="auth-divider">
          <span>or sign in with email</span>
        </div>

        {/* Tab switch between Email code (passwordless) and Password */}
        <div className="auth-tabs" role="tablist">
          <button
            type="button"
            className={`auth-tab${tab === 'email-code' ? ' active' : ''}`}
            onClick={() => { setTab('email-code'); setError(null); }}
            role="tab"
            aria-selected={tab === 'email-code'}
          >
            Email code
          </button>
          <button
            type="button"
            className={`auth-tab${tab === 'password' ? ' active' : ''}`}
            onClick={() => { setTab('password'); setError(null); }}
            role="tab"
            aria-selected={tab === 'password'}
          >
            Password
          </button>
        </div>

        {/* Mode A: Email Verification Code (Passwordless) */}
        {tab === 'email-code' ? (
          step === 'input' ? (
            <form onSubmit={handleSendCode} noValidate>
              <label className="field">
                <span className="label">Work Email</span>
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

              {error ? (
                <p className="note auth-error" role="alert" style={{ color: 'var(--danger)' }}>
                  {error}
                </p>
              ) : null}

              <button className="btn btn-primary auth-submit" type="submit" disabled={busy}>
                {busy ? <Loader2 size={15} className="spin" aria-hidden="true" /> : <Mail size={15} aria-hidden="true" />}
                Send verification code
              </button>
            </form>
          ) : (
            <form onSubmit={handleVerifyCode} noValidate>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                <span style={{ fontSize: 13, color: 'var(--muted)' }}>Signing in as <strong>{email}</strong></span>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  style={{ padding: '2px 6px', fontSize: 12 }}
                  onClick={() => { setStep('input'); setCode(''); setError(null); setInfo(null); }}
                >
                  Change
                </button>
              </div>

              {info ? (
                <p className="note" style={{ color: 'var(--primary, #4f46e5)', background: 'rgba(79, 70, 229, 0.08)', padding: '8px 12px', borderRadius: 8, margin: '6px 0 12px', fontSize: 12.5 }}>
                  {info}
                </p>
              ) : null}

              <label className="field">
                <span className="label">6-digit Verification Code</span>
                <input
                  className="input auth-otp-input"
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  autoComplete="one-time-code"
                  autoFocus
                  maxLength={6}
                  value={code}
                  onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
                  placeholder="123456"
                />
              </label>

              {error ? (
                <p className="note auth-error" role="alert" style={{ color: 'var(--danger)' }}>
                  {error}
                </p>
              ) : null}

              <button className="btn btn-primary auth-submit" type="submit" disabled={busy || code.length < 6}>
                {busy ? <Loader2 size={15} className="spin" aria-hidden="true" /> : <ShieldCheck size={15} aria-hidden="true" />}
                Verify &amp; Sign in
              </button>

              <div style={{ display: 'flex', justifyContent: 'center', marginTop: 12 }}>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  disabled={busy}
                  onClick={(e) => handleSendCode(e)}
                  style={{ fontSize: 12.5 }}
                >
                  <RefreshCw size={13} aria-hidden="true" /> Resend code
                </button>
              </div>
            </form>
          )
        ) : (
          /* Mode B: Password Sign In */
          <form onSubmit={submitPassword} noValidate>
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
              Sign in with password
            </button>
          </form>
        )}

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
