/**
 * Marketing landing page for Relay.
 *
 * Communicates the value proposition, core workflow and demo entry points.
 * Purely presentational: links into /app (agent workspace) and /chat
 * (customer experience) using the shared design system.
 */

import {
  ArrowRight, BarChart3, BookOpen, Bot, Check, Clock, MessagesSquare,
  ShieldCheck, Users, Wrench,
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
    icon: <Bot size={18} aria-hidden="true" />,
    title: 'Answers grounded in your knowledge base',
    text: 'Every AI reply cites the exact support policy it used — no invented answers, no black box.',
  },
  {
    icon: <Wrench size={18} aria-hidden="true" />,
    title: 'Real order lookups, not chatbot filler',
    text: 'The assistant calls your order system and returns live status, carrier and tracking data.',
  },
  {
    icon: <Users size={18} aria-hidden="true" />,
    title: 'Human handoff that actually works',
    text: 'Tricky or frustrated customers reach your queue in seconds, with full transcript and reason.',
  },
  {
    icon: <BarChart3 size={18} aria-hidden="true" />,
    title: 'Metrics your team will use',
    text: 'Resolution rate, CSAT, first-response time and volume trends — computed from real conversations.',
  },
  {
    icon: <BookOpen size={18} aria-hidden="true" />,
    title: 'A knowledge base you can edit',
    text: 'Policies change. Update any article and the assistant starts citing the new wording immediately.',
  },
  {
    icon: <ShieldCheck size={18} aria-hidden="true" />,
    title: 'Built honest by default',
    text: 'When the AI is unsure it escalates instead of guessing. Failure is always visible, never masked.',
  },
];

const WORKFLOW: Array<{ title: string; text: string }> = [
  { title: 'A customer asks', text: 'Refunds, order status, troubleshooting — the assistant classifies intent instantly.' },
  { title: 'Relay answers or escalates', text: 'Confident questions get cited answers; account actions and frustration go to a human.' },
  { title: 'Your team closes the loop', text: 'Agents see the queue, reply in context, resolve — and the dashboard updates live.' },
];

export default function Landing({
  onOpenWorkspace,
  onOpenChat,
}: {
  onOpenWorkspace: () => void;
  onOpenChat: () => void;
}) {
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
          <span className="badge badge-demo">Support agent · demo workspace</span>
          <h1>
            First-line support that answers,
            <br />
            cites and hands off.
          </h1>
          <p className="landing-lede">
            Relay answers your customers from your own knowledge base, looks up real order
            status, and brings a human in the moment it should — with resolution metrics to
            prove it.
          </p>
          <div className="landing-cta">
            <button type="button" className="btn btn-primary btn-lg" onClick={onOpenChat}>
              <MessagesSquare size={17} aria-hidden="true" />
              Open the customer demo
            </button>
            <button type="button" className="btn btn-outline btn-lg" onClick={onOpenWorkspace}>
              Explore the agent workspace
            </button>
          </div>
          <ul className="landing-proof">
            <li><Check size={14} aria-hidden="true" /> Citations on every answer</li>
            <li><Check size={14} aria-hidden="true" /> Order-status tool calls</li>
            <li><Check size={14} aria-hidden="true" /> Staged human handoff</li>
          </ul>
        </section>

        <section id="features" className="landing-section">
          <h2>Everything a small support team needs</h2>
          <p className="landing-section-sub">Not a chatbot widget — a workflow, from first question to resolved ticket.</p>
          <div className="landing-grid">
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
          <h2>How it works</h2>
          <p className="landing-section-sub">Three steps, no swivel-chair between tools.</p>
          <ol className="landing-steps">
            {WORKFLOW.map((step, index) => (
              <li key={step.title}>
                <span className="step-number" aria-hidden="true">{index + 1}</span>
                <div>
                  <div className="card-title">{step.title}</div>
                  <p className="note">{step.text}</p>
                </div>
              </li>
            ))}
          </ol>
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
        <span className="note">Demo data. Built as a local-first support product.</span>
      </footer>
    </div>
  );
}
