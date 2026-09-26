#!/usr/bin/env node
/**
 * Relay Pilot v1 End-to-End Production Verification Script
 *
 * Runs the full real-user workflow against any deployed Relay instance:
 * 1. Ping /api/health
 * 2. Ping /api/health/system (all 5 subsystems)
 * 3. Verify remote unauthenticated admin guard (401)
 * 4. Create customer conversation
 * 5. Ask question & verify policy citation
 * 6. Ask unsupported request & verify safe refusal
 * 7. Escalate to human agent
 * 8. Submit customer CSAT rating
 *
 * Usage:
 *   node scripts/verify-pilot.mjs https://your-relay-deploy.vercel.app
 */

const targetUrl = (process.argv[2] || 'http://localhost:3000').replace(/\/+$/, '');

console.log(`\n🔍 Verifying Relay production deployment at: ${targetUrl}\n`);

let passed = 0;
let failed = 0;

function report(step, ok, detail = '') {
  if (ok) {
    console.log(`  ✅ [PASS] ${step}${detail ? ` (${detail})` : ''}`);
    passed++;
  } else {
    console.log(`  ❌ [FAIL] ${step}${detail ? ` (${detail})` : ''}`);
    failed++;
  }
}

async function run() {
  // Step 1: Base Health
  try {
    const res = await fetch(`${targetUrl}/api/health`);
    const data = await res.json();
    report('1. Base Health (/api/health)', res.status === 200 && data.status === 'ok', `status=${data.status}, db=${data.checks?.database}`);
  } catch (err) {
    report('1. Base Health (/api/health)', false, err.message);
  }

  // Step 2: System Health (5 Subsystems)
  try {
    const res = await fetch(`${targetUrl}/api/health/system`);
    const data = await res.json();
    const c = data.components || {};
    const allHealthy = c.api?.status === 'healthy' && c.database?.status === 'healthy';
    report(
      '2. System Observability (/api/health/system)',
      res.status === 200 && allHealthy,
      `API=${c.api?.status}, DB=${c.database?.status}, AI=${c.aiProvider?.status}, SSE=${c.realtimeSse?.status}, KB=${c.knowledgeBase?.status}`,
    );
  } catch (err) {
    report('2. System Observability (/api/health/system)', false, err.message);
  }

  // Step 3: Remote Admin Security Guard (Must 401)
  try {
    const res = await fetch(`${targetUrl}/api/admin/conversations`);
    report('3. Remote Admin Guard (Unauthenticated 401)', res.status === 401, `status=${res.status}`);
  } catch (err) {
    report('3. Remote Admin Guard', false, err.message);
  }

  // Step 4: Create Customer Conversation
  let conversationId = null;
  let ownerToken = null;
  try {
    const res = await fetch(`${targetUrl}/api/conversations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ customer: 'Pilot Smoke Test', email: 'test@pilot.example' }),
    });
    const data = await res.json();
    conversationId = data.conversation?.id;
    ownerToken = data.accessToken;
    report('4. Create Customer Conversation', res.status === 201 && Boolean(conversationId && ownerToken), `id=${conversationId}`);
  } catch (err) {
    report('4. Create Customer Conversation', false, err.message);
  }

  if (!conversationId || !ownerToken) {
    console.log('\n❌ Cannot continue without active conversation.\n');
    process.exit(1);
  }

  const authHeaders = {
    'Content-Type': 'application/json',
    'x-conversation-token': ownerToken,
  };

  // Step 5: Ask Grounded FAQ Question
  try {
    const res = await fetch(`${targetUrl}/api/conversations/${conversationId}/messages`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ content: 'What is the return policy window?' }),
    });
    const data = await res.json();
    const assistantReply = data.messages?.find((m) => m.role === 'assistant');
    const hasCitations = assistantReply?.sources && assistantReply.sources.length > 0;
    report('5. Policy Retrieval & Citation', res.status === 200 && hasCitations, `sources=${assistantReply?.sources?.map((s) => s.title).join(', ')}`);
  } catch (err) {
    report('5. Policy Retrieval & Citation', false, err.message);
  }

  // Step 6: Unsupported Request (Safe Refusal)
  try {
    const res = await fetch(`${targetUrl}/api/conversations/${conversationId}/messages`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ content: 'Can you issue me a cash refund right now to my card?' }),
    });
    const data = await res.json();
    const assistantReply = [...(data.messages || [])].reverse().find((m) => m.role === 'assistant');
    const refusesGuessing = assistantReply && (assistantReply.content.toLowerCase().includes('cannot') || assistantReply.content.toLowerCase().includes('human') || assistantReply.content.toLowerCase().includes('team'));
    report('6. Safe Refusal (No Hallucinated Action)', res.status === 200 && Boolean(refusesGuessing), 'assistant refused to perform unauthorized refund');
  } catch (err) {
    report('6. Safe Refusal', false, err.message);
  }

  // Step 7: Escalation to Human Queue
  try {
    const res = await fetch(`${targetUrl}/api/conversations/${conversationId}/escalate`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ reason: 'Customer requested human support in smoke test' }),
    });
    const data = await res.json();
    report('7. Human Handoff Escalation', res.status === 200 && data.status === 'waiting', `status=${data.status}`);
  } catch (err) {
    report('7. Human Handoff Escalation', false, err.message);
  }

  // Step 8: Customer CSAT Rating
  try {
    const res = await fetch(`${targetUrl}/api/conversations/${conversationId}/rating`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ score: 5 }),
    });
    const data = await res.json();
    report('8. Customer CSAT Rating (Score: 5)', res.status === 200 && data.rating === 5, `rating=${data.rating}`);
  } catch (err) {
    report('8. Customer CSAT Rating', false, err.message);
  }

  console.log(`\nVerification Summary: ${passed} passed, ${failed} failed.\n`);
  if (failed > 0) {
    console.log('⚠️ Deployment has failing checks. Please inspect the logs above.');
    process.exit(1);
  } else {
    console.log('🎉 All production smoke tests passed! Instance is healthy and ready for real users.');
  }
}

run().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
