/**
 * Admin workspace: shell, overview, conversations, drawer, knowledge base,
 * analytics and settings pages.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent, MouseEvent, ReactNode } from 'react';
import {
  AlertCircle, ArrowRight, BarChart3, BookOpen, Bot, Check, CheckCircle2, Clock, Code, Copy,
  ExternalLink, FileText, HelpCircle, Inbox, LayoutDashboard, LifeBuoy, Loader2, MessageSquare,
  MessagesSquare, Pencil, Plus, RefreshCw, Search, Send, Sparkles, Settings as SettingsIcon,
  ShieldCheck, Star, ThumbsDown, UserRound, Users, X,
} from 'lucide-react';

import { ApiError, AuthError, api, getAdminToken, setAdminToken } from '../service-api';
import type { SessionUser } from '../service-api';
import type {
  Conversation, ConversationDetail, ConversationStatus, Faq, FaqInput, Health, Intent,
  KnowledgeGap, Stats, SystemHealthReport, Usage,
} from '../service-types';
import { AccountCard } from '../Auth';
import {
  ADMIN_NAME, Avatar, BusinessStoryCard, CitedAnswer, EmptyState, INTENTS, INTENT_LABEL, IntentBars, IntentPill,
  lastCustomerQueryRef, LogoMark, Modal, PROVIDER_LABEL, Spinner, STATUS_LABEL, StatCard, statCards,
  StatusPill, VolumeChart, MessageBubble, currentGreeting, errorMessage, initials,
  formatDateTime, formatSeconds, smoothPath, timeAgo, todayLabel, getFriendlyName,
} from '../ui/shared';

/* ================================================================== *
 * Widget installation modal
 * ================================================================== */

export function InstallWidgetModal({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const [tab, setTab] = useState<'script' | 'shopify' | 'react'>('script');
  const [copied, setCopied] = useState(false);

  if (!isOpen) return null;

  const origin = typeof window !== 'undefined' ? window.location.origin : 'https://relay.yourdomain.com';

  const scriptCode = `<!-- Relay AI Support Widget -->
<script
  src="${origin}/widget.js"
  data-workspace="acme-studio"
  async
></script>`;

  const shopifyCode = `<!-- In your Shopify theme.liquid, right before </body>: -->
<script
  src="${origin}/widget.js"
  data-workspace="acme-studio"
  async
></script>`;

  const reactCode = `// In your React / Next.js root layout:
export function SupportWidget() {
  return (
    <script
      src="${origin}/widget.js"
      data-workspace="acme-studio"
      async
    />
  );
}`;

  const currentCode = tab === 'script' ? scriptCode : tab === 'shopify' ? shopifyCode : reactCode;

  const copyCode = () => {
    navigator.clipboard.writeText(currentCode);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <Modal
      title="Connect your support widget"
      description="Add Relay to your storefront or web app in under two minutes."
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>Close</button>
          <button className="btn btn-primary" onClick={copyCode}>
            {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
            {copied ? 'Copied to clipboard' : 'Copy code snippet'}
          </button>
        </>
      }
    >
      <div className="modal-body">
        <div className="segmented" style={{ marginBottom: 16 }}>
          <button
            type="button"
            className={tab === 'script' ? 'active' : ''}
            onClick={() => setTab('script')}
          >
            HTML / Vanilla JS
          </button>
          <button
            type="button"
            className={tab === 'shopify' ? 'active' : ''}
            onClick={() => setTab('shopify')}
          >
            Shopify / WooCommerce
          </button>
          <button
            type="button"
            className={tab === 'react' ? 'active' : ''}
            onClick={() => setTab('react')}
          >
            React / Next.js
          </button>
        </div>

        <div className="code-block-wrap" style={{ position: 'relative' }}>
          <pre
            className="code-box"
            style={{
              padding: 14,
              background: '#1c2420',
              color: '#f3f6f3',
              borderRadius: 8,
              fontSize: 13,
              overflowX: 'auto',
              margin: 0,
              fontFamily: 'monospace',
            }}
          >
            <code>{currentCode}</code>
          </pre>
        </div>

        <div className="card" style={{ marginTop: 16, padding: 14, background: 'var(--surface-sunken)' }}>
          <div style={{ fontWeight: 600, fontSize: 13, color: 'var(--ink)' }}>How it works on your site:</div>
          <ul style={{ margin: '8px 0 0 18px', padding: 0, fontSize: 12.5, color: 'var(--ink-muted)', lineHeight: 1.6 }}>
            <li>Non-intrusive floating launcher button in the bottom right corner.</li>
            <li>Grounded solely in your knowledge base articles — zero hallucinations.</li>
            <li>When confidence is low or the customer requests a person, it automatically escalates to this inbox.</li>
          </ul>
        </div>
      </div>
    </Modal>
  );
}

/* ================================================================== *
 * Demo Workspace Notice Banner
 * ================================================================== */

function DemoBanner({ onPreviewChat, onOpenKb }: { onPreviewChat: () => void; onOpenKb: () => void }) {
  const [dismissed, setDismissed] = useState(false);
  if (dismissed) return null;

  return (
    <aside className="demo-workspace-banner" aria-label="Demo workspace information">
      <div className="demo-banner-content">
        <span className="demo-banner-icon">
          <Sparkles size={16} aria-hidden="true" />
        </span>
        <div className="demo-banner-text">
          <span className="demo-banner-tag">Interactive Demo Mode</span>
          <p className="demo-banner-desc">
            You're exploring Relay with preloaded store policies and simulated conversations. Test AI answers in customer preview, edit policies, or connect your live store when ready.
          </p>
        </div>
      </div>
      <div className="demo-banner-actions">
        <button type="button" className="btn btn-outline btn-xs" onClick={onPreviewChat}>
          <MessageSquare size={13} aria-hidden="true" />
          Test in customer chat
        </button>
        <button type="button" className="btn btn-ghost btn-xs" onClick={onOpenKb}>
          <BookOpen size={13} aria-hidden="true" />
          Review policies
        </button>
        <button
          type="button"
          className="demo-banner-dismiss"
          onClick={() => setDismissed(true)}
          title="Dismiss banner"
          aria-label="Dismiss demo banner"
        >
          <X size={14} aria-hidden="true" />
        </button>
      </div>
    </aside>
  );
}

/* ================================================================== *
 * Onboarding Card (Quick Setup Guide)
 * ================================================================== */

interface OnboardingCardProps {
  faqCount: number;
  onSeedSample: () => void;
  seedingSample: boolean;
  onOpenKb: () => void;
  onPreview: () => void;
  onInstallWidget: () => void;
  onViewInbox: () => void;
}

function OnboardingCard({
  faqCount, onSeedSample, seedingSample, onOpenKb, onPreview, onInstallWidget, onViewInbox,
}: OnboardingCardProps) {
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem('relay_onboarding_dismissed') === 'true';
    } catch {
      return false;
    }
  });

  const dismiss = () => {
    try {
      localStorage.setItem('relay_onboarding_dismissed', 'true');
    } catch {}
    setDismissed(true);
  };

  const reopen = () => {
    try {
      localStorage.removeItem('relay_onboarding_dismissed');
    } catch {}
    setDismissed(false);
  };

  if (dismissed) {
    return (
      <div className="row" style={{ justifyContent: 'flex-end', marginBottom: 16 }}>
        <button
          type="button"
          className="btn btn-ghost btn-xs"
          onClick={reopen}
          style={{ gap: 5, color: 'var(--ink-muted)' }}
        >
          <HelpCircle size={13} aria-hidden="true" />
          Show Quick Setup Guide (4 steps)
        </button>
      </div>
    );
  }

  const step1Done = faqCount > 0;
  const completedSteps = step1Done ? 1 : 0;
  const progressPct = Math.round((completedSteps / 4) * 100);

  return (
    <section className="onboarding-card" aria-label="Quick setup guide">
      <div className="onboarding-head">
        <div className="onboarding-head-left">
          <div className="onboarding-title-badge">
            <Sparkles size={13} aria-hidden="true" />
            <span>First 5-Minute Onboarding</span>
          </div>
          <h2 className="onboarding-title">Get your AI support ready in 4 easy steps</h2>
          <p className="onboarding-sub">
            Teach your AI store policies, test verified responses in the sandbox, and connect live chat to your customers.
          </p>
        </div>

        <div className="onboarding-head-right">
          <div className="onboarding-progress-pill" title={`${completedSteps} of 4 steps ready`}>
            <div className="progress-info">
              <span className="progress-label">Setup progress</span>
              <span className="progress-count">{completedSteps} / 4 ready</span>
            </div>
            <div className="mini-progress-track">
              <div
                className="mini-progress-fill"
                style={{ width: `${Math.max(25, progressPct)}%` }}
              />
            </div>
          </div>
          <button
            type="button"
            className="btn btn-ghost btn-xs dismiss-btn"
            onClick={dismiss}
            title="Dismiss setup guide"
            aria-label="Dismiss setup guide"
          >
            <X size={14} aria-hidden="true" />
            <span>Dismiss</span>
          </button>
        </div>
      </div>

      <div className="onboarding-steps">
        {/* Step 1 */}
        <div className={`onboarding-step${step1Done ? ' done' : ''}`}>
          <div className="step-header">
            <div className={`step-badge${step1Done ? ' complete' : ''}`}>
              {step1Done ? <Check size={14} aria-hidden="true" /> : '1'}
            </div>
            {step1Done ? (
              <span className="badge badge-ok">
                <Check size={10} aria-hidden="true" /> {faqCount} active policies
              </span>
            ) : (
              <span className="badge badge-warn">Action required</span>
            )}
          </div>
          <div className="step-body">
            <div className="step-title">1. Add store policies</div>
            <div className="step-sub">
              Upload policies or load standard e-commerce defaults (Shipping, Returns, Refunds, Tracking, Support).
            </div>
            <div className="step-actions">
              <button
                type="button"
                className="btn btn-primary btn-xs"
                onClick={onSeedSample}
                disabled={seedingSample}
              >
                {seedingSample ? <Spinner size={12} /> : <Sparkles size={12} aria-hidden="true" />}
                {step1Done ? 'Reload sample policies' : 'Use sample policies'}
              </button>
              <button
                type="button"
                className="btn btn-outline btn-xs"
                onClick={onOpenKb}
              >
                <Plus size={12} aria-hidden="true" />
                Add custom FAQ
              </button>
            </div>
          </div>
        </div>

        {/* Step 2 */}
        <div className="onboarding-step">
          <div className="step-header">
            <div className="step-badge">2</div>
            <span className="badge badge-neutral">Interactive</span>
          </div>
          <div className="step-body">
            <div className="step-title">2. Test your AI in chat</div>
            <div className="step-sub">
              Ask tricky customer questions, verify cited sources, and watch how it triggers a human handoff when unsure.
            </div>
            <div className="step-actions">
              <button
                type="button"
                className="btn btn-outline btn-xs"
                onClick={onPreview}
              >
                <MessageSquare size={12} aria-hidden="true" />
                Test customer chat ↗
              </button>
            </div>
          </div>
        </div>

        {/* Step 3 */}
        <div className="onboarding-step">
          <div className="step-header">
            <div className="step-badge">3</div>
            <span className="badge badge-neutral">1-line snippet</span>
          </div>
          <div className="step-body">
            <div className="step-title">3. Connect storefront</div>
            <div className="step-sub">
              Install the lightweight chat bubble on Shopify, WooCommerce, or any custom storefront with a single script tag.
            </div>
            <div className="step-actions">
              <button
                type="button"
                className="btn btn-outline btn-xs"
                onClick={onInstallWidget}
              >
                <Code size={12} aria-hidden="true" />
                Get embed code
              </button>
            </div>
          </div>
        </div>

        {/* Step 4 */}
        <div className="onboarding-step">
          <div className="step-header">
            <div className="step-badge">4</div>
            <span className="badge badge-neutral">Autonomous & safe</span>
          </div>
          <div className="step-body">
            <div className="step-title">4. Go live & monitor</div>
            <div className="step-sub">
              Confident answers are handled automatically. Every customer escalation flows directly to your human inbox.
            </div>
            <div className="step-actions">
              <button
                type="button"
                className="btn btn-ghost btn-xs"
                onClick={onViewInbox}
              >
                <Inbox size={12} aria-hidden="true" />
                View live inbox →
              </button>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

interface OverviewProps {
  session: SessionUser | null;
  stats: Stats | null;
  statsLoading: boolean;
  conversations: Conversation[];
  loading: boolean;
  days: 7 | 30;
  onDays: (days: 7 | 30) => void;
  onOpen: (id: string) => void;
  onViewAll: () => void;
  onOpenKb: () => void;
  onPreview: () => void;
  onNewConversation: () => void;
  onInstallWidget: () => void;
  onSeedSample: () => void;
  seedingSample: boolean;
  faqCount: number;
  mode: 'demo' | 'live';
}

function OverviewPage({
  session, stats, statsLoading, conversations, loading, days, onDays, onOpen, onViewAll, onOpenKb,
  onPreview, onNewConversation, onInstallWidget, onSeedSample, seedingSample, faqCount, mode,
}: OverviewProps) {
  const [query, setQuery] = useState('');
  const userName = getFriendlyName(session, 'there');

  const recent = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const list = needle
      ? conversations.filter((c) =>
          `${c.customer} ${c.email} ${c.title} ${c.preview}`.toLowerCase().includes(needle),
        )
      : conversations;
    return list.slice(0, 6);
  }, [conversations, query]);

  return (
    <>
      <header className="page-head">
        <div>
          <div className="breadcrumb">
            <span>Workspace</span>
            <span aria-hidden="true">/</span>
            <span className="crumb-current">Overview</span>
          </div>
          <div className="greeting-meta">
            <span className="badge badge-ok">
              <CheckCircle2 size={12} aria-hidden="true" />All systems operational
            </span>
            <span className="date-chip">{todayLabel()}</span>
          </div>
          <h1 className="page-title">{currentGreeting()}, {userName} 👋</h1>
          <p className="page-sub">Here’s how your store support and AI resolutions are performing today.</p>
        </div>
        <div className="head-actions">
          <div className="segmented" role="group" aria-label="Date window">
            {([7, 30] as const).map((value) => (
              <button
                key={value}
                type="button"
                className={days === value ? 'active' : ''}
                aria-pressed={days === value}
                onClick={() => onDays(value)}
              >
                Last {value} days
              </button>
            ))}
          </div>
          <button className="btn btn-outline" onClick={onInstallWidget}>
            <Code size={15} aria-hidden="true" />Install widget
          </button>
          <button className="btn btn-outline" onClick={onPreview}>
            <MessageSquare size={15} aria-hidden="true" />Preview chat
          </button>
          <button className="btn btn-primary" onClick={onNewConversation}>
            <Plus size={15} aria-hidden="true" />New conversation
          </button>
        </div>
      </header>

      <OnboardingCard
        faqCount={faqCount}
        onSeedSample={onSeedSample}
        seedingSample={seedingSample}
        onOpenKb={onOpenKb}
        onPreview={onPreview}
        onInstallWidget={onInstallWidget}
        onViewInbox={onViewAll}
      />

      <BusinessStoryCard stats={stats} days={days} />

      <div className="grid-stats">
        {statCards(stats, days).map(({ key, ...card }) => (
          <StatCard key={key} {...card} />
        ))}
      </div>

      <section className="banner">
        <span className="banner-icon">
          <Sparkles size={18} aria-hidden="true" />
        </span>
        <div className="banner-body">
          <div className="banner-title">Your support, on autopilot</div>
          <p className="banner-text">
            Relay answers from your knowledge base, cites the article it used, and hands the
            conversation to a human the moment it matters. {stats ? `${stats.waiting} waiting for a human right now.` : ''}
          </p>
        </div>
        <button className="btn-link" onClick={onOpenKb}>
          Manage knowledge base<ArrowRight size={13} aria-hidden="true" />
        </button>
      </section>

      <div className="grid-main">
        <section className="card">
          <div className="card-head">
            <div>
              <div className="card-title">Conversation volume</div>
              <div className="card-sub">
                Conversations started per day, split by who handled them.
                {mode === 'demo' ? ' Demo workspace data.' : ''}
              </div>
            </div>
          </div>
          {statsLoading && !stats ? (
            <div className="loading-block"><Spinner />Loading volume…</div>
          ) : (
            <VolumeChart data={stats?.volume ?? []} />
          )}
        </section>

        <section className="card">
          <div className="card-head">
            <div>
              <div className="card-title">What brings customers here?</div>
              <div className="card-sub">Detected intent per conversation.</div>
            </div>
          </div>
          <IntentBars stats={stats} />
        </section>
      </div>

      <section className="card">
        <div className="card-head">
          <div>
            <div className="card-title">Recent conversations</div>
            <div className="card-sub">Newest activity across your workspace.</div>
          </div>
          <div className="head-actions">
            <div className="search">
              <Search size={15} aria-hidden="true" />
              <input
                className="input"
                type="search"
                value={query}
                placeholder="Search conversations"
                aria-label="Search recent conversations"
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
            <button className="btn btn-ghost btn-sm" onClick={onViewAll}>
              View all<ArrowRight size={14} aria-hidden="true" />
            </button>
          </div>
        </div>
        {loading && conversations.length === 0 ? (
          <div className="stack" style={{ padding: 22 }}>
            {[0, 1, 2, 3].map((i) => <div key={i} className="skeleton-row" />)}
          </div>
        ) : recent.length === 0 ? (
          <EmptyState
            title={query ? 'No conversations match that search' : 'No conversations yet'}
            text={query ? 'Try a different customer, subject or keyword.' : 'Start one from the customer preview to see it here.'}
          />
        ) : (
          <div className="table-scroll">
            <table className="data">
              <thead>
                <tr>
                  <th scope="col">Customer</th>
                  <th scope="col">Topic</th>
                  <th scope="col">Intent</th>
                  <th scope="col">Status</th>
                  <th scope="col">Updated</th>
                  <th scope="col">Assignee</th>
                </tr>
              </thead>
              <tbody>
                {recent.map((conversation) => (
                  <tr
                    key={conversation.id}
                    className="clickable"
                    tabIndex={0}
                    role="button"
                    aria-label={`Open conversation: ${conversation.title}`}
                    onClick={() => onOpen(conversation.id)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        onOpen(conversation.id);
                      }
                    }}
                  >
                    <td>
                      <div className="cell-customer">
                        <Avatar name={conversation.customer} email={conversation.email} />
                        <div style={{ minWidth: 0 }}>
                          <div className="customer-name">{conversation.customer}</div>
                          <div className="customer-email">{conversation.email}</div>
                        </div>
                      </div>
                    </td>
                    <td className="cell-topic">
                      <div className="topic-title">{conversation.title}</div>
                      <div className="topic-preview">{conversation.preview || 'No messages yet'}</div>
                    </td>
                    <td><IntentPill intent={conversation.intent} /></td>
                    <td><StatusPill status={conversation.status} /></td>
                    <td className="cell-muted">{timeAgo(conversation.updatedAt)}</td>
                    <td className="cell-assignee">{conversation.assignee ?? 'Unassigned'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <p className="footer-note">Thoughtful support, powered by CodeBuddy.</p>
    </>
  );
}

/* ================================================================== *
 * Conversations
 * ================================================================== */

type StatusTab = 'all' | ConversationStatus;

interface ConversationsProps {
  conversations: Conversation[];
  loading: boolean;
  onOpen: (id: string) => void;
  newWaitingIds: Set<string>;
  onOpenWaiting: (id: string) => void;
}

function ConversationsPage({ conversations, loading, onOpen, newWaitingIds, onOpenWaiting }: ConversationsProps) {
  const [query, setQuery] = useState('');
  const [tab, setTab] = useState<StatusTab>('all');
  const [intent, setIntent] = useState<'all' | Intent>('all');

  const counts = useMemo(() => ({
    all: conversations.length,
    open: conversations.filter((c) => c.status === 'open').length,
    waiting: conversations.filter((c) => c.status === 'waiting').length,
    resolved: conversations.filter((c) => c.status === 'resolved').length,
  }), [conversations]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return conversations.filter((conversation) => {
      if (tab !== 'all' && conversation.status !== tab) return false;
      if (intent !== 'all' && conversation.intent !== intent) return false;
      if (!needle) return true;
      return `${conversation.customer} ${conversation.email} ${conversation.title} ${conversation.preview}`
        .toLowerCase()
        .includes(needle);
    });
  }, [conversations, query, tab, intent]);

  const tabs: Array<{ id: StatusTab; label: string; count: number }> = [
    { id: 'all', label: 'All', count: counts.all },
    { id: 'open', label: 'Open', count: counts.open },
    { id: 'waiting', label: 'Needs a human', count: counts.waiting },
    { id: 'resolved', label: 'Resolved', count: counts.resolved },
  ];

  return (
    <>
      <header className="page-head">
        <div>
          <div className="breadcrumb">
            <span>Workspace</span>
            <span aria-hidden="true">/</span>
            <span className="crumb-current">Conversations</span>
          </div>
          <h1 className="page-title">Conversations</h1>
          <p className="page-sub">Every customer thread, with the full transcript and handoff history.</p>
        </div>
      </header>

      <section className="card">
        <div className="tabs" role="tablist" aria-label="Filter by status">
          {tabs.map((entry) => (
            <button
              key={entry.id}
              type="button"
              role="tab"
              aria-selected={tab === entry.id}
              className={`tab${tab === entry.id ? ' active' : ''}`}
              onClick={() => setTab(entry.id)}
            >
              {entry.label}
              <span className="tab-count">{entry.count}</span>
            </button>
          ))}
        </div>

        <div className="toolbar">
          <div className="search">
            <Search size={15} aria-hidden="true" />
            <input
              className="input"
              type="search"
              value={query}
              placeholder="Search by customer, email or message"
              aria-label="Search conversations"
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          <div className="field" style={{ minWidth: 190 }}>
            <select
              className="select"
              value={intent}
              aria-label="Filter by intent"
              onChange={(event) => setIntent(event.target.value as 'all' | Intent)}
            >
              <option value="all">All intents</option>
              {INTENTS.map((value) => (
                <option key={value} value={value}>{INTENT_LABEL[value]}</option>
              ))}
            </select>
          </div>
          <span className="note" style={{ marginLeft: 'auto' }}>
            {filtered.length} of {conversations.length}
          </span>
        </div>

        {loading && conversations.length === 0 ? (
          <div className="loading-block"><Spinner />Loading conversations…</div>
        ) : filtered.length === 0 ? (
          <EmptyState
            title="Nothing matches these filters"
            text="Try clearing the search box or switching back to the All tab."
          />
        ) : (
          <div className="table-scroll">
            <table className="data">
              <thead>
                <tr>
                  <th scope="col">Customer</th>
                  <th scope="col">Topic</th>
                  <th scope="col">Intent</th>
                  <th scope="col">Status</th>
                  <th scope="col">Updated</th>
                  <th scope="col">Assignee</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((conversation) => (
                  <tr
                    key={conversation.id}
                    className="clickable"
                    tabIndex={0}
                    role="button"
                    aria-label={`Open conversation: ${conversation.title}`}
                    onClick={() => onOpen(conversation.id)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        onOpen(conversation.id);
                      }
                    }}
                  >
                    <td>
                      <div className="cell-customer">
                        <Avatar name={conversation.customer} email={conversation.email} />
                        <div style={{ minWidth: 0 }}>
                          <div className="customer-name">{conversation.customer}</div>
                          <div className="customer-email">{conversation.email}</div>
                        </div>
                      </div>
                    </td>
                    <td className="cell-topic">
                      <div className="topic-title">{conversation.title}</div>
                      <div className="topic-preview">{conversation.preview || 'No messages yet'}</div>
                    </td>
                    <td>
                      <div className="row" style={{ gap: 6 }}>
                        <IntentPill intent={conversation.intent} />
                        {newWaitingIds.has(conversation.id) ? <span className="badge badge-new">New</span> : null}
                      </div>
                    </td>
                    <td><StatusPill status={conversation.status} /></td>
                    <td className="cell-muted">{timeAgo(conversation.updatedAt)}</td>
                    <td className="cell-assignee">{conversation.assignee ?? 'Unassigned'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

/* ================================================================== *
 * Conversation drawer
 * ================================================================== */

interface DrawerProps {
  id: string;
  session: SessionUser | null;
  faqs: Faq[];
  onClose: () => void;
  onUpdated: (conversation: Conversation) => void;
  onOpenSource: (source: { id: string; title: string }) => void;
  onError: (error: unknown) => void;
  mode: 'demo' | 'live';
}

function ConversationDrawer({ id, session, faqs, onClose, onUpdated, onOpenSource, onError, mode }: DrawerProps) {
  const [detail, setDetail] = useState<ConversationDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState<'reply' | 'resolve' | 'assign' | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const lastStamp = useRef('');

  const apply = useCallback((next: ConversationDetail) => {
    // Skip no-op refreshes from polling so the workspace does not re-render for nothing.
    const stamp = [
      next.conversation.updatedAt,
      next.conversation.status,
      next.conversation.assignee ?? '',
      next.conversation.rating ?? '',
      next.messages.length,
    ].join('|');
    if (stamp === lastStamp.current) return;
    lastStamp.current = stamp;
    setDetail(next);
    onUpdated(next.conversation);
  }, [onUpdated]);

  useEffect(() => {
    let cancelled = false;
    lastStamp.current = '';
    setLoading(true);
    api.getConversation(id)
      .then((data) => {
        if (!cancelled) apply(data);
      })
      .catch((error) => {
        if (!cancelled) onError(error);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [id, apply, onError]);

  // Poll the transcript while the drawer is open so human replies land live.
  useEffect(() => {
    let cancelled = false;
    const timer = window.setInterval(async () => {
      try {
        const data = await api.getConversation(id);
        if (!cancelled) apply(data);
      } catch {
        /* keep the current view; the next tick retries */
      }
    }, 6000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [id, apply]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const messages = detail?.messages ?? [];

  const usedSources = useMemo(() => {
    const map = new Map<string, string>();
    for (const msg of messages) {
      if (msg.sources && msg.sources.length > 0) {
        for (const src of msg.sources) {
          map.set(src.id, src.title);
        }
      }
    }
    return Array.from(map.entries()).map(([id, title]) => ({ id, title }));
  }, [messages]);

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, id]);

  const conversation = detail?.conversation;

  const doReply = async () => {
    const content = reply.trim();
    if (!content || busy) return;
    setBusy('reply');
    try {
      await api.reply(id, content);
      setReply('');
      const data = await api.getConversation(id);
      apply(data);
    } catch (error) {
      onError(error);
    } finally {
      setBusy(null);
    }
  };

  const doResolve = async () => {
    if (busy) return;
    setBusy('resolve');
    try {
      await api.resolve(id);
      const data = await api.getConversation(id);
      apply(data);
    } catch (error) {
      onError(error);
    } finally {
      setBusy(null);
    }
  };

  const currentAgentName = session ? getFriendlyName(session) : 'Support Agent';
  const isAssignedToMe = Boolean(
    conversation &&
    (conversation.assignee === currentAgentName || (session?.name && conversation.assignee === session.name))
  );

  const doAssign = async () => {
    if (busy) return;
    setBusy('assign');
    try {
      const updated = await api.assign(id, currentAgentName);
      onUpdated(updated);
      setDetail((prev) => (prev ? { ...prev, conversation: updated } : prev));
    } catch (error) {
      onError(error);
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <div className="overlay" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-modal="true" aria-label="Conversation detail">
        <div className="drawer-head">
          <div className="row" style={{ alignItems: 'flex-start', justifyContent: 'space-between' }}>
            <div style={{ minWidth: 0 }}>
              <div className="drawer-title">{conversation?.title ?? 'Loading conversation…'}</div>
              <div className="card-sub">
                {conversation ? `${conversation.customer} · ${conversation.email}` : 'Fetching transcript'}
              </div>
            </div>
            <button className="icon-btn" onClick={onClose} aria-label="Close conversation detail">
              <X size={16} aria-hidden="true" />
            </button>
          </div>
          {conversation ? (
            <div className="row row-wrap" style={{ marginTop: 12 }}>
              <IntentPill intent={conversation.intent} />
              <StatusPill status={conversation.status} />
              {conversation.rating ? (
                <span className="pill">Rated {conversation.rating}/5</span>
              ) : null}
              {conversation.isDemo ? <span className="badge badge-demo">Sample data</span> : null}
            </div>
          ) : null}
        </div>

        <div className="drawer-body" ref={logRef}>
          {loading && !detail ? (
            <div className="loading-block"><Spinner />Loading transcript…</div>
          ) : !conversation ? (
            <EmptyState title="Conversation unavailable" text="It may have been removed. Close this panel and try again." />
          ) : (
            <>
              {conversation.status === 'waiting' || conversation.escalationReason ? (
                <div className="escalation-alert-banner">
                  <div className="escalation-alert-icon">
                    <AlertCircle size={18} aria-hidden="true" />
                  </div>
                  <div className="escalation-alert-content">
                    <div className="escalation-alert-title">
                      {conversation.status === 'waiting' ? 'Needs Human Support' : 'Escalation Record'}
                    </div>
                    <div className="escalation-alert-reason">
                      <strong>Reason for escalation:</strong> {conversation.escalationReason || 'Customer requested human support'}
                    </div>
                  </div>
                </div>
              ) : null}

              <div className="card" style={{ padding: 16, marginBottom: 18 }}>
                <dl className="kv">
                  <dt>Assignee</dt>
                  <dd>{conversation.assignee ?? 'Unassigned'}</dd>
                  <dt>Created</dt>
                  <dd>{formatDateTime(conversation.createdAt)}</dd>
                  <dt>Last update</dt>
                  <dd>{formatDateTime(conversation.updatedAt)}</dd>
                  <dt>Intent</dt>
                  <dd><IntentPill intent={conversation.intent} /></dd>
                  <dt>Reason for escalation</dt>
                  <dd>{conversation.escalationReason ?? 'None (direct AI resolution)'}</dd>
                  <dt>Knowledge used</dt>
                  <dd>
                    {usedSources.length === 0 ? (
                      <span className="cell-muted">None used (unverified question or direct escalation)</span>
                    ) : (
                      <div className="row row-wrap" style={{ gap: 6 }}>
                        {usedSources.map((s) => (
                          <button
                            key={s.id}
                            type="button"
                            className="btn btn-outline btn-xs"
                            style={{ gap: 4 }}
                            onClick={() => onOpenSource(s)}
                            title="Inspect cited policy"
                          >
                            <BookOpen size={11} aria-hidden="true" />
                            <span>{s.title}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </dd>
                  <dt>Answer source</dt>
                  <dd>{mode === 'live' ? 'CodeBuddy agent, grounded in the knowledge base' : 'Demo agent, grounded in the knowledge base'}</dd>
                </dl>
                <div className="row row-wrap" style={{ marginTop: 16 }}>
                  <button
                    className="btn btn-outline btn-sm"
                    onClick={doAssign}
                    disabled={busy !== null || isAssignedToMe}
                  >
                    {busy === 'assign' ? <Spinner size={14} /> : <UserRound size={14} aria-hidden="true" />}
                    {isAssignedToMe
                      ? '✓ Assigned to you'
                      : conversation.assignee
                        ? `Assigned to ${conversation.assignee}`
                        : 'Assign to me'}
                  </button>
                  <button
                    className="btn btn-primary btn-sm"
                    onClick={doResolve}
                    disabled={busy !== null || conversation.status === 'resolved'}
                  >
                    {busy === 'resolve' ? <Spinner size={14} /> : <Check size={14} aria-hidden="true" />}
                    {conversation.status === 'resolved' ? 'Resolved' : 'Resolve'}
                  </button>
                </div>
              </div>

              <div className="eyebrow" style={{ marginBottom: 12 }}>Conversation log</div>
              {messages.length === 0 ? (
                <EmptyState title="No messages yet" text="This thread has not received a customer message." />
              ) : (
                <div className="log">
                  {messages.map((message) => (
                    <MessageBubble
                      key={message.id}
                      message={message}
                      faqs={faqs}
                      onOpenSource={(source) => {
                        const lastUser = [...messages].reverse().find((entry) => entry.role === 'user');
                        if (lastUser) lastCustomerQueryRef.value = lastUser.content;
                        onOpenSource(source);
                      }}
                    />
                  ))}
                </div>
              )}
            </>
          )}
        </div>

        <div className="drawer-foot">
          <div className="composer">
            <textarea
              rows={3}
              value={reply}
              disabled={!conversation}
              aria-label="Reply to the customer"
              placeholder={
                !conversation
                  ? 'Open a conversation to reply.'
                  : conversation.status === 'resolved'
                    ? 'This conversation is resolved. Replying will not reopen it.'
                    : 'Write a reply as a human agent…'
              }
              onChange={(event) => setReply(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  void doReply();
                }
              }}
            />
            <div className="composer-foot">
              <span className="hint">Replying as {currentAgentName} · Press Ctrl + Enter to send</span>
              <button
                className="btn btn-primary btn-sm"
                onClick={doReply}
                disabled={!conversation || busy !== null || !reply.trim()}
              >
                {busy === 'reply' ? <Spinner size={14} /> : <Send size={14} aria-hidden="true" />}
                Send reply
              </button>
            </div>
          </div>
        </div>
      </aside>
    </>
  );
}

interface KnowledgeProps {
  faqs: Faq[];
  loading: boolean;
  onSaved: (faq: Faq) => void;
  onSeedSample: () => void;
  seedingSample: boolean;
  onError: (error: unknown) => void;
}

const EMPTY_FAQ: FaqInput = { title: '', answer: '', category: 'general', tags: [] };

const GAP_REASON_LABEL: Record<string, string> = {
  incorrect: 'Incorrect answer',
  didnt_answer: "Didn't answer question",
  missing_info: 'Missing information in KB',
  need_human: 'Customer needed human',
};

function KnowledgePage({ faqs, loading, onSaved, onSeedSample, seedingSample, onError }: KnowledgeProps) {
  const [activeSubTab, setActiveSubTab] = useState<'articles' | 'gaps'>('articles');
  const [gaps, setGaps] = useState<KnowledgeGap[]>([]);
  const [loadingGaps, setLoadingGaps] = useState(false);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<'all' | Intent>('all');
  const [editing, setEditing] = useState<{ id: string | null; gapId?: string; draft: FaqInput; tagsText: string } | null>(null);
  const [saving, setSaving] = useState(false);

  const refreshGaps = useCallback(async () => {
    setLoadingGaps(true);
    try {
      const res = await api.listKnowledgeGaps();
      setGaps(res.items);
    } catch (error) {
      onError(error);
    } finally {
      setLoadingGaps(false);
    }
  }, [onError]);

  useEffect(() => {
    void refreshGaps();
  }, [refreshGaps]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return faqs.filter((faq) => {
      if (category !== 'all' && faq.category !== category) return false;
      if (!needle) return true;
      return `${faq.title} ${faq.answer} ${faq.tags.join(' ')}`.toLowerCase().includes(needle);
    });
  }, [faqs, query, category]);

  const save = async () => {
    if (!editing) return;
    const title = editing.draft.title.trim();
    const answer = editing.draft.answer.trim();
    if (!title || !answer) {
      onError(new Error('An article needs both a title and an answer.'));
      return;
    }
    const payload: FaqInput = {
      title,
      answer,
      category: editing.draft.category,
      tags: editing.tagsText.split(',').map((tag) => tag.trim()).filter(Boolean),
    };
    setSaving(true);
    try {
      const saved = editing.id
        ? await api.updateFaq(editing.id, payload)
        : await api.createFaq(payload);
      onSaved(saved);
      if (editing.gapId) {
        await api.resolveKnowledgeGap(editing.gapId);
        setGaps((prev) => prev.filter((g) => g.id !== editing.gapId));
      }
      setEditing(null);
    } catch (error) {
      onError(error);
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <header className="page-head">
        <div>
          <div className="breadcrumb">
            <span>Workspace</span>
            <span aria-hidden="true">/</span>
            <span className="crumb-current">Knowledge base</span>
          </div>
          <h1 className="page-title">Knowledge base</h1>
          <p className="page-sub">
            Every answer Relay gives is grounded in approved policies. Keep them accurate and the
            assistant stays accurate.
          </p>
        </div>
        <div className="head-actions">
          <button
            type="button"
            className="btn btn-outline"
            onClick={onSeedSample}
            disabled={seedingSample}
          >
            {seedingSample ? <Spinner size={14} /> : <Sparkles size={14} aria-hidden="true" />}
            Use sample policies
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => setEditing({ id: null, draft: { ...EMPTY_FAQ }, tagsText: '' })}
          >
            <Plus size={15} aria-hidden="true" />New article
          </button>
        </div>
      </header>

      <div className="tabs" role="tablist" style={{ marginBottom: 16 }}>
        <button
          type="button"
          role="tab"
          aria-selected={activeSubTab === 'articles'}
          className={`tab${activeSubTab === 'articles' ? ' active' : ''}`}
          onClick={() => setActiveSubTab('articles')}
        >
          Articles
          <span className="tab-count">{faqs.length}</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeSubTab === 'gaps'}
          className={`tab${activeSubTab === 'gaps' ? ' active' : ''}`}
          onClick={() => {
            setActiveSubTab('gaps');
            void refreshGaps();
          }}
        >
          Knowledge Gaps
          <span className={`tab-count${gaps.length > 0 ? ' pulse' : ''}`}>{gaps.length}</span>
        </button>
      </div>

      {activeSubTab === 'gaps' ? (
        <section className="card">
          <div className="card-head">
            <div>
              <div className="card-title">Identified Knowledge Gaps ({gaps.length})</div>
              <div className="card-sub">
                Questions customers flagged as unhelpful, missing information, or requiring escalation.
              </div>
            </div>
            <button className="btn btn-ghost btn-xs" onClick={() => void refreshGaps()}>
              <RefreshCw size={13} aria-hidden="true" />
              Refresh
            </button>
          </div>

          {loadingGaps && gaps.length === 0 ? (
            <div className="loading-block"><Spinner />Loading knowledge gaps…</div>
          ) : gaps.length === 0 ? (
            <EmptyState
              title="No open knowledge gaps"
              text="When customers click 👎 or report missing policies in chat, Relay records them here so you can plug the gap."
            />
          ) : (
            <div className="stack" style={{ padding: 18, gap: 14 }}>
              {gaps.map((gap) => (
                <article className="gap-card" key={gap.id}>
                  <div className="gap-head">
                    <div className="row" style={{ gap: 8, alignItems: 'center' }}>
                      <span className="badge badge-warn">
                        <AlertCircle size={12} aria-hidden="true" />
                        {GAP_REASON_LABEL[gap.reason] || gap.reason}
                      </span>
                      <span className="note">{timeAgo(gap.createdAt)}</span>
                    </div>
                    <div className="gap-actions">
                      <button
                        type="button"
                        className="btn btn-primary btn-xs"
                        onClick={() => {
                          setEditing({
                            id: null,
                            gapId: gap.id,
                            draft: {
                              title: gap.query,
                              answer: '',
                              category: 'general',
                              tags: ['gap-fix'],
                            },
                            tagsText: 'gap-fix',
                          });
                        }}
                      >
                        <Plus size={12} aria-hidden="true" />
                        Draft article from gap
                      </button>
                      <button
                        type="button"
                        className="btn btn-outline btn-xs"
                        onClick={async () => {
                          try {
                            await api.resolveKnowledgeGap(gap.id);
                            setGaps((prev) => prev.filter((g) => g.id !== gap.id));
                          } catch (e) {
                            onError(e);
                          }
                        }}
                      >
                        <Check size={12} aria-hidden="true" />
                        Dismiss
                      </button>
                    </div>
                  </div>
                  <div className="gap-query">
                    <strong>Customer question:</strong> "{gap.query}"
                  </div>
                  {gap.answer ? (
                    <div className="gap-answer-snippet">
                      <strong>Relay reply:</strong> {gap.answer.slice(0, 160)}…
                    </div>
                  ) : null}
                  {gap.comment ? (
                    <div className="gap-comment">
                      <strong>Customer feedback:</strong> "{gap.comment}"
                    </div>
                  ) : null}
                </article>
              ))}
            </div>
          )}
        </section>
      ) : (
        <section className="card">
          <div className="toolbar">
            <div className="search">
              <Search size={15} aria-hidden="true" />
              <input
                className="input"
                type="search"
                value={query}
                placeholder="Search articles, answers and tags"
                aria-label="Search knowledge base"
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
            <div className="field" style={{ minWidth: 190 }}>
              <select
                className="select"
                value={category}
                aria-label="Filter by category"
                onChange={(event) => setCategory(event.target.value as 'all' | Intent)}
              >
                <option value="all">All categories</option>
                {INTENTS.map((value) => (
                  <option key={value} value={value}>{INTENT_LABEL[value]}</option>
                ))}
              </select>
            </div>
            <span className="note" style={{ marginLeft: 'auto' }}>
              {filtered.length} of {faqs.length}
            </span>
          </div>

          {loading && faqs.length === 0 ? (
            <div className="loading-block"><Spinner />Loading articles…</div>
          ) : filtered.length === 0 ? (
            <EmptyState
              title={query || category !== 'all' ? 'No articles match' : 'No articles yet'}
              text={query || category !== 'all'
                ? 'Try another search term or category.'
                : 'Add your first article so Relay has something to answer from.'}
            />
          ) : (
            filtered.map((faq) => (
              <article className="faq-item" key={faq.id}>
                <div className="faq-head">
                  <div style={{ minWidth: 0 }}>
                    <div className="faq-title">{faq.title}</div>
                    <div className="row row-wrap" style={{ marginTop: 6 }}>
                      <IntentPill intent={faq.category} />
                      <span className="note">Updated {formatDateTime(faq.updatedAt)}</span>
                    </div>
                  </div>
                  <button
                    className="btn btn-outline btn-sm"
                    aria-label={`Edit article: ${faq.title}`}
                    onClick={() => setEditing({ id: faq.id, draft: { ...faq }, tagsText: faq.tags.join(', ') })}
                  >
                    <Pencil size={13} aria-hidden="true" />Edit
                  </button>
                </div>
                <p className="faq-answer">{faq.answer}</p>
                {faq.tags.length > 0 ? (
                  <div className="tag-row">
                    {faq.tags.map((tag) => <span className="tag" key={tag}>{tag}</span>)}
                  </div>
                ) : null}
              </article>
            ))
          )}
        </section>
      )}

      {editing ? (
        <Modal
          title={editing.id ? 'Edit article' : 'New article'}
          description="Relay answers only from what is written here, and cites the article it used."
          onClose={() => setEditing(null)}
          footer={
            <>
              <button className="btn btn-ghost" onClick={() => setEditing(null)} disabled={saving}>
                Cancel
              </button>
              <button className="btn btn-primary" onClick={save} disabled={saving}>
                {saving ? <Spinner size={14} /> : null}
                {editing.id ? 'Save changes' : 'Create article'}
              </button>
            </>
          }
        >
          <div className="modal-body">
            <label className="field">
              <span className="label">Title</span>
              <input
                className="input"
                value={editing.draft.title}
                aria-label="Article title"
                placeholder="How refunds are processed"
                onChange={(event) =>
                  setEditing({ ...editing, draft: { ...editing.draft, title: event.target.value } })
                }
              />
            </label>
            <label className="field">
              <span className="label">Answer</span>
              <textarea
                className="textarea"
                rows={6}
                value={editing.draft.answer}
                aria-label="Article answer"
                placeholder="Write the answer exactly as the assistant should give it."
                onChange={(event) =>
                  setEditing({ ...editing, draft: { ...editing.draft, answer: event.target.value } })
                }
              />
            </label>
            <label className="field">
              <span className="label">Category</span>
              <select
                className="select"
                value={editing.draft.category}
                aria-label="Article category"
                onChange={(event) =>
                  setEditing({ ...editing, draft: { ...editing.draft, category: event.target.value as Intent } })
                }
              >
                {INTENTS.map((value) => (
                  <option key={value} value={value}>{INTENT_LABEL[value]}</option>
                ))}
              </select>
            </label>
            <label className="field">
              <span className="label">Tags</span>
              <input
                className="input"
                value={editing.tagsText}
                aria-label="Article tags, comma separated"
                placeholder="refund, billing, timeline"
                onChange={(event) => setEditing({ ...editing, tagsText: event.target.value })}
              />
              <span className="hint">Comma separated. Tags help the assistant match a question to this article.</span>
            </label>
          </div>
        </Modal>
      ) : null}
    </>
  );
}

/* ================================================================== *
 * Analytics
 * ================================================================== */

function AnalyticsPage({
  stats, loading, days, onDays,
}: {
  stats: Stats | null;
  loading: boolean;
  days: 7 | 30;
  onDays: (days: 7 | 30) => void;
}) {
  const cards = statCards(stats, days);
  const ratings = stats?.satisfaction ?? [];
  const ratingCount = stats?.ratingCount ?? 0;
  const average = ratingCount > 0
    ? (ratings.reduce((sum, entry) => sum + entry.score * entry.count, 0) / ratingCount).toFixed(2)
    : null;

  return (
    <>
      <header className="page-head">
        <div>
          <div className="breadcrumb">
            <span>Workspace</span>
            <span aria-hidden="true">/</span>
            <span className="crumb-current">Analytics</span>
          </div>
          <h1 className="page-title">Analytics</h1>
          <p className="page-sub">Measured from real conversation records in this window.</p>
        </div>
        <div className="head-actions">
          <div className="segmented" role="group" aria-label="Date window">
            {([7, 30] as const).map((value) => (
              <button
                key={value}
                type="button"
                className={days === value ? 'active' : ''}
                aria-pressed={days === value}
                onClick={() => onDays(value)}
              >
                Last {value} days
              </button>
            ))}
          </div>
        </div>
      </header>

      <BusinessStoryCard stats={stats} days={days} />

      <div className="grid-stats">
        {cards.map(({ key, ...card }) => <StatCard key={key} {...card} />)}
      </div>

      <div className="grid-stats">
        <StatCard
          label="Waiting for a human"
          value={stats ? String(stats.waiting) : '—'}
          foot="Escalated threads still in the human queue."
          icon={<Users size={17} aria-hidden="true" />}
          tone="lime"
        />
        <StatCard
          label="Ratings collected"
          value={stats ? String(stats.ratingCount) : '—'}
          foot="Customers who rated the conversation 1–5."
          icon={<Star size={17} aria-hidden="true" />}
          tone="sand"
        />
        <StatCard
          label="Handled by a human"
          value={stats ? String(stats.volume.reduce((sum, point) => sum + point.human, 0)) : '—'}
          foot={`Conversations a person replied to or took over in the last ${days} days.`}
          icon={<UserRound size={17} aria-hidden="true" />}
          tone="mist"
        />
        <StatCard
          label="Answered by Relay"
          value={stats ? String(stats.volume.reduce((sum, point) => sum + point.ai, 0)) : '—'}
          foot={`Conversations answered by the assistant in the last ${days} days.`}
          icon={<Bot size={17} aria-hidden="true" />}
        />
      </div>

      <section className="card" style={{ marginBottom: 16 }}>
        <div className="card-head">
          <div>
            <div className="card-title">Conversation volume</div>
            <div className="card-sub">Conversations started per day, split by who handled them.</div>
          </div>
        </div>
        {loading && !stats ? (
          <div className="loading-block"><Spinner />Loading volume…</div>
        ) : (
          <VolumeChart data={stats?.volume ?? []} />
        )}
      </section>

      <div className="grid-half">
        <section className="card">
          <div className="card-head">
            <div>
              <div className="card-title">Rating distribution</div>
              <div className="card-sub">
                {ratingCount > 0 ? `${ratingCount} ratings · average ${average} of 5` : 'No ratings collected yet.'}
              </div>
            </div>
          </div>
          {ratingCount === 0 ? (
            <div className="chart-empty">Customers can rate a conversation from the chat window.</div>
          ) : (
            <div className="bars">
              {[5, 4, 3, 2, 1].map((score) => {
                const count = ratings.find((entry) => entry.score === score)?.count ?? 0;
                const pct = ratingCount > 0 ? Math.round((count / ratingCount) * 100) : 0;
                return (
                  <div key={score}>
                    <div className="bar-head">
                      <span className="bar-name">{score} star{score === 1 ? '' : 's'}</span>
                      <span className="bar-val">{count} · {pct}%</span>
                    </div>
                    <div className="bar-track" role="img" aria-label={`${score} stars: ${count} ratings, ${pct} percent`}>
                      <div className="bar-fill" style={{ width: `${pct}%` }} />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        <section className="card">
          <div className="card-head">
            <div>
              <div className="card-title">What brings customers here?</div>
              <div className="card-sub">Detected intent per conversation.</div>
            </div>
          </div>
          <IntentBars stats={stats} />
        </section>
      </div>

      <section className="card" style={{ marginTop: 16 }}>
        <div className="card-head">
          <div>
            <div className="card-title">Support Resolution & Quality Funnel</div>
            <div className="card-sub">
              How customer inquiries progress from first touch to verified resolution in the last {days} days.
            </div>
          </div>
          <span className="badge badge-ok">
            <ShieldCheck size={12} aria-hidden="true" />
            Zero-Guess Support
          </span>
        </div>

        <div className="funnel-grid">
          <div className="funnel-step">
            <div className="funnel-step-num">Step 1</div>
            <div className="funnel-step-name">Total Inquiries</div>
            <div className="funnel-step-val">{stats ? stats.total : 0}</div>
            <div className="funnel-step-sub">100% of customer threads</div>
          </div>

          <div className="funnel-step">
            <div className="funnel-step-num">Step 2</div>
            <div className="funnel-step-name">AI Grounded Answers</div>
            <div className="funnel-step-val">
              {stats ? (stats.aiResolutions + stats.humanHandoffs) : 0}
            </div>
            <div className="funnel-step-sub">Checked against verified KB</div>
          </div>

          <div className="funnel-step highlight">
            <div className="funnel-step-num">Step 3</div>
            <div className="funnel-step-name">AI Zero-Touch Resolutions</div>
            <div className="funnel-step-val">{stats ? stats.aiResolutions : 0}</div>
            <div className="funnel-step-sub">
              {stats && stats.total > 0 ? `${stats.resolutionRate}% resolution rate` : 'Resolved by AI'}
            </div>
          </div>

          <div className="funnel-step">
            <div className="funnel-step-num">Step 4</div>
            <div className="funnel-step-name">Human Escalations</div>
            <div className="funnel-step-val">{stats ? stats.humanHandoffs : 0}</div>
            <div className="funnel-step-sub">Handed off with full context</div>
          </div>

          <div className="funnel-step">
            <div className="funnel-step-num">Step 5</div>
            <div className="funnel-step-name">CSAT Validations</div>
            <div className="funnel-step-val">{stats ? stats.ratingCount : 0}</div>
            <div className="funnel-step-sub">
              {stats && stats.csat !== null ? `${stats.csat}% positive score` : 'Customer verified'}
            </div>
          </div>
        </div>
      </section>

      <section className="card" style={{ marginTop: 16 }}>
        <div className="card-head">
          <div>
            <div className="card-title">Customer Experience & Product Funnel Health</div>
            <div className="card-sub">Tracking every milestone from visitor to verified CSAT.</div>
          </div>
        </div>
        <div className="table-scroll">
          <table className="data">
            <thead>
              <tr>
                <th scope="col">Funnel Milestone</th>
                <th scope="col">Status</th>
                <th scope="col">Target Experience</th>
                <th scope="col">Measurement Metric</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td><strong>1. Landing page visit</strong></td>
                <td><span className="badge badge-ok">Active</span></td>
                <td>Positioning: "Answer when confident, escalate when necessary"</td>
                <td className="cell-muted">Traffic & interest</td>
              </tr>
              <tr>
                <td><strong>2. Start free / Signup</strong></td>
                <td><span className="badge badge-ok">Active</span></td>
                <td>Frictionless entry without mandatory credit card</td>
                <td className="cell-muted">Account creation rate</td>
              </tr>
              <tr>
                <td><strong>3. Workspace created</strong></td>
                <td><span className="badge badge-ok">Active</span></td>
                <td>Immediate ready-to-test workspace</td>
                <td className="cell-muted">Workspace readiness</td>
              </tr>
              <tr>
                <td><strong>4. Knowledge added</strong></td>
                <td><span className="badge badge-ok">Active</span></td>
                <td>Upload FAQ / Paste text / 1-click Acme demo policies</td>
                <td className="cell-muted">Verified articles</td>
              </tr>
              <tr>
                <td><strong>5. First AI question</strong></td>
                <td><span className="badge badge-ok">Active</span></td>
                <td>Customer asks support question in preview or widget</td>
                <td className="cell-muted">First message latency</td>
              </tr>
              <tr>
                <td><strong>6. First cited answer</strong></td>
                <td><span className="badge badge-ok">Active</span></td>
                <td>Trustworthy answer citing verified knowledge articles</td>
                <td className="cell-muted">Citation accuracy (100%)</td>
              </tr>
              <tr>
                <td><strong>7. Safe human handoff</strong></td>
                <td><span className="badge badge-ok">Active</span></td>
                <td>Low confidence or out-of-scope triggers handoff without guessing</td>
                <td className="cell-muted">{stats ? `${stats.humanHandoffs} handoffs` : '0'}</td>
              </tr>
              <tr>
                <td><strong>8. Agent inbox takeover</strong></td>
                <td><span className="badge badge-ok">Active</span></td>
                <td>Agent sees intent, full transcript, knowledge used, escalation reason</td>
                <td className="cell-muted">Realtime SSE queue</td>
              </tr>
              <tr>
                <td><strong>9. Conversation resolved</strong></td>
                <td><span className="badge badge-ok">Active</span></td>
                <td>Agent or AI resolves thread cleanly</td>
                <td className="cell-muted">{stats ? `${stats.resolved} resolved` : '0'}</td>
              </tr>
              <tr>
                <td><strong>10. Customer CSAT rating</strong></td>
                <td><span className="badge badge-ok">Active</span></td>
                <td>Customer rates 1-5 stars & message feedback thumbs</td>
                <td className="cell-muted">{stats && stats.csat !== null ? `${stats.csat}% CSAT` : 'Pending'}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

/* ================================================================== *
 * Settings
 * ================================================================== */

function SettingsPage({
  health, healthError, onRefreshHealth,
}: {
  health: Health | null;
  healthError: string | null;
  onRefreshHealth: () => void;
}) {
  const mode = health?.mode ?? 'demo';
  const [usage, setUsage] = useState<Usage | null>(null);
  const [usageError, setUsageError] = useState<string | null>(null);
  const [sysReport, setSysReport] = useState<SystemHealthReport | null>(null);
  const [sysLoading, setSysLoading] = useState(true);
  const [sysError, setSysError] = useState<string | null>(null);

  const fetchSysHealth = useCallback(() => {
    setSysLoading(true);
    setSysError(null);
    api.getSystemHealth()
      .then((report) => {
        setSysReport(report);
        setSysLoading(false);
      })
      .catch((err) => {
        setSysError(errorMessage(err));
        setSysLoading(false);
      });
  }, []);

  useEffect(() => {
    let cancelled = false;
    api.getUsage()
      .then((summary) => { if (!cancelled) setUsage(summary); })
      .catch((error) => { if (!cancelled) setUsageError(errorMessage(error)); });
    fetchSysHealth();
    return () => { cancelled = true; };
  }, [fetchSysHealth]);

  const handleRefresh = useCallback(() => {
    onRefreshHealth();
    fetchSysHealth();
  }, [onRefreshHealth, fetchSysHealth]);

  const meterRow = (label: string, used: number, limit: number | null) => {
    const percent = limit && limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
    return (
      <div style={{ marginBottom: 14 }}>
        <div className="bar-head">
          <span className="bar-name">{label}</span>
          <span className="bar-val">{used.toLocaleString()} / {limit === null ? '∞' : limit.toLocaleString()} · {percent}%</span>
        </div>
        <div
          className="bar-track"
          role="progressbar"
          aria-label={label}
          aria-valuenow={percent}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div className="bar-fill" style={{ width: `${percent}%` }} />
        </div>
      </div>
    );
  };

  return (
    <>
      <header className="page-head">
        <div>
          <div className="breadcrumb">
            <span>Workspace</span>
            <span aria-hidden="true">/</span>
            <span className="crumb-current">Settings</span>
          </div>
          <h1 className="page-title">Settings</h1>
          <p className="page-sub">How this Relay workspace is configured, and what it can and cannot do.</p>
        </div>
        <div className="head-actions">
          <button className="btn btn-outline" onClick={handleRefresh}>
            <RefreshCw size={15} aria-hidden="true" />Refresh status
          </button>
        </div>
      </header>

      <div className="stack">
        <section className="card">
          <div className="card-head">
            <div>
              <div className="card-title">System Health & Telemetry</div>
              <div className="card-sub">Real-time status of production subsystems (<span className="code">GET /api/admin/system-health</span>).</div>
            </div>
            <span className={`badge ${sysReport?.status === 'healthy' ? 'badge-ok' : sysReport?.status === 'degraded' ? 'badge-warn' : 'badge-danger'}`}>
              ● {sysReport?.status === 'healthy' ? 'All Systems Healthy' : sysReport?.status ?? 'Checking...'}
            </span>
          </div>
          <div className="card-pad">
            {sysLoading ? (
              <div className="loading-block"><Spinner />Checking system health…</div>
            ) : sysError ? (
              <p className="note" style={{ color: 'var(--danger)' }}>{sysError}</p>
            ) : sysReport ? (
              <>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10, marginBottom: 16 }}>
                  <div style={{ padding: 12, background: 'var(--surface-sunken)', borderRadius: 8, border: '1px solid var(--border)' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ fontWeight: 600, fontSize: 13 }}>API Gateway</span>
                      <span className={`badge ${sysReport.components.api.status === 'healthy' ? 'badge-ok' : 'badge-warn'}`}>
                        ● {sysReport.components.api.status}
                      </span>
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--text-sub)', marginTop: 6 }}>
                      {sysReport.telemetry.http.avgDurationMs !== null ? `${sysReport.telemetry.http.avgDurationMs}ms avg latency` : 'Active'}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
                      {sysReport.telemetry.http.requestsTotal} reqs · {sysReport.telemetry.http.responses2xx} 2xx · {sysReport.telemetry.http.responses4xx} 4xx · {sysReport.telemetry.http.responses5xx} 5xx
                    </div>
                  </div>

                  <div style={{ padding: 12, background: 'var(--surface-sunken)', borderRadius: 8, border: '1px solid var(--border)' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ fontWeight: 600, fontSize: 13 }}>Database</span>
                      <span className={`badge ${sysReport.components.database.status === 'healthy' ? 'badge-ok' : 'badge-warn'}`}>
                        ● {sysReport.components.database.status}
                      </span>
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--text-sub)', marginTop: 6 }}>
                      {sysReport.telemetry.database.pingLatencyMs !== null ? `${sysReport.telemetry.database.pingLatencyMs}ms ping` : 'Connected'}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
                      {sysReport.telemetry.database.errorsTotal} connection errors
                    </div>
                  </div>

                  <div style={{ padding: 12, background: 'var(--surface-sunken)', borderRadius: 8, border: '1px solid var(--border)' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ fontWeight: 600, fontSize: 13 }}>AI Provider</span>
                      <span className={`badge ${sysReport.components.aiProvider.status === 'healthy' ? 'badge-ok' : 'badge-warn'}`}>
                        ● {sysReport.components.aiProvider.status}
                      </span>
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--text-sub)', marginTop: 6 }}>
                      {sysReport.telemetry.ai.avgLatencyMs !== null ? `${sysReport.telemetry.ai.avgLatencyMs}ms avg latency` : 'Standby'}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
                      {sysReport.telemetry.ai.requestsTotal} turns · {sysReport.telemetry.ai.failuresTotal} failures
                    </div>
                  </div>

                  <div style={{ padding: 12, background: 'var(--surface-sunken)', borderRadius: 8, border: '1px solid var(--border)' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ fontWeight: 600, fontSize: 13 }}>Realtime / SSE</span>
                      <span className={`badge ${sysReport.components.realtimeSse.status === 'healthy' ? 'badge-ok' : 'badge-warn'}`}>
                        ● {sysReport.components.realtimeSse.status}
                      </span>
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--text-sub)', marginTop: 6 }}>
                      {sysReport.telemetry.realtimeSse.activeSubscribers} active clients
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
                      {sysReport.telemetry.realtimeSse.failuresTotal} disconnect errors
                    </div>
                  </div>

                  <div style={{ padding: 12, background: 'var(--surface-sunken)', borderRadius: 8, border: '1px solid var(--border)' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ fontWeight: 600, fontSize: 13 }}>Knowledge Base</span>
                      <span className={`badge ${sysReport.components.knowledgeBase.status === 'healthy' ? 'badge-ok' : 'badge-warn'}`}>
                        ● {sysReport.components.knowledgeBase.status}
                      </span>
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--text-sub)', marginTop: 6 }}>
                      {sysReport.telemetry.knowledgeBase.faqCount} articles indexed
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
                      {sysReport.telemetry.knowledgeBase.searchesTotal} searches · {sysReport.telemetry.knowledgeBase.zeroMatchSearches} zero matches
                    </div>
                  </div>
                </div>

                {sysReport.telemetry.planLimits || sysReport.telemetry.handoffs ? (
                  <dl className="kv" style={{ marginTop: 8 }}>
                    {sysReport.telemetry.planLimits && (
                      <>
                        <dt>Plan Rejections</dt>
                        <dd>
                          {sysReport.telemetry.planLimits.conversationsRejected} conversations · {sysReport.telemetry.planLimits.aiMessagesRejected} AI messages
                        </dd>
                      </>
                    )}
                    {sysReport.telemetry.handoffs && (
                      <>
                        <dt>Handoffs Recorded</dt>
                        <dd>
                          {sysReport.telemetry.handoffs.total} total
                        </dd>
                      </>
                    )}
                  </dl>
                ) : null}
              </>
            ) : null}
          </div>
        </section>

        <section className="card">
          <div className="card-head">
            <div>
              <div className="card-title">Free plan — this month</div>
              <div className="card-sub">Relay is free: conversations and AI answers reset every calendar month.</div>
            </div>
            <span className="badge badge-ok">Free</span>
          </div>
          <div className="card-pad">
            {usageError ? (
              <p className="note" style={{ color: 'var(--danger)' }}>{usageError}</p>
            ) : usage ? (
              <>
                {meterRow('Conversations', usage.conversationsUsed, usage.conversationsLimit)}
                {meterRow('AI answers', usage.aiMessagesUsed, usage.aiMessagesLimit)}
                <p className="note" style={{ marginTop: 8 }}>
                  Human replies, escalations and ratings are never metered. Self-hosting? Raise or remove the caps
                  with <span className="code">FREE_CONVERSATIONS_LIMIT</span> and <span className="code">FREE_AI_MESSAGES_LIMIT</span> (0 = unlimited).
                </p>
              </>
            ) : (
              <div className="loading-block"><Spinner />Loading usage…</div>
            )}
          </div>
        </section>

        <section className="card">
          <div className="card-head">
            <div>
              <div className="card-title">Runtime status</div>
              <div className="card-sub">Read from the server at <span className="code">GET /api/health</span>.</div>
            </div>
            <span className={`badge ${mode === 'live' ? 'badge-ok' : 'badge-demo'}`}>
              {mode === 'live' ? 'Live mode' : 'Demo mode'}
            </span>
          </div>
          <div className="card-pad">
            {healthError ? (
              <p className="note" style={{ color: 'var(--danger)' }}>{healthError}</p>
            ) : (
              <dl className="kv">
                <dt>Health</dt>
                <dd>{health ? health.status : 'unknown'}</dd>
                <dt>Answer engine</dt>
                <dd>
                  {mode === 'live'
                    ? 'CodeBuddy agent, answering only from the knowledge base.'
                    : 'Deterministic demo agent, answering only from the knowledge base.'}
                </dd>
                <dt>Admin auth</dt>
                <dd>
                  {health?.adminAuthRequired
                    ? 'Required — requests carry the x-admin-token header for this browser session.'
                    : 'Not required — the server has no ADMIN_TOKEN set.'}
                </dd>
                <dt>Data source</dt>
                <dd>
                  {mode === 'live'
                    ? 'Live conversations recorded in the server database.'
                    : 'Seeded sample conversations plus any you create. Not live customer performance.'}
                </dd>
              </dl>
            )}
          </div>
        </section>

        <section className="card">
          <div className="card-head">
            <div>
              <div className="card-title">Server setup</div>
              <div className="card-sub">Configured on the server environment — never entered in this interface.</div>
            </div>
            <span className="stat-icon"><ShieldCheck size={17} aria-hidden="true" /></span>
          </div>
          <div className="card-pad">
            <p className="note">
              Relay never asks for or stores credentials in the browser. Set these variables where the server
              process runs, then restart it.
            </p>
            <dl className="kv" style={{ marginTop: 16 }}>
              <dt><span className="code">CODEBUDDY_LIVE</span></dt>
              <dd>Set to <span className="code">true</span> to answer with the CodeBuddy agent. Left unset, the deterministic demo agent is used.</dd>
              <dt><span className="code">ADMIN_TOKEN</span></dt>
              <dd>Optional shared secret. When set, this workspace asks for it once per browser session and sends it as <span className="code">x-admin-token</span>.</dd>
              <dt><span className="code">MONGODB_URI</span></dt>
              <dd>Connection string for the MongoDB server. Defaults to <span className="code">mongodb://127.0.0.1:27017</span>; use an Atlas URI in production.</dd>
              <dt><span className="code">DATA_DIR</span></dt>
              <dd>Directory for local artifacts. Defaults to the server working directory.</dd>
              <dt><span className="code">SEED_DEMO</span></dt>
              <dd>Set to <span className="code">false</span> to start with an empty workspace instead of seeded sample conversations.</dd>
              <dt><span className="code">PORT</span></dt>
              <dd>Port the API listens on. Defaults to <span className="code">3000</span>; the dev client proxies <span className="code">/api</span> to it.</dd>
            </dl>
          </div>
        </section>

        <section className="card">
          <div className="card-head">
            <div>
              <div className="card-title">CodeBuddy integration</div>
              <div className="card-sub">Only used when <span className="code">CODEBUDDY_LIVE=true</span>.</div>
            </div>
            <span className="stat-icon lime"><Bot size={17} aria-hidden="true" /></span>
          </div>
          <div className="card-pad">
            <p className="note">
              In live mode Relay calls the CodeBuddy Agent SDK for a single, tool-free turn. The SDK reads its own
              credentials from the server environment, so there is nothing to paste into this app. The agent receives
              the knowledge base as context and returns a structured reply plus the article ids it used.
            </p>
            <p className="note" style={{ marginTop: 10 }}>
              If that call fails, the conversation is handed to a human instead of falling back to demo answers, so
              customers never see a guess presented as a real answer.
            </p>
          </div>
        </section>

        <section className="card">
          <div className="card-head">
            <div>
              <div className="card-title">Connectors</div>
              <div className="card-sub">What Relay can actually reach today.</div>
            </div>
            <span className="stat-icon mist"><LifeBuoy size={17} aria-hidden="true" /></span>
          </div>
          <div className="card-pad">
            <div className="row row-wrap" style={{ gap: 8, marginBottom: 12 }}>
              <span className="badge badge-ok"><Check size={12} aria-hidden="true" />Knowledge base</span>
              <span className="badge badge-ok"><Check size={12} aria-hidden="true" />Conversation store</span>
              <span className="badge badge-warn"><AlertCircle size={12} aria-hidden="true" />No order system</span>
              <span className="badge badge-warn"><AlertCircle size={12} aria-hidden="true" />No refund or payment system</span>
              <span className="badge badge-warn"><AlertCircle size={12} aria-hidden="true" />No account or identity system</span>
            </div>
            <p className="note">
              There is no live order, refund, payment or account connector. Relay cannot read or change order state,
              issue or check refunds, or verify identity — so it never claims to. Requests that need those systems are
              handed to a human agent, who can act on them outside this chat.
            </p>
          </div>
        </section>
      </div>
    </>
  );
}

/* ================================================================== *
 * Customer centre
 * ================================================================== */

type Page = 'overview' | 'conversations' | 'knowledge' | 'analytics' | 'settings';

interface AdminProps {
  session: SessionUser | null;
  onSignOut: () => void;
  onPreviewChat: () => void;
  onNewConversation: () => void;
}

function AdminApp({ session, onSignOut, onPreviewChat, onNewConversation }: AdminProps) {
  const [page, setPage] = useState<Page>('overview');
  const [days, setDays] = useState<7 | 30>(7);
  const daysRef = useRef<7 | 30>(7);
  const lastLoadedDays = useRef<7 | 30 | null>(null);

  const [health, setHealth] = useState<Health | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [faqs, setFaqs] = useState<Faq[]>([]);
  const [loading, setLoading] = useState(true);
  const [statsLoading, setStatsLoading] = useState(true);
  const [ready, setReady] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [source, setSource] = useState<{ id: string; title: string } | null>(null);
  const [toast, setToast] = useState<{ kind: 'error' | 'info'; text: string; retry?: () => void } | null>(null);
  const [authNeeded, setAuthNeeded] = useState(false);
  const [authDraft, setAuthDraft] = useState('');
  const [authError, setAuthError] = useState<string | null>(null);
  const [authBusy, setAuthBusy] = useState(false);
  const [retryToken, setRetryToken] = useState(0);
  const [installWidgetOpen, setInstallWidgetOpen] = useState(false);
  const [seedingSample, setSeedingSample] = useState(false);
  /** Conversations that just entered the human queue, with the time they did. */
  const [newWaiting, setNewWaiting] = useState<Map<string, number>>(new Map());
  const statusSnapshot = useRef<Map<string, string>>(new Map());
  /** Previous badge counts, used to trigger a pop animation on increase. */
  const lastBadgeRef = useRef<Record<string, number>>({ waiting: 0 });

  useEffect(() => {
    if (!toast) return;
    if (toast.kind === 'info') {
      const timer = window.setTimeout(() => {
        setToast(null);
      }, 4500);
      return () => window.clearTimeout(timer);
    }
  }, [toast]);

  const handleError = useCallback((error: unknown, retry?: () => void) => {
    if (error instanceof AuthError) {
      setAuthNeeded(true);
      return;
    }
    setToast({ kind: 'error', text: errorMessage(error), retry });
  }, []);

  const handleSeedSample = useCallback(async () => {
    setSeedingSample(true);
    try {
      const res = await api.seedSampleKnowledge();
      setFaqs(res.items);
      setToast({
        kind: 'info',
        text: `Loaded ${res.items.length} sample policies (Returns, Shipping, Refunds, Tracking, Account, Support).`,
      });
    } catch (err) {
      handleError(err);
    } finally {
      setSeedingSample(false);
    }
  }, [handleError]);

  const reload = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const [page, nextStats, nextFaqs] = await Promise.all([
        api.listConversations(),
        api.getStats(daysRef.current),
        api.listFaqs(),
      ]);
      setConversations(page.items);
      setStats(nextStats);
      setFaqs(nextFaqs);
      lastLoadedDays.current = daysRef.current;
      setReady(true);
      setAuthNeeded(false);
      setToast((current) => (current && current.kind === 'error' ? null : current));

      // Detect conversations that just joined the human queue so the UI can
      // flag them as fresh during a live demo.
      const newlyWaiting: string[] = [];
      const nextSnapshot = new Map<string, string>();
      for (const conversation of page.items) {
        const previous = statusSnapshot.current.get(conversation.id);
        if (previous && previous !== 'waiting' && conversation.status === 'waiting') {
          newlyWaiting.push(conversation.id);
        }
        nextSnapshot.set(conversation.id, conversation.status);
      }
      statusSnapshot.current = nextSnapshot;
      if (newlyWaiting.length > 0) {
        const now = Date.now();
        setNewWaiting((prev) => {
          const next = new Map(prev);
          for (const id of newlyWaiting) next.set(id, now);
          return next;
        });
      }
    } catch (error) {
      handleError(error, () => void reload(false));
    } finally {
      setLoading(false);
      setStatsLoading(false);
    }
  }, [handleError]);

  const refreshHealth = useCallback(async () => {
    setHealthError(null);
    try {
      setHealth(await api.health());
    } catch (error) {
      setHealthError(errorMessage(error));
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const loaded = await api.health();
        if (cancelled) return;
        setHealth(loaded);
        if (loaded.adminAuthRequired && !getAdminToken()) {
          setAuthNeeded(true);
          setLoading(false);
          setStatsLoading(false);
          return;
        }
      } catch (error) {
        if (cancelled) return;
        setHealthError(errorMessage(error));
        setToast({ kind: 'error', text: errorMessage(error), retry: () => void reload(false) });
        setLoading(false);
        setStatsLoading(false);
        return;
      }
      if (!cancelled) void reload(false);
    })();
    return () => { cancelled = true; };
  }, [reload]);

  useEffect(() => {
    if (!ready || lastLoadedDays.current === days) return;
    let cancelled = false;
    setStatsLoading(true);
    api.getStats(days)
      .then((next) => {
        if (!cancelled) {
          setStats(next);
          lastLoadedDays.current = days;
        }
      })
      .catch((error) => {
        if (!cancelled) handleError(error, () => setRetryToken((token) => token + 1));
      })
      .finally(() => {
        if (!cancelled) setStatsLoading(false);
      });
    return () => { cancelled = true; };
  }, [days, ready, handleError, retryToken]);

  // Poll faster while anything is waiting in the human queue so a demo with
  // two screens side by side shows the ticket appear within a couple seconds.
  const waitingCount = conversations.filter((conversation) => conversation.status === 'waiting').length;
  useEffect(() => {
    if (!ready || authNeeded) return;
    const interval = waitingCount > 0 ? 2500 : 10000;
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void reload(true);
    }, interval);
    return () => window.clearInterval(timer);
  }, [ready, authNeeded, reload, waitingCount]);

  // Realtime: an SSE stream pushes a refresh signal the moment anything
  // changes (conversation mutations, FAQ edits). Debounced so a burst of
  // events triggers one reload; polling above stays as the fallback.
  useEffect(() => {
    if (!ready || authNeeded || typeof window.EventSource === 'undefined') return;
    let timer: number | null = null;
    const scheduleReload = () => {
      if (timer !== null) return;
      timer = window.setTimeout(() => {
        timer = null;
        if (document.visibilityState === 'visible') void reload(true);
      }, 250);
    };
    const source = new EventSource('/api/admin/events');
    source.addEventListener('workspace', scheduleReload);
    source.onerror = () => {
      // EventSource retries on its own; polling covers us in the meantime.
    };
    return () => {
      source.close();
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [ready, authNeeded, reload]);

  // Expire the “new in queue” highlight after a few seconds.
  useEffect(() => {
    const timer = window.setInterval(() => {
      setNewWaiting((prev) => {
        if (prev.size === 0) return prev;
        const cutoff = Date.now() - 15000;
        const next = new Map(prev);
        let changed = false;
        next.forEach((at, id) => {
          if (at < cutoff) {
            next.delete(id);
            changed = true;
          }
        });
        return changed ? next : prev;
      });
    }, 4000);
    return () => window.clearInterval(timer);
  }, []);

  const changeDays = (value: 7 | 30) => {
    daysRef.current = value;
    setDays(value);
  };

  const submitToken = async (event: FormEvent) => {
    event.preventDefault();
    setAuthBusy(true);
    setAuthError(null);
    setAdminToken(authDraft.trim());
    try {
      const [page, nextStats, nextFaqs] = await Promise.all([
        api.listConversations(),
        api.getStats(daysRef.current),
        api.listFaqs(),
      ]);
      setConversations(page.items);
      setStats(nextStats);
      setFaqs(nextFaqs);
      lastLoadedDays.current = daysRef.current;
      setAuthNeeded(false);
      setReady(true);
      setAuthDraft('');
    } catch (error) {
      setAuthError(
        error instanceof AuthError
          ? 'That token was not accepted. Check the ADMIN_TOKEN value on the server.'
          : errorMessage(error),
      );
    } finally {
      setAuthBusy(false);
      setLoading(false);
      setStatsLoading(false);
    }
  };

  const updateConversation = useCallback((updated: Conversation) => {
    setConversations((prev) => {
      const index = prev.findIndex((entry) => entry.id === updated.id);
      if (index === -1) return [updated, ...prev];
      const next = [...prev];
      next[index] = updated;
      return next;
    });
  }, []);

  const closeDrawer = useCallback(() => setOpenId(null), []);
  const closeSource = useCallback(() => setSource(null), []);
  const openConversations = useCallback(() => setPage('conversations'), []);
  const openKnowledge = useCallback(() => setPage('knowledge'), []);

  const acknowledgeWaiting = useCallback((id: string) => {
    setNewWaiting((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
  }, []);

  const saveFaq = useCallback((saved: Faq) => {
    setFaqs((prev) => {
      const index = prev.findIndex((entry) => entry.id === saved.id);
      if (index === -1) return [saved, ...prev];
      const next = [...prev];
      next[index] = saved;
      return next;
    });
  }, []);

  const waiting = conversations.filter((conversation) => conversation.status === 'waiting').length;
  if (waiting !== lastBadgeRef.current.waiting) {
    lastBadgeRef.current.waiting = waiting;
  }
  const mode = health?.mode ?? stats?.mode ?? 'demo';
  const sourceFaq = source ? faqs.find((faq) => faq.id === source.id) ?? null : null;

  const navItems: Array<{ id: Page; label: string; icon: ReactNode; badge?: number }> = [
    { id: 'overview', label: 'Overview', icon: <LayoutDashboard size={16} aria-hidden="true" /> },
    { id: 'conversations', label: 'Conversations', icon: <MessagesSquare size={16} aria-hidden="true" />, badge: waiting },
    { id: 'knowledge', label: 'Knowledge base', icon: <BookOpen size={16} aria-hidden="true" /> },
    { id: 'analytics', label: 'Analytics', icon: <BarChart3 size={16} aria-hidden="true" /> },
  ];

  return (
    <div className="shell">
      <nav className="sidebar" aria-label="Workspace navigation">
        <div className="brand">
          <LogoMark />
          <span className="brand-word">relay</span>
        </div>

        <div className="workspace-card">
          <span className="workspace-avatar" aria-hidden="true">AS</span>
          <div className="workspace-meta">
            <div className="workspace-name">Acme Studio</div>
            <div className="workspace-sub">{mode === 'live' ? 'Live workspace' : 'Demo workspace'}</div>
          </div>
        </div>

        <div className="nav">
          <div className="nav-label">Workspace</div>
          {navItems.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`nav-item${page === item.id ? ' active' : ''}`}
              aria-current={page === item.id ? 'page' : undefined}
              onClick={() => setPage(item.id)}
            >
              {item.icon}
              <span className="nav-text">{item.label}</span>
              {item.badge ? (
                <span className={`badge badge-count${item.badge > lastBadgeRef.current[item.id] ? ' pulse' : ''}`}>
                  {item.badge}
                </span>
              ) : null}
            </button>
          ))}
        </div>

        <div className="nav-divider" />

        <div className="nav">
          <button type="button" className="nav-item" onClick={onPreviewChat}>
            <LifeBuoy size={16} aria-hidden="true" />
            <span className="nav-text">Customer preview</span>
          </button>
          <button
            type="button"
            className={`nav-item${page === 'settings' ? ' active' : ''}`}
            aria-current={page === 'settings' ? 'page' : undefined}
            onClick={() => setPage('settings')}
          >
            <SettingsIcon size={16} aria-hidden="true" />
            <span className="nav-text">Settings</span>
          </button>
        </div>

        <div className="sidebar-spacer" />

        <div className="agent-card">
          {session ? (
            <AccountCard user={session} onSignOut={onSignOut} />
          ) : (
            <>
              <span className="agent-avatar" aria-hidden="true">WA</span>
              <div className="workspace-meta">
                <div className="agent-name">Workspace Admin</div>
                <div className="agent-role">Active Session</div>
              </div>
            </>
          )}
        </div>
      </nav>

      <main className="main">
        {mode === 'demo' ? (
          <DemoBanner
            onPreviewChat={onPreviewChat}
            onOpenKb={openKnowledge}
          />
        ) : null}

        {page === 'overview' ? (
          <OverviewPage
            session={session}
            stats={stats}
            statsLoading={statsLoading}
            conversations={conversations}
            loading={loading}
            days={days}
            onDays={changeDays}
            onOpen={setOpenId}
            onViewAll={openConversations}
            onOpenKb={openKnowledge}
            onPreview={onPreviewChat}
            onNewConversation={onNewConversation}
            onInstallWidget={() => setInstallWidgetOpen(true)}
            onSeedSample={handleSeedSample}
            seedingSample={seedingSample}
            faqCount={faqs.length}
            mode={mode}
          />
        ) : null}

        {page === 'conversations' ? (
          <ConversationsPage
            conversations={conversations}
            loading={loading}
            onOpen={setOpenId}
            newWaitingIds={new Set(newWaiting.keys())}
            onOpenWaiting={acknowledgeWaiting}
          />
        ) : null}

        {page === 'knowledge' ? (
          <KnowledgePage
            faqs={faqs}
            loading={loading}
            onSaved={saveFaq}
            onSeedSample={handleSeedSample}
            seedingSample={seedingSample}
            onError={handleError}
          />
        ) : null}

        {page === 'analytics' ? (
          <AnalyticsPage stats={stats} loading={statsLoading} days={days} onDays={changeDays} />
        ) : null}

        {page === 'settings' ? (
          <SettingsPage health={health} healthError={healthError} onRefreshHealth={() => void refreshHealth()} />
        ) : null}
      </main>

      <InstallWidgetModal
        isOpen={installWidgetOpen}
        onClose={() => setInstallWidgetOpen(false)}
      />

      {openId ? (
        <ConversationDrawer
          id={openId}
          session={session}
          faqs={faqs}
          mode={mode}
          onClose={closeDrawer}
          onUpdated={updateConversation}
          onOpenSource={setSource}
          onError={handleError}
        />
      ) : null}

      {source ? (
        <Modal
          title={source.title}
          description={sourceFaq ? `Knowledge base article · ${INTENT_LABEL[sourceFaq.category]}` : 'Knowledge base article'}
          onClose={closeSource}
        >
          <div className="modal-body">
            {sourceFaq ? (
              <>
                <CitedAnswer faq={sourceFaq} />
                {sourceFaq.tags.length > 0 ? (
                  <div className="tag-row">
                    {sourceFaq.tags.map((tag) => <span className="tag" key={tag}>{tag}</span>)}
                  </div>
                ) : null}
                <p className="hint">Last updated {formatDateTime(sourceFaq.updatedAt)}.</p>
              </>
            ) : (
              <p className="note">
                This article is no longer in the knowledge base, so the original answer cannot be shown. The reply
                that cited it is still in the transcript above.
              </p>
            )}
          </div>
        </Modal>
      ) : null}

      {authNeeded ? (
        <Modal
          title="Admin sign-in required"
          description="This server requires an admin token before workspace data can be read."
          onClose={() => setAuthNeeded(false)}
        >
          <form onSubmit={submitToken}>
            <div className="modal-body">
              <label className="field">
                <span className="label">Admin token</span>
                <input
                  className="input"
                  type="password"
                  value={authDraft}
                  autoFocus
                  aria-label="Admin token"
                  placeholder="Paste the ADMIN_TOKEN value"
                  onChange={(event) => setAuthDraft(event.target.value)}
                />
                <span className="hint">
                  Stored in this browser tab only (sessionStorage) and sent as the x-admin-token header. Relay never
                  writes it anywhere else.
                </span>
              </label>
              {authError ? (
                <p className="note" style={{ color: 'var(--danger)' }}>{authError}</p>
              ) : null}
            </div>
            <div className="modal-foot">
              <button type="button" className="btn btn-ghost" onClick={() => setAuthNeeded(false)}>
                Not now
              </button>
              <button type="submit" className="btn btn-primary" disabled={authBusy || !authDraft.trim()}>
                {authBusy ? <Spinner size={14} /> : <ShieldCheck size={14} aria-hidden="true" />}
                Unlock workspace
              </button>
            </div>
          </form>
        </Modal>
      ) : null}

      {toast ? (
        <div className="toast-wrap">
          <div className={`toast${toast.kind === 'info' ? ' toast-info' : ''}`} role="alert">
            <span className="toast-icon">
              {toast.kind === 'info' ? (
                <CheckCircle2 size={16} aria-hidden="true" />
              ) : (
                <AlertCircle size={16} aria-hidden="true" />
              )}
            </span>
            <span className="toast-text">{toast.text}</span>
            {toast.retry ? (
              <button
                className="btn btn-outline btn-sm"
                onClick={() => {
                  const retry = toast.retry;
                  setToast(null);
                  retry?.();
                }}
              >
                <RefreshCw size={13} aria-hidden="true" />Retry
              </button>
            ) : null}
            <button className="icon-btn" onClick={() => setToast(null)} aria-label="Dismiss message">
              <X size={14} aria-hidden="true" />
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/* ================================================================== *
 * Root
 * ================================================================== */


export default AdminApp;
