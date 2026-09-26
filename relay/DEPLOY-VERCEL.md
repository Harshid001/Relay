# Deploying Relay to Vercel + MongoDB Atlas

**Total cost: $0.** Relay's free plan (300 conversations · 1,000 AI answers per
month, human handoffs always unlimited) runs entirely on free tiers:

Serverless production topology — no VM to babysit:

```
Browser ─> Vercel (CDN: static React build + serverless Express API)
                    │
                    └─> MongoDB Atlas (free M0 cluster, replica set)
```

The repo ships ready for this: `api/index.ts` is the serverless entrypoint
and `vercel.json` routes `/api/*` to it while serving the Vite build from
`dist/` with an SPA fallback.

---

## 1 · MongoDB Atlas (free tier)

1. [cloud.mongodb.com](https://cloud.mongodb.com) → Build a **M0 (Free)** cluster.
2. **Database Access** → create a user (remember the password).
3. **Network Access** → allow `0.0.0.0/0`. Serverless platforms have no fixed
   outbound IPs; with a strong unique password this is the standard M0 trade-off.
4. **Connect → Drivers** → copy the SRV URI. Append your database name if you
   like (`…mongodb.net/relay`) — otherwise `MONGODB_DB` picks it.

> **Never commit the URI** (it contains the password). It lives in Vercel's
> env vars only. If it was ever pasted into a chat, a ticket, or a file,
> rotate the password from Database Access first.

## 2 · Vercel

1. Push the repo to GitHub, then [vercel.com/new](https://vercel.com/new) →
   Import. Framework preset **Vite** is auto-detected; `vercel.json` supplies
   the rest (`npm run build`, output `dist/`, API routing).
2. Environment variables (Project → Settings → Environment Variables):

   | Variable | Value |
   |---|---|
   | `MONGODB_URI` | your Atlas SRV URI |
   | `MONGODB_DB` | `relay` |
   | `SEED_DEMO` | `true` for the demo experience, `false` for real use |
   | `ADMIN_TOKEN` | `openssl rand -hex 32` |
   | `TRUST_PROXY` | `1` (Vercel is one proxy hop; enables client-IP rate limits + Secure cookies) |
   | `ALLOWED_HOSTS` | `*.vercel.app` (preview deploys) plus your custom domain |
   | `BOOTSTRAP_ADMIN_EMAIL` | you@yourdomain.com |
   | `BOOTSTRAP_ADMIN_PASSWORD` | 12+ characters |
   | `NOTIFY_EMAILS` / `RESEND_API_KEY` | optional email alerts |
   | `CODEBUDDY_LIVE` | keep `false` — the live SDK path spawns a CLI process and is not serverless-safe |
   | `FREE_CONVERSATIONS_LIMIT` | optional; default `300`, set `0` for unlimited |
   | `FREE_AI_MESSAGES_LIMIT` | optional; default `1000`, set `0` for unlimited |
   | `MONGODB_MAX_POOL_SIZE` | optional; default `10` on serverless, `20` on VM |

3. **Deploy.** Verify:
   - Base health: `curl https://<app>.vercel.app/api/health` → `{"status":"ok",…}`
   - System health: `curl https://<app>.vercel.app/api/health/system` → `{"status":"healthy","components":{…}}`
   First login provisions nothing extra — the bootstrap admin already exists.
4. Custom domain: Project → Domains → add it, then **append it to
   `ALLOWED_HOSTS`** and redeploy (unknown hosts get `403 Forbidden host`).

## 3 · Serverless caveats (all documented in code)

- **Realtime:** the admin SSE stream lives as long as one function invocation
  (`maxDuration: 60`); the workspace UI's polling fallback covers updates
  after a stream recycle.
- **Rate limits & busy locks** are per serverless instance — approximate, not
  global. Move to a shared store if that ever matters.
- **Cold starts:** the first request after idle pays the Atlas connect +
  index build (~1–2 s).
- **Backups:** Atlas M0 has no continuous backups. Periodically run
  `mongodump --uri "$MONGODB_URI" --archive --gzip` from your machine (or a
  scheduled GitHub Action) and store the archive in Cloudflare R2 via
  `scripts/backup-r2.sh` as a reference for the S3 upload half.

## Free-tier budget

| Resource | Free allowance | This deployment |
|---|---|---|
| Vercel Hobby | 100 GB bandwidth/mo, generous function time | support traffic, well under |
| Atlas M0 | 512 MB storage, shared | conversations + FAQs, fine for years of demo use |
| Relay free plan | 300 conversations · 1,000 AI answers/mo | raise or remove on your own deploy via env vars |
