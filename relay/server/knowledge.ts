/**
 * Relay Store support knowledge base.
 *
 * Deterministic, dependency-free helpers used by both the demo responder and the
 * live (SDK backed) responder:
 *   - intent detection with synonym support and follow-up context carry-over
 *   - ranked FAQ retrieval over keyword synonyms
 *   - deterministic hand-off policy (things this channel genuinely cannot do)
 *
 * Nothing in here talks to the network or to the database.
 */

import { extractOrderNumber, findOrderById } from './orders.js';

export type Intent = 'refund' | 'order' | 'technical' | 'general';

export const INTENTS: Intent[] = ['refund', 'order', 'technical', 'general'];

export interface FaqRecord {
  id: string;
  title: string;
  answer: string;
  category: Intent;
  tags: string[];
}

export type Confidence = 'high' | 'medium' | 'low' | 'none';

/* ------------------------------------------------------------------ *
 * Seed knowledge base (fictional Relay Store)
 * ------------------------------------------------------------------ */

export const SEED_FAQS: FaqRecord[] = [
  {
    id: 'faq-return-policy-30-days',
    title: 'Return policy: 30 days, unused items only',
    answer:
      'Relay Store accepts returns within 30 days of delivery. Items must be unused, in their original packaging, and include every accessory that shipped with them. You start a return from Orders in your Relay Store account, which generates the return label. Returns that arrive used, damaged after delivery, or missing the original packaging can be declined. This chat cannot start or authorise a return for you.',
    category: 'refund',
    tags: [
      'refund', 'refunds', 'refunded', 'return', 'returns', 'returning', 'return policy',
      'money back', 'send back', 'send it back', '30 day', '30-day', 'unused', 'policy',
      'window', 'eligibility', 'can i return', 'how do i return',
    ],
  },
  {
    id: 'faq-refund-timing',
    title: 'Refund timing: 5 to 10 business days after approval',
    answer:
      'Once a return is approved, the refund is released to your original payment method and usually appears within 5 to 10 business days. Your bank or card issuer can add a few more days before it posts to your statement. Business days exclude weekends and public holidays. If more than 10 business days have passed since your approval email, a human agent can escalate it to the payments team.',
    category: 'refund',
    tags: [
      'refund', 'refunds', 'refund timing', 'how long', 'business days', '5-10',
      'pending', 'money back', 'when', 'how long do refunds take', 'refund time',
      'delay', 'processing time',
    ],
  },
  {
    id: 'faq-no-refunds-performed',
    title: 'Relay support never performs refunds',
    answer:
      'Relay Store chat support cannot move money. We never issue refunds directly, never reverse a charge, and never collect card, CVV or bank details. A refund is only released by the original payment provider after a return has been approved. Anyone asking you for payment details inside a Relay Store chat is not us.',
    category: 'refund',
    tags: [
      'refund', 'refunds', 'refunded', 'money back', 'reimburse', 'reimbursement',
      'chargeback', 'card', 'payment', 'billing', 'charged', 'refund me now',
      'refund my card', 'reverse charge',
    ],
  },
  {
    id: 'faq-refund-status',
    title: 'Checking the status of your own refund',
    answer:
      'Refund status is tied to your specific order and payment provider, so it cannot be read from this chat. Check the approval email from Relay Store for the expected date, then your bank statement. If that window has passed, a human agent can escalate it to the payments team.',
    category: 'refund',
    tags: [
      'refund', 'refund status', 'my refund', 'where is my refund', 'has my refund',
      'did my refund', 'pending refund', 'track refund', 'check my refund',
      'still no refund', 'refund not received', 'refund not arrived', 'no refund yet',
    ],
  },
  {
    id: 'faq-order-tracking',
    title: 'Tracking your order',
    answer:
      'This prototype has no live order or carrier integration, so no tracking state can be shown here. Your shipping confirmation email contains the carrier and the tracking number. If you never received a shipping confirmation, a human agent can check the order record.',
    category: 'order',
    tags: [
      'order', 'orders', 'tracking', 'track', 'trace', 'tracking number', 'shipment',
      'shipped', 'package', 'parcel', 'courier', 'eta', 'delivery', 'where is my order',
      'order status', 'how do i track', 'dispatch', 'shipping confirmation',
    ],
  },
  {
    id: 'faq-failed-delivery',
    title: 'Failed or missed delivery',
    answer:
      'When a delivery attempt fails, most carriers return the parcel to the local depot and try again on the next business day. If the carrier marked the parcel as delivered but you cannot find it, check with neighbours and your building office first. This chat cannot contact the carrier, so a human agent takes over if the parcel is still missing after that.',
    category: 'order',
    tags: [
      'failed delivery', 'missed delivery', 'delivery attempt', 'not delivered',
      'never arrived', 'has not arrived', 'did not arrive', 'lost package', 'lost parcel',
      'missing parcel', 'missing package', 'delivery', 'courier', 'driver', 'attempted',
      'late', 'delayed', 'delay',
    ],
  },
  {
    id: 'faq-cancel-order',
    title: 'Cancelling an order',
    answer:
      'Cancelling depends on the live state of your order, which this chat cannot read or change. Cancellation requests are handled by a human agent: send your order number and a human agent will pick it up. If the parcel has already shipped, the normal return process applies instead.',
    category: 'order',
    tags: [
      'cancel', 'cancelling', 'cancellation', 'cancel order', 'cancel my order',
      'stop my order', 'call off', 'cancelled', 'before it ships',
    ],
  },
  {
    id: 'faq-login-password',
    title: 'Cannot log in or reset your password',
    answer:
      'Use "Forgot password" on the Relay Store sign-in page and enter the email address on your account. The reset link is valid for 30 minutes and can only be used once. Check spam or junk if it does not arrive within a few minutes. After five failed attempts the account locks for 15 minutes.',
    category: 'technical',
    tags: [
      'login', 'log in', 'sign in', 'signin', 'password', 'reset password', 'locked',
      'locked out', 'account locked', 'credentials', 'cannot log in', 'cant log in',
      '2fa', 'otp', 'one time code', 'verification code',
    ],
  },
  {
    id: 'faq-browser-cache',
    title: 'Clearing your browser cache',
    answer:
      'A stale cache is the most common cause of a page that loads incorrectly or a cart that empties itself. Reload with Ctrl+Shift+R (Cmd+Shift+R on macOS), or open the site in a private/incognito window to test. To clear it fully: browser menu, Settings, Privacy and security, Clear browsing data, then select Cached images and files.',
    category: 'technical',
    tags: [
      'cache', 'cached', 'clear cache', 'browser', 'hard refresh', 'incognito',
      'private window', 'stale', 'old version', 'reload', 'cart empties', 'not updating',
    ],
  },
  {
    id: 'faq-cookies',
    title: 'Cookies and site errors',
    answer:
      'Relay Store needs first-party cookies for sign-in and for the cart to work. If cookies are blocked the site will show errors or sign you out. Allow cookies for relaystore.example in your browser privacy settings, then reload the page. Blocking third-party cookies is fine and does not affect the store.',
    category: 'technical',
    tags: [
      'cookies', 'cookie', 'enable cookies', 'blocked cookies', 'privacy settings',
      'site error', 'signed out', 'session expired', 'keep getting logged out',
    ],
  },
  {
    id: 'faq-error-message',
    title: 'Reporting an error message',
    answer:
      'Note the exact error text and, if one is shown, the reference code at the bottom of the message, plus the time it happened and the browser you used. That detail is what the engineering team needs, and a screenshot helps. If the error completely blocks a purchase or sign-in, ask for a human agent.',
    category: 'technical',
    tags: [
      'error', 'error code', 'reference code', 'bug', 'glitch', 'crash', 'crashing',
      'something went wrong', '500', 'exception', 'broken page', 'not working',
      'does not work', 'doesnt work', 'wont load', 'failed',
    ],
  },
  {
    id: 'faq-email-verification',
    title: 'Verification email not arriving',
    answer:
      'Verification emails usually arrive within a few minutes. Check spam, junk and promotions folders, and add no-reply@relaystore.example to your contacts. If your mailbox is full, or the address was mistyped, the message will bounce instead of arriving. You can request a new verification email from the account page once every 10 minutes.',
    category: 'technical',
    tags: [
      'email', 'verification', 'verify', 'confirmation email', 'not receiving',
      'didnt get email', 'no email', 'spam', 'junk', 'inbox', 'bounced', 'activation email',
    ],
  },
  {
    id: 'faq-human-agent',
    title: 'Talking to a human agent',
    answer:
      'Relay Store support is staffed Monday to Friday, 9am to 6pm. Ask for a human agent at any point and the conversation is handed to the queue immediately - you do not need to repeat yourself, the full history goes with it. Outside those hours a human replies on the next business day.',
    category: 'general',
    tags: [
      'human', 'agent', 'person', 'representative', 'someone real', 'talk to someone',
      'support team', 'manager', 'escalate', 'real person', 'customer service',
      'support hours', 'opening hours', 'when are you open',
    ],
  },
  {
    id: 'faq-payment-actions',
    title: 'Payment details and payment actions',
    answer:
      'This chat can never take a payment, change a payment method, or collect card numbers, CVV codes or bank details. Payment changes must be made yourself in your Relay Store account under Payment methods, and any refund is always released through the original payment provider. Never share payment details in a support chat.',
    category: 'general',
    tags: [
      'payment', 'payment method', 'card', 'card details', 'charged', 'charge',
      'billing', 'invoice', 'receipt', 'paypal', 'cvv', 'update card', 'change card',
    ],
  },
  {
    id: 'faq-account-changes',
    title: 'Account-specific changes',
    answer:
      'Changes such as updating the email address, merging accounts, or removing a saved address need identity verification and cannot be done from this chat. A human agent verifies you before any account change is made. We will never ask you for your password.',
    category: 'general',
    tags: [
      'account', 'profile', 'account details', 'change email', 'update email',
      'change address', 'update address', 'delete account', 'merge account',
      'account settings', 'identity verification',
    ],
  },
];

/* ------------------------------------------------------------------ *
 * Text normalisation helpers
 * ------------------------------------------------------------------ */

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Lowercase, unify apostrophes, drop punctuation, collapse whitespace. */
export function normalizeText(text: string): string {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[\u2018\u2019\u02bc\u00b4`]/g, "'")
    .replace(/[^a-z0-9'\-\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Normalised form with apostrophes and hyphens flattened, for term matching. */
export function flattenText(text: string): string {
  return normalizeText(text).replace(/'/g, '').replace(/[-\s]+/g, ' ').trim();
}

const regexCache = new Map<string, RegExp>();

/**
 * Word-boundary-ish regex for a term. Allows a small set of English inflections
 * so "order" also matches "orders"/"ordered"/"ordering".
 */
function termRegex(term: string): RegExp {
  const key = flattenText(term);
  const cached = regexCache.get(key);
  if (cached) return cached;
  const body = key
    .split(' ')
    .filter(Boolean)
    .map(escapeRegExp)
    .join('\\s+');
  const re = new RegExp(`(?:^|[^a-z0-9])${body}(?:s|es|ed|ing|d)?(?:$|[^a-z0-9])`);
  regexCache.set(key, re);
  return re;
}

export function hasTerm(flattenedHaystack: string, term: string): boolean {
  if (!flattenedHaystack) return false;
  return termRegex(term).test(flattenedHaystack);
}

/* ------------------------------------------------------------------ *
 * Intent detection
 * ------------------------------------------------------------------ */

type WeightedTerm = [term: string, weight: number];

const INTENT_TERMS: Record<'refund' | 'order' | 'technical', WeightedTerm[]> = {
  refund: [
    ['refund', 3], ['money back', 3], ['return', 3], ['send back', 3], ['send it back', 3],
    ['reimburse', 3], ['reimbursement', 3], ['chargeback', 3], ['arrived broken', 3],
    ['exchange', 2], ['replacement', 2], ['30 day', 2], ['unused', 2], ['defective', 2],
    ['damaged', 2], ['faulty', 2], ['return label', 2], ['credit back', 2], ['restocking', 1],
  ],
  order: [
    ['where is my order', 4], ['order', 2], ['tracking', 3], ['track', 2], ['shipment', 2],
    ['shipping', 2], ['shipped', 2], ['delivery', 2], ['deliver', 2], ['package', 2],
    ['parcel', 2], ['courier', 2], ['dispatch', 2], ['cancel', 3], ['invoice', 2],
    ['receipt', 2], ['confirmation email', 2], ['eta', 2], ['arrive', 1], ['late', 1],
    ['lost', 2], ['missing', 2],
  ],
  technical: [
    ['login', 3], ['log in', 3], ['sign in', 3], ['password', 3], ['locked out', 3],
    ['account locked', 3], ['not working', 3], ['does not work', 3], ['doesnt work', 3],
    ['wont work', 3], ['cache', 3], ['cookie', 3], ['technical', 3], ['error', 2],
    ['bug', 2], ['glitch', 2], ['crash', 2], ['browser', 2], ['website', 2], ['web site', 2],
    ['blank', 2], ['freeze', 2], ['2fa', 2], ['otp', 2], ['verification', 2], ['verify', 2],
    ['reset', 2], ['page', 1], ['app', 1], ['slow', 1], ['issue', 1], ['problem', 1],
    ['broken', 1], ['loading', 1], ['down', 1],
  ],
};

/** Cues that the message is a follow-up on an already established topic. */
const FOLLOW_UP_RE =
  /\b(still|again|same (?:issue|problem|thing|error|result)|not fixed|no (?:update|reply|response|answer)|any (?:update|news|progress)|nothing (?:changed|happened)|not resolved|as i said|i already (?:said|told)|it (?:does not|doesnt|wont|will not|is not|isnt)|that (?:did not|didnt)|this (?:does not|doesnt))\b/;

/** Explicit topic nouns that should override follow-up carry-over. */
const EXPLICIT_TOPIC_RE =
  /\b(refund|refunds|refunded|money back|return|returns|reimburse|chargeback|order number|tracking number|tracking|track|package|parcel|shipment|delivery|courier|invoice|receipt|cancel|password|log in|login|sign in|error code)\b/;

export interface IntentDetection {
  intent: Intent;
  confidence: Confidence;
  scores: Record<Intent, number>;
  carriedOver: boolean;
}

/**
 * Deterministic intent detection.
 * A follow-up such as "it still does not work" inherits the previous intent
 * unless the message names an explicit new topic.
 */
export function detectIntent(text: string, previousIntent: Intent | null = null): IntentDetection {
  const hay = flattenText(text);
  const scores: Record<Intent, number> = { refund: 0, order: 0, technical: 0, general: 0 };

  for (const intent of ['refund', 'order', 'technical'] as const) {
    for (const [term, weight] of INTENT_TERMS[intent]) {
      if (hasTerm(hay, term)) scores[intent] += weight;
    }
  }
  // Soft general signals.
  for (const term of ['hello', 'hi there', 'thanks', 'thank you', 'question', 'help']) {
    if (hasTerm(hay, term)) scores.general += 0.5;
  }

  const isFollowUp = FOLLOW_UP_RE.test(hay);
  const namesTopic = EXPLICIT_TOPIC_RE.test(hay);

  if (isFollowUp && !namesTopic && previousIntent && previousIntent !== 'general') {
    return {
      intent: previousIntent,
      confidence: 'medium',
      scores,
      carriedOver: true,
    };
  }

  let best: Intent = 'general';
  let bestScore = 0;
  for (const intent of ['refund', 'order', 'technical'] as const) {
    if (scores[intent] > bestScore) {
      bestScore = scores[intent];
      best = intent;
    }
  }

  if (bestScore === 0) {
    if (previousIntent && isFollowUp) {
      return { intent: previousIntent, confidence: 'low', scores, carriedOver: true };
    }
    return { intent: 'general', confidence: 'low', scores, carriedOver: false };
  }

  const confidence: Confidence = bestScore >= 4 ? 'high' : bestScore >= 2 ? 'medium' : 'low';
  return { intent: best, confidence, scores, carriedOver: false };
}

/* ------------------------------------------------------------------ *
 * Hand-off policy - what this channel honestly cannot do
 * ------------------------------------------------------------------ */

export interface HandoffDecision {
  escalate: boolean;
  reason: string | null;
  /** Stable identifier used to pick the customer facing hand-off message. */
  code: string | null;
}

const HUMAN_REQUEST_RE =
  /\b(human|real person|live agent|human agent|agent|representative|rep|someone real|support (?:team|person)|talk to (?:a )?(?:human|someone|person|agent)|speak (?:to|with) (?:a )?(?:human|someone|person|agent)|manager|escalate (?:this|me)|connect me)\b/;

const CANCELLATION_RE = /\b(cancel|cancelling|cancellation|cancelled|call off|stop my order)\b/;

const MY_REFUND_RE = /\bmy\b[^.!?]{0,30}\b(refund|return|money back|reimbursement)\b/;
const MY_ORDER_RE =
  /\bmy\b[^.!?]{0,30}\b(order|orders|package|parcel|shipment|delivery|item|deliveries)\b/;
const STATUS_LOOKUP_RE =
  /\b(where|when|status|update|pending|still|yet|has|have|did|does|is|was|check|track|tracking|arrived|received|processed|missing|stuck)\b/;
const HOW_TO_RE = /\bhow (?:do|can|should|would) i\b/;

const ACCOUNT_CHANGE_RE =
  /\b(change|update|remove|delete|merge|transfer|edit|close)\b[^.!?]{0,40}\b(email|e-mail|address|account|profile|phone number|name)\b/;
const PAYMENT_CHANGE_RE =
  /\b(change|update|add|remove|delete|switch)\b[^.!?]{0,40}\b(payment|card|billing|invoice)\b/;
const BILLING_DISPUTE_RE =
  /\b(double charge|charged twice|two charges|duplicate charge|extra charge|overcharged|wrong amount|unauthorised charge|unauthorized charge)\b/;

/**
 * Deterministic reasons to hand a conversation to a human immediately.
 * Used before any AI generation, in demo and live mode alike.
 */
export function policyHandoff(text: string): HandoffDecision {
  const hay = flattenText(text);

  if (HUMAN_REQUEST_RE.test(hay)) {
    return {
      escalate: true,
      reason: 'Customer asked to speak with a human agent',
      code: 'human_request',
    };
  }

  if (BILLING_DISPUTE_RE.test(hay)) {
    return {
      escalate: true,
      reason: 'Billing dispute needs a human agent',
      code: 'billing_dispute',
    };
  }

  if (CANCELLATION_RE.test(hay)) {
    return {
      escalate: true,
      reason: 'Order cancellation depends on live order state and needs a human agent',
      code: 'cancellation',
    };
  }

  if (MY_REFUND_RE.test(hay) && STATUS_LOOKUP_RE.test(hay)) {
    return {
      escalate: true,
      reason: 'Refund status is account specific and needs a human agent',
      code: 'refund_status',
    };
  }

  if (MY_ORDER_RE.test(hay) && STATUS_LOOKUP_RE.test(hay) && !HOW_TO_RE.test(hay)) {
    return {
      escalate: true,
      reason: 'Order lookup needs live order access which this channel does not have',
      code: 'order_lookup',
    };
  }

  if (ACCOUNT_CHANGE_RE.test(hay)) {
    return {
      escalate: true,
      reason: 'Account changes require identity verification by a human agent',
      code: 'account_change',
    };
  }

  if (PAYMENT_CHANGE_RE.test(hay)) {
    return {
      escalate: true,
      reason: 'Payment changes cannot be performed in chat',
      code: 'payment_change',
    };
  }

  return { escalate: false, reason: null, code: null };
}

/* ------------------------------------------------------------------ *
 * Order-number lookup (the one “tool call” Relay can make)
 * ------------------------------------------------------------------ */

export interface OrderLookupDecision {
  /** An order number was mentioned and resolved against the demo catalogue. */
  found: boolean;
  orderId: string | null;
  /** True when the message asks about the state of a specific order. */
  wantsStatus: boolean;
}

const ORDER_STATUS_ASK_RE =
  /\b(where|when|status|track|tracking|arrive|arriving|delivery|deliver|deliver\s|shipped|shipping|eta|update|check|late|stuck|still)\b/;

/**
 * Detects an order number in the message and whether the customer wants its
 * status. Used by both the demo responder (deterministic lookup) and the live
 * responder (grounding context + citation), and by the API layer to keep the
 * catalogue data out of stored chat text.
 */
export function lookupOrderDecision(text: string): OrderLookupDecision {
  const hay = flattenText(text);
  const orderId = extractOrderNumber(text);
  const found = orderId !== null && findOrderById(orderId) !== undefined;
  const wantsStatus = ORDER_STATUS_ASK_RE.test(hay);
  return { found, orderId, wantsStatus };
}

/* ------------------------------------------------------------------ *
 * FAQ retrieval
 * ------------------------------------------------------------------ */

const STOPWORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'to', 'of', 'and',
  'or', 'for', 'in', 'on', 'at', 'it', 'its', 'this', 'that', 'these', 'those', 'my', 'your',
  'our', 'their', 'i', 'you', 'we', 'they', 'me', 'us', 'them', 'do', 'does', 'did', 'can',
  'could', 'would', 'should', 'will', 'shall', 'have', 'has', 'had', 'not', 'no', 'but', 'if',
  'so', 'about', 'with', 'from', 'get', 'got', 'please', 'help', 'need', 'want', 'there',
  'here', 'am', 'as', 'by', 'just', 'now', 'some', 'any', 'more', 'most', 'much', 'very',
  'too', 'also', 'then', 'than', 'out', 'up', 'down', 'off', 'over', 'only', 'other', 'such',
  'own', 'same', 'again', 'still', 'andor', 'im', 'ive', 'dont', 'cant', 'wont', 'didnt',
  'isnt', 'doesnt', 'wasnt', 'havent', 'hasnt', 'were', 'youre', 'theres', 'whats', 'lets',
  'hey', 'hello', 'thanks', 'thank', 'ok', 'okay', 'yes', 'yeah', 'sure', 'know', 'think',
]);

/** Synonym groups: a query term matches an FAQ term if they share a group. */
const SYNONYM_GROUPS: string[][] = [
  ['refund', 'refunds', 'refunded', 'money back', 'reimburse', 'reimbursement', 'credit back', 'chargeback'],
  ['return', 'returns', 'returning', 'returned', 'send back', 'send it back', 'ship back', 'return label'],
  ['tracking', 'track', 'trace', 'tracking number', 'tracking info', 'tracking link', 'where is my order', 'order status', 'status'],
  ['order', 'orders', 'ordered', 'purchase', 'bought', 'confirmation', 'order number'],
  ['package', 'parcel', 'shipment', 'consignment', 'box'],
  ['delivery', 'deliver', 'delivered', 'shipping', 'shipped', 'dispatch', 'courier', 'carrier', 'driver'],
  ['late', 'delayed', 'delay', 'slow', 'stuck', 'overdue'],
  ['missing', 'lost', 'never arrived', 'not arrived', 'did not arrive', 'has not arrived', 'not delivered'],
  ['cancel', 'cancelling', 'cancellation', 'cancelled', 'call off'],
  ['login', 'log in', 'sign in', 'signin', 'sign on'],
  ['password', 'passcode', 'pass phrase', 'credentials', 'reset password', 'forgot password'],
  ['locked', 'locked out', 'account locked', 'blocked'],
  ['cache', 'cached', 'clear cache', 'browser cache', 'hard refresh'],
  ['cookie', 'cookies', 'enable cookies', 'blocked cookies'],
  ['error', 'errors', 'bug', 'glitch', 'crash', 'exception', 'something went wrong', 'failed'],
  ['email', 'e-mail', 'mail', 'inbox', 'verification email', 'confirmation email'],
  ['verification', 'verify', 'activate', 'activation', 'confirm'],
  ['spam', 'junk', 'promotions', 'bulk folder'],
  ['human', 'agent', 'person', 'representative', 'rep', 'someone real', 'support team', 'manager', 'staff'],
  ['hours', 'opening hours', 'support hours', 'when are you open', 'availability'],
  ['payment', 'pay', 'paid', 'card', 'billing', 'invoice', 'receipt', 'paypal', 'cvv'],
  ['account', 'profile', 'account details', 'account settings', 'membership'],
  ['address', 'shipping address', 'billing address', 'postcode', 'zip'],
  ['damaged', 'defective', 'faulty', 'broken', 'not working', 'does not work', 'doesnt work', 'malfunction'],
  ['unused', 'unopened', 'original packaging', 'as new'],
  ['policy', 'rule', 'rules', 'terms', 'guidelines', 'eligibility', 'window'],
];

let synonymIndex: Map<string, Set<string>> | null = null;

function getSynonymIndex(): Map<string, Set<string>> {
  if (synonymIndex) return synonymIndex;
  const index = new Map<string, Set<string>>();
  for (const group of SYNONYM_GROUPS) {
    const flat = group.map(flattenText).filter(Boolean);
    const set = new Set(flat);
    for (const term of flat) {
      const existing = index.get(term);
      if (existing) {
        set.forEach((member) => existing.add(member));
      } else {
        index.set(term, new Set(set));
      }
    }
  }
  synonymIndex = index;
  return index;
}

interface FaqTermIndex {
  list: string[];
  set: Set<string>;
}

const faqTermCache = new Map<string, FaqTermIndex>();

function faqTerms(faq: FaqRecord): FaqTermIndex {
  const cacheKey = faq.id + '|' + faq.title;
  const cached = faqTermCache.get(cacheKey);
  if (cached) return cached;

  const set = new Set<string>();
  const list: string[] = [];
  const add = (value: string) => {
    const flat = flattenText(value);
    if (!flat) return;
    if (!set.has(flat)) {
      set.add(flat);
      list.push(flat);
    }
    for (const word of flat.split(' ')) {
      if (word.length >= 3 && !set.has(word)) {
        set.add(word);
        list.push(word);
      }
    }
  };

  add(faq.title);
  add(faq.category);
  for (const tag of faq.tags) add(tag);

  const result: FaqTermIndex = { list, set };
  faqTermCache.set(cacheKey, result);
  return result;
}

interface QueryTerm {
  term: string;
  weight: number;
}

function queryTerms(text: string): QueryTerm[] {
  const words = flattenText(text).split(' ').filter(Boolean);
  const out: QueryTerm[] = [];
  const seen = new Set<string>();
  for (const word of words) {
    if (word.length < 3 || STOPWORDS.has(word) || seen.has(word)) continue;
    seen.add(word);
    out.push({ term: word, weight: 1 });
  }
  for (let i = 0; i < words.length - 1; i += 1) {
    const bigram = `${words[i]} ${words[i + 1]}`;
    if (seen.has(bigram)) continue;
    seen.add(bigram);
    out.push({ term: bigram, weight: 1.7 });
  }
  return out;
}

interface Boost {
  pattern: RegExp;
  faqId: string;
  points: number;
}

const BOOSTS: Boost[] = [
  { pattern: /^(refunds?|money back|returns?|send (?:it )?back|reimburse(?:ment)?)$/, faqId: 'faq-return-policy-30-days', points: 6 },
  { pattern: /\b(how long|how many days|when|timing|business days|take)\b.*\brefund/, faqId: 'faq-refund-timing', points: 5 },
  { pattern: /\brefund\b.*\b(how long|when|timing|business days|take|pending)\b/, faqId: 'faq-refund-timing', points: 5 },
  { pattern: /\b(where is my order|order status|track my order|tracking (?:number|info|link))\b/, faqId: 'faq-order-tracking', points: 6 },
  { pattern: /\b(cancel|cancelling|cancellation)\b/, faqId: 'faq-cancel-order', points: 6 },
  { pattern: /\b(failed delivery|missed delivery|delivery attempt|never arrived|has not arrived|lost (?:package|parcel))\b/, faqId: 'faq-failed-delivery', points: 6 },
  { pattern: /\b(password|log in|login|sign in|locked out)\b/, faqId: 'faq-login-password', points: 6 },
  { pattern: /\b(cache|cached|hard refresh|incognito)\b/, faqId: 'faq-browser-cache', points: 6 },
  { pattern: /\bcookies?\b/, faqId: 'faq-cookies', points: 6 },
  { pattern: /\b(error|bug|glitch|crash|reference code)\b/, faqId: 'faq-error-message', points: 5 },
  { pattern: /\b(verification email|confirm(?:ation)? email|didnt get (?:the )?email|no email|spam folder|junk folder)\b/, faqId: 'faq-email-verification', points: 6 },
  { pattern: /\b(human|real person|representative|talk to someone|speak to someone|support hours|opening hours)\b/, faqId: 'faq-human-agent', points: 6 },
  { pattern: /\b(payment method|card details|cvv|charge my card|take payment|pay over chat)\b/, faqId: 'faq-payment-actions', points: 5 },
  { pattern: /\b(change|update|delete|merge)\b.*\b(email|address|account|profile)\b/, faqId: 'faq-account-changes', points: 5 },
  { pattern: /\bmy refund\b/, faqId: 'faq-refund-status', points: 4 },
];

export interface FaqMatch {
  faq: FaqRecord;
  score: number;
}

export interface RetrievalResult {
  best: FaqMatch | null;
  matches: FaqMatch[];
  confidence: Confidence;
}

export interface RetrievalOptions {
  /** Intent carried over from previous turns - biases retrieval toward that category. */
  contextIntent?: Intent | null;
  limit?: number;
}

/**
 * Ranked keyword retrieval over the FAQ set using synonym expansion.
 * A bare "refund" resolves to the 30-day return policy entry.
 */
export function searchFaqs(
  query: string,
  faqs: FaqRecord[],
  options: RetrievalOptions = {},
): RetrievalResult {
  const limit = options.limit ?? 3;
  const hay = flattenText(query);
  if (!hay || faqs.length === 0) {
    return { best: null, matches: [], confidence: 'none' };
  }

  const index = getSynonymIndex();
  const terms = queryTerms(query);
  const scored: FaqMatch[] = [];

  for (const faq of faqs) {
    const owned = faqTerms(faq);
    let score = 0;

    for (const { term, weight } of terms) {
      const variants: string[] = [term];
      const group = index.get(term);
      if (group) {
        group.forEach((member) => {
          if (!variants.includes(member)) variants.push(member);
        });
      }

      let hits = 0;
      for (const variant of variants) {
        if (owned.set.has(variant)) {
          hits += 1;
        } else if (variant.length >= 4) {
          for (const ownedTerm of owned.list) {
            if (ownedTerm.length >= 4 && ownedTerm.startsWith(variant)) {
              hits += 0.5;
              break;
            }
          }
        }
      }
      if (hits > 0) {
        const multiplier = Math.min(3, 1 + 0.5 * (hits - 1));
        score += weight * multiplier * 2;
      }
    }

    for (const boost of BOOSTS) {
      if (boost.faqId === faq.id && boost.pattern.test(hay)) score += boost.points;
    }

    if (options.contextIntent && faq.category === options.contextIntent && score > 0) {
      score += 2;
    }

    if (score > 0) scored.push({ faq, score });
  }

  scored.sort((a, b) => b.score - a.score || a.faq.id.localeCompare(b.faq.id));

  const best = scored[0] ?? null;
  let confidence: Confidence = 'none';
  if (best) {
    if (best.score >= 6) confidence = 'high';
    else if (best.score >= 3) confidence = 'medium';
    else confidence = 'low';
  }

  return { best, matches: scored.slice(0, limit), confidence };
}

/**
 * FAQs used as untrusted reference data for the live model prompt.
 */
export function knowledgeForPrompt(
  query: string,
  faqs: FaqRecord[],
  contextIntent: Intent | null,
): FaqRecord[] {
  const result = searchFaqs(query, faqs, { contextIntent, limit: 5 });
  if (result.matches.length > 0) return result.matches.map((m) => m.faq);
  if (contextIntent && contextIntent !== 'general') {
    return faqs.filter((f) => f.category === contextIntent).slice(0, 4);
  }
  return [];
}
