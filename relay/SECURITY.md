# Security policy

## Reporting a vulnerability

Do **not** open a public issue for a suspected vulnerability. Use
**GitHub → Security → Report a vulnerability** (private vulnerability
reporting) on this repository so the report stays confidential until a fix
ships.

Please include:

- What you think is affected (endpoint, component, configuration)
- Steps to reproduce, ideally against a local `docker compose up` stack
- What an attacker gains (read, write, impersonation, availability)
- Anything you already tried that did *not* work (saves round-trips)

## Scope

In scope: the Express API (`relay/backend`), the React workspace
(`relay/frontend`), the Docker/Caddy/compose deployment files, and the
documented environment templates.

Out of scope: third-party services themselves (MongoDB Atlas, Vercel,
Cloudflare, Resend, Google Identity Services) — report those to their
vendors, unless the issue is in how Relay configures or calls them.

## What is already enforced (so reports can build on it)

- Passwords: scrypt (N=16384, r=8, p=1), per-user salt, constant-time compare.
- Sessions: opaque tokens stored hashed, 30-day TTL, `HttpOnly; SameSite=Lax`
  cookies, per-session CSRF tokens required on cookie-authenticated mutations.
- Headers: CSP, HSTS (1 year, subdomains), `X-Frame-Options: SAMEORIGIN`,
  `nosniff`, `no-referrer` via helmet — see `relay/backend/server/index.ts`.
- Brute force: 8-attempt login throttle per IP+email per 10 minutes; email
  code requests throttled per address; global per-IP rate limits (600/120/40
  req/min by bucket). All of these are stored in MongoDB, so they hold across
  instances and restarts.
- Google Sign-In validates the ID token audience and refuses tokens entirely
  when `GOOGLE_CLIENT_ID` is unset (`server/auth.ts`).
- Email OTP / magic-link secrets are returned only when
  `ALLOW_AUTH_DEBUG_CODE=true` **and** `NODE_ENV !== 'production'` **and** the
  caller is on loopback — never based on `NODE_ENV` or a missing mail provider.
- The first self-service sign-up becomes an `agent`, not an admin, unless
  `ALLOW_FIRST_USER_ADMIN=true`. Provision the initial admin with
  `BOOTSTRAP_ADMIN_EMAIL` / `BOOTSTRAP_ADMIN_PASSWORD`.
- Host/Origin allowlist with `403` on mismatch; never run production with
  `ALLOWED_HOSTS="*"`.
- Database writes are additionally constrained by `$jsonSchema` validators
  (see `server/migrations.ts`).
- CI runs `npm run lint`, `npm audit --omit=dev --audit-level=high` on both
  packages and builds + smoke-tests the production image; the backend pins
  `express ^4.22.3` (path-to-regexp ReDoS fix).

## Known accepted risks (do not report these as new)

- Rate limits and conversation turn-locks are enforced in MongoDB
  (`server/ratelimit.ts`), so they hold across instances. SSE subscriptions
  remain per instance by design (the workspace UI falls back to polling).
- Atlas M0 (documented Vercel path) has no continuous backups; automated
  backups (`BACKUP_ENABLED=true` + `.github/workflows/backup.yml`) are opt-in.
- Demo seed data (`SEED_DEMO=true`) is fictional by design and opt-in.
