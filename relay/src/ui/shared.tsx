/**
 * Shared UI primitives, formatting helpers and constants.
 *
 * Everything here is presentational or pure - imported by both the admin
 * workspace and the customer chat. Do not add data-fetching to this module.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent, MouseEvent, ReactNode } from 'react';
import {
  AlertCircle, ArrowRight, BookOpen, Bot, Check, CheckCircle2, Clock, ExternalLink,
  Inbox, Loader2, MessagesSquare, MessageSquare, Sparkles, Star, Users, Wrench, X,
} from 'lucide-react';

import { ApiError } from '../service-api';
import type { ConversationStatus, Faq, Intent, Message, Stats, VolumePoint } from '../service-types';

export const INTENTS: Intent[] = ['refund', 'order', 'technical', 'general'];
export const ADMIN_NAME = 'Alex Morgan';

export const INTENT_LABEL: Record<Intent, string> = {
  refund: 'Refunds & billing',
  order: 'Orders & shipping',
  technical: 'Technical issues',
  general: 'General questions',
};

export const STATUS_LABEL: Record<ConversationStatus, string> = {
  open: 'Open',
  waiting: 'Needs a human',
  resolved: 'Resolved',
};

export const PROVIDER_LABEL: Record<string, string> = {
  demo: 'Demo agent',
  codebuddy: 'CodeBuddy',
  human: 'Human agent',
};

export function initials(name: string, email: string): string {
  const source = (name || email || '?').trim();
  const parts = source.split(/[\s.@_-]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return source.slice(0, 2).toUpperCase();
}

export function timeAgo(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '—';
  const minutes = Math.round((Date.now() - then) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(new Date(iso));
}

export function formatDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('en-US', {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  }).format(date);
}

export function formatSeconds(value: number): string {
  if (value < 60) return `${Math.round(value)}s`;
  const minutes = Math.floor(value / 60);
  if (minutes < 60) {
    const seconds = Math.round(value % 60);
    return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

export function currentGreeting(): string {
  const hour = Number(
    new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false }).format(new Date()),
  );
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

export function todayLabel(): string {
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'long', month: 'long', day: 'numeric',
  }).format(new Date());
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return 'Something went wrong.';
}

/**
 * Highlights the sentence of a cited FAQ answer that matches the customer's
 * question terms, so the demo can point at the exact support-policy line used.
 */
export function CitedAnswer({ faq }: { faq: Faq }) {
  const query = lastCustomerQueryRef.value;
  const parts = useMemo(() => {
    if (!query) return null;
    const terms = flattenForHighlight(query);
    if (terms.length === 0) return null;
    const sentences = faq.answer.split(/(?<=[.!?])\s+/);
    let bestIndex = -1;
    let bestHits = 0;
    for (let index = 0; index < sentences.length; index += 1) {
      const haystack = sentences[index].toLowerCase();
      const hits = terms.filter((term) => haystack.includes(term)).length;
      if (hits > 0 && hits > bestHits) {
        bestIndex = index;
        bestHits = hits;
      }
    }
    if (bestIndex === -1) return null;
    return sentences.map((sentence, index) =>
      index === bestIndex ? (
        <mark className="cite" key={index}>
          {sentence}
          <span className="cite-note">cited</span>
        </mark>
      ) : (
        <span key={index}>{sentence} </span>
      ),
    );
  }, [faq.answer, query]);

  if (!parts) return <p className="faq-answer" style={{ marginTop: 0 }}>{faq.answer}</p>;
  return <p className="faq-answer" style={{ marginTop: 0 }}>{parts}</p>;
}

/** Shared query state so both workspace and customer modals can highlight. */
export const lastCustomerQueryRef = { value: '' };

export function flattenForHighlight(text: string): string[] {
  return String(text ?? '')
    .toLowerCase()
    .split(/[^a-z0-9']+/)
    .filter((word) => word.length >= 3 && !STOP_WORDS_HIGHLIGHT.includes(word));
}

export const STOP_WORDS_HIGHLIGHT = [
  'the', 'and', 'for', 'with', 'that', 'this', 'have', 'has', 'was', 'were', 'are',
  'you', 'your', 'our', 'their', 'from', 'what', 'when', 'where', 'how', 'why', 'who',
  'can', 'could', 'would', 'should', 'will', 'does', 'did', 'not', 'but', 'its', 'it\'s',
];

export function smoothPath(points: Array<[number, number]>): string {
  if (points.length === 0) return '';
  if (points.length < 3) {
    return points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p[0]} ${p[1]}`).join(' ');
  }
  let d = `M ${points[0][0]} ${points[0][1]}`;
  for (let i = 0; i < points.length - 1; i += 1) {
    const p0 = points[i - 1] ?? points[i];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[i + 2] ?? p2;
    const c1x = p1[0] + (p2[0] - p0[0]) / 6;
    const c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6;
    const c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += ` C ${c1x} ${c1y} ${c2x} ${c2y} ${p2[0]} ${p2[1]}`;
  }
  return d;
}

/* ================================================================== *
 * Shared UI
 * ================================================================== */

export function LogoMark({ size = 22 }: { size?: number }) {
  return (
    <svg className="brand-mark" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <rect x="3" y="3.5" width="18" height="7.5" rx="3.75" fill="#d9ed9f" />
      <rect x="3" y="13" width="18" height="7.5" rx="3.75" fill="#d9ed9f" />
      <path d="M12 10.4v3.2" stroke="#306645" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

export function Spinner({ size = 16 }: { size?: number }) {
  return <Loader2 className="spinner" size={size} aria-hidden="true" />;
}

export function Avatar({ name, email }: { name: string; email: string }) {
  return (
    <span className="avatar" aria-hidden="true">
      {initials(name, email)}
    </span>
  );
}

export function IntentPill({ intent }: { intent: Intent }) {
  return <span className={`pill pill-${intent}`}>{INTENT_LABEL[intent]}</span>;
}

export function StatusPill({ status }: { status: ConversationStatus }) {
  const tone = status === 'resolved' ? 'badge-ok' : status === 'waiting' ? 'badge-warn' : 'badge-neutral';
  return <span className={`badge ${tone}`}>{STATUS_LABEL[status]}</span>;
}

export function EmptyState({ title, text }: { title: string; text: string }) {
  return (
    <div className="empty">
      <div className="empty-icon">
        <Inbox size={20} aria-hidden="true" />
      </div>
      <div className="empty-title">{title}</div>
      <p className="empty-text">{text}</p>
    </div>
  );
}

interface ModalProps {
  title: string;
  description?: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}

export function Modal({ title, description, onClose, children, footer, wide = false }: ModalProps) {
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    panel.current?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="modal"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className={`modal-panel${wide ? ' wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        ref={panel}
      >
        <div className="modal-head">
          <div>
            <div className="card-title">{title}</div>
            {description ? <div className="card-sub">{description}</div> : null}
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Close dialog">
            <X size={16} aria-hidden="true" />
          </button>
        </div>
        {children}
        {footer ? <div className="modal-foot">{footer}</div> : null}
      </div>
    </div>
  );
}

/* ================================================================== *
 * Volume chart
 * ================================================================== */

const CHART_W = 720;
const CHART_H = 240;
const PAD = { left: 38, right: 14, top: 16, bottom: 28 };

export function VolumeChart({ data }: { data: VolumePoint[] }) {
  const [hover, setHover] = useState<number | null>(null);

  const innerW = CHART_W - PAD.left - PAD.right;
  const innerH = CHART_H - PAD.top - PAD.bottom;
  const peak = Math.max(1, ...data.map((point) => Math.max(point.ai, point.human)));
  const step = Math.max(1, Math.ceil(peak / 4));
  const max = step * 4;

  const x = (index: number) =>
    PAD.left + (data.length <= 1 ? innerW / 2 : (index / (data.length - 1)) * innerW);
  const y = (value: number) => PAD.top + innerH - (value / max) * innerH;

  const aiPoints = data.map((point, i) => [x(i), y(point.ai)] as [number, number]);
  const humanPoints = data.map((point, i) => [x(i), y(point.human)] as [number, number]);

  const aiArea = aiPoints.length
    ? `${smoothPath(aiPoints)} L ${x(data.length - 1)} ${PAD.top + innerH} L ${x(0)} ${PAD.top + innerH} Z`
    : '';
  const humanLine = smoothPath(humanPoints);

  const labelEvery = Math.max(1, Math.ceil(data.length / 7));
  const ticks = [0, 1, 2, 3, 4].map((i) => i * step);

  const active = hover !== null ? data[hover] : null;

  const onMove = (event: MouseEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const rel = ((event.clientX - rect.left) / rect.width) * CHART_W;
    let best = 0;
    let bestDist = Infinity;
    data.forEach((_, i) => {
      const dist = Math.abs(x(i) - rel);
      if (dist < bestDist) {
        bestDist = dist;
        best = i;
      }
    });
    setHover(best);
  };

  if (data.length === 0) {
    return <div className="chart-empty">No message activity in this window yet.</div>;
  }

  const tooltipX = hover !== null ? Math.min(Math.max(x(hover), PAD.left + 62), CHART_W - PAD.right - 62) : 0;

  return (
    <div className="chart-wrap">
      <svg
        className="chart-svg"
        viewBox={`0 0 ${CHART_W} ${CHART_H}`}
        role="img"
        aria-label="Conversations started per day, answered by Relay versus handled by a human"
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
      >
        {ticks.map((tick) => (
          <g key={tick}>
            <line
              x1={PAD.left}
              x2={CHART_W - PAD.right}
              y1={y(tick)}
              y2={y(tick)}
              stroke="#eef1ea"
              strokeWidth="1"
            />
            <text x={PAD.left - 10} y={y(tick) + 4} textAnchor="end" fontSize="10" fill="#8a978f">
              {tick}
            </text>
          </g>
        ))}

        <defs>
          <linearGradient id="relay-ai-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#306645" stopOpacity="0.18" />
            <stop offset="100%" stopColor="#306645" stopOpacity="0.01" />
          </linearGradient>
        </defs>

        {aiArea ? <path d={aiArea} fill="url(#relay-ai-fill)" /> : null}
        <path d={smoothPath(aiPoints)} fill="none" stroke="#306645" strokeWidth="2.4" strokeLinecap="round" />
        <path d={humanLine} fill="none" stroke="#b7d95f" strokeWidth="2.2" strokeLinecap="round" strokeDasharray="5 4" />

        {hover !== null ? (
          <g>
            <line
              x1={x(hover)}
              x2={x(hover)}
              y1={PAD.top}
              y2={PAD.top + innerH}
              stroke="#d5dbd1"
              strokeWidth="1"
            />
            <circle cx={x(hover)} cy={y(data[hover].ai)} r="4" fill="#306645" stroke="#fff" strokeWidth="1.5" />
            <circle cx={x(hover)} cy={y(data[hover].human)} r="4" fill="#b7d95f" stroke="#fff" strokeWidth="1.5" />
            <g transform={`translate(${tooltipX}, ${PAD.top})`}>
              <rect x="-62" y="0" width="124" height="46" rx="8" fill="#ffffff" stroke="#e5e9e3" />
              <text x="-54" y="17" fontSize="10" fill="#8a978f">
                {data[hover].label}
              </text>
              <text x="-54" y="34" fontSize="11" fill="#202b25">
                {`Assistant ${data[hover].ai}  ·  Human ${data[hover].human}`}
              </text>
            </g>
          </g>
        ) : null}

        {data.map((point, i) =>
          i % labelEvery === 0 || i === data.length - 1 ? (
            <text
              key={point.date}
              x={x(i)}
              y={CHART_H - 8}
              textAnchor="middle"
              fontSize="10"
              fill="#8a978f"
            >
              {point.label}
            </text>
          ) : null,
        )}
      </svg>
      <div className="row row-wrap" style={{ justifyContent: 'space-between', marginTop: 6 }}>
        <div className="chart-legend">
          <span className="legend-key">
            <span className="legend-swatch" style={{ background: '#306645' }} />Answered by Relay
          </span>
          <span className="legend-key">
            <span className="legend-swatch" style={{ background: '#b7d95f' }} />Handled by a human
          </span>
        </div>
        <span className="note">
          {active
            ? `${active.label}: ${active.ai} assistant · ${active.human} human`
            : 'Hover the chart for a daily breakdown.'}
        </span>
      </div>
    </div>
  );
}

/* ================================================================== *
 * Stat cards
 * ================================================================== */

export function StatCard({
  label, value, foot, icon, tone = '',
}: {
  label: string;
  value: string;
  foot: string;
  icon: ReactNode;
  tone?: string;
}) {
  return (
    <article className="card stat">
      <div className="stat-top">
        <span className="stat-label">{label}</span>
        <span className={`stat-icon ${tone}`}>{icon}</span>
      </div>
      <div className="stat-value">{value}</div>
      <p className="stat-foot">{foot}</p>
    </article>
  );
}

export function statCards(stats: Stats | null, days: 7 | 30) {
  const window = `last ${days} days`;
  const ratings = stats?.ratingCount ?? 0;
  return [
    {
      key: 'total',
      label: 'Total conversations',
      value: stats ? String(stats.total) : '—',
      foot: `Conversations started in the ${window}.`,
      icon: <MessagesSquare size={17} aria-hidden="true" />,
      tone: '',
    },
    {
      key: 'resolution',
      label: 'Resolution rate',
      value: stats ? `${stats.resolutionRate}%` : '—',
      foot: `Share of the ${window} marked resolved.`,
      icon: <CheckCircle2 size={17} aria-hidden="true" />,
      tone: 'lime',
    },
    {
      key: 'csat',
      label: 'Customer satisfaction',
      value: stats && stats.csat !== null ? `${stats.csat}%` : '—',
      foot: ratings
        ? `From ${ratings} customer rating${ratings === 1 ? '' : 's'} of 4 or 5.`
        : 'No customer ratings submitted yet.',
      icon: <Star size={17} aria-hidden="true" />,
      tone: 'sand',
    },
    {
      key: 'response',
      label: 'Avg. first response',
      value: stats && stats.avgResponseSeconds !== null ? formatSeconds(stats.avgResponseSeconds) : '—',
      foot: 'Time from a customer message to the first reply.',
      icon: <Clock size={17} aria-hidden="true" />,
      tone: 'mist',
    },
  ];
}

export function IntentBars({ stats }: { stats: Stats | null }) {
  const total = stats?.total ?? 0;
  const intents = stats?.intents ?? [];
  if (!stats || intents.length === 0) {
    return <div className="chart-empty">No conversations in this window yet.</div>;
  }
  return (
    <div className="bars">
      {intents.map(({ intent, count }) => {
        const pct = total > 0 ? Math.round((count / total) * 100) : 0;
        return (
          <div key={intent}>
            <div className="bar-head">
              <span className="bar-name">{INTENT_LABEL[intent]}</span>
              <span className="bar-val">{count} · {pct}%</span>
            </div>
            <div
              className="bar-track"
              role="img"
              aria-label={`${INTENT_LABEL[intent]}: ${count} conversations, ${pct} percent`}
            >
              <div className={`bar-fill${intent === 'general' ? ' lime' : ''}`} style={{ width: `${pct}%` }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ================================================================== *
 * Overview
 * ================================================================== */

export function MessageBubble({
  message, faqs, onOpenSource,
}: {
  message: Message;
  faqs: Faq[];
  onOpenSource: (source: { id: string; title: string }) => void;
}) {
  const tone =
    message.role === 'user' ? 'msg-user'
      : message.role === 'human' ? 'msg-human'
        : message.role === 'system' ? 'msg-system'
          : 'msg-assistant';

  const roleLabel =
    message.role === 'user' ? 'Customer'
      : message.role === 'system' ? 'System'
        : PROVIDER_LABEL[message.provider ?? ''] ?? (message.role === 'human' ? 'Human agent' : 'Relay assistant');

  const isTool = message.role === 'assistant' && Boolean(message.tool);

  return (
    <div className={`msg ${tone}${isTool ? ' msg-tool' : ''}`}>
      {isTool ? (
        <div className="tool-trace" aria-hidden="true">
          <Wrench size={12} aria-hidden="true" />
          <span className="code">lookup_order("{message.tool!.args.orderId}")</span>
          <span className="tool-trace-check">✓</span>
        </div>
      ) : null}
      <div className="msg-bubble">{message.content}</div>
      {message.sources && message.sources.length > 0 ? (
        <div className="sources">
          {message.sources.map((source) => {
            const known = faqs.some((faq) => faq.id === source.id);
            return (
              <button
                key={source.id}
                className="source-chip"
                onClick={() => onOpenSource(source)}
                aria-label={`Open knowledge base article: ${source.title}`}
              >
                <BookOpen size={12} aria-hidden="true" />
                {source.title}
                <ExternalLink size={11} aria-hidden="true" />
                {!known ? <span className="hint">(not in list)</span> : null}
              </button>
            );
          })}
        </div>
      ) : null}
      <div className="msg-meta">
        <span className="msg-role-tag">{roleLabel}</span>
        <span aria-hidden="true">·</span>
        <span>{formatDateTime(message.createdAt)}</span>
      </div>
    </div>
  );
}

/* ================================================================== *
 * Knowledge base
 * ================================================================== */
