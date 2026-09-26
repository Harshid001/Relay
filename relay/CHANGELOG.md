# Changelog

All notable changes to Relay are recorded here. Dates are release dates;
`Unreleased` tracks the working tree toward the next cut.

## Unreleased

### Security

- Email OTP / magic-link secrets are never returned unless `ALLOW_AUTH_DEBUG_CODE=true`,
  `NODE_ENV !== 'production'` **and** the caller is loopback. Previously the
  code was returned whenever `NODE_ENV` was not `production` (or no mail
  provider was configured), which allowed account takeover on a misconfigured
  deploy.
- Google Sign-In refuses tokens unless `GOOGLE_CLIENT_ID` is set and the token
  audience matches, instead of skipping audience validation when the client ID
  was absent.
- The first self-service sign-up is now an `agent` by default; admin promotion
  requires `ALLOW_FIRST_USER_ADMIN=true` or the `BOOTSTRAP_ADMIN_*` path.
- Login-failure and email-code throttles moved from process memory to MongoDB,
  so brute-force protection holds across serverless instances.
- Live mode now warns at startup when `TRUST_PROXY` is unset (cookie `Secure`
  flag and client-IP rate limits depend on it).
- Bumped `express` 4.21.2 → ^4.22.3 (path-to-regexp ReDoS + qs/body-parser
  DoS advisories). Both packages audit clean; CI fails on high/critical.
- Helmet security headers on every response: CSP (Google GSI + Google Fonts
  allowlisted, React inline styles permitted), HSTS (1 year, subdomains),
  `X-Frame-Options: SAMEORIGIN`.
- Per-session CSRF tokens: issued at login/verify/Google and via
  `GET /auth/me`, required as `x-csrf-token` on cookie-session mutations.
  Header-token auth (`x-admin-token`, `x-conversation-token`) is exempt.
- Loopback implicit-admin now requires demo mode; live mode never grants it.
- Loud startup warning when `ALLOWED_HOSTS="*"` meets live mode.
- `audit_events` retained 365 days via TTL (previously unbounded).

### Added

- Versioned schema migrations (`server/migrations.ts`) with `$jsonSchema`
  validators for conversations, messages, FAQs, users and sessions.
- Managed observability: Sentry (`SENTRY_DSN`) for error tracking, alert
  routing and optional tracing, plus a dependency-free `ERROR_WEBHOOK_URL`
  JSON sink (`server/monitoring.ts`).
- Cross-instance realtime: the workspace event bus fans out through a MongoDB
  change stream (`realtime_events`, TTL 60s) so SSE reaches clients on every
  instance; standalone mongod and serverless stay in-process with the polling
  fallback (`server/events.ts`).
- Opt-in Playwright visual regression suite (`npm run test:visual`).
- 13 in-process unit tests for validation, plan, config, HTTP and monitoring.
- ESLint + Prettier at the repo root (`npm run lint`, zero warnings) and a
  CI lint job.
- CI Docker job: validates the production compose file, builds the image and
  smoke-tests `/api/health` against a real MongoDB.
- Scheduled backups (`BACKUP_ENABLED=true`) plus a monthly restore rehearsal
  in `.github/workflows/backup.yml`.
- Enforced coverage floor (line 52% / branch 68%) for the measured modules
  (rises with the unit suite).

### Changed

- `server/index.ts` is now a thin composition root (1,365 → ~275 lines);
  config, validation and the system/customer/admin route groups live in
  `server/config.ts`, `server/validation.ts` and `server/routes/*`.
- Demo seeding is opt-in: fresh deploys start empty unless `SEED_DEMO=true`;
  live mode also skips sample FAQ policies (loadable on demand).
- Rate limits and turn locks moved from process memory to MongoDB
  (`server/ratelimit.ts`): shared budget across instances, TTL crash
  recovery for abandoned turn locks.
- Backend compiles with `tsc` (`npm run build` → `dist/`); Docker and
  `npm start` run `node dist/server/index.js` (no tsx in production).
- OpenAPI 3.1 reference for all 35 paths at `/api/openapi.json`
  (also enveloped at `/api/v1/openapi.json`).
- Frontend route splitting: landing entry 292 KB → ~50 KB, vendor chunk
  cached, chat/admin lazy.
- Vercel entrypoint moved to root-level `relay/api/` (the only place Vercel
  discovers functions); fixed `build` script, `frontend/dist` output, and an
  explicit `installCommand`.
- Accessibility: secondary text token darkened to WCAG AA
  (`--ink-faint: #5f6f66`), chat page gained `<header>`/`<main>` landmarks;
  axe scans run in CI over landing, chat, and login.

### Tests

- 37 integration tests (added: helmet headers, OpenAPI shape, CSRF allow/
  deny, shared limiter 409/429 with `Retry-After`).
- 6 Playwright pilot tests (landing → cited answer → handoff → admin
  login/reply/resolve), runnable against source or `dist/`.
- 3 axe accessibility tests; 15 frontend unit tests (`service-api`).
- Informational `c8` coverage (`npm run test:coverage`).

### Docs

- Rollback runbooks for OCI and Vercel; `SECURITY.md` with reporting
  channel and accepted risks.

## History (from git, newest first)

- `62ab43a` — CI supports the split backend/frontend architecture.
- `2987c49` — Codebase split into frontend/backend; workspace UI refresh.
- `69659e2` — Passwordless email code, magic link, Google sign-in.
- `b5cc372` — Remote admin guard verified with forwarded IP.
- `f676c6a` — Pilot deployment verification script.
- `1f2be6e` — Vercel Root Directory docs.
- `e294357` — Production hardening, health observability, test expansion.
- `14e18e7` — Vercel serverless entrypoint, routing, host allowlist.
- `7be6d9c` — Public deployment: host allowlist, proxy-aware IPs, honest copy.
- `dcad2a3` — Initial Relay (React + Express + MongoDB).
