# Relay — Intelligent Customer Service Agent

A working customer-support application customized from the installed **codebuddy-chat-web / init-cbc-sdk-web** template. React 18 + TypeScript + Vite frontend, Express backend, MongoDB persistence, and `@tencent-ai/agent-sdk` for opt-in live responses.

## Run

Requires Node.js 22.13+ and a MongoDB server (8.x recommended; a single-node replica set enables transactions, and MongoDB 8+ can run as one standalone process too). From this project folder:

```sh
npm install
npm run build
npm start
```

The server connects to `MONGODB_URI` (default `mongodb://127.0.0.1:27017`), seeds the knowledge base and demo conversations on first run, then listens.

Open **http://127.0.0.1:3000**. Customer chat: **http://127.0.0.1:3000/?view=chat**.

### Production (Vercel + MongoDB Atlas)

The repo is Vercel-ready: `api/index.ts` runs the Express API as a serverless
function, the Vite build ships as static assets, and `vercel.json` wires the
routing (including the `ALLOWED_HOSTS` guard for `*.vercel.app` domains).
See **[DEPLOY-VERCEL.md](./DEPLOY-VERCEL.md)** for the full guide — Atlas M0
setup, environment variables, custom domains and serverless caveats.

### Production (any Ubuntu VM + Cloudflare)

Complete deployment kit for a single free-tier VM (the guide uses OCI Always
Free; any Ubuntu VM works): Caddy auto-TLS, self-hosted Mongo replica set, and
nightly `mongodump` backups to Cloudflare R2. See
**[DEPLOY-OCI.md](./DEPLOY-OCI.md)**.

Two settings make a public deployment work (both in `.env.prod`, see
`.env.prod.example`): `ALLOWED_HOSTS` lists the hostnames the server answers
for — requests with any other `Host` or `Origin` header get `403` — and
`TRUST_PROXY` (number of proxy hops) makes rate limiting and secure cookies
key on the real client IP from `X-Forwarded-For`. The production compose file
wires both from `DOMAIN` automatically.

### Docker

A production-like local stack (app + MongoDB replica set) is included:

```sh
docker compose up --build
```

### CI

GitHub Actions (`.github/workflows/ci.yml`) typechecks, builds, and runs the full integration suite against a real MongoDB replica set on every pull request.

For development, `npm run dev` runs the backend on 3000 and Vite on 5173. Both listen only on loopback. `npm test` runs isolated integration tests, including a real server restart; `npm run typecheck` checks frontend and backend.

Dependencies install normally with `npm install` (252 packages, verified with Node 22.22.2). The downloadable source archive at `../outputs/Relay-Intelligent-Customer-Service.zip` deliberately excludes `node_modules`, so run `npm install` after extracting it elsewhere. The build output in `dist/` is included, so the app runs as soon as dependencies are present.

## Accounts, sessions and RBAC

Relay supports real accounts alongside the original shared-token mode:

- **Provisioning:** on first start with an empty `users` collection, Relay creates the initial admin from `BOOTSTRAP_ADMIN_EMAIL` / `BOOTSTRAP_ADMIN_PASSWORD` (12+ chars). `BOOTSTRAP_ADMIN_NAME` is optional.
- **Sessions:** opaque 256-bit tokens; only sha256 hashes are stored, with a 30-day TTL index. Browsers get an `httpOnly` `SameSite=Lax` cookie (`Secure` is added automatically behind a TLS proxy when `TRUST_PROXY=1`).
- **Passwords:** scrypt with per-user salts and constant-time comparison; login is rate-limited per IP+email and never reveals whether an account exists.
- **Roles:** `admin` > `agent`. Admins manage accounts, FAQ writes and role changes; agents work the queue. Mutations are recorded in an `audit_events` collection with actor and request ID.
- **Legacy fallback:** while no accounts exist, the shared `ADMIN_TOKEN` header still unlocks admin routes (open demo mode keeps working). It is ignored once real accounts are provisioned.

Endpoints: `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me`, `GET|POST /api/auth/users`, `POST /api/auth/users/:id/role`, `POST /api/auth/password`.

## API surface

- REST endpoints live under `/api/*` (legacy, unwrapped) and `/api/v1/*` (identical payloads wrapped in `{ success, data | error }` envelopes).
- Every response carries an `X-Request-Id` header; one structured JSON log line is emitted per request.
- `GET /api/health` reports process + database status (`503` when Mongo is unreachable); `GET /api/metrics` exposes Prometheus-style counters and latency buckets.
- `GET /api/admin/conversations?limit=&offset=` returns `{ items, total, limit, offset }` (default/limit max 100/200).
- `GET /api/admin/events` is a Server-Sent Events stream (session-authenticated) broadcasting `workspace` events for conversation and FAQ changes; the workspace UI subscribes and refreshes instantly, with polling as fallback.

## Email notifications

When `NOTIFY_EMAILS` is set (comma-separated recipients, max 10), Relay emails the team whenever a conversation joins the human queue. Delivery uses Resend's HTTP API when `RESEND_API_KEY` is present (`NOTIFY_FROM_EMAIL` overrides the sender); without a key, notifications are logged instead so nothing is silent. Mail failures never affect request handling.

## PWA / mobile

The frontend is an installable PWA: `public/manifest.webmanifest` plus an offline service worker (app-shell navigation fallback; hashed assets are stale-while-revalidate; `/api/*` is never cached). The installed mobile app reuses the same responsive UI and backend APIs — sign-in state lives in the cookie session. SEO basics ship in `index.html` (description, Open Graph, Twitter card) along with `public/robots.txt` and `public/sitemap.xml`.

## Demo versus live

The default demo is fully functional offline: FAQ retrieval, multi-turn context, handoff rules, human replies, ratings, editable knowledge and persistence all work without a key. It is **not** a live language model. The dashboard clearly marks the 30 seeded conversations and 15 sample policies as demonstration data.

To enable CodeBuddy, copy `.env.example` to `.env` in this folder and configure server-side values:

```dotenv
CODEBUDDY_LIVE=true
CODEBUDDY_API_KEY=your-own-codebuddy-key
ADMIN_TOKEN=your-own-long-random-admin-secret
SEED_DEMO=false
```

Restart the server. The admin dashboard will request the admin token, or you can provision real accounts with `BOOTSTRAP_ADMIN_EMAIL` / `BOOTSTRAP_ADMIN_PASSWORD` and sign in at the login screen. Replace the fictional FAQs with your actual policies before real use. No credentials are included or sent to the browser beyond the httpOnly session cookie; account passwords are stored only as scrypt hashes.

Optional variables: `CODEBUDDY_AUTH_TOKEN`, `CODEBUDDY_MODEL`, `CODEBUDDY_CODE_PATH`, `DATA_DIR`, `PORT`, `RELAY_TURN_DELAY_MS` (artificial reply latency, 0 by default, handy for watching the loading and hand-off states), `ALLOWED_HOSTS` (extra hostnames beyond loopback the server accepts; `*` disables the Host/Origin guard), `TRUST_PROXY` (proxy-hop count; enables `X-Forwarded-For` client-IP resolution). The SDK can use its installed CLI or an explicitly configured CLI path. The actual authenticated model response must be verified with your own valid credentials; it was not exercised during delivery.

## Features

- Customer multi-turn chat with reload-safe local conversation selection and server-side history.
- Ranked keyword/synonym FAQ retrieval with clickable source citations.
- Automatic refund, order inquiry, technical support and general intent recognition, retaining intent across follow-ups.
- Immediate human escalation on explicit requests and account-specific actions; automatic escalation after two low-confidence or unsuccessful troubleshooting turns. Waiting conversations stop receiving bot replies.
- Human queue: search, filter, assign, read transcript, reply, resolve. New queue items refresh automatically.
- A human's status decision always wins: if someone resolves or takes over a thread while an assistant reply is still generating, the assistant does not re-queue it.
- One 1–5 satisfaction rating per conversation.
- Dashboard and analytics: conversation counts, resolution rate, first response time, CSAT, intent distribution, rating distribution and 7/30-day activity.
- Editable FAQ knowledge base with persistent add/edit operations.

## Data and metric definitions

MongoDB stores conversations (with embedded owner token hashes), messages, citations, ratings, FAQs, tool-call events and idempotency keys. Idempotency entries expire automatically after 24 hours via a TTL index. `MONGODB_URI` and `MONGODB_DB` change the connection; demo and live modes use separate databases so records never mix. The legacy SQLite files in `data/` are no longer used and can be archived.

- **Resolution rate:** conversations currently resolved / conversations created in the selected window. It is not an AI-only success rate.
- **CSAT:** ratings of 4 or 5 / all ratings on conversations in the selected window.
- **Conversation volume:** one count per conversation, on its creation day; human if it has a human reply or is awaiting a human, assistant otherwise.
- **First response:** mean time from the first customer message to the first assistant/human reply in the window; system notices do not count.
- Date grouping uses the server's local calendar timezone.

## CodeBuddy integration and safety

`server/agent.ts` calls the real SDK `query()` API with a bounded history and retrieved FAQ context. User content is treated as data, tools are denied, external MCP servers and user/project settings are not loaded, and each request has a 30-second abort timer. A structured result provides the answer, intent and handoff decision. SDK failures preserve the user message and escalate honestly rather than masquerading as successful AI responses. Responses are returned as JSON after completion, with an in-progress indicator in the UI; token streaming is intentionally not used.

Customer endpoints require a random per-conversation owner token. Admin endpoints accept a cookie session from a real account, or the legacy `ADMIN_TOKEN` header while no accounts exist; live mode refuses to start without `ADMIN_TOKEN`. Body limits, validation, request throttling, Host/Origin checks and audit logging are enabled.

## Before public deployment

This is a local application, not an internet-hardened SaaS. Add HTTPS, proper user accounts/SSO and role-based access, audit and retention policies, operational monitoring, privacy review and durable hosting. Replace sample policies and demo identities. Connect your actual order/refund system and support staffing if required. Relay cannot issue refunds, track real parcels, or notify an external helpdesk in this version; handoff is to its built-in human inbox. Do not expose the loopback demo through a public tunnel without implementing those controls.

## Active source

- `src/App.tsx`: thin path router — `/` landing, `/app` workspace, `/chat` customer view.
- `src/Landing.tsx`: marketing page with demo entry points.
- `src/admin/AdminApp.tsx`: workspace shell, overview, inbox, knowledge, analytics and settings pages.
- `src/customer/CustomerCenter.tsx`: customer chat with handoff staging and demo starters.
- `src/ui/shared.tsx`: shared UI primitives, formatting helpers and chart components.
- `src/Auth.tsx`: login page, session hook and account card.
- `src/ErrorBoundary.tsx`: render-error containment for the workspace.
- `src/service-api.ts`, `src/service-types.ts`: typed client contract and session handling.
- `server/index.ts`: API, access control, handoffs and static hosting.
- `server/auth.ts`, `server/auth-routes.ts`: accounts, sessions, RBAC and audit.
- `server/events.ts`, `server/notify.ts`: realtime event bus and email notifications.
- `server/logger.ts`, `server/http.ts`: structured logging, request IDs, envelopes, metrics.
- `server/db.ts`: MongoDB repositories, indexes, demo seed and statistics.
- `server/knowledge.ts`: sample FAQs, ranking and intent rules.
- `server/orders.ts`: mocked order catalogue backing the lookup tool call.
- `server/agent.ts`: demo responder and real CodeBuddy adapter.
- `server/env.ts`: project-local .env loading.
- `tests/support.test.ts`: reproducible backend tests (run against MongoDB).

The original template's chat components (TDesign, SSE streaming, permission dialogs) were removed once the support product replaced them, so nothing unused ships in the tree. Verified with `npm run typecheck`, `npm test` and `npm run build`.
