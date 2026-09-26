import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
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
    env: { ...process.env, DATA_DIR: dataDir, ADMIN_TOKEN: 'test-admin-only', SEED_DEMO: 'false', CODEBUDDY_LIVE: 'false', RESEND_API_KEY: '', ALLOW_AUTH_DEBUG_CODE: 'true', MONGODB_DB: `relay_test_${path.basename(dataDir).replace(/[^a-z0-9]/gi, '')}`, ...extra },
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
  return { status: response.status, data: await response.json() as any, headers: response.headers };
}
/** GET with an exact Host header (fetch may normalize Host; raw sockets don't). */
function rawGet(url: string, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const request = http.request(
      { host: target.hostname, port: target.port, path: target.pathname, headers: { host } },
      (res) => { res.resume(); resolve(res.statusCode ?? 0); },
    );
    request.on('error', reject);
    request.end();
  });
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
test('host/origin guard: loopback default, ALLOWED_HOSTS opens a domain, * disables', async () => {
  const original = base;
  // Default: loopback works; a public Host name is rejected even on GET.
  assert.equal(await rawGet(`${base}/api/health`, 'relay.example'), 403);
  assert.equal((await req('/api/health', undefined, {})).status, 200);

  const configured = await launch({ ALLOWED_HOSTS: 'relay.example, *.vercel.app' });
  try {
    base = configured.url;
    assert.equal(await rawGet(`${base}/api/health`, 'relay.example'), 200);
    // Host is matched by hostname, ignoring the port.
    assert.equal(await rawGet(`${base}/api/health`, 'relay.example:8443'), 200);
    // Suffix wildcards match any subdomain but not lookalikes or the bare domain.
    assert.equal(await rawGet(`${base}/api/health`, 'relay-team.vercel.app'), 200);
    assert.equal(await rawGet(`${base}/api/health`, 'xvercel.app'), 403);
    assert.equal(await rawGet(`${base}/api/health`, 'vercel.app'), 403);
    // Origins from allowed hosts may write; strangers still cannot.
    assert.equal((await req('/api/conversations', { customer: 'A' }, { Origin: 'https://relay.example' })).status, 201);
    assert.equal((await req('/api/conversations', { customer: 'A' }, { Origin: 'https://evil.example' })).status, 403);
  } finally { base = original; await stop(configured.proc); }

  // ALLOWED_HOSTS="*" disables the guard entirely (documented escape hatch).
  const open = await launch({ ALLOWED_HOSTS: '*' });
  try {
    base = open.url;
    assert.equal(await rawGet(`${base}/api/health`, 'anything.example'), 200);
  } finally { base = original; await stop(open.proc); }
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

test('killer demo flow: multi-policy citation, refuse unanswerable refund without guessing, message feedback, knowledge gap tracking', async () => {
  const session = await create();

  // Step 1: My order hasn't arrived and I want a refund.
  const turn1 = await send(session, "My order hasn't arrived and I want a refund.");
  assert.equal(turn1.status, 200);
  const bot1 = turn1.data.messages.findLast((m: any) => m.role === 'assistant');
  assert.ok(bot1);
  assert.ok(bot1.sources.length >= 2);
  const titles = bot1.sources.map((s: any) => s.title.toLowerCase());
  assert.ok(titles.some((t: string) => t.includes('refund') || t.includes('return')));
  assert.ok(titles.some((t: string) => t.includes('shipping') || t.includes('tracking') || t.includes('delivery')));

  // Step 2: Unanswerable inquiry: "I received the wrong product. Can you issue the refund now?"
  const turn2 = await send(session, 'I received the wrong product. Can you issue the refund now?');
  assert.equal(turn2.status, 200);
  const bot2 = turn2.data.messages.findLast((m: any) => m.role === 'assistant');
  assert.ok(bot2);
  // Zero fabricated citations
  assert.equal(bot2.sources.length, 0);
  assert.match(bot2.content, /safely resolve|support/i);

  // Step 3: Message feedback endpoint: customer submits negative feedback with 'need_human'
  const fbRes = await req(
    `/api/conversations/${session.id}/messages/${bot2.id}/feedback`,
    { helpful: false, reason: 'need_human', comment: 'Need an agent to verify the wrong item' },
    { 'x-conversation-token': session.token },
  );
  assert.equal(fbRes.status, 200);
  assert.equal(fbRes.data.message.feedback.helpful, false);
  assert.equal(fbRes.data.message.feedback.reason, 'need_human');

  // Conversation should auto-escalate on 'need_human'
  const convAfterFb = await req(`/api/conversations/${session.id}`, undefined, { 'x-conversation-token': session.token });
  assert.equal(convAfterFb.data.conversation.status, 'waiting');

  // Step 4: Admin knowledge gaps endpoint lists the newly recorded gap
  const gaps = await req('/api/admin/knowledge-gaps');
  assert.equal(gaps.status, 200);
  const gap = gaps.data.items.find((g: any) => g.messageId === bot2.id);
  assert.ok(gap);
  assert.equal(gap.reason, 'need_human');
  assert.equal(gap.status, 'open');

  // Step 5: Admin resolves the knowledge gap
  const resolved = await req(`/api/admin/knowledge-gaps/${gap.id}/resolve`, {});
  assert.equal(resolved.status, 200);
  const gapsAfter = await req('/api/admin/knowledge-gaps');
  const resolvedGap = gapsAfter.data.items.find((g: any) => g.id === gap.id);
  assert.equal(resolvedGap.status, 'resolved');

  // Step 6: Admin seeds sample knowledge
  const seeded = await req('/api/admin/onboarding/sample-knowledge', {});
  assert.equal(seeded.status, 200);
  assert.ok(seeded.data.items.length >= 6);
});

test('account auth: bootstrap, login, session cookies, RBAC and logout', async () => {
  const original = base;
  const instance = await launch({
    ADMIN_TOKEN: '',
    BOOTSTRAP_ADMIN_EMAIL: 'owner@relay.test',
    BOOTSTRAP_ADMIN_PASSWORD: 'bootstrap-pass-123',
    BOOTSTRAP_ADMIN_NAME: 'Owner One',
    MONGODB_DB: `relay_test_auth_${Date.now()}`,
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

test('tenant & customer isolation: conversations, messages, and ratings are strictly token-isolated', async () => {
  // Create Customer A conversation
  const custA = await create();
  // Create Customer B conversation
  const custB = await create();
  assert.notEqual(custA.id, custB.id);
  assert.notEqual(custA.token, custB.token);

  // Customer A can read Conversation A
  const getA = await req(`/api/conversations/${custA.id}`, undefined, { 'x-conversation-token': custA.token });
  assert.equal(getA.status, 200);
  assert.equal(getA.data.conversation.id, custA.id);

  // Customer B with Token B attempting to access Conversation A receives 404 (does NOT leak existence)
  const crossGet = await req(`/api/conversations/${custA.id}`, undefined, { 'x-conversation-token': custB.token });
  assert.equal(crossGet.status, 404);

  // Anonymous request without token receives 404 (timing-safe existence mask)
  const anonGet = await req(`/api/conversations/${custA.id}`, undefined, {});
  assert.equal(anonGet.status, 404);

  // Customer B attempting to send message to Conversation A receives 404
  const crossSend = await req(
    `/api/conversations/${custA.id}/messages`,
    { content: 'Hacked message' },
    { 'x-conversation-token': custB.token },
    'POST',
  );
  assert.equal(crossSend.status, 404);

  // Customer B attempting to rate Conversation A receives 404
  const crossRate = await req(
    `/api/conversations/${custA.id}/rating`,
    { score: 1 },
    { 'x-conversation-token': custB.token },
    'POST',
  );
  assert.equal(crossRate.status, 404);

  // Customer B attempting to escalate Conversation A receives 404
  const crossEscalate = await req(
    `/api/conversations/${custA.id}/escalate`,
    { reason: 'Customer B escalation' },
    { 'x-conversation-token': custB.token },
    'POST',
  );
  assert.equal(crossEscalate.status, 404);
});

test('security: remote requests never receive implicit admin even without ADMIN_TOKEN or users', async () => {
  const original = base;
  const instance = await launch({
    ADMIN_TOKEN: '',
    MONGODB_DB: `relay_test_remote_${Date.now()}`,
  });
  try {
    base = instance.url;

    // A remote IP header (e.g. from an external client via reverse proxy)
    const remoteHeaders = { 'x-forwarded-for': '198.51.100.25' };

    // Remote request to admin route without token must be rejected with 401
    const remoteAdmin = await req('/api/admin/conversations', undefined, remoteHeaders);
    assert.equal(remoteAdmin.status, 401);

    // Loopback without x-forwarded-for will get implicit admin when no accounts exist (local dev convenience)
    const localAdmin = await req('/api/admin/conversations', undefined, {});
    assert.equal(localAdmin.status, 200);
  } finally {
    base = original;
    await stop(instance.proc);
  }
});

test('api routing: supports both legacy unwrapped /api and enveloped /api/v1', async () => {
  // /api/health returns unwrapped object
  const legacyHealth = await req('/api/health', undefined, {});
  assert.equal(legacyHealth.status, 200);
  assert.equal(legacyHealth.data.mode, 'demo');
  assert.equal(legacyHealth.data.status, 'ok');
  assert.equal(legacyHealth.data.success, undefined);

  // /api/v1/health returns enveloped { success: true, data: { ... } }
  const v1Health = await req('/api/v1/health', undefined, {});
  assert.equal(v1Health.status, 200);
  assert.equal(v1Health.data.success, true);
  assert.equal(v1Health.data.data.mode, 'demo');
  assert.equal(v1Health.data.data.status, 'ok');

  // /api/v1/conversations creates conversation and wraps result
  const v1Conv = await req('/api/v1/conversations', { customer: 'V1 Customer', email: 'v1@test.local' }, {});
  assert.equal(v1Conv.status, 201);
  assert.equal(v1Conv.data.success, true);
  assert.ok(v1Conv.data.data.conversation);
  assert.ok(v1Conv.data.data.accessToken);

  // /api/v1 envelope on error
  const v1Err = await req(`/api/v1/conversations/${v1Conv.data.data.conversation.id}`, undefined, {});
  assert.equal(v1Err.status, 404);
  assert.equal(v1Err.data.success, false);
  assert.ok(v1Err.data.error);
});

test('observability: /admin/system-health and /health/system report all subsystems and telemetry', async () => {
  // Public health/system endpoint
  const pub = await req('/api/health/system', undefined, {});
  assert.equal(pub.status, 200);
  assert.equal(pub.data.status, 'healthy');
  assert.equal(pub.data.components.api.status, 'healthy');
  assert.equal(pub.data.components.database.status, 'healthy');
  assert.equal(pub.data.components.aiProvider.status, 'healthy');
  assert.equal(pub.data.components.realtimeSse.status, 'healthy');
  assert.equal(pub.data.components.knowledgeBase.status, 'healthy');
  assert.ok(typeof pub.data.uptimeSeconds === 'number');

  // Telemetry sub-objects
  assert.ok(pub.data.telemetry.ai);
  assert.ok(pub.data.telemetry.http);
  assert.ok(pub.data.telemetry.database);
  assert.ok(pub.data.telemetry.realtimeSse);
  assert.ok(pub.data.telemetry.knowledgeBase);

  // Admin system-health requires auth
  const anon = await req('/api/admin/system-health', undefined, {});
  assert.equal(anon.status, 401);

  const authed = await req('/api/admin/system-health', undefined, adminHeaders);
  assert.equal(authed.status, 200);
  assert.equal(authed.data.status, 'healthy');
  assert.ok(authed.data.telemetry.http.requestsTotal > 0);
});

test('plan limits: AI message limit preserves user message, escalates to waiting, and returns 429', async () => {
  const original = base;
  const instance = await launch({
    FREE_AI_MESSAGES_LIMIT: '1',
    MONGODB_DB: `relay_test_limits_${Date.now()}`,
  });
  try {
    base = instance.url;
    const session = await create();

    // 1st message: within limit
    const turn1 = await send(session, 'What is the return policy?');
    assert.equal(turn1.status, 200);

    // 2nd message: exceeds AI message limit
    const turn2 = await send(session, 'Can I exchange my item instead?');
    assert.equal(turn2.status, 429);
    assert.equal(turn2.data.aiMessagesLimitReached, true);

    // Verify conversation was preserved, transitioned to waiting, and has escalation note
    const detail = await req(`/api/conversations/${session.id}`, undefined, { 'x-conversation-token': session.token });
    assert.equal(detail.status, 200);
    assert.equal(detail.data.conversation.status, 'waiting');
    assert.equal(detail.data.conversation.escalationReason, 'Monthly AI message cap reached');

    // Customer message was saved
    const customerMsg = detail.data.messages.find((m: any) => m.content === 'Can I exchange my item instead?');
    assert.ok(customerMsg);

    // Assistant notice was saved
    const assistantMsg = detail.data.messages.find((m: any) => m.role === 'assistant' && m.content.includes('monthly limit'));
    assert.ok(assistantMsg);
  } finally {
    base = original;
    await stop(instance.proc);
  }
});

test('auth: config endpoint returns auth capabilities and googleClientId', async () => {
  const result = await req('/api/auth/config', undefined, {});
  assert.equal(result.status, 200);
  assert.equal(result.data.emailVerification, true);
  assert.equal(typeof result.data.googleClientId === 'string' || result.data.googleClientId === null, true);
});

test('auth: email verification code flow (send code, rate limit, wrong code, valid code, session cookie, replay protection)', async () => {
  const testEmail = `pilot-${Date.now()}@relay.test`;

  // 1. Invalid email rejected
  const badEmail = await req('/api/auth/email/send-code', { email: 'not-an-email' }, {});
  assert.equal(badEmail.status, 400);

  // 2. Send code successfully
  const sendRes = await req('/api/auth/email/send-code', { email: testEmail }, {});
  assert.equal(sendRes.status, 200);
  assert.equal(sendRes.data.ok, true);
  assert.ok(sendRes.data.debugCode, 'Expected debugCode in non-prod mode');
  const code = sendRes.data.debugCode as string;
  assert.match(code, /^\d{6}$/);

  // 3. Rate limiting (consecutive request within 60s)
  const throttled = await req('/api/auth/email/send-code', { email: testEmail }, {});
  assert.equal(throttled.status, 429);

  // 4. Verify with incorrect code
  const wrongRes = await req('/api/auth/email/verify', { email: testEmail, code: '000000' }, {});
  assert.equal(wrongRes.status, 401);

  // 5. Verify with correct code
  const verifyRes = await req('/api/auth/email/verify', { email: testEmail, code }, {});
  assert.equal(verifyRes.status, 200);
  assert.equal(verifyRes.data.user.email, testEmail);
  assert.ok(verifyRes.data.user.id);
  assert.ok(['admin', 'agent'].includes(verifyRes.data.user.role));

  // Check Set-Cookie header contains relay_session
  const setCookie = verifyRes.headers.get('set-cookie');
  assert.ok(setCookie, 'Expected Set-Cookie header');
  assert.match(setCookie, /relay_session=/);

  // 6. Access /api/auth/me using the session cookie
  const cookiePart = setCookie.split(';')[0];
  const meRes = await req('/api/auth/me', undefined, { cookie: cookiePart });
  assert.equal(meRes.status, 200);
  assert.equal(meRes.data.user.email, testEmail);

  // 7. Replay protection (code is single-use)
  const reuseRes = await req('/api/auth/email/verify', { email: testEmail, code }, {});
  assert.equal(reuseRes.status, 401);
});

test('auth: email magic link token flow (verify with token, single-use, agent role provisioning)', async () => {
  const tokenEmail = `magic-${Date.now()}@relay.test`;

  // Request code/token
  const sendRes = await req('/api/auth/email/send-code', { email: tokenEmail }, {});
  assert.equal(sendRes.status, 200);
  assert.ok(sendRes.data.debugToken, 'Expected debugToken in non-prod mode');
  const token = sendRes.data.debugToken as string;

  // Verify using magic link token
  const verifyRes = await req('/api/auth/email/verify', { email: tokenEmail, token }, {});
  assert.equal(verifyRes.status, 200);
  assert.equal(verifyRes.data.user.email, tokenEmail);

  // Replay protection (token is single-use)
  const reuseRes = await req('/api/auth/email/verify', { email: tokenEmail, token }, {});
  assert.equal(reuseRes.status, 401);
});

test('auth: Google sign-in endpoint validates credential input and rejects invalid tokens', async () => {
  // Empty credential rejected
  const emptyRes = await req('/api/auth/google', { credential: '' }, {});
  assert.equal(emptyRes.status, 400);

  // Invalid fake credential rejected by Google OAuth verification
  const fakeRes = await req('/api/auth/google', { credential: 'fake.google.jwt.token' }, {});
  assert.equal(fakeRes.status, 401);
});



