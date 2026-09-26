# Relay — the free AI support agent

Relay answers your customers from your own knowledge base, cites every answer,
and hands difficult conversations to a human with full context. It is **free to
use**: a generous free plan on any deployment, no credit card, no per-seat
fees, and no per-resolution meter that punishes you when it works.

Two ways to run it, both free:

| | Free plan (any deployment) | Self-host (free infrastructure) |
|---|---|---|
| Cost | $0 | $0 on Vercel Hobby + Atlas M0 (or a free VM) |
| Monthly allowance | 300 conversations · 1,000 AI answers | Raise or remove the caps with env vars |
| Human handoffs | Unlimited, never metered | Unlimited |
| Data | Your deployment's database | Entirely yours |

## Structure & Running

The project is structured into two dedicated directories:
- **`frontend/`**: React client powered by Vite, Tailwind/PostCSS, and Lucide icons.
- **`backend/`**: Express server, MongoDB store, AI Agent SDK, and automated test suite.

### Frontend
```sh
cd frontend
npm install
npm run dev    # Starts Vite dev server on http://127.0.0.1:5173
npm run build  # Compiles client into frontend/dist
```

### Backend
```sh
cd backend
npm install
npm run dev    # Starts API server on http://127.0.0.1:3000 with tsx watch
npm run test   # Runs 33 automated tests
```

From the root `relay/` folder:
```sh
npm run dev:frontend    # Starts frontend dev server
npm run dev:backend     # Starts backend dev server
npm run build:frontend  # Builds frontend bundle
npm run test:backend    # Runs backend tests
```

### The free plan

Every workspace includes a monthly allowance that resets each calendar month:

- **300 conversations** (`FREE_CONVERSATIONS_LIMIT`)
- **1,000 AI assistant answers** (`FREE_AI_MESSAGES_LIMIT`)

When a conversation is over, customers can still reach a human in existing
threads — handoffs, human replies and ratings are never metered. The current
usage is visible to the team in **Settings → Free plan — this month** and via
`GET /api/admin/usage`. Set a limit to `0` to disable that cap entirely
(self-hosters who want unlimited set both to `0`).

### Free deployment in ~15 minutes (Vercel + Atlas)

The repo is Vercel-ready: `api/index.ts` runs the Express API as a serverless
function, the Vite build ships as static assets, and `vercel.json` wires the
routing. See **[DEPLOY-VERCEL.md](./DEPLOY-VERCEL.md)**. Everything runs on
free tiers — total cost $0, plus your own LLM key if you enable live mode.

Prefer a VM? See **[DEPLOY-OCI.md](./DEPLOY-OCI.md)** (any Ubuntu VM works).

### Docker

```sh
docker compose up --build
```

### CI

GitHub Actions (`.github/workflows/ci.yml`) typechecks, builds, and runs the full integration suite against a real MongoDB replica set on every pull request.

For development, `npm run dev` runs the backend on 3000 and Vite on 5173. `npm test` runs isolated integration tests; `npm run typecheck` checks frontend and backend.

## Accounts, sessions and RBAC

- **Provisioning:** on first start with an empty `users` collection, Relay creates the initial admin from `BOOTSTRAP_ADMIN_EMAIL` / `BOOTSTRAP_ADMIN_PASSWORD` (12+ chars). `BOOTSTRAP_ADMIN_NAME` is optional.
- **Sessions:** opaque 256-bit tokens; only sha256 hashes are stored, with a 30-day TTL index. Browsers get an `httpOnly` `SameSite=Lax` cookie (`Secure` is added automatically behind a TLS proxy when `TRUST_PROXY=1`).
- **Passwords:** scrypt with per-user salts and constant-time comparison; login is rate-limited per IP+email and never reveals whether an account exists.
- **Roles:** `admin` > `agent`. Admins manage accounts, FAQ writes and role changes; agents work the queue. Mutations are recorded in an `audit_events` collection.
- **Legacy fallback:** while no accounts exist, the shared `ADMIN_TOKEN` header still unlocks admin routes (open demo mode keeps working). It is ignored once real accounts are provisioned.

## API surface

- REST endpoints live under `/api/*` (legacy, unwrapped) and `/api/v1/*` (identical payloads wrapped in `{ success, data | error }` envelopes).
- Every response carries an `X-Request-Id` header; one structured JSON log line is emitted per request.
- `GET /api/health` reports process + database status (`503` when Mongo is unreachable); `GET /api/metrics` exposes Prometheus-style counters.
- `GET /api/admin/usage` returns free-plan usage for the current month.
- `GET /api/admin/conversations?limit=&offset=` returns `{ items, total, limit, offset }` (default/limit max 100/200).
- `GET /api/admin/events` is a Server-Sent Events stream (session-authenticated) broadcasting workspace events; the workspace UI subscribes and refreshes instantly, with polling as fallback.

## Email notifications

When `NOTIFY_EMAILS` is set (comma-separated recipients, max 10), Relay emails the team whenever a conversation joins the human queue. Delivery uses Resend's HTTP API when `RESEND_API_KEY` is present (`NOTIFY_FROM_EMAIL` overrides the sender); without a key, notifications are logged instead so nothing is silent. Mail failures never affect request handling.

## PWA / mobile

The frontend is an installable PWA: `public/manifest.webmanifest` plus an offline service worker (app-shell navigation fallback; `/api/*` is never cached). SEO basics ship in `index.html` along with `public/robots.txt` and `public/sitemap.xml`.

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

Optional variables: `CODEBUDDY_AUTH_TOKEN`, `CODEBUDDY_MODEL`, `CODEBUDDY_CODE_PATH`, `DATA_DIR`, `PORT`, `RELAY_TURN_DELAY_MS`, `ALLOWED_HOSTS`, `TRUST_PROXY`, `FREE_CONVERSATIONS_LIMIT` (default 300, `0` = unlimited), `FREE_AI_MESSAGES_LIMIT` (default 1000, `0` = unlimited). The actual authenticated model response must be verified with your own valid credentials.

## Features

- Customer multi-turn chat with reload-safe local conversation selection and server-side history.
- Ranked keyword/synonym FAQ retrieval with clickable source citations.
- Automatic refund, order inquiry, technical support and general intent recognition, retaining intent across follow-ups.
- Immediate human escalation on explicit requests and account-specific actions; automatic escalation after two low-confidence or unsuccessful troubleshooting turns. Waiting conversations stop receiving bot replies.
- Human queue: search, filter, assign, read transcript, reply, resolve. New queue items refresh automatically.
- A human's status decision always wins over an in-flight assistant turn.
- One 1–5 satisfaction rating per conversation.
- Dashboard and analytics: conversation counts, resolution rate, first response time, CSAT, intent distribution, rating distribution and 7/30-day activity.
- Editable FAQ knowledge base with persistent add/edit operations.
- Free-plan usage meters in Settings, with honest 429 messaging at the cap.

## Data and metric definitions

MongoDB stores conversations (with embedded owner token hashes), messages, citations, ratings, FAQs, tool-call events and idempotency keys. Idempotency entries expire automatically after 24 hours via a TTL index. `MONGODB_URI` and `MONGODB_DB` change the connection; demo and live modes use separate databases so records never mix.

- **Resolution rate:** conversations currently resolved / conversations created in the selected window. It is not an AI-only success rate.
- **CSAT:** ratings of 4 or 5 / all ratings on conversations in the selected window.
- **Conversation volume:** one count per conversation, on its creation day; human if it has a human reply or is awaiting a human, assistant otherwise.
- **First response:** mean time from the first customer message to the first assistant/human reply in the window; system notices do not count.
- Date grouping uses the server's local calendar timezone.

## CodeBuddy integration and safety

`server/agent.ts` calls the real SDK `query()` API with a bounded history and retrieved FAQ context. User content is treated as data, tools are denied, external MCP servers and user/project settings are not loaded, and each request has a 30-second abort timer. SDK failures preserve the user message and escalate honestly rather than masquerading as successful AI responses.

Customer endpoints require a random per-conversation owner token. Admin endpoints accept a cookie session from a real account, or the legacy `ADMIN_TOKEN` header while no accounts exist; live mode refuses to start without `ADMIN_TOKEN`. Body limits, validation, request throttling, Host/Origin checks and audit logging are enabled.

## Before public deployment

Add HTTPS, proper user accounts/SSO and role-based access, audit and retention policies, operational monitoring, privacy review and durable hosting. Replace sample policies and demo identities. Relay cannot issue refunds, track real parcels, or notify an external helpdesk in this version; handoff is to its built-in human inbox.

## Active source

- `src/App.tsx`: thin path router — `/` landing, `/app` workspace, `/chat` customer view.
- `src/Landing.tsx`: marketing page with the free/self-host story.
- `src/admin/AdminApp.tsx`: workspace shell, overview, inbox, knowledge, analytics and settings (with usage meters).
- `src/customer/CustomerCenter.tsx`: customer chat with handoff staging and demo starters.
- `src/ui/shared.tsx`: shared UI primitives, formatting helpers and chart components.
- `src/Auth.tsx`: login page, session hook and account card.
- `src/ErrorBoundary.tsx`: render-error containment for the workspace.
- `src/service-api.ts`, `src/service-types.ts`: typed client contract and session handling.
- `server/index.ts`: API, access control, free-plan guards, handoffs and static hosting.
- `server/plan.ts`: free-tier limits, month window and usage summary.
- `server/auth.ts`, `server/auth-routes.ts`: accounts, sessions, RBAC and audit.
- `server/events.ts`, `server/notify.ts`: realtime event bus and email notifications.
- `server/logger.ts`, `server/http.ts`: structured logging, request IDs, envelopes, metrics.
- `server/db.ts`: MongoDB repositories, indexes, demo seed and statistics.
- `server/knowledge.ts`: sample FAQs, ranking and intent rules.
- `server/orders.ts`: mocked order catalogue backing the lookup tool call.
- `server/agent.ts`: demo responder and real CodeBuddy adapter.
- `server/env.ts`: project-local .env loading.
- `tests/support.test.ts`: reproducible backend tests (run against MongoDB).
