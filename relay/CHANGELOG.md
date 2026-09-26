# Changelog

All notable changes to Relay are recorded here. Dates are release dates;
`Unreleased` tracks the working tree toward the next cut.

## Unreleased

### Security — production readiness audit fixes (PRD-001…PRD-020)

- OTP / magic-link secrets are no longer written to stdout or structured logs
  when no mail provider is configured (`server/notify.ts` logs delivery
  metadata only). Local developers keep the loopback-only
  `ALLOW_AUTH_DEBUG_CODE` response field, already surfaced in the login UI.
- Auth throttles now fail closed: a throttle-store outage refuses the attempt
  with 503 (+ `Retry-After`) and reports via `reportError`, instead of
  silently disabling brute-force protection. Bulk-traffic limiting stays
  fail-open for availability but now reports outages too.
- New per-surface auth budgets: email verify (20/10 min per IP+email), Google
  login (30/10 min per IP), password change (10/10 min per account).
- Password change revokes every other session for the account; new
  `POST /auth/logout-all` revokes all of them. Session cookies are cleared
  with the same `Secure` attribute they were set with.
- Production refuses to start without `TRUST_PROXY` (cookie `Secure` flag and
  client-IP rate limits depend on it); development keeps a warning.
- `/api/metrics` and `/api/health/system` require an authenticated session;
  the public `/api/health` liveness probe is unchanged. OpenAPI documents the
  new auth requirements plus `POST /auth/logout-all` (36 paths total).
- MongoDB authentication in both compose stacks (root user via
  `MONGO_ROOT_USER`/`MONGO_ROOT_PASSWORD` in prod, `MONGO_USER`/
  `MONGO_PASSWORD` in dev); dev mongo binds to loopback only. Backup/restore
  scripts authenticate from `.env.prod`.
- Outbound Google/Resend calls carry a 5 s abort timeout so a hung upstream
  cannot hang sign-in or notifications.

### Added

- Bounded reads everywhere: `GET /faqs`, conversation transcripts,
  `GET /admin/knowledge-gaps` and `GET /auth/users` accept `limit`/`offset`
  (shared `parsePagination` helper, covered by unit tests); most-recent-N
  transcripts stay chronological.
- Workspace data now loads for cookie-session users when `ADMIN_TOKEN` is set:
  the dashboard attempts `reload()` first and only shows the legacy-token
  prompt on 401. Previously the pre-emptive `adminAuthRequired` gate bricked
  the queue for password sessions on every live deployment (and failed the
  pilot e2e) — fixed, pilot + a11y green at 9/9 locally.
- Keyboard containment: shared `useFocusTrap` (Tab cycling + focus return)
  wired into `Modal` and the conversation drawer; queue tables use real
  `Open` buttons instead of `tr role=button`; skip link targets every view
  (login landmark included); rating exposes radiogroup semantics.
- PWA installability: generated `icon-192/512.png`, maskable icon and
  `og-image.png` (`backend/scripts/gen-pwa-assets.mjs`), wired into the
  manifest, touch icon and social meta.
- Dependency-free load probe (`backend/scripts/load-probe.mjs`): 500×20
  against public reads measured ~1560 rps, p50 ≈ 10 ms, p95 ≈ 26 ms, zero
  errors on local hardware.
- Pre-production backup release gate in both deploy guides (RPO ≤ 24 h,
  rehearsed restore evidence required), expanded `.env.prod.example`
  (database auth, caps, account policy, observability, backups), and a
  `format:check` CI step.

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
- OpenAPI 3.1 reference at `/api/openapi.json`
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

- 14 backend unit tests (validation incl. pagination, plan, config, HTTP,
  monitoring) run without MongoDB; 16 frontend unit tests (`service-api`).
- 6 Playwright pilot tests (landing → cited answer → handoff → admin
  login/reply/resolve), runnable against source or `dist/` (need MongoDB).
- 3 axe accessibility tests; informational `c8` coverage
  (`npm run test:coverage`, floor lines 52% / branches 68%).

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
