/**
 * Customer chat: conversation session management, staged human handoff,
 * order-lookup tool display, ratings and demo starters.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent, MouseEvent } from 'react';
import {
  AlertCircle, ArrowRight, Bot, Check, CheckCircle2, Loader2, MessageSquare, Send,
  Sparkles, Star, UserRound, Users, Wrench,
} from 'lucide-react';

import { ApiError, api, customerApi, loadCustomerStore, saveCustomerStore } from '../service-api';
import type { Conversation, ConversationDetail, CustomerStore, Faq, Health, Message } from '../service-types';
import {
  CitedAnswer, EmptyState, INTENT_LABEL, LogoMark, Modal, Spinner, STATUS_LABEL, MessageBubble, lastCustomerQueryRef, errorMessage,
  formatDateTime, timeAgo,
} from '../ui/shared';

interface DemoStarter {
  label: string;
  text: string;
  kind: 'order' | 'other';
  orderId?: string;
}

/** One-click demo questions, ordered to demonstrate Relay's core loop in 1-2-3 sequence. */
const DEMO_STARTERS: DemoStarter[] = [
  {
    label: '1. Order + refund',
    text: "My order hasn't arrived and I want a refund.",
    kind: 'other',
  },
  {
    label: '2. Unanswerable test',
    text: 'I received the wrong product. Can you issue the refund now?',
    kind: 'other',
  },
  {
    label: '3. Order lookup #4471',
    text: "Where's my order #4471? It was supposed to arrive today.",
    kind: 'order',
    orderId: '4471',
  },
  { label: '4. Talk to a human', text: 'I want to talk to a human agent', kind: 'other' },
];

function CustomerCenter({ fresh, onExit }: { fresh: boolean; onExit: () => void }) {
  const [store, setStore] = useState<CustomerStore>(() => loadCustomerStore());
  const storeRef = useRef<CustomerStore>(store);
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [faqs, setFaqs] = useState<Faq[]>([]);
  const [health, setHealth] = useState<Health | null>(null);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState<null | 'send' | 'escalate'>(null);
  /** Staged reply phases so the demo can show the tool call before the answer. */
  const [phase, setPhase] = useState<null | 'tool' | 'answering' | 'escalating'>(null);
  /** Transient banner after an order-lookup tool call. */
  const [toolFlash, setToolFlash] = useState<{ orderId: string; at: number } | null>(null);
  /** Two-stage human handoff: connecting… then queued. */
  const [handoffStage, setHandoffStage] = useState<'connecting' | 'queued' | null>(null);
  const pendingHandoffAnnounced = useRef(false);
  const pendingOrderId = useRef<string | null>(null);
  const prevStatusRef = useRef<Conversation['status'] | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [source, setSource] = useState<Faq | null>(null);
  const [ratingBusy, setRatingBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const commit = useCallback((next: CustomerStore) => {
    storeRef.current = next;
    setStore(next);
    saveCustomerStore(next);
  }, []);

  const tokenFor = useCallback(
    (id: string | undefined) => storeRef.current.sessions.find((session) => session.id === id)?.token ?? null,
    [],
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const [loadedFaqs, loadedHealth] = await Promise.all([
          api.listFaqs(),
          api.health().catch(() => null),
        ]);
        if (cancelled) return;
        setFaqs(loadedFaqs);
        if (loadedHealth) setHealth(loadedHealth);

        const current = storeRef.current;
        if (fresh) {
          commit({ activeId: null, sessions: current.sessions });
        } else if (current.activeId) {
          const session = current.sessions.find((entry) => entry.id === current.activeId);
          if (session) {
            try {
              const detail = await customerApi.get(session.id, session.token);
              if (cancelled) return;
              setConversation(detail.conversation);
              setMessages(detail.messages);
            } catch {
              if (!cancelled) commit({ activeId: null, sessions: current.sessions });
            }
          }
        }
      } catch (caught) {
        if (!cancelled) setError(errorMessage(caught));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [fresh, commit]);

  // While a human owns the thread, poll for their replies.
  useEffect(() => {
    const id = conversation?.id;
    if (!id || conversation?.status !== 'waiting') return;
    const token = tokenFor(id);
    if (!token) return;
    let cancelled = false;
    const timer = window.setInterval(async () => {
      try {
        const detail = await customerApi.get(id, token);
        if (!cancelled) {
          setConversation(detail.conversation);
          setMessages(detail.messages);
        }
      } catch {
        /* retry on the next tick */
      }
    }, 4000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [conversation?.id, conversation?.status, tokenFor]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, busy]);

  // The tool phase is staged: show “looking up order…” briefly, then switch to
  // the answering indicator while the request is still in flight.
  useEffect(() => {
    if (phase !== 'tool') return;
    const timer = window.setTimeout(() => {
      setPhase((current) => (current === 'tool' ? 'answering' : current));
    }, 1200);
    return () => window.clearTimeout(timer);
  }, [phase]);

  // Auto-dismiss the tool-call banner.
  useEffect(() => {
    if (!toolFlash) return;
    const timer = window.setTimeout(() => setToolFlash(null), 6000);
    return () => window.clearTimeout(timer);
  }, [toolFlash]);

  // When the conversation lands in the queue, run the staged handoff. If the
  // assistant already announced the handoff in its reply (auto-escalation),
  // skip straight to “queued”; a customer-requested handoff gets the full
  // “connecting you…” animation with a transient system notice.
  useEffect(() => {
    const status = conversation?.status;
    const prev = prevStatusRef.current;
    prevStatusRef.current = status;
    if (status !== 'waiting' || prev === undefined || prev === 'waiting') return;
    if (pendingHandoffAnnounced.current) {
      setHandoffStage('queued');
      return;
    }
    setHandoffStage('connecting');
    const timer = window.setTimeout(() => {
      setHandoffStage('queued');
      setMessages((current) => {
        if (current.some((m) => m.role === 'system' && /connecting you to a human agent/i.test(m.content))) {
          return current;
        }
        return [
          ...current,
          {
            id: `local-connecting-${Date.now()}`,
            conversationId: conversation?.id ?? '',
            role: 'system' as const,
            content: 'Connecting you to a human agent…',
            createdAt: new Date().toISOString(),
            sources: [],
          },
        ];
      });
    }, 1600);
    return () => window.clearTimeout(timer);
  }, [conversation?.status, conversation?.id]);

  // Leave the queued state when the conversation is resolved or a new one starts.
  useEffect(() => {
    if (conversation?.status !== 'waiting' && handoffStage !== null) {
      setHandoffStage(null);
    }
  }, [conversation?.status, handoffStage]);

  const pendingSend = useRef<{ conversationId: string; content: string; clientId: string } | null>(null);

  const send = useCallback(async (raw: string, opts?: { starter?: DemoStarter }) => {
    const content = raw.trim();
    if (!content || busy !== null) return;
    setError(null);
    setBusy('send');
    setInput('');
    /** A new conversation may fail (free cap). Only create once per send. */
    let createdThisSend = false;
    pendingOrderId.current = opts?.starter?.orderId ?? /(\d{3,6})/.exec(content)?.[1] ?? null;
    // Staged tool phase for typed questions too: an order number plus a status
    // word means the lookup tool is about to run.
    const looksLikeOrderLookup = pendingOrderId.current !== null
      && /\b(where|track|status|arrive|delivery|shipping|shipped|late|stuck)\b/i.test(content);
    setPhase(opts?.starter?.kind === 'order' || looksLikeOrderLookup ? 'tool' : 'answering');

    let active = conversation;
    let token = tokenFor(active?.id);
    try {
      if (!active || !token) {
        const created = await customerApi.create({});
        active = created.conversation;
        token = created.accessToken; // may be null when the free cap blocks creation
        commit({
          activeId: active.id,
          sessions: [
            { id: active.id, token, title: active.title, createdAt: new Date().toISOString() },
            ...storeRef.current.sessions.filter((entry) => entry.id !== active!.id),
          ].slice(0, 12),
        });
        setConversation(active);
        setMessages([]);
        prevStatusRef.current = undefined;
        createdThisSend = true;
      }

      const optimistic: Message = {
        id: `pending-${Date.now()}`,
        conversationId: active.id,
        role: 'user',
        content,
        createdAt: new Date().toISOString(),
        sources: [],
      };
      setMessages((prev) => [...prev, optimistic]);

      if (!pendingSend.current || pendingSend.current.conversationId !== active.id || pendingSend.current.content !== content) {
        pendingSend.current = { conversationId: active.id, content, clientId: crypto.randomUUID() };
      }
      const detail = await customerApi.send(active.id, token, content, pendingSend.current.clientId);
      pendingSend.current = null;
      setConversation(detail.conversation);
      setMessages(detail.messages);
      if (detail.conversation.status === 'waiting') {
        // The assistant reply in this response already announced the handoff.
        pendingHandoffAnnounced.current = true;
      }
      if (detail.toolEvent?.name === 'lookup_order') {
        setToolFlash({ orderId: detail.toolEvent.args.orderId, at: Date.now() });
      }
      commit({
        activeId: active.id,
        sessions: storeRef.current.sessions.map((entry) =>
          entry.id === active!.id ? { ...entry, title: detail.conversation.title } : entry,
        ),
      });
    } catch (caught) {
      setMessages((prev) => prev.filter((message) => !message.id.startsWith('pending-')));
      setInput(content);
      // A 429 from the free-plan cap: reset to the pre-send state so a retry
      // can go through (or reach a human) once capacity frees up.
      if (createdThisSend && caught instanceof ApiError && caught.status === 429) {
        commit({ activeId: null, sessions: storeRef.current.sessions.filter((entry) => entry.id !== active!.id) });
        setConversation(null);
        setMessages([]);
      }
      setError(errorMessage(caught));
    } finally {
      setBusy(null);
      setPhase(null);
      pendingOrderId.current = null;
    }
  }, [busy, commit, conversation, tokenFor]);

  const requestHuman = async () => {
    const id = conversation?.id;
    const token = tokenFor(id);
    if (!id || !token || busy !== null) return;
    setError(null);
    setBusy('escalate');
    setPhase('escalating');
    pendingHandoffAnnounced.current = false;
    try {
      await customerApi.escalate(id, token, 'Customer requested a human agent');
      const detail = await customerApi.get(id, token);
      setConversation(detail.conversation);
      setMessages(detail.messages);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(null);
      setPhase(null);
    }
  };

  const submitRating = async (score: number) => {
    const id = conversation?.id;
    const token = tokenFor(id);
    if (!id || !token || ratingBusy) return;
    setRatingBusy(true);
    setError(null);
    try {
      const updated = await customerApi.rate(id, token, score);
      setConversation(updated);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setRatingBusy(false);
    }
  };

  const handleMessageFeedback = useCallback(
    async (
      messageId: string,
      feedback: {
        helpful: boolean;
        reason?: 'incorrect' | 'didnt_answer' | 'missing_info' | 'need_human' | null;
        comment?: string | null;
      },
    ) => {
      const id = conversation?.id;
      const token = tokenFor(id);
      if (!id || !token) return;
      try {
        await customerApi.feedback(id, token, messageId, feedback);
        const detail = await customerApi.get(id, token);
        setConversation(detail.conversation);
        setMessages(detail.messages);
      } catch (err) {
        console.error('Failed to submit message feedback:', err);
      }
    },
    [conversation?.id, tokenFor],
  );

  const startNew = () => {
    commit({ activeId: null, sessions: storeRef.current.sessions });
    setConversation(null);
    setMessages([]);
    setInput('');
    setError(null);
    setToolFlash(null);
    setHandoffStage(null);
    pendingHandoffAnnounced.current = false;
    prevStatusRef.current = undefined;
    inputRef.current?.focus();
  };

  const switchSession = async (id: string) => {
    const session = storeRef.current.sessions.find((entry) => entry.id === id);
    if (!session) return;
    setError(null);
    setLoading(true);
    setToolFlash(null);
    setHandoffStage(null);
    pendingHandoffAnnounced.current = false;
    prevStatusRef.current = undefined;
    try {
      const detail = await customerApi.get(session.id, session.token);
      commit({ ...storeRef.current, activeId: session.id });
      setConversation(detail.conversation);
      setMessages(detail.messages);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setLoading(false);
    }
  };

  const openSource = async (ref: { id: string; title: string }) => {
    const found = faqs.find((faq) => faq.id === ref.id);
    if (found) {
      setSource(found);
      return;
    }
    try {
      const latest = await api.listFaqs();
      setFaqs(latest);
      const match = latest.find((faq) => faq.id === ref.id);
      if (match) setSource(match);
      else setError(`“${ref.title}” is no longer in the knowledge base.`);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  };

  const resolved = conversation?.status === 'resolved';
  const waiting = conversation?.status === 'waiting';
  const canRate =
    Boolean(conversation) &&
    conversation!.rating === null &&
    messages.some((message) => message.role === 'assistant' || message.role === 'human');

  return (
    <div className="customer">
      <div className="customer-bar">
        <div className="row">
          <LogoMark />
          <span className="brand-word">relay</span>
          <span className="badge badge-neutral">Customer view</span>
        </div>
        <div className="row">
          {store.sessions.length > 0 ? (
            <div className="field" style={{ minWidth: 190 }}>
              <select
                className="select"
                value={conversation?.id ?? ''}
                aria-label="Your previous conversations"
                onChange={(event) => {
                  if (event.target.value) void switchSession(event.target.value);
                }}
              >
                <option value="">{conversation ? 'Switch conversation…' : 'Your conversations…'}</option>
                {store.sessions.map((session) => (
                  <option key={session.id} value={session.id}>
                    {session.title || 'New conversation'}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
          <button className="btn btn-outline btn-sm" onClick={startNew}>New conversation</button>
          <button className="btn btn-ghost btn-sm" onClick={onExit}>Back to workspace</button>
        </div>
      </div>

      <div className="customer-grid">
        <aside className="customer-aside">
          <h1 className="customer-title">A helpful answer is one message away.</h1>
          <p className="page-sub">
            Ask in your own words. Relay answers from the support knowledge base and shows you the article it used.
          </p>

          <div className="row row-wrap" style={{ marginTop: 14 }}>
            <span className="badge badge-ok">
              <CheckCircle2 size={12} aria-hidden="true" />All systems operational
            </span>
            <span className="badge badge-neutral">
              {health?.mode === 'live' ? 'Live answers' : 'Demo answers'}
            </span>
          </div>

          <p className="note" style={{ marginTop: 18 }}>
            {health?.mode === 'live'
              ? 'Answers come from the CodeBuddy agent and your support knowledge base.'
              : 'This workspace runs in demo mode: answers are deterministic and come from the sample knowledge base. Try one of the scripted starters above the chat box.'}
          </p>

          <div className="card" style={{ marginTop: 22, border: '1px solid var(--border)' }}>
            <div className="card-head" style={{ padding: '12px 14px', borderBottom: '1px solid var(--border)' }}>
              <div className="row" style={{ gap: 7 }}>
                <Sparkles size={14} aria-hidden="true" style={{ color: 'var(--brand)' }} />
                <span style={{ fontSize: 13, fontWeight: 600 }}>The 30-Second Proof</span>
              </div>
            </div>
            <div style={{ padding: '12px 14px', fontSize: 12, lineHeight: 1.5, color: 'var(--muted)' }}>
              <p style={{ margin: '0 0 8px' }}>Watch the core Relay loop in 3 clicks:</p>
              <ol style={{ paddingLeft: 16, margin: 0 }}>
                <li style={{ marginBottom: 6 }}>
                  <strong>Policy answer:</strong> Click starter #1 &rarr; Relay cites shipping and refund policies.
                </li>
                <li style={{ marginBottom: 6 }}>
                  <strong>Knowledge gap:</strong> Click starter #2 &rarr; Relay refuses to fabricate citations and offers human handoff.
                </li>
                <li>
                  <strong>Human inbox:</strong> Click &ldquo;Request a human&rdquo; &rarr; Head back to the workspace to see full context, cited policies, and resolve the thread.
                </li>
              </ol>
            </div>
          </div>
        </aside>

        <section className="chat-panel" aria-label="Support chat">
          <div className="chat-head">
            <div className="row">
              <span className="stat-icon"><Bot size={17} aria-hidden="true" /></span>
              <div>
                <div className="card-title">Relay Assistant</div>
                <div className="card-sub">Knowledge-powered support</div>
              </div>
            </div>
            <span className="badge badge-demo">{health?.mode === 'live' ? 'Live' : 'Demo'} mode</span>
          </div>

          <div className="chat-scroll" ref={scrollRef}>
            {loading ? (
              <div className="loading-block"><Spinner />Loading your conversation…</div>
            ) : messages.length === 0 ? (
              <EmptyState
                title="No messages yet"
                text="Send your first message and Relay will look for the best answer in the knowledge base."
              />
            ) : (
              <div className="log">
                {messages.map((message) => (
                  <MessageBubble
                    key={message.id}
                    message={message}
                    faqs={faqs}
                    allowFeedback={!resolved && !waiting}
                    onFeedback={handleMessageFeedback}
                    onOpenSource={(source) => {
                      const lastUser = [...messages].reverse().find((entry) => entry.role === 'user');
                      if (lastUser) lastCustomerQueryRef.value = lastUser.content;
                      void openSource(source);
                    }}
                  />
                ))}
                {busy === 'send' && conversation && !waiting ? (
                  <div className="msg msg-assistant">
                    <div className="typing">
                      {phase === 'tool' ? (
                        <>
                          <Wrench size={13} aria-hidden="true" />
                          Looking up order #{pendingOrderId.current ?? '…'}…
                        </>
                      ) : (
                        <>
                          <span className="dots" aria-hidden="true"><span /><span /><span /></span>
                          Finding the best answer…
                        </>
                      )}
                    </div>
                  </div>
                ) : null}
              </div>
            )}
          </div>

          <div className="chat-foot">
            {error ? (
              <div className="toast" role="alert" style={{ marginBottom: 12 }}>
                <AlertCircle size={16} aria-hidden="true" />
                <span className="toast-text">{error}</span>
                <button className="btn btn-ghost btn-sm" onClick={() => setError(null)}>Dismiss</button>
              </div>
            ) : null}

            {handoffStage === 'connecting' ? (
              <div className="handoff handoff-connecting">
                <span className="dots" aria-hidden="true"><span /><span /><span /></span>
                <span>Connecting you to a human agent…</span>
              </div>
            ) : null}

            {waiting ? (
              <div className="handoff">
                <Users size={16} aria-hidden="true" />
                <span>
                  You are in the human queue. Reason: {conversation?.escalationReason ?? 'Customer requested a human agent'}.
                  A teammate will reply here — you can keep adding details in the meantime.
                </span>
              </div>
            ) : null}

            {toolFlash ? (
              <div className="tool-flash" role="status">
                <Wrench size={14} aria-hidden="true" />
                <span>
                  Relay just looked up order <strong>#{toolFlash.orderId}</strong> live — order systems are
                  normally out of reach for chat, so this is the one connector enabled for the demo.
                </span>
              </div>
            ) : null}

            {resolved ? (
              <div className="resolved-note">
                <span>This conversation is marked resolved. Start a new one if you need anything else.</span>
                <button className="btn btn-primary btn-sm" onClick={startNew}>New conversation</button>
              </div>
            ) : (
              <>
                {canRate && !conversation?.rating ? (
                  <div className="row row-wrap" style={{ justifyContent: 'space-between', marginBottom: 10 }}>
                    <span className="note">How was this answer?</span>
                    <div className="rating" role="group" aria-label="Rate this conversation">
                      {[1, 2, 3, 4, 5].map((score) => (
                        <button
                          key={score}
                          className="star-btn"
                          disabled={ratingBusy}
                          aria-label={`Rate ${score} out of 5`}
                          onClick={() => void submitRating(score)}
                        >
                          <Star size={17} aria-hidden="true" />
                        </button>
                      ))}
                    </div>
                  </div>
                ) : null}
                {conversation?.rating ? (
                  <p className="note" style={{ marginBottom: 10 }}>
                    Thanks for your feedback — you rated this {conversation.rating} out of 5.
                  </p>
                ) : null}

                <div className="starters" role="group" aria-label="Demo starter questions">
                  {DEMO_STARTERS.map((starter) => (
                    <button
                      key={starter.label}
                      type="button"
                      className="starter"
                      disabled={busy !== null}
                      onClick={() => {
                        setInput(starter.text);
                        inputRef.current?.focus();
                      }}
                    >
                      <Sparkles size={13} aria-hidden="true" />
                      {starter.label}
                      <span className={`starter-kbd${starter.kind === 'order' ? ' order' : ''}`}>Try this →</span>
                    </button>
                  ))}
                </div>

                <div className="composer">
                  <textarea
                    ref={inputRef}
                    rows={3}
                    value={input}
                    aria-label="Message Relay Assistant"
                    placeholder="Type your question…"
                    onChange={(event) => setInput(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' && !event.shiftKey) {
                        event.preventDefault();
                        void send(input);
                      }
                    }}
                  />
                  <div className="composer-foot">
                    <span className="hint">Enter to send · Shift + Enter for a new line</span>
                    <div className="row">
                      <button
                        className="btn btn-outline btn-sm"
                        onClick={requestHuman}
                        disabled={busy !== null || !conversation || waiting}
                      >
                        <UserRound size={14} aria-hidden="true" />
                        {waiting ? 'Human requested' : busy === 'escalate' ? 'Requesting…' : 'Request a human'}
                      </button>
                      <button
                        className="btn btn-primary btn-sm"
                        onClick={() => void send(input)}
                        disabled={busy !== null || !input.trim()}
                      >
                        {busy === 'send' ? <Spinner size={14} /> : <Send size={14} aria-hidden="true" />}
                        Send
                      </button>
                    </div>
                  </div>
                </div>
              </>
            )}
          </div>
        </section>
      </div>

      {source ? (
        <Modal
          title={source.title}
          description={`Knowledge base article · ${INTENT_LABEL[source.category]}`}
          onClose={() => setSource(null)}
        >
          <div className="modal-body">
            <CitedAnswer faq={source} />
            {source.tags.length > 0 ? (
              <div className="tag-row">
                {source.tags.map((tag) => <span className="tag" key={tag}>{tag}</span>)}
              </div>
            ) : null}
            <p className="hint">Last updated {formatDateTime(source.updatedAt)}.</p>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}

/* ================================================================== *
 * Workspace shell
 * ================================================================== */

export default CustomerCenter;
