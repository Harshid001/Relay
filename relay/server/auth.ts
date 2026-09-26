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

export async function createSession(userId: string, userAgent: string | null): Promise<string> {
  const token = crypto.randomBytes(32).toString('base64url');
  const tokenHash = crypto.createHash('sha256').update(token, 'utf8').digest('hex');
  const now = new Date();
  await sessions().insertOne({
    _id: tokenHash,
    user_id: userId,
    created_at: now,
    expires_at: new Date(now.getTime() + SESSION_TTL_SECONDS * 1000),
    last_seen_at: now,
    user_agent: userAgent?.slice(0, 200) ?? null,
  });
  return token;
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
        }
      } else if (!expected && (path.startsWith('/api/admin') || path.startsWith('/api/v1/admin')) && isLoopbackRequest(req)) {
        // Open demo mode (no ADMIN_TOKEN, no accounts): admin routes stay
        // reachable on loopback only. Remote requests fail closed (401).
        req.user = implicitAdmin();
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
