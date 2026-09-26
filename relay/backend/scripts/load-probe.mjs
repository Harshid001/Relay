#!/usr/bin/env node
/**
 * Dependency-free HTTP load probe (perf smoke, not a benchmark suite).
 *
 * Hits public read endpoints of a RUNNING Relay server and reports latency
 * percentiles + status codes. Start the server first, e.g.:
 *   npm run dev            # backend on :3000 (needs MONGODB_URI or local mongo)
 *   node scripts/load-probe.mjs --url http://127.0.0.1:3000
 *
 * Flags: --url (default http://127.0.0.1:3000) --requests (default 500)
 *        --concurrency (default 20)
 *
 * Exit 1 when any request fails or p95 exceeds 2000 ms (generous ceiling for
 * cold dev hardware; tighten per environment in CI).
 */
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 || args[i + 1] === undefined ? fallback : args[i + 1];
};
const BASE = String(opt('url', 'http://127.0.0.1:3000')).replace(/\/+$/, '');
const TOTAL = Math.max(1, Number(opt('requests', 500)) || 500);
const CONCURRENCY = Math.min(200, Math.max(1, Number(opt('concurrency', 20)) || 20));

const ROUTES = ['/api/health', '/api/faqs', '/api/openapi.json'];

function pct(sorted, p) {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

async function worker(n, stats) {
  for (let i = 0; i < n; i++) {
    const route = ROUTES[i % ROUTES.length];
    const start = process.hrtime.bigint();
    try {
      const res = await fetch(`${BASE}${route}`);
      await res.arrayBuffer();
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      stats.lat.push(ms);
      stats.codes.set(res.status, (stats.codes.get(res.status) ?? 0) + 1);
      if (!res.ok) stats.errors.push(`${route} -> ${res.status}`);
    } catch (err) {
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      stats.lat.push(ms);
      stats.errors.push(`${route} -> ${String(err).slice(0, 120)}`);
    }
  }
}

const stats = { lat: [], codes: new Map(), errors: [] };
const t0 = Date.now();
const perWorker = Math.ceil(TOTAL / CONCURRENCY);
await Promise.all(
  Array.from({ length: CONCURRENCY }, (_, w) =>
    worker(w === CONCURRENCY - 1 ? TOTAL - perWorker * (CONCURRENCY - 1) : perWorker, stats),
  ),
);
const wallMs = Date.now() - t0;
stats.lat.sort((a, b) => a - b);

console.log(`probe: ${TOTAL} requests x ${CONCURRENCY} concurrency -> ${BASE}`);
console.log(`wall: ${wallMs} ms  (~${(TOTAL / (wallMs / 1000)).toFixed(0)} rps)`);
console.log(
  `latency ms: min ${stats.lat[0]?.toFixed(1)}  p50 ${pct(stats.lat, 50).toFixed(1)}  ` +
    `p95 ${pct(stats.lat, 95).toFixed(1)}  p99 ${pct(stats.lat, 99).toFixed(1)}  max ${stats.lat.at(-1)?.toFixed(1)}`,
);
console.log(`status: ${[...stats.codes.entries()].map(([s, n]) => `${s}x${n}`).join(' ')}`);
if (stats.errors.length > 0) {
  console.log(`errors (${stats.errors.length}):`);
  for (const e of stats.errors.slice(0, 10)) console.log(`  ${e}`);
}
const p95 = pct(stats.lat, 95);
if (stats.errors.length > 0 || p95 > 2000) {
  console.error('PROBE FAILED: errors present or p95 > 2000 ms');
  process.exit(1);
}
console.log('PROBE PASSED');
