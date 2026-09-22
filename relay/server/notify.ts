/**
 * Email notifications for workspace events.
 *
 * Provider-agnostic: any SMTP-style delivery function can be plugged in.
 * Out of the box it supports Resend's simple HTTP API (no SDK needed) when
 * RESEND_API_KEY is set, and otherwise degrades to a console stub so the
 * demo runs with zero configuration.
 *
 * Gated by NOTIFY_EMAILS (comma-separated recipients). All notifications are
 * fire-and-forget: a mail failure is logged and never affects the request.
 */

import { log } from './logger.js';
import type { WorkspaceEvent } from './events.js';

interface EmailMessage {
  to: string[];
  subject: string;
  text: string;
}

const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const FROM = process.env.NOTIFY_FROM_EMAIL ?? 'Relay <onboarding@resend.dev>';

async function sendViaResend(message: EmailMessage): Promise<boolean> {
  const key = (process.env.RESEND_API_KEY ?? '').trim();
  if (!key) return false;
  try {
    const response = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: FROM,
        to: message.to,
        subject: message.subject,
        text: message.text,
      }),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      log.error('email_send_failed', { status: response.status, body: body.slice(0, 300) });
      return false;
    }
    return true;
  } catch (error) {
    log.error('email_send_error', { error: String(error) });
    return false;
  }
}

function recipients(): string[] {
  return (process.env.NOTIFY_EMAILS ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .slice(0, 10);
}

/** True when notifications are configured. */
export function notificationsEnabled(): boolean {
  return recipients().length > 0;
}

async function deliver(message: Omit<EmailMessage, 'to'>): Promise<void> {
  const to = recipients();
  if (to.length === 0) return;
  const sent = await sendViaResend({ to, subject: message.subject, text: message.text });
  if (sent) {
    log.info('email_sent', { to, subject: message.subject });
  } else {
    // Configured recipients but no provider key: log so nothing is silent.
    log.info('email_stub', { to, subject: message.subject });
  }
}

/** Maps a workspace event to a human notification, if it warrants one. */
export async function notifyOnEvent(event: WorkspaceEvent, conversationTitle?: string): Promise<void> {
  if (!notificationsEnabled()) return;

  if (event.type === 'conversation' && event.status === 'waiting') {
    await deliver({
      subject: `Relay: new ticket needs a human — ${conversationTitle ?? event.id}`,
      text: [
        'A conversation just joined the human queue.',
        '',
        `Conversation: ${conversationTitle ?? event.id}`,
        `Id: ${event.id}`,
        '',
        'Open the agent workspace to reply.',
      ].join('\n'),
    });
  }
  // 'faq' events and non-waiting status changes do not warrant an email.
}
