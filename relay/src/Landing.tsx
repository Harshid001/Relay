/**
 * Marketing landing page for Relay.
 *
 * Positioning: "AI handles the repetitive. Humans handle the important."
 * Relay is the first line of support for small e-commerce and SaaS teams —
 * it resolves repetitive questions from the company's knowledge base with
 * citations, and hands difficult conversations to a human with full context.
 *
 * Purely presentational: links into /app (agent workspace) and /chat
 * (customer experience) using the shared design system.
 */

import {
  ArrowRight, BarChart3, BookOpen, Check, Clock, Github, HandCoins, HeartHandshake,
  MessagesSquare, PackageSearch, RefreshCcw, ShieldCheck, UserRoundCheck, Users,
} from 'lucide-react';

function Logo({ size = 26 }: { size?: number }) {
  return (
    <svg viewBox="0 0 32 32" width={size} height={size} aria-hidden="true">
      <rect width="32" height="32" rx="8" fill="#306645" />
      <rect x="7" y="8" width="18" height="6.5" rx="3.25" fill="#d9ed9f" />
      <rect x="7" y="17.5" width="18" height="6.5" rx="3.25" fill="#d9ed9f" />
    </svg>
  );
}

const FEATURES: Array<{ icon: React.ReactNode; title: string; text: string }> = [
  {
    icon: <BookOpen size={18} aria-hidden="true" />,
    title: 'Answers from your knowledge base',
    text: 'Relay uses your FAQs and support docs to answer — not guesses generated from nowhere. Every reply cites the exact policy it used.',
  },
  {
    icon: <UserRoundCheck size={18} aria-hidden="true" />,
    title: 'One-click human escalation',
    text: 'Customers who ask for a person get one — no maze, no dead end. Relay also escalates on its own when confidence drops.',
  },
  {
    icon: <Users size={18} aria-hidden="true" />,
    title: 'Full context transferred',
    text: 'Your agent receives the entire conversation, the reason for the handoff and what was already tried. Customers never repeat themselves.',
  },
  {
    icon: <PackageSearch size={18} aria-hidden="true" />,
    title: 'Order lookups, not chatbot filler',
    text: 'Point Relay at your order system and it answers with live status, carrier and tracking data. (This demo queries a sample catalogue.)',
  },
  {
    icon: <BarChart3 size={18} aria-hidden="true" />,
    title: 'Metrics that prove it works',
    text: 'Resolution rate, CSAT, first-response time and handoff rate — computed from real conversations, not vanity counters.',
  },
  {
    icon: <ShieldCheck size={18} aria-hidden="true" />,
    title: 'Honest by default',
    text: 'When the AI is unsure it escalates instead of guessing. Failure is always visible, never masked.',
  },
];

const PROBLEM_SOLUTION: Array<{ problem: string; solution: string }> = [
  {
    problem: 'Your team answers the same questions every day',
    solution: 'Relay answers them from your knowledge base — instantly, at any hour',
  },
  {
    problem: 'AI chatbots invent answers',
    solution: 'Every Relay reply cites the exact support doc it used',
  },
  {
    problem: 'Customers get stuck talking to a bot',
    solution: 'One click — or one frustrated sentence — reaches a human',
  },
  {
    problem: 'Agents waste time reading old conversations',
    solution: 'Handoffs arrive with the full transcript and reason attached',
  },
];

const BEFORE_AFTER: Array<{ label: string; note: string; count: number; human: boolean }> = [
  { label: 'Repetitive FAQs', note: 'Relay resolves with cited answers', count: 40, human: false },
  { label: 'Order & refund questions', note: 'Relay resolves with lookups and policy answers', count: 20, human: false },
  { label: 'Technical questions', note: 'Relay gathers details, then hands off', count: 15, human: true },
  { label: 'Complex conversations', note: 'Your team — with full context attached', count: 25, human: true },
];

export default function Landing({
  onOpenWorkspace,
  onOpenChat,
}: {
  onOpenWorkspace: () => void;
  onOpenChat: () => void;
}) {
  const before = BEFORE_AFTER.reduce((sum, row) => sum + row.count, 0);
  const relayResolved = BEFORE_AFTER.filter((row) => !row.human).reduce((sum, row) => sum + row.count, 0);
  const humanHandled = before - relayResolved;

  return (
    <div className="landing">
      <header className="landing-nav">
        <div className="landing-brand">
          <Logo />
          <span className="brand-word">relay</span>
        </div>
        <nav className="landing-links" aria-label="Primary">
          <a href="#features">Features</a>
          <a href="#how">How it works</a>
          <a href="#before-after">Before & after</a>
          <button type="button" className="btn btn-ghost" onClick={onOpenWorkspace}>
            Agent sign-in
          </button>
          <button type="button" className="btn btn-primary" onClick={onOpenChat}>
            Try the demo
            <ArrowRight size={15} aria-hidden="true" />
          </button>
        </nav>
      </header>

      <main>
        <section className="landing-hero">
          <span className="badge badge-demo">Built for small e-commerce &amp; SaaS support teams</span>
          <h1>
            AI handles the repetitive.
            <br />
            Humans handle the <em style={{ fontStyle: 'normal', color: 'var(--accent, #306645)' }}>important</em>.
          </h1>
          <p className="landing-lede">
            Relay is an AI support agent that answers your customers from your own knowledge
            base — with citations — and hands difficult conversations to your team with the
            complete conversation history. Launch AI customer support for free.
          </p>
          <div className="landing-cta">
            <button type="button" className="btn btn-primary btn-lg" onClick={onOpenChat}>
              <MessagesSquare size={17} aria-hidden="true" />
              Launch AI support for free
            </button>
            <button type="button" className="btn btn-outline btn-lg" onClick={onOpenWorkspace}>
              Explore the agent workspace
            </button>
          </div>
          <ul className="landing-proof">
            <li><Check size={14} aria-hidden="true" /> No credit card</li>
            <li><Check size={14} aria-hidden="true" /> Citations on every answer</li>
            <li><Check size={14} aria-hidden="true" /> Human handoffs always free</li>
          </ul>
          <p className="landing-freecaps note">
            300 conversations and 1,000 AI answers a month, free. Handoffs to your team are
            never metered.
          </p>
        </section>

        <section id="features" className="landing-section">
          <h2>Stop answering the same questions every day</h2>
          <p className="landing-section-sub">
            Relay takes the repetitive work off your team&apos;s plate — without becoming another
            wall between your customers and your people.
          </p>
          <div className="landing-grid">
            <article className="card feature-card">
              <span className="stat-icon" aria-hidden="true"><RefreshCcw size={18} /></span>
              <div className="card-title">Let Relay handle</div>
              <ul className="landing-handlist">
                <li>Order and delivery questions</li>
                <li>Refund and cancellation requests</li>
                <li>Product and account questions</li>
                <li>Technical support</li>
                <li>Frequently asked questions</li>
              </ul>
            </article>
            <article className="card feature-card">
              <span className="stat-icon" aria-hidden="true"><HandCoins size={18} /></span>
              <div className="card-title">When AI isn&apos;t enough, a human takes over</div>
              <p className="note">
                Relay detects low-confidence conversations and customers who ask for a person.
                Your support agent receives the entire conversation and context — so customers
                never explain their problem twice.
              </p>
            </article>
          </div>
          <div className="landing-grid landing-grid-3">
            {FEATURES.map((feature) => (
              <article className="card feature-card" key={feature.title}>
                <span className="stat-icon" aria-hidden="true">{feature.icon}</span>
                <div className="card-title">{feature.title}</div>
                <p className="note">{feature.text}</p>
              </article>
            ))}
          </div>
        </section>

        <section id="how" className="landing-section landing-section-alt">
          <h2>Your knowledge. Your answers. Your team.</h2>
          <p className="landing-section-sub">
            Three steps, no swivel-chair between tools.
          </p>
          <ol className="landing-steps">
            <li>
              <span className="step-number" aria-hidden="true">1</span>
              <div>
                <div className="card-title">A customer asks</div>
                <p className="note">
                  &ldquo;My order hasn&apos;t arrived and I want a refund.&rdquo; Relay classifies the
                  intent instantly — refunds, order status, troubleshooting.
                </p>
              </div>
            </li>
            <li>
              <span className="step-number" aria-hidden="true">2</span>
              <div>
                <div className="card-title">Relay answers — and shows the source</div>
                <p className="note">
                  Confident questions get answers grounded in your knowledge base, with the
                  exact policy cited. Account actions and frustration go to a human instead.
                </p>
              </div>
            </li>
            <li>
              <span className="step-number" aria-hidden="true">3</span>
              <div>
                <div className="card-title">Your team closes the loop</div>
                <p className="note">
                  Agents get the queue with full transcripts, reply in context, resolve — and
                  the dashboard updates live.
                </p>
              </div>
            </li>
          </ol>
        </section>

        <section id="before-after" className="landing-section">
          <h2>Before Relay, your team answers everything</h2>
          <p className="landing-section-sub">
            An illustrative day for a small support team — every conversation, on you.
          </p>
          <div className="landing-grid landing-grid-2">
            <article className="card feature-card">
              <div className="card-title">Before Relay</div>
              <p className="note">100 customer conversations a day. Your team handles all 100.</p>
              <div className="landing-ba-row"><span>Repetitive FAQs</span><strong>40</strong></div>
              <div className="landing-ba-row"><span>Order &amp; refund questions</span><strong>20</strong></div>
              <div className="landing-ba-row"><span>Technical questions</span><strong>15</strong></div>
              <div className="landing-ba-row"><span>Complex conversations</span><strong>25</strong></div>
            </article>
            <article className="card feature-card landing-ba-with">
              <div className="card-title">With Relay</div>
              <p className="note">Same 100 conversations. Your team focuses on the 25 complex ones.</p>
              {BEFORE_AFTER.map((row) => (
                <div className="landing-ba-row" key={row.label}>
                  <span>
                    {row.label}
                    <em className="landing-ba-note">{row.note}</em>
                  </span>
                  <strong>{row.count}</strong>
                </div>
              ))}
              <p className="landing-ba-sum note">
                <Check size={14} aria-hidden="true" />
                {relayResolved} resolved by Relay · {humanHandled} handed off with full
                context · illustrative numbers, not measured results
              </p>
            </article>
          </div>
        </section>

        <section className="landing-section landing-section-alt">
          <h2>Built for small support teams</h2>
          <p className="landing-section-sub">
            Start free. Track resolution rate, CSAT, response time, AI usage and human handoffs
            from one dashboard.
          </p>
          <div className="landing-grid">
            <article className="card feature-card">
              <span className="stat-icon" aria-hidden="true"><HeartHandshake size={18} /></span>
              <div className="card-title">Free cloud workspace</div>
              <p className="note">
                300 conversations and 1,000 AI answers a month — and human handoffs are always
                unlimited. Resets monthly. No credit card, no seat count.
              </p>
            </article>
            <article className="card feature-card">
              <span className="stat-icon" aria-hidden="true"><Github size={18} /></span>
              <div className="card-title">Self-host on free tiers</div>
              <p className="note">
                Run your own Relay on Vercel + MongoDB Atlas free tiers, or a single VM. Raise
                or remove the caps with two environment variables. Your data stays yours.
              </p>
            </article>
          </div>
        </section>

        <section className="landing-section landing-final">
          <h2>See it handle a real queue</h2>
          <p className="landing-section-sub">
            Open the customer chat and the agent workspace side by side — watch an order
            lookup, a cited refund answer and a human handoff land in the queue live.
          </p>
          <div className="landing-cta">
            <button type="button" className="btn btn-primary btn-lg" onClick={onOpenChat}>
              Start the demo
              <ArrowRight size={17} aria-hidden="true" />
            </button>
            <span className="note"><Clock size={13} aria-hidden="true" /> 60 seconds is enough</span>
          </div>
        </section>
      </main>

      <footer className="landing-foot">
        <div className="landing-brand">
          <Logo size={20} />
          <span className="brand-word">relay</span>
        </div>
        <span className="note">
          AI handles the repetitive. Humans handle the important. · Free plan · self-hostable ·
          demo data included.
        </span>
      </footer>
    </div>
  );
}
