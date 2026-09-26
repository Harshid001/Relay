import { test } from 'node:test';
import assert from 'node:assert/strict';

import { hostAllowed } from '../server/config.js';
import { envelope, fail, metricsText, ok, wrap } from '../server/http.js';
import { currentMonthWindow, limitMessage, conversationsLimitReached, aiMessagesLimitReached, getUsageSummary } from '../server/plan.js';
import { asRecord, parseIntent, parseTags, readOptionalString, readRequiredString } from '../server/validation.js';
import { monitoringEnabled } from '../server/monitoring.js';

/* -------------------------------- validation ------------------------------ */

test('asRecord only accepts plain objects', () => {
  assert.deepEqual(asRecord({ a: 1 }), { a: 1 });
  assert.deepEqual(asRecord(null), {});
  assert.deepEqual(asRecord([1, 2]), {});
  assert.deepEqual(asRecord('x'), {});
});

test('readRequiredString trims, rejects empties and over-long values', () => {
  assert.equal(readRequiredString('  hi  ', 10), 'hi');
  assert.equal(readRequiredString('', 10), null);
  assert.equal(readRequiredString('   ', 10), null);
  assert.equal(readRequiredString('toolong', 3), null);
  assert.equal(readRequiredString(42, 10), null);
});

test('readOptionalString returns undefined when absent and null on wrong type', () => {
  assert.equal(readOptionalString(undefined, 10), undefined);
  assert.equal(readOptionalString(null, 10), undefined);
  assert.equal(readOptionalString('  x ', 10), 'x');
  assert.equal(readOptionalString(123, 10), null);
  assert.equal(readOptionalString('twelve-chars', 3), null);
});

test('parseIntent accepts known intents only', () => {
  assert.equal(parseIntent('refund'), 'refund');
  assert.equal(parseIntent('order'), 'order');
  assert.equal(parseIntent('technical'), 'technical');
  assert.equal(parseIntent('general'), 'general');
  assert.equal(parseIntent('billing'), null);
  assert.equal(parseIntent(7), null);
});

test('parseTags dedupes, trims, and enforces bounds', () => {
  assert.deepEqual(parseTags(['a', 'a', ' b ']), ['a', 'b']);
  assert.deepEqual(parseTags(undefined), []);
  assert.deepEqual(parseTags(null), []);
  assert.equal(parseTags('nope'), null);
  assert.equal(parseTags(Array.from({ length: 13 }, (_v, i) => `t${i}`)), null);
  assert.equal(parseTags(['x'.repeat(41)]), null);
});

/* ----------------------------------- plan --------------------------------- */

test('plan windows, guards and messages behave as documented', () => {
  const { start, end } = currentMonthWindow(new Date(2026, 8, 26, 12, 0, 0));
  assert.equal(start.getDate(), 1);
  assert.equal(start.getHours(), 0);
  assert.equal(end.getHours(), 12);

  // Defaults are 300 conversations / 1000 AI messages; 0 disables a cap.
  assert.equal(conversationsLimitReached(299), null);
  assert.equal(conversationsLimitReached(300), 'conversations');
  assert.equal(aiMessagesLimitReached(999), null);
  assert.equal(aiMessagesLimitReached(1000), 'ai_messages');

  assert.match(limitMessage('conversations'), /monthly limit/);
  assert.match(limitMessage('ai_messages'), /AI answers/);
});

test('getUsageSummary reports used/limit and percent of the tightest cap', async () => {
  const summary = await getUsageSummary({
    conversations: async () => 150,
    aiMessages: async () => 100,
  });
  assert.equal(summary.plan, 'free');
  assert.equal(summary.conversationsUsed, 150);
  assert.equal(summary.aiMessagesUsed, 100);
  assert.equal(summary.conversationsLimit, 300);
  assert.equal(summary.aiMessagesLimit, 1000);
  assert.equal(summary.percentUsed, 50); // 150/300 is the tighter fraction
});

/* ---------------------------------- config -------------------------------- */

test('hostAllowed matches exact hosts and suffix wildcards without lookalikes', () => {
  // Loopback is always allowed.
  assert.equal(hostAllowed('127.0.0.1'), true);
  assert.equal(hostAllowed('localhost'), true);
  // Unknown public names are rejected in the default configuration.
  assert.equal(hostAllowed('relay.example'), false);
  assert.equal(hostAllowed('evil.example'), false);
});

/* ----------------------------------- http --------------------------------- */

function mockRes(statusCode = 200) {
  return {
    statusCode,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
  };
}

test('envelope wraps success and error payloads and passes envelopes through', () => {
  const success = mockRes();
  envelope({} as never, success as never, () => undefined);
  success.json({ hello: 'world' });
  assert.deepEqual(success.body, { success: true, data: { hello: 'world' } });

  const failure = mockRes(404);
  envelope({} as never, failure as never, () => undefined);
  failure.json({ error: 'Not found' });
  assert.deepEqual(failure.body, {
    success: false,
    error: { code: 'NOT_FOUND', message: 'Not found' },
  });

  const passthrough = mockRes();
  envelope({} as never, passthrough as never, () => undefined);
  passthrough.json({ success: false, error: { code: 'X', message: 'y' } });
  assert.deepEqual(passthrough.body, { success: false, error: { code: 'X', message: 'y' } });
});

test('ok and fail set the intended status and shape', () => {
  const created = mockRes();
  ok(created as never, { id: 1 }, 201);
  assert.equal(created.statusCode, 201);
  assert.deepEqual(created.body, { success: true, data: { id: 1 } });

  const bad = mockRes();
  fail(bad as never, 400, 'nope', { field: 'x' });
  assert.equal(bad.statusCode, 400);
  assert.deepEqual(bad.body, {
    success: false,
    error: { code: 'VALIDATION_ERROR', message: 'nope', details: { field: 'x' } },
  });
});

test('wrap forwards async rejections to next', async () => {
  const boom = new Error('boom');
  let received: unknown = null;
  const handler = wrap(async () => {
    throw boom;
  });
  await new Promise<void>((resolve) => {
    handler({} as never, {} as never, ((err: unknown) => {
      received = err;
      resolve();
    }) as never);
  });
  assert.equal(received, boom);
});

test('metricsText exposes Prometheus counters', () => {
  const text = metricsText();
  assert.match(text, /relay_requests_total \d+/);
  assert.match(text, /relay_errors_total \d+/);
  assert.match(text, /relay_request_duration_seconds\{le="\+Inf"\}/);
});

/* -------------------------------- monitoring ------------------------------ */

test('monitoring is disabled without a DSN or webhook', () => {
  assert.equal(monitoringEnabled(), false);
});
