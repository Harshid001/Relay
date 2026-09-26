/**
 * Authentication, sessions and RBAC.
 *
 * - Passwords: scrypt (node:crypto) with per-user random salt and
 *   constant-time comparison. No external dependency.
 * - Sessions: opaque 256-bit tokens stored hashed in MongoDB with a TTL index
 *   (30 days). Cookies are httpOnly + SameSite=Lax; `secure` is enabled when
 *   the request arrived over HTTPS (set TRUST_PROXY=1 behind a TLS proxy).
 * - Roles: 'admin' > 'agent'. Admin-only: user invites, FAQ writes, role
 *   changes, resolve. Agents: queue work, replies, assignment, escalation view.
 * - Audit: role-protected mutations append an audit_events document.
 *
 * Backward compatibility: when no users exist yet, the legacy single-token
 * admin mode still works (see requireUser), so existing deployments and the
 * seeded demo keep functioning until the first admin is provisioned.
 */

import crypto from 'node:crypto';
import type { Collection, Db, WithId } from 'mongodb';
import type { NextFunction, Request, RequestHandler, Response } from 'express';

import { getDb, newId } from './db.js';

export type Role = 'admin' | 'agent';

export const SESSION_COOKIE = 'relay_session';
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

export interface UserDoc {
  _id: string;
  email: string;
  name: string;
  role: Role;
  password_hash: string;
  password_salt: string;
  invited_by: string | null;
  created_at: string;
  last_login_at: string | null;
}

export interface SessionDoc {
  _id: string; // sha256 of the raw token
  user_id: string;
  csrf_token: string; // per-session anti-CSRF token (see requireCsrf)
  created_at: Date;
  expires_at: Date;
  last_seen_at: Date;
  user_agent: string | null;
}

export interface AuditEventDoc {
  _id: string;
  at: string;
  actor_id: string | null;
  actor_email: string;
  action: string;
  target: string;
  details?: Record<string, unknown>;
  request_id: string | null;
  /** TTL anchor: audit trail is retained AUDIT_RETENTION_DAYS, then pruned. */
  expires_at: Date;
}

/** Audit trail retention. Long enough for annual reviews, bounded by TTL. */
export const AUDIT_RETENTION_DAYS = 365;

export interface EmailVerificationDoc {
  _id: string;
  email: string;
  code_hash: string;
  token: string;
  expires_at: Date;
  created_at: Date;
  attempts: number;
}

function users(): Collection<UserDoc> {
  return getDb().collection<UserDoc>('users');
}
function sessions(): Collection<SessionDoc> {
  return getDb().collection<SessionDoc>('sessions');
}
function auditEvents(): Collection<AuditEventDoc> {
  return getDb().collection<AuditEventDoc>('audit_events');
}
function emailVerifications(): Collection<EmailVerificationDoc> {
  return getDb().collection<EmailVerificationDoc>('email_verifications');
}

/* ------------------------------------------------------------------ *
 * Passwords
 * ------------------------------------------------------------------ */

export function hashPassword(password: string): { hash: string; salt: string } {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 }).toString('hex');
  return { hash, salt };
}

export function verifyPassword(password: string, salt: string, expectedHash: string): boolean {
  const candidate = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  const expected = Buffer.from(expectedHash, 'hex');
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

/* ------------------------------------------------------------------ *
 * Indexes + bootstrap
 * ------------------------------------------------------------------ */

export async function ensureAuthIndexes(db: Db): Promise<void> {
  await Promise.all([
    db.collection<UserDoc>('users').createIndex({ email: 1 }, { unique: true }),
    db.collection<SessionDoc>('sessions').createIndex({ user_id: 1 }),
    db.collection<SessionDoc>('sessions').createIndex(
      { expires_at: 1 },
      { expireAfterSeconds: 0 },
    ),
    db.collection<AuditEventDoc>('audit_events').createIndex({ at: -1 }),
    db.collection<AuditEventDoc>('audit_events').createIndex({ actor_id: 1, at: -1 }),
    // Retention: `at` is an ISO string (TTL needs a Date), so expiry hangs
    // off a dedicated anchor set at insert time.
    db.collection<AuditEventDoc>('audit_events').createIndex(
      { expires_at: 1 },
      { expireAfterSeconds: 0 },
    ),
    db.collection<EmailVerificationDoc>('email_verifications').createIndex(
      { expires_at: 1 },
      { expireAfterSeconds: 0 },
    ),
    db.collection<EmailVerificationDoc>('email_verifications').createIndex({ email: 1 }),
    db.collection<EmailVerificationDoc>('email_verifications').createIndex({ token: 1 }),
  ]);
}

/**
 * Provisions the first admin account from environment variables. If
 * BOOTSTRAP_ADMIN_EMAIL + BOOTSTRAP_ADMIN_PASSWORD are set and no users exist,
 * the account is created at startup. Nothing is logged about the password.
 */
export async function bootstrapAdminFromEnv(): Promise<void> {
  const email = (process.env.BOOTSTRAP_ADMIN_EMAIL ?? '').trim().toLowerCase();
  const password = process.env.BOOTSTRAP_ADMIN_PASSWORD ?? '';
  if (!email || !password) return;
  if (password.length < 12) {
    console.error('[relay] BOOTSTRAP_ADMIN_PASSWORD must be at least 12 characters; skipping bootstrap');
    return;
  }
  if ((await users().countDocuments()) > 0) return;

  const { hash, salt } = hashPassword(password);
  await users().insertOne({
    _id: newId(),
    email,
    name: (process.env.BOOTSTRAP_ADMIN_NAME ?? 'Admin').trim() || 'Admin',
    role: 'admin',
    password_hash: hash,
    password_salt: salt,
    invited_by: null,
    created_at: new Date().toISOString(),
    last_login_at: null,
  });
  cachedHasUsers = true;
  console.log(`[relay] bootstrapped admin account for ${email}`);
}

/* ------------------------------------------------------------------ *
 * Sessions
 * ------------------------------------------------------------------ */

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: Role;
}

function toSessionUser(user: WithId<UserDoc>): SessionUser {
  return { id: user._id, email: user.email, name: user.name, role: user.role };
}

function implicitAdmin(): SessionUser {
  return {
    id: 'legacy-admin',
    email: 'legacy-admin@local',
    name: 'Legacy admin',
    role: 'admin',
  };
}

export async function createSession(
  userId: string,
  userAgent: string | null,
): Promise<{ token: string; csrfToken: string }> {
  const token = crypto.randomBytes(32).toString('base64url');
  const tokenHash = crypto.createHash('sha256').update(token, 'utf8').digest('hex');
  const csrfToken = crypto.randomBytes(32).toString('base64url');
  const now = new Date();
  await sessions().insertOne({
    _id: tokenHash,
    user_id: userId,
    csrf_token: csrfToken,
    created_at: now,
    expires_at: new Date(now.getTime() + SESSION_TTL_SECONDS * 1000),
    last_seen_at: now,
    user_agent: userAgent?.slice(0, 200) ?? null,
  });
  return { token, csrfToken };
}

export async function destroySession(token: string): Promise<void> {
  const tokenHash = crypto.createHash('sha256').update(token, 'utf8').digest('hex');
  await sessions().deleteOne({ _id: tokenHash });
}

async function userForToken(token: string): Promise<SessionUser | null> {
  const tokenHash = crypto.createHash('sha256').update(token, 'utf8').digest('hex');
  const session = await sessions().findOne({ _id: tokenHash });
  if (!session) return null;
  if (session.expires_at.getTime() < Date.now()) {
    await sessions().deleteOne({ _id: tokenHash });
    return null;
  }
  const user = await users().findOne({ _id: session.user_id });
  if (!user) return null;
  // Sliding last-seen (not awaited: non-critical write).
  void sessions().updateOne({ _id: tokenHash }, { $set: { last_seen_at: new Date() } });
  return toSessionUser(user);
}

function sessionTokenFromRequest(req: Request): string | null {
  const cookieHeader = req.get('cookie');
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === SESSION_COOKIE) return decodeURIComponent(rest.join('='));
  }
  return null;
}

/** Public accessor for the raw session token in the request cookies. */
export function sessionTokenFromCookie(req: Request): string | null {
  return sessionTokenFromRequest(req);
}

function requestIsSecure(req: Request): boolean {
  if (req.secure) return true;
  if (process.env.TRUST_PROXY === '1' && req.get('x-forwarded-proto') === 'https') return true;
  return false;
}

export function setSessionCookie(req: Request, res: Response, token: string): void {
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${SESSION_TTL_SECONDS}`,
  ];
  if (requestIsSecure(req)) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

export function clearSessionCookie(res: Response): void {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

/* ------------------------------------------------------------------ *
 * Middleware
 * ------------------------------------------------------------------ */

declare module 'express-serve-static-core' {
  interface Request {
    user?: SessionUser;
    /**
     * How req.user was established. 'session' means the ambient cookie
     * session (CSRF-able, so requireCsrf applies); the header-token paths
     * carry explicit per-request secrets and are exempt.
     */
    authMethod?: 'session' | 'admin-token' | 'loopback';
  }
}

let cachedHasUsers: boolean | null = null;

export function resetAuthCacheForTests(): void {
  cachedHasUsers = null;
}

export function isLoopbackRequest(req: Request): boolean {
  const forwarded = req.get('x-forwarded-for');
  if (forwarded) {
    const first = forwarded.split(',')[0].trim().toLowerCase();
    if (
      first !== '127.0.0.1' &&
      first !== '::1' &&
      first !== 'localhost' &&
      !first.endsWith('127.0.0.1')
    ) {
      return false;
    }
  }
  const ip = (req.ip ?? req.socket?.remoteAddress ?? '').trim().toLowerCase();
  return (
    ip === '127.0.0.1' ||
    ip === '::1' ||
    ip === '::ffff:127.0.0.1' ||
    ip === 'localhost' ||
    ip.endsWith('127.0.0.1')
  );
}

/**
 * Resolves the current user (cookie session) when one exists. Legacy mode:
 * if the database has no users at all, requests carrying the valid
 * ADMIN_TOKEN are treated as an implicit admin so nothing breaks before the
 * first account is provisioned.
 */
export const attachUser: RequestHandler = (req, res, next) => {
  void (async () => {
    const token = sessionTokenFromRequest(req);
    if (token) {
      const user = await userForToken(token);
      if (user) {
        req.user = user;
        req.authMethod = 'session';
        next();
        return;
      }
    }

    const hasUsers =
      cachedHasUsers ??
      (await (async () => {
        const count = await users().countDocuments();
        if (count > 0) cachedHasUsers = true;
        return count > 0;
      })());

    if (!hasUsers) {
      const legacy = req.get('x-admin-token') ?? '';
      const expected = (process.env.ADMIN_TOKEN ?? '').trim();
      const path = req.path ?? '';
      if (expected && legacy.length > 0) {
        const a = crypto.createHash('sha256').update(legacy, 'utf8').digest();
        const b = crypto.createHash('sha256').update(expected, 'utf8').digest();
        if (crypto.timingSafeEqual(a, b)) {
          req.user = implicitAdmin();
          req.authMethod = 'admin-token';
        }
      } else if (
        !expected &&
        process.env.CODEBUDDY_LIVE !== 'true' &&
        (path.startsWith('/api/admin') || path.startsWith('/api/v1/admin')) &&
        isLoopbackRequest(req)
      ) {
        // Open demo mode only (no ADMIN_TOKEN, no accounts, not live): admin
        // routes stay reachable on loopback. Remote requests fail closed
        // (401), and live mode never grants implicit admin.
        req.user = implicitAdmin();
        req.authMethod = 'loopback';
      }
    }
    next();
  })().catch(next);
};

/** Requires an authenticated user; 401 otherwise. */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  next();
}

/** Requires one of the given roles; 403 otherwise. */
export function requireRole(...roles: Role[]): RequestHandler {
  return (req, res, next) => {
    if (!req.user) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    if (!roles.includes(req.user.role)) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }
    next();
  };
}

/** Returns the stored CSRF token for a raw session token, or null. */
export async function sessionCsrfToken(rawToken: string): Promise<string | null> {
  const tokenHash = crypto.createHash('sha256').update(rawToken, 'utf8').digest('hex');
  const session = await sessions().findOne(
    { _id: tokenHash },
    { projection: { csrf_token: 1, expires_at: 1 } },
  );
  if (!session || session.expires_at.getTime() < Date.now()) return null;
  return session.csrf_token ?? null;
}

const CSRF_SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * CSRF guard for cookie-session authentication. Browsers attach the session
 * cookie to cross-site requests automatically, so every state-changing
 * request authenticated via the ambient cookie must also carry the
 * per-session `x-csrf-token` (issued at login and via GET /auth/me).
 * Requests authenticated with explicit header secrets (x-admin-token,
 * x-conversation-token) and safe methods are exempt.
 */
export const requireCsrf: RequestHandler = (req, res, next) => {
  void (async () => {
    if (CSRF_SAFE_METHODS.has(req.method)) {
      next();
      return;
    }
    if (req.authMethod !== 'session') {
      next();
      return;
    }
    const rawToken = sessionTokenFromRequest(req);
    const expected = rawToken ? await sessionCsrfToken(rawToken) : null;
    const provided = req.get('x-csrf-token') ?? '';
    const a = Buffer.from(provided, 'utf8');
    const b = Buffer.from(expected ?? '', 'utf8');
    if (!expected || !provided || a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      res.status(403).json({ error: 'CSRF token required' });
      return;
    }
    next();
  })().catch(next);
};

/* ------------------------------------------------------------------ *
 * Accounts
 * ------------------------------------------------------------------ */

export async function countUsers(): Promise<number> {
  return users().countDocuments();
}

export async function findUserByEmail(email: string): Promise<WithId<UserDoc> | null> {
  return users().findOne({ email: email.trim().toLowerCase() });
}

export async function listUsers(): Promise<Array<SessionUser & { createdAt: string; lastLoginAt: string | null }>> {
  const docs = await users().find().sort({ created_at: 1 }).toArray();
  return docs.map((doc) => ({
    id: doc._id,
    email: doc.email,
    name: doc.name,
    role: doc.role,
    createdAt: doc.created_at,
    lastLoginAt: doc.last_login_at,
  }));
}

export interface CreateUserInput {
  email: string;
  name: string;
  role: Role;
  password: string;
  invitedBy: string | null;
}

export async function createUser(input: CreateUserInput): Promise<SessionUser> {
  const { hash, salt } = hashPassword(input.password);
  const doc: UserDoc = {
    _id: newId(),
    email: input.email.trim().toLowerCase(),
    name: input.name.trim(),
    role: input.role,
    password_hash: hash,
    password_salt: salt,
    invited_by: input.invitedBy,
    created_at: new Date().toISOString(),
    last_login_at: null,
  };
  await users().insertOne(doc);
  cachedHasUsers = true;
  return { id: doc._id, email: doc.email, name: doc.name, role: doc.role };
}

export async function authenticate(
  email: string,
  password: string,
): Promise<SessionUser | null> {
  const user = await findUserByEmail(email);
  if (!user) {
    // Equalise timing between "no such user" and "wrong password".
    verifyPassword(password, crypto.randomBytes(16).toString('hex'), crypto.randomBytes(64).toString('hex'));
    return null;
  }
  if (!verifyPassword(password, user.password_salt, user.password_hash)) return null;
  await users().updateOne({ _id: user._id }, { $set: { last_login_at: new Date().toISOString() } });
  return toSessionUser(user);
}

export async function changePassword(
  userId: string,
  currentPassword: string,
  newPassword: string,
): Promise<boolean> {
  const user = await users().findOne({ _id: userId });
  if (!user) return false;
  if (!verifyPassword(currentPassword, user.password_salt, user.password_hash)) return false;
  const { hash, salt } = hashPassword(newPassword);
  await users().updateOne(
    { _id: userId },
    { $set: { password_hash: hash, password_salt: salt } },
  );
  return true;
}

export async function setUserRole(actor: SessionUser, userId: string, role: Role): Promise<boolean> {
  if (actor.id === userId) return false; // never demote yourself
  const result = await users().updateOne({ _id: userId }, { $set: { role } });
  return result.matchedCount > 0;
}

/* ------------------------------------------------------------------ *
 * Email verification (OTP + Magic Link)
 * ------------------------------------------------------------------ */

export async function createEmailVerification(email: string): Promise<{ code: string; token: string; expiresAt: Date }> {
  const normalizedEmail = email.trim().toLowerCase();
  const code = String(crypto.randomInt(100000, 1000000));
  const codeHash = crypto.createHash('sha256').update(code, 'utf8').digest('hex');
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

  // Clear any existing active verifications for this email
  await emailVerifications().deleteMany({ email: normalizedEmail });

  await emailVerifications().insertOne({
    _id: newId(),
    email: normalizedEmail,
    code_hash: codeHash,
    token,
    expires_at: expiresAt,
    created_at: new Date(),
    attempts: 0,
  });

  return { code, token, expiresAt };
}

export async function verifyEmailCode(email: string, code: string): Promise<boolean> {
  const normalizedEmail = email.trim().toLowerCase();
  const record = await emailVerifications().findOne({ email: normalizedEmail });
  if (!record) return false;
  if (record.expires_at.getTime() < Date.now()) {
    await emailVerifications().deleteOne({ _id: record._id });
    return false;
  }
  if (record.attempts >= 5) {
    await emailVerifications().deleteOne({ _id: record._id });
    return false;
  }

  const candidateHash = crypto.createHash('sha256').update(code.trim(), 'utf8').digest('hex');
  const a = Buffer.from(candidateHash, 'hex');
  const b = Buffer.from(record.code_hash, 'hex');
  const match = a.length === b.length && crypto.timingSafeEqual(a, b);

  if (match) {
    await emailVerifications().deleteOne({ _id: record._id });
    return true;
  } else {
    await emailVerifications().updateOne({ _id: record._id }, { $inc: { attempts: 1 } });
    return false;
  }
}

export async function verifyEmailToken(token: string): Promise<string | null> {
  if (!token) return null;
  const record = await emailVerifications().findOne({ token });
  if (!record) return null;
  if (record.expires_at.getTime() < Date.now()) {
    await emailVerifications().deleteOne({ _id: record._id });
    return null;
  }
  await emailVerifications().deleteOne({ _id: record._id });
  return record.email;
}

/**
 * Whether the first self-service sign-up may become an admin. This is an
 * explicit opt-in so an unclaimed deployment cannot be taken over by whoever
 * registers first; the sanctioned way to create the initial admin is the
 * BOOTSTRAP_ADMIN_EMAIL/PASSWORD path (see bootstrapAdminFromEnv).
 */
export function firstUserAdminAllowed(): boolean {
  return process.env.ALLOW_FIRST_USER_ADMIN === 'true';
}

export async function findOrCreateUserByEmail(email: string, name?: string): Promise<SessionUser> {
  const normalizedEmail = email.trim().toLowerCase();
  const existing = await findUserByEmail(normalizedEmail);
  if (existing) {
    await users().updateOne({ _id: existing._id }, { $set: { last_login_at: new Date().toISOString() } });
    return toSessionUser(existing);
  }

  const count = await users().countDocuments();
  const role: Role = count === 0 && firstUserAdminAllowed() ? 'admin' : 'agent';
  const displayName = name?.trim() || normalizedEmail.split('@')[0] || 'User';
  const { hash, salt } = hashPassword(crypto.randomBytes(32).toString('hex'));

  const userDoc: UserDoc = {
    _id: newId(),
    email: normalizedEmail,
    name: displayName,
    role,
    password_hash: hash,
    password_salt: salt,
    invited_by: null,
    created_at: new Date().toISOString(),
    last_login_at: new Date().toISOString(),
  };

  await users().insertOne(userDoc);
  cachedHasUsers = true;
  return { id: userDoc._id, email: userDoc.email, name: userDoc.name, role: userDoc.role };
}

/* ------------------------------------------------------------------ *
 * Google Sign-In (Token verification via Google OAuth2 API)
 * ------------------------------------------------------------------ */

export async function verifyGoogleIdToken(idToken: string): Promise<{ email: string; name: string; picture?: string; sub: string } | null> {
  if (!idToken || typeof idToken !== 'string') return null;
  try {
    const res = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`);
    if (!res.ok) return null;
    const data = await res.json() as {
      email?: string;
      email_verified?: string | boolean;
      name?: string;
      picture?: string;
      sub?: string;
      aud?: string;
    };
    if (!data.email) return null;
    const isVerified = data.email_verified === 'true' || data.email_verified === true;
    if (!isVerified) return null;

    // Audience validation is mandatory: without a configured client ID we
    // cannot tell which OAuth client issued the token, so refuse it rather
    // than accepting tokens minted for any application.
    const expectedAud = (process.env.GOOGLE_CLIENT_ID ?? '').trim();
    if (!expectedAud) {
      console.warn('[relay] Google sign-in rejected: GOOGLE_CLIENT_ID is not configured');
      return null;
    }
    if (data.aud !== expectedAud) {
      console.warn('[relay] Google token aud mismatch:', data.aud, 'expected:', expectedAud);
      return null;
    }

    return {
      email: data.email.toLowerCase(),
      name: data.name ?? data.email.split('@')[0],
      picture: data.picture,
      sub: data.sub ?? '',
    };
  } catch (err) {
    console.error('[relay] Error verifying Google token:', err);
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * Audit
 * ------------------------------------------------------------------ */

export async function audit(
  req: Request,
  action: string,
  target: string,
  details?: Record<string, unknown>,
): Promise<void> {
  try {
    await auditEvents().insertOne({
      _id: newId(),
      at: new Date().toISOString(),
      actor_id: req.user?.id ?? null,
      actor_email: req.user?.email ?? 'anonymous',
      action,
      target,
      details,
      request_id: req.requestId ?? null,
      expires_at: new Date(Date.now() + AUDIT_RETENTION_DAYS * 24 * 60 * 60 * 1000),
    });
  } catch {
    // Audit failures must not break the request path; the structured log
    // already captured the request.
  }
}

export async function listAudit(limit = 100): Promise<AuditEventDoc[]> {
  return auditEvents().find().sort({ at: -1 }).limit(Math.min(limit, 500)).toArray();
}

/**
 * Called from server startup so collections/indexes exist before first use.
 */
export async function initAuthCollections(db: Db): Promise<void> {
  await ensureAuthIndexes(db);
}
