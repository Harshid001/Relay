import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { detectIntent, searchFaqs, SEED_FAQS, policyHandoff } from '../server/knowledge.js';
import { parseAgentReply, buildLivePrompt } from '../server/agent.js';

const project = fileURLToPath(new URL('../', import.meta.url));
const artifacts = path.join(project, 'artifacts');
mkdirSync(artifacts, { recursive: true });
const dataDir = mkdtempSync(path.join(artifacts, 'test-data-'));
const adminHeaders = { 'x-admin-token': 'test-admin-only' };
let child: ChildProcess;
let base: string;
let current: { id: string; token: string };
let savedMessageCount = 0;

async function launch(extra: Record<string, string> = {}) {
  const proc = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), path.join(project, 'tests/server-fixture.ts')], {
    cwd: project,
    env: { ...process.env, DATA_DIR: dataDir, ADMIN_TOKEN: 'test-admin-only', SEED_DEMO: 'false', CODEBUDDY_LIVE: 'false', MONGODB_DB: `relay_test_${path.basename(dataDir).replace(/[^a-z0-9]/gi, '')}`, ...extra },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const url = await new Promise<string>((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => { proc.kill(); reject(new Error(`Server startup timed out: ${output}`)); }, 20000);
    proc.stdout!.on('data', chunk => {
      output += chunk;
      const match = output.match(/READY:(\d+)/);
      if (match) { clearTimeout(timer); resolve(`http://127.0.0.1:${match[1]}`); }
    });
    proc.stderr!.on('data', chunk => { output += chunk; });
    proc.once('error', e => { clearTimeout(timer); reject(e); });
    proc.once('exit', code => { clearTimeout(timer); reject(new Error(`Server exited ${code}: ${output}`)); });
  });
  return { proc, url };
}
async function stop(proc: ChildProcess) {
  if (proc.exitCode === null && proc.signalCode === null) { const done = once(proc, 'exit'); proc.kill(); await done; }
}
async function req(route: string, body?: unknown, headers: Record<string, string> = adminHeaders, method?: string) {
  const response = await fetch(base + route, {
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    headers: { ...headers, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, data: await response.json() as any };
}
async function create() {
  const result = await req('/api/conversations', { customer: 'Test Customer', email: 'customer@example.test' }, {});
  assert.equal(result.status, 201);
  return { id: result.data.conversation.id, token: result.data.accessToken };
}
async function send(session: {id:string;token:string}, text: string, clientId?: string) {
  return req(`/api/conversations/${session.id}/messages`, { content: text, clientId }, { 'x-conversation-token': session.token });
}
before(async () => { const instance = await launch(); child = instance.proc; base = instance.url; });
after(async () => { if (child) await stop(child); });

test('classifies refund, order and technical intents and retains follow-up context', () => {
  assert.equal(detectIntent('What is the refund policy?').intent, 'refund');
  assert.equal(detectIntent('Where is my delivery?').intent, 'order');
  assert.equal(detectIntent('I cannot login to my account').intent, 'technical');
  assert.equal(detectIntent('It still does not work', 'technical').intent, 'technical');
});
test('retrieves policy evidence instead of inventing account actions', () => {
  const retrieval = searchFaqs('refund', SEED_FAQS);
  assert.ok(retrieval.best);
  assert.equal(retrieval.best.faq.category, 'refund');
  assert.match(retrieval.best.faq.answer, /30/);
  assert.equal(policyHandoff('I want to talk to a human').escalate, true);
  assert.equal(policyHandoff('Cancel my order').escalate, true);
});
test('parses structured SDK responses and bounds conversation context', () => {
  assert.deepEqual(parseAgentReply('{"reply":"Hello","intent":"order","escalate":false}'), { reply:'Hello',intent:'order',escalate:false,usedOrderLookup:false });
  assert.deepEqual(parseAgentReply('{"reply":"Found it","intent":"order","escalate":false,"used_order_lookup":true}'), { reply:'Found it',intent:'order',escalate:false,usedOrderLookup:true });
  assert.equal(parseAgentReply('not json'), null);
  assert.equal(parseAgentReply('{"reply":""}'), null);
  const prompt = buildLivePrompt({ userText: 'Hello', history: Array.from({length:30}, () => ({role:'user' as const, content:'x'.repeat(5000)})), faqs: [] });
  assert.ok(prompt.length < 17000);
});
test('reports demo mode with auth and seeded FAQs but no fake conversations', async () => {
  const health = await req('/api/health', undefined, {});
  assert.equal(health.status, 200); assert.equal(health.data.mode, 'demo'); assert.equal(health.data.adminAuthRequired, true);
  const faqs = await req('/api/faqs', undefined, {}); assert.ok(faqs.data.length >= 12);
  const stats = await req('/api/admin/stats?days=7'); assert.equal(stats.data.total, 0); assert.equal(stats.data.csat, null);
});
test('protects admin logs and rejects cross-origin state changes', async () => {
  assert.equal((await req('/api/admin/conversations', undefined, {})).status, 401);
  assert.equal((await req('/api/admin/conversations', undefined, {'x-admin-token':'wrong'})).status, 401);
  assert.equal((await req('/api/conversations', {}, {Origin:'https://untrusted.example'})).status, 403);
  assert.equal((await req('/api/conversations', {}, {Origin:'null'})).status, 403);
});
test('creates an owner-protected conversation', async () => {
  current = await create(); assert.ok(current.token.length >= 32);
  assert.equal((await req(`/api/conversations/${current.id}`, undefined, {})).status, 404);
  assert.equal((await req(`/api/conversations/${current.id}`, undefined, {'x-conversation-token':'wrong'})).status, 404);
  assert.equal((await req(`/api/conversations/${current.id}`, undefined, {'x-conversation-token':current.token})).status, 200);
});
test('answers FAQ questions with intent, source citations and persistent turns', async () => {
  const response = await send(current, 'What is your refund policy?', 'first-turn');
  assert.equal(response.status, 200); assert.equal(response.data.conversation.intent, 'refund');
  const assistant = response.data.messages.findLast((m:any) => m.role === 'assistant');
  assert.match(assistant.content, /30/); assert.ok(assistant.sources.length); assert.equal(assistant.provider, 'demo');
  savedMessageCount = response.data.messages.length;
});
test('deduplicates retried message IDs and validates message bodies', async () => {
  const duplicate = await send(current, 'What is your refund policy?', 'first-turn');
  assert.equal(duplicate.data.messages.length, savedMessageCount);
  assert.equal((await send(current, '')).status, 400);
  assert.equal((await send(current, 'x'.repeat(4001))).status, 400);
});
test('automatically hands off after two failed troubleshooting attempts', async () => {
  const support = await create();
  await send(support, 'I cannot login to my account');
  const first = await send(support, 'The login still does not work');
  assert.equal(first.data.conversation.intent, 'technical');
  const second = await send(support, 'The same login problem is not fixed');
  assert.equal(second.data.conversation.status, 'waiting');
  assert.match(second.data.conversation.escalationReason, /unresolved|unsuccessful/i);
});
test('hands off low-confidence conversations rather than hallucinating', async () => {
  const support = await create();
  await send(support, 'What is the orbital period of Neptune?');
  const second = await send(support, 'Explain quasars and pulsars please');
  assert.equal(second.data.conversation.status, 'waiting');
});
test('explicit human request creates a queue item and suppresses future bot replies', async () => {
  const escalated = await send(current, 'Please connect me to a human agent');
  assert.equal(escalated.data.conversation.status, 'waiting');
  const count = escalated.data.messages.filter((m:any) => m.role === 'assistant').length;
  const next = await send(current, 'Here is some more context for the human');
  assert.equal(next.data.messages.filter((m:any) => m.role === 'assistant').length, count);
  const list = await req('/api/admin/conversations'); assert.ok(list.data.items.some((c:any) => c.id === current.id && c.status === 'waiting'));
});
test('supports human assignment, reply, resolution and customer visibility', async () => {
  const assigned = await req(`/api/admin/conversations/${current.id}/assign`, {name:'Alex Morgan'});
  assert.equal(assigned.data.assignee, 'Alex Morgan');
  const reply = await req(`/api/admin/conversations/${current.id}/reply`, {content:'I can help you complete the return request.'});
  assert.equal(reply.data.role, 'human');
  const resolved = await req(`/api/admin/conversations/${current.id}/resolve`, {}); assert.equal(resolved.data.status, 'resolved');
  const owner = await req(`/api/conversations/${current.id}`, undefined, {'x-conversation-token':current.token});
  assert.ok(owner.data.messages.some((m:any) => m.content === reply.data.content)); savedMessageCount = owner.data.messages.length;
});
test('persists one rating and derives accurate satisfaction statistics', async () => {
  const owner = {'x-conversation-token':current.token};
  assert.equal((await req(`/api/conversations/${current.id}/rating`, {score:6}, owner)).status, 400);
  assert.equal((await req(`/api/conversations/${current.id}/rating`, {score:5}, owner)).status, 200);
  assert.equal((await req(`/api/conversations/${current.id}/rating`, {score:1}, owner)).status, 409);
  const stats = await req('/api/admin/stats?days=7');
  assert.equal(stats.data.ratingCount, 1); assert.equal(stats.data.csat, 100); assert.equal(stats.data.volume.length, 7);
  assert.equal(stats.data.total, 3); assert.equal(stats.data.waiting, 2); assert.equal(stats.data.resolutionRate, 33.3);
});
test('creates and edits FAQ articles and uses updated knowledge in replies', async () => {
  const created = await req('/api/admin/faqs', { title:'Moonstone setup guide', answer:'Use the silver switch to activate Moonstone.', category:'technical',tags:['moonstone','setup'] });
  assert.equal(created.status, 201);
  const updated = await req(`/api/admin/faqs/${created.data.id}`, {answer:'Use the blue switch to activate Moonstone.'}, adminHeaders, 'PATCH');
  assert.equal(updated.status, 200);
  const session = await create(); const reply = await send(session, 'Moonstone setup guide');
  assert.ok(reply.data.messages.some((m:any) => m.content.includes('blue switch')));
});
test('known order number gets a tool-call lookup instead of a handoff', async () => {
  const session = await create();
  const result = await send(session, "Where's my order #4471? It was supposed to arrive today.");
  assert.equal(result.status, 200);
  assert.equal(result.data.conversation.status, 'open');
  assert.equal(result.data.conversation.intent, 'order');
  const assistant = result.data.messages.findLast((m:any) => m.role === 'assistant');
  assert.ok(assistant.tool);
  assert.equal(assistant.tool.name, 'lookup_order');
  assert.equal(assistant.tool.args.orderId, '4471');
  assert.match(assistant.content, /SS-9204-4471|delivery van/);
  assert.equal(result.data.toolEvent?.name, 'lookup_order');
  // An unknown order number still hands off honestly rather than guessing.
  const unknown = await send(session, 'Where is my order #9999?');
  assert.equal(unknown.data.conversation.status, 'waiting');
});

test('survives an actual backend process restart without losing history or ratings', async () => {
  await stop(child); const restarted = await launch(); child = restarted.proc; base = restarted.url;
  const detail = await req(`/api/conversations/${current.id}`, undefined, {'x-conversation-token':current.token});
  assert.equal(detail.status, 200); assert.equal(detail.data.messages.length, savedMessageCount);
  assert.equal(detail.data.conversation.rating, 5); assert.equal(detail.data.conversation.assignee, 'Alex Morgan');
  assert.equal(detail.data.conversation.status, 'resolved');
});
test('a human resolve during an in-flight turn is not reverted', async () => {
  const original = base;
  // The delay keeps the assistant turn in flight while the human resolves.
  const slow = await launch({ RELAY_TURN_DELAY_MS: '1500' });
  try {
    base = slow.url;
    const session = await create();
    const pending = send(session, 'Please connect me to a human agent');
    await new Promise((resolve) => setTimeout(resolve, 400));
    const resolved = await req(`/api/admin/conversations/${session.id}/resolve`, {});
    assert.equal(resolved.data.status, 'resolved');
    const finished = await pending;
    assert.equal(finished.status, 200);
    const after = await req(`/api/admin/conversations/${session.id}`);
    assert.equal(after.data.conversation.status, 'resolved');
    assert.equal(after.data.conversation.escalationReason, null);
  } finally {
    base = original;
    await stop(slow.proc);
  }
});
test('live mode fails closed without admin authentication', async () => {
  await assert.rejects(launch({ CODEBUDDY_LIVE:'true', ADMIN_TOKEN:'' }), /requires ADMIN_TOKEN/);
});
test('volume counts each conversation once and system notices are not first responses', async () => {
  const support = await create();
  await send(support, 'Where is my order?');
  await send(support, 'Please connect me to a human agent');
  const before = await req('/api/admin/stats?days=7');
  const volumeTotal = before.data.volume.reduce((sum:number, point:any) => sum + point.ai + point.human, 0);
  assert.equal(volumeTotal, before.data.total);
  const responseBefore = before.data.avgResponseSeconds;
  // Resolving a thread drops in a system notice with no reply after the last
  // customer message; that must not be averaged in as a sub-second response.
  await req(`/api/admin/conversations/${support.id}/resolve`, {});
  const after = await req('/api/admin/stats?days=7');
  assert.ok(after.data.avgResponseSeconds === null || after.data.avgResponseSeconds >= (responseBefore ?? 0) * 0.5);
});
test('SDK startup failure escalates honestly without making an external model call', async () => {
  const original = base;
  const live = await launch({ CODEBUDDY_LIVE:'true', CODEBUDDY_CODE_PATH:path.join(project,'artifacts','missing-cli-for-test'), CODEBUDDY_API_KEY:'', CODEBUDDY_AUTH_TOKEN:'' });
  try {
    base = live.url; const session = await create(); const result = await send(session, 'What is your refund policy?');
    assert.equal(result.data.conversation.status, 'waiting');
    assert.ok(result.data.messages.some((m:any) => /temporarily unavailable/i.test(m.content)));
    assert.equal(result.data.messages.filter((m:any) => m.role === 'user').length, 1);
    assert.ok(!result.data.messages.some((m:any) => m.provider === 'demo'));
  } finally { base = original; await stop(live.proc); }
});

test('admin SSE stream broadcasts conversation events in real time', async () => {
  const original = base;
  const instance = await launch({
    ADMIN_TOKEN: '',
    BOOTSTRAP_ADMIN_EMAIL: 'sse@relay.test',
    BOOTSTRAP_ADMIN_PASSWORD: 'bootstrap-pass-123',
    // Distinct database: the shared per-run database is bootstrapped by the
    // auth test below, and bootstrap only runs when no users exist.
    MONGODB_DB: `relay_test_sse_${path.basename(dataDir).replace(/[^a-z0-9]/gi, '')}`,
  });
  try {
    base = instance.url;
    const login = await fetch(base + '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'sse@relay.test', password: 'bootstrap-pass-123' }),
    });
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];

    // Open the stream, wait for headers, then escalate a conversation.
    const controller = new AbortController();
    const stream = await fetch(base + '/api/admin/events', { headers: { cookie }, signal: controller.signal });
    assert.equal(stream.status, 200);
    assert.equal(stream.headers.get('content-type'), 'text/event-stream');

    const session = await create();
    const escalation = req(`/api/conversations/${session.id}/escalate`, { reason: 'sse test' }, { 'x-conversation-token': session.token });

    // Read the stream until the conversation event arrives (or timeout).
    const reader = stream.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let received = false;
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      while (!received) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        if (buffer.includes('"type":"conversation"') && buffer.includes(`"id":"${session.id}"`)) {
          received = true;
        }
      }
    } catch {
      /* abort on timeout */
    } finally {
      clearTimeout(timeout);
      controller.abort();
    }
    await escalation;
    assert.ok(received, 'expected a conversation event on the SSE stream');
  } finally {
    base = original;
    await stop(instance.proc);
  }
});

test('account auth: bootstrap, login, session cookies, RBAC and logout', async () => {
  const original = base;
  const instance = await launch({
    ADMIN_TOKEN: '',
    BOOTSTRAP_ADMIN_EMAIL: 'owner@relay.test',
    BOOTSTRAP_ADMIN_PASSWORD: 'bootstrap-pass-123',
    BOOTSTRAP_ADMIN_NAME: 'Owner One',
  });
  try {
    base = instance.url;

    // No accounts existed at startup, so the bootstrap admin was created.
    const anon = await req('/api/admin/conversations', undefined, {});
    assert.equal(anon.status, 401);

    // Wrong password never reveals whether the account exists.
    const bad = await req('/api/auth/login', { email: 'owner@relay.test', password: 'wrong-password-1' }, {});
    assert.equal(bad.status, 401);

    const login = await fetch(base + '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'owner@relay.test', password: 'bootstrap-pass-123' }),
    });
    assert.equal(login.status, 200);
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
    assert.ok(cookie.startsWith('relay_session='));
    const admin = { cookie };

    const me = await req('/api/auth/me', undefined, admin);
    assert.equal(me.data.user.email, 'owner@relay.test');
    assert.equal(me.data.user.role, 'admin');

    // Session cookie alone unlocks admin routes (no x-admin-token anywhere).
    const list = await req('/api/admin/conversations', undefined, admin);
    assert.equal(list.status, 200);

    // Admin invites an agent; the agent is rejected from admin-only actions.
    const invite = await req('/api/auth/users', { email: 'agent@relay.test', name: 'Agent One', role: 'agent', password: 'agent-pass-12345' }, admin);
    assert.equal(invite.status, 201);
    const agentLogin = await fetch(base + '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'agent@relay.test', password: 'agent-pass-12345' }),
    });
    const agentCookie = (agentLogin.headers.get('set-cookie') ?? '').split(';')[0];
    const agentHeaders = { cookie: agentCookie };
    const agentRead = await req('/api/admin/conversations', undefined, agentHeaders);
    assert.equal(agentRead.status, 200);
    const agentWrite = await req('/api/admin/faqs', { title: 'x', answer: 'y', category: 'general', tags: [] }, agentHeaders);
    assert.equal(agentWrite.status, 403);

    // Role changes and self-demotion guards.
    const demote = await req(`/api/auth/users/${invite.data.id}/role`, { role: 'admin' }, admin);
    assert.equal(demote.status, 200);
    const selfDemote = await req(`/api/auth/users/${me.data.user.id}/role`, { role: 'agent' }, admin);
    assert.equal(selfDemote.status, 400);

    // Logout destroys the session server-side.
    const logout = await req('/api/auth/logout', {}, admin);
    assert.equal(logout.status, 200);
    const afterLogout = await req('/api/admin/conversations', undefined, admin);
    assert.equal(afterLogout.status, 401);
  } finally {
    base = original;
    await stop(instance.proc);
  }
});
