/**
 * Authentication routes: /api/auth/*.
 *
 *   POST /api/auth/login      { email, password } → session cookie
 *   POST /api/auth/logout     clears the session
 *   POST /api/auth/logout-all revokes every session for the account
 *   GET  /api/auth/me         current user (null when signed out)
 *   GET  /api/auth/users      admin: list accounts
 *   POST /api/auth/users      admin: create an account (invite flow)
 *   POST /api/auth/users/:id/role  admin: change a role
 *   POST /api/auth/password   change own password
 *
 * Login is rate limited per IP, audit-logged, and never reveals whether an
 * account exists. Passwords follow the same validation on both ends.
 */

import { Router } from 'express';
import type { Request, RequestHandler, Response } from 'express';

import * as auth from './auth.js';
import { audit } from './auth.js';
import { reportError } from './monitoring.js';
import * as rateLimiters from './ratelimit.js';
import { parsePagination } from './validation.js';
import { sendVerificationEmail } from './notify.js';

export const authRouter = Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_NAME = 80;

/**
 * Auth throttles are stored in MongoDB (server/ratelimit.ts) rather than
 * process memory, so they hold across serverless instances and restarts
 * exactly like the general API rate limiter.
 *
 * Unlike the general API limiter — which fails open to preserve availability
 * during a store outage — auth gates FAIL CLOSED (PRD-003): on a store error
 * the attempt is refused with 503 and the outage is reported. A database
 * blip must never silently disable brute-force protection.
 */
const EMAIL_CODE_WINDOW_MS = 60_000;
const LOGIN_WINDOW_MS = 10 * 60_000;
const LOGIN_MAX_FAILURES = 8;
// PRD-005: every credential-guessing surface gets its own budget.
const VERIFY_WINDOW_MS = 10 * 60_000;
const VERIFY_MAX_ATTEMPTS = 20;
const GOOGLE_WINDOW_MS = 10 * 60_000;
const GOOGLE_MAX_ATTEMPTS = 30;
const PASSWORD_WINDOW_MS = 10 * 60_000;
const PASSWORD_MAX_ATTEMPTS = 10;

/** 503 when the throttle store itself is unavailable (fail closed). */
function throttleUnavailable(res: Response): void {
  res.setHeader('Retry-After', '60');
  res.status(503).json({ error: 'Authentication service is temporarily unavailable. Try again shortly.' });
}

async function reportThrottleOutage(key: string, error: unknown): Promise<void> {
  try {
    await reportError('auth-throttle', error, { key });
  } catch {
    /* reporting must never break the auth path */
  }
}

/**
 * Shared gate: refuses with 429 once the budget for `key` is spent, or 503
 * when the counter store is unreachable. Returns true when the attempt may
 * proceed. Callers record the outcome with recordThrottleHit/clearThrottle.
 */
async function throttleGate(
  res: Response,
  key: string,
  max: number,
  windowMs: number,
  message: string,
): Promise<boolean> {
  let count: number;
  try {
    count = await rateLimiters.readCounter(key, windowMs);
  } catch (error) {
    await reportThrottleOutage(key, error);
    throttleUnavailable(res);
    return false;
  }
  if (count >= max) {
    res.setHeader('Retry-After', '60');
    res.status(429).json({ error: message });
    return false;
  }
  return true;
}

/** Records a failed attempt; a store outage is reported but never blocks. */
async function recordThrottleHit(key: string, windowMs: number): Promise<void> {
  try {
    await rateLimiters.bumpCounter(key, windowMs);
  } catch (error) {
    await reportThrottleOutage(key, error);
  }
}

/** Clears the budget after a successful attempt; never blocks on outage. */
async function clearThrottle(key: string, windowMs: number): Promise<void> {
  try {
    await rateLimiters.resetCounter(key, windowMs);
  } catch (error) {
    await reportThrottleOutage(key, error);
  }
}

function loginKey(req: Request, email: string): string {
  return `login|${req.ip ?? 'unknown'}|${email.trim().toLowerCase()}`;
}

async function emailThrottle(req: Request, res: Response, email: string): Promise<boolean> {
  const key = `emailcode|${email}`;
  if (
    !(await throttleGate(
      res,
      key,
      1,
      EMAIL_CODE_WINDOW_MS,
      'Please wait a minute before requesting another verification code.',
    ))
  )
    return false;
  try {
    await rateLimiters.bumpCounter(key, EMAIL_CODE_WINDOW_MS);
  } catch (error) {
    await reportThrottleOutage(key, error);
    throttleUnavailable(res);
    return false;
  }
  return true;
}

/** Blocks a sign-in attempt once the failure budget for IP+email is spent. */
async function loginThrottle(req: Request, res: Response, email: string): Promise<boolean> {
  return throttleGate(
    res,
    loginKey(req, email),
    LOGIN_MAX_FAILURES,
    LOGIN_WINDOW_MS,
    'Too many sign-in attempts. Try again shortly.',
  );
}

async function recordFailure(req: Request, email: string): Promise<void> {
  await recordThrottleHit(loginKey(req, email), LOGIN_WINDOW_MS);
}

async function clearFailures(req: Request, email: string): Promise<void> {
  await clearThrottle(loginKey(req, email), LOGIN_WINDOW_MS);
}

function readBody(body: unknown): Record<string, unknown> {
  return body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

function cleanEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase();
  return trimmed.length <= 200 && EMAIL_RE.test(trimmed) ? trimmed : null;
}

function cleanPassword(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return value.length >= 12 && value.length <= 200 ? value : null;
}

function cleanName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= MAX_NAME ? trimmed : null;
}

/** Wraps async handlers on the router. */
const wrap =
  (handler: (req: Request, res: Response) => Promise<unknown>): RequestHandler =>
  (req, res, next) => {
    handler(req, res).catch(next);
  };

authRouter.post(
  '/login',
  wrap(async (req, res) => {
    const body = readBody(req.body);
    const email = cleanEmail(body.email);
    const password = typeof body.password === 'string' ? body.password : '';

    if (!email || !password) {
      res.status(400).json({ error: 'Enter a valid email and password.' });
      return;
    }
    if (!(await loginThrottle(req, res, email))) return;

    const user = await auth.authenticate(email, password);
    if (!user) {
      await recordFailure(req, email);
      await audit(req, 'auth.login_failed', email);
      res.status(401).json({ error: 'Incorrect email or password.' });
      return;
    }

    await clearFailures(req, email);
    const session = await auth.createSession(user.id, req.get('user-agent') ?? null);
    auth.setSessionCookie(req, res, session.token);
    await audit(req, 'auth.login', user.email);
    res.json({ user, csrfToken: session.csrfToken });
  }),
);

authRouter.post(
  '/logout',
  wrap(async (req, res) => {
    const token = req
      .get('cookie')
      ?.split(';')
      .find((part) => part.trim().startsWith(`${auth.SESSION_COOKIE}=`));
    if (token) {
      const raw = decodeURIComponent(token.split('=').slice(1).join('='));
      await auth.destroySession(raw);
    }
    auth.clearSessionCookie(req, res);
    if (req.user) await audit(req, 'auth.logout', req.user.email);
    res.json({ ok: true });
  }),
);

authRouter.post(
  '/logout-all',
  auth.requireAuth,
  wrap(async (req, res) => {
    // PRD-004: revokes every session for this account, including the current
    // one — the escape hatch when a session may be compromised.
    if (!req.user) return;
    const revoked = await auth.destroyUserSessions(req.user.id);
    auth.clearSessionCookie(req, res);
    await audit(req, 'auth.logout_all', req.user.email, { revoked });
    res.json({ ok: true, revoked });
  }),
);

authRouter.get(
  '/me',
  wrap(async (req, res) => {
    // Session-authenticated clients need the per-session CSRF token for
    // state-changing requests (see requireCsrf); it is readable here because
    // only the session owner can call /me.
    const csrfToken =
      req.authMethod === 'session'
        ? await auth.sessionCsrfToken(auth.sessionTokenFromCookie(req) ?? '')
        : null;
    res.json({ user: req.user ?? null, csrfToken });
  }),
);

authRouter.get(
  '/config',
  wrap(async (_req, res) => {
    res.json({
      googleClientId: (process.env.GOOGLE_CLIENT_ID ?? '').trim() || null,
      emailVerification: true,
    });
  }),
);

authRouter.post(
  '/email/send-code',
  wrap(async (req, res) => {
    const body = readBody(req.body);
    const email = cleanEmail(body.email);
    if (!email) {
      res.status(400).json({ error: 'Enter a valid email address.' });
      return;
    }

    if (!(await emailThrottle(req, res, email))) return;

    const { code, token } = await auth.createEmailVerification(email);

    // Build magic link for browser convenience
    const origin = (req.get('origin') ?? `${req.protocol}://${req.get('host') ?? '127.0.0.1:3000'}`).replace(
      /\/+$/,
      '',
    );
    const magicLink = `${origin}/app?verify_token=${token}&email=${encodeURIComponent(email)}`;

    await sendVerificationEmail(email, code, magicLink);
    await audit(req, 'auth.email_code_sent', email);

    // Dev-only escape hatch: return the code/token ONLY when the operator
    // explicitly opts in AND the caller is on loopback. Never key this off
    // NODE_ENV or the absence of an email provider — a misconfigured public
    // deployment would hand out account access to anyone who asks.
    const exposeDebugSecrets =
      process.env.ALLOW_AUTH_DEBUG_CODE === 'true' &&
      process.env.NODE_ENV !== 'production' &&
      auth.isLoopbackRequest(req);
    res.json({
      ok: true,
      message: 'Verification code sent to your email.',
      ...(exposeDebugSecrets ? { debugCode: code, debugToken: token } : {}),
    });
  }),
);

authRouter.post(
  '/email/verify',
  wrap(async (req, res) => {
    const body = readBody(req.body);
    const email = cleanEmail(body.email);
    const code = typeof body.code === 'string' ? body.code.trim() : '';
    const token = typeof body.token === 'string' ? body.token.trim() : '';

    if (!email) {
      res.status(400).json({ error: 'Email address is required.' });
      return;
    }

    // PRD-005: the per-code 5-guess delete (server/auth.ts) is not enough on
    // its own — fresh codes can be requested every minute — so guess attempts
    // are additionally budgeted per IP+email.
    const verifyKey = `verify|${req.ip ?? 'unknown'}|${email}`;
    if (
      !(await throttleGate(
        res,
        verifyKey,
        VERIFY_MAX_ATTEMPTS,
        VERIFY_WINDOW_MS,
        'Too many verification attempts. Try again shortly.',
      ))
    )
      return;

    let verified = false;
    if (token) {
      const tokenEmail = await auth.verifyEmailToken(token);
      verified = tokenEmail !== null && tokenEmail === email;
    } else if (code) {
      verified = await auth.verifyEmailCode(email, code);
    } else {
      res.status(400).json({ error: 'Verification code or token is required.' });
      return;
    }

    if (!verified) {
      await recordThrottleHit(verifyKey, VERIFY_WINDOW_MS);
      await audit(req, 'auth.email_verify_failed', email);
      res.status(401).json({ error: 'Invalid or expired verification code.' });
      return;
    }
    await clearThrottle(verifyKey, VERIFY_WINDOW_MS);

    const user = await auth.findOrCreateUserByEmail(email);
    const session = await auth.createSession(user.id, req.get('user-agent') ?? null);
    auth.setSessionCookie(req, res, session.token);
    await audit(req, 'auth.email_verified_login', user.email);
    res.json({ user, csrfToken: session.csrfToken });
  }),
);

authRouter.post(
  '/google',
  wrap(async (req, res) => {
    const body = readBody(req.body);
    const credential = typeof body.credential === 'string' ? body.credential.trim() : '';
    if (!credential) {
      res.status(400).json({ error: 'Google credential is required.' });
      return;
    }

    // PRD-005: each attempt costs an outbound Google verification call, so
    // the endpoint is budgeted per IP like the other auth gates.
    const googleKey = `google|${req.ip ?? 'unknown'}`;
    if (
      !(await throttleGate(
        res,
        googleKey,
        GOOGLE_MAX_ATTEMPTS,
        GOOGLE_WINDOW_MS,
        'Too many sign-in attempts. Try again shortly.',
      ))
    )
      return;

    const googleUser = await auth.verifyGoogleIdToken(credential);
    if (!googleUser || !googleUser.email) {
      await recordThrottleHit(googleKey, GOOGLE_WINDOW_MS);
      res.status(401).json({ error: 'Google authentication failed or email unverified.' });
      return;
    }
    await clearThrottle(googleKey, GOOGLE_WINDOW_MS);

    const user = await auth.findOrCreateUserByEmail(googleUser.email, googleUser.name);
    const session = await auth.createSession(user.id, req.get('user-agent') ?? null);
    auth.setSessionCookie(req, res, session.token);
    await audit(req, 'auth.google_login', user.email);
    res.json({ user, csrfToken: session.csrfToken });
  }),
);

authRouter.get(
  '/users',
  auth.requireRole('admin'),
  wrap(async (req, res) => {
    // PRD-009: previously unsliced.
    const { limit, offset } = parsePagination(req.query, { limit: 200, max: 500 });
    res.json(await auth.listUsers({ limit, offset }));
  }),
);

authRouter.post(
  '/users',
  auth.requireRole('admin'),
  wrap(async (req, res) => {
    const body = readBody(req.body);
    const email = cleanEmail(body.email);
    const name = cleanName(body.name);
    const password = cleanPassword(body.password);
    const role = body.role === 'agent' ? 'agent' : body.role === 'admin' ? 'admin' : null;

    if (!email || !name || !password || !role) {
      res.status(400).json({
        error:
          'email (valid), name (1-80 chars), password (12-200 chars) and role (admin|agent) are required.',
      });
      return;
    }
    if (await auth.findUserByEmail(email)) {
      res.status(409).json({ error: 'An account with this email already exists.' });
      return;
    }

    const user = await auth.createUser({
      email,
      name,
      role,
      password,
      invitedBy: req.user?.id ?? null,
    });
    await audit(req, 'auth.user_created', email, { role });
    res.status(201).json(user);
  }),
);

authRouter.post(
  '/users/:id/role',
  auth.requireRole('admin'),
  wrap(async (req, res) => {
    const targetId = req.params.id;
    const role = req.body?.role === 'admin' ? 'admin' : req.body?.role === 'agent' ? 'agent' : null;
    if (!role) {
      res.status(400).json({ error: 'role must be admin or agent.' });
      return;
    }
    if (!req.user) return;
    if (req.user.id === targetId) {
      res.status(400).json({ error: 'Role not changed. You cannot change your own role.' });
      return;
    }
    const changed = await auth.setUserRole(req.user, targetId, role);
    if (!changed) {
      res.status(404).json({ error: 'User not found.' });
      return;
    }
    await audit(req, 'auth.role_changed', targetId, { role });
    res.json({ ok: true });
  }),
);

authRouter.post(
  '/password',
  auth.requireAuth,
  wrap(async (req, res) => {
    const body = readBody(req.body);
    const current = typeof body.currentPassword === 'string' ? body.currentPassword : '';
    const next = cleanPassword(body.newPassword);
    if (!next) {
      res.status(400).json({ error: 'New password must be 12-200 characters.' });
      return;
    }
    if (!req.user) return;
    // PRD-005: password guessing against an authenticated session is still
    // budgeted per account, so a stolen session cannot be used to probe the
    // current password without limit.
    const passwordKey = `password|${req.user.id}`;
    if (
      !(await throttleGate(
        res,
        passwordKey,
        PASSWORD_MAX_ATTEMPTS,
        PASSWORD_WINDOW_MS,
        'Too many password attempts. Try again shortly.',
      ))
    )
      return;
    const changed = await auth.changePassword(req.user.id, current, next);
    if (!changed) {
      await recordThrottleHit(passwordKey, PASSWORD_WINDOW_MS);
      res.status(400).json({ error: 'Current password is incorrect.' });
      return;
    }
    await clearThrottle(passwordKey, PASSWORD_WINDOW_MS);
    // PRD-004: a password change ends every other session for this account so
    // a stolen session does not survive the victim's reset. The session that
    // performed the change stays valid.
    await auth.destroyUserSessions(req.user.id, auth.sessionTokenFromCookie(req) ?? undefined);
    await audit(req, 'auth.password_changed', req.user.email);
    res.json({ ok: true });
  }),
);
