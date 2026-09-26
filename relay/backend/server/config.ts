/**
 * Environment-derived configuration and the Host/Origin guard.
 *
 * Extracted from server/index.ts so the HTTP wiring stays readable and this
 * policy can be reasoned about (and tested) on its own.
 */

import type { Request, RequestHandler, Response } from 'express';

import { isLiveMode } from './agent.js';

export const PORT = Number(process.env.PORT ?? 3000);
export const HOST = process.env.HOST ?? '127.0.0.1';

export const LIVE = isLiveMode();
export const MODE: 'demo' | 'live' = LIVE ? 'live' : 'demo';

export const ADMIN_TOKEN = (process.env.ADMIN_TOKEN ?? '').trim();
export const ADMIN_AUTH_REQUIRED = ADMIN_TOKEN.length > 0;

// Behind a TLS-terminating proxy the socket address is the proxy's: TRUST_PROXY
// is the number of hops in front of the app (1 for Caddy/nginx/Vercel, 2 when
// Cloudflare proxies into Caddy). A hop count — not "true" — is spoof-proof.
const rawTrustProxyHops = Number.parseInt(process.env.TRUST_PROXY ?? '', 10);
export const TRUST_PROXY_HOPS =
  Number.isInteger(rawTrustProxyHops) && rawTrustProxyHops > 0 ? rawTrustProxyHops : 0;
export const TRUST_PROXY_ENABLED = TRUST_PROXY_HOPS > 0;

/**
 * Hostnames this deployment answers for. Loopback is always allowed so the
 * local prototype and container healthchecks work out of the box; production
 * adds its public name(s) via ALLOWED_HOSTS (comma-separated). Requests whose
 * Host or Origin header is not on the list are rejected with 403. Set
 * ALLOWED_HOSTS="*" to disable the check entirely — not recommended: the
 * Origin guard blocks cross-site writes against cookie sessions.
 */
const ALLOWED_HOSTNAMES = new Set([
  '127.0.0.1',
  'localhost',
  '::1',
  '[::1]',
  ...(process.env.ALLOWED_HOSTS ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean),
]);
export const ALLOW_ALL_HOSTS = ALLOWED_HOSTNAMES.has('*');

/** Exact names plus suffix wildcards like "*.vercel.app" (any subdomain). */
export function hostAllowed(hostname: string): boolean {
  if (ALLOW_ALL_HOSTS) return true;
  for (const entry of ALLOWED_HOSTNAMES) {
    if (entry.startsWith('*.')) {
      const suffix = entry.slice(1); // '.vercel.app'
      if (hostname.endsWith(suffix) && hostname.length > suffix.length) return true;
    } else if (hostname === entry) {
      return true;
    }
  }
  return false;
}

/**
 * Fails fast on unsafe live-mode configuration, and warns about the settings
 * that silently weaken security when omitted. Runs once at import time.
 */
export function assertLiveConfig(): void {
  if (LIVE && !ADMIN_AUTH_REQUIRED) {
    console.error(
      '[relay] CODEBUDDY_LIVE=true requires ADMIN_TOKEN to be set. Refusing to start in live mode without admin authentication.',
    );
    process.exit(1);
  }
  if (LIVE && ALLOW_ALL_HOSTS) {
    console.error(
      '[relay] WARNING: ALLOWED_HOSTS="*" disables the Host/Origin guard in live mode. ' +
        'Set ALLOWED_HOSTS to your domain(s) unless you accept losing cross-site-write protection.',
    );
  }
  if (LIVE && !TRUST_PROXY_ENABLED) {
    console.warn(
      '[relay] WARNING: live mode is running without TRUST_PROXY. Behind a proxy or custom ' +
        'domain this collapses all clients into one rate-limit bucket and drops the Secure ' +
        'flag from session cookies. Set TRUST_PROXY to the number of proxy hops in front of ' +
        'the app (1 behind a single Caddy/nginx, 2 when Cloudflare proxies into Caddy).',
    );
  }
}

assertLiveConfig();

/**
 * Sets the mode header and rejects requests whose Host or Origin is not an
 * allowed hostname (403), including `Origin: null`.
 */
export const hostOriginGuard: RequestHandler = (req: Request, res: Response, next) => {
  res.setHeader('X-Relay-Mode', MODE);

  const hostHeader = String(req.headers.host ?? '');
  if (hostHeader) {
    const match = hostHeader.match(/^(\[[^\]]+\]|[^:]+)/);
    const hostname = (match ? match[1] : hostHeader).toLowerCase();
    if (!hostAllowed(hostname)) {
      res.status(403).json({ error: 'Forbidden host' });
      return;
    }
  }

  const origin = req.headers.origin;
  if (origin === 'null') {
    res.status(403).json({ error: 'Forbidden origin' });
    return;
  }
  if (typeof origin === 'string' && origin) {
    let originHost = '';
    try {
      originHost = new URL(origin).hostname.toLowerCase();
    } catch {
      res.status(403).json({ error: 'Forbidden origin' });
      return;
    }
    if (!hostAllowed(originHost)) {
      res.status(403).json({ error: 'Forbidden origin' });
      return;
    }
  }

  next();
};
