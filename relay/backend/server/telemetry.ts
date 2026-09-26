/**
 * Relay production observability & telemetry layer.
 *
 * Tracks in-memory counters and latencies for:
 *   - AI request success / failure & latency
 *   - MongoDB query latency & error counts
 *   - API HTTP request volume (2xx, 4xx, 5xx)
 *   - SSE connection lifecycle & errors
 *   - Human handoff counts & failure reasons
 *   - Citation retrieval success / failure
 *   - Free-plan limit rejections
 *
 * Powers /api/admin/system-health and enhances /api/metrics.
 */

export interface SystemComponentHealth {
  status: 'healthy' | 'degraded' | 'unhealthy';
  message?: string;
  latencyMs?: number;
  details?: Record<string, unknown>;
}

export interface SystemHealthReport {
  status: 'healthy' | 'degraded' | 'unhealthy';
  timestamp: string;
  uptimeSeconds: number;
  components: {
    api: SystemComponentHealth;
    database: SystemComponentHealth;
    aiProvider: SystemComponentHealth;
    realtimeSse: SystemComponentHealth;
    knowledgeBase: SystemComponentHealth;
  };
  telemetry: {
    ai: {
      requestsTotal: number;
      failuresTotal: number;
      avgLatencyMs: number | null;
      lastLatencyMs: number | null;
    };
    http: {
      requestsTotal: number;
      responses2xx: number;
      responses4xx: number;
      responses5xx: number;
      avgDurationMs: number | null;
    };
    database: {
      pingLatencyMs: number | null;
      errorsTotal: number;
    };
    realtimeSse: {
      activeSubscribers: number;
      failuresTotal: number;
    };
    knowledgeBase: {
      searchesTotal: number;
      zeroMatchSearches: number;
      faqCount: number;
    };
    planLimits: {
      rejectionsTotal: number;
      conversationsBlocked: number;
      aiMessagesBlocked: number;
    };
    handoffs: {
      total: number;
      byReason: Record<string, number>;
    };
  };
}

class TelemetryCollector {
  private startTime = Date.now();

  // AI
  private aiRequestsTotal = 0;
  private aiFailuresTotal = 0;
  private aiLatencySumMs = 0;
  private aiLatencyCount = 0;
  private aiLastLatencyMs: number | null = null;

  // HTTP
  private httpRequestsTotal = 0;
  private http2xxTotal = 0;
  private http4xxTotal = 0;
  private http5xxTotal = 0;
  private httpDurationSumMs = 0;

  // Database
  private dbErrorsTotal = 0;
  private dbLastPingLatencyMs: number | null = null;

  // Realtime SSE
  private sseActiveSubscribers = 0;
  private sseFailuresTotal = 0;

  // Knowledge base
  private kbSearchesTotal = 0;
  private kbZeroMatchesTotal = 0;

  // Plan limits
  private planConversationsBlocked = 0;
  private planAiMessagesBlocked = 0;

  // Handoffs
  private handoffsTotal = 0;
  private handoffsByReason: Record<string, number> = {};

  recordAiTurn(success: boolean, durationMs: number): void {
    this.aiRequestsTotal += 1;
    if (!success) {
      this.aiFailuresTotal += 1;
    }
    this.aiLatencySumMs += durationMs;
    this.aiLatencyCount += 1;
    this.aiLastLatencyMs = Math.round(durationMs * 10) / 10;
  }

  recordHttp(status: number, durationMs: number): void {
    this.httpRequestsTotal += 1;
    this.httpDurationSumMs += durationMs;
    if (status >= 200 && status < 300) this.http2xxTotal += 1;
    else if (status >= 400 && status < 500) this.http4xxTotal += 1;
    else if (status >= 500) this.http5xxTotal += 1;
  }

  recordDbError(): void {
    this.dbErrorsTotal += 1;
  }

  setDbPingLatency(latencyMs: number): void {
    this.dbLastPingLatencyMs = Math.round(latencyMs * 10) / 10;
  }

  setSseSubscribers(count: number): void {
    this.sseActiveSubscribers = count;
  }

  recordSseFailure(): void {
    this.sseFailuresTotal += 1;
  }

  recordKbSearch(foundMatches: boolean): void {
    this.kbSearchesTotal += 1;
    if (!foundMatches) this.kbZeroMatchesTotal += 1;
  }

  recordPlanLimitRejection(type: 'conversations' | 'ai_messages'): void {
    if (type === 'conversations') this.planConversationsBlocked += 1;
    else this.planAiMessagesBlocked += 1;
  }

  recordHandoff(reason: string): void {
    this.handoffsTotal += 1;
    const key = reason.trim().slice(0, 80) || 'unspecified';
    this.handoffsByReason[key] = (this.handoffsByReason[key] ?? 0) + 1;
  }

  getSnapshot(params: {
    dbConnected: boolean;
    dbPingLatencyMs: number | null;
    isLive: boolean;
    faqCount: number;
    activeSseCount: number;
  }): SystemHealthReport {
    this.setSseSubscribers(params.activeSseCount);
    if (params.dbPingLatencyMs !== null) {
      this.setDbPingLatency(params.dbPingLatencyMs);
    }

    const uptimeSeconds = Math.floor((Date.now() - this.startTime) / 1000);
    const avgHttpMs =
      this.httpRequestsTotal > 0
        ? Math.round((this.httpDurationSumMs / this.httpRequestsTotal) * 10) / 10
        : null;
    const avgAiMs =
      this.aiLatencyCount > 0
        ? Math.round((this.aiLatencySumMs / this.aiLatencyCount) * 10) / 10
        : null;

    // Component statuses
    const apiStatus: SystemComponentHealth = {
      status: this.http5xxTotal > 5 && this.http5xxTotal > this.http2xxTotal * 0.1 ? 'degraded' : 'healthy',
      latencyMs: avgHttpMs ?? undefined,
      details: {
        uptimeSeconds,
        requestsTotal: this.httpRequestsTotal,
        errors4xx: this.http4xxTotal,
        errors5xx: this.http5xxTotal,
      },
    };

    const databaseStatus: SystemComponentHealth = {
      status: params.dbConnected ? (this.dbErrorsTotal > 10 ? 'degraded' : 'healthy') : 'unhealthy',
      latencyMs: params.dbPingLatencyMs ?? undefined,
      details: {
        errorsTotal: this.dbErrorsTotal,
      },
    };

    const aiStatus: SystemComponentHealth = {
      status:
        this.aiFailuresTotal > 0 && this.aiFailuresTotal >= this.aiRequestsTotal * 0.5
          ? 'degraded'
          : 'healthy',
      latencyMs: this.aiLastLatencyMs ?? undefined,
      details: {
        mode: params.isLive ? 'codebuddy' : 'demo',
        requestsTotal: this.aiRequestsTotal,
        failuresTotal: this.aiFailuresTotal,
        avgLatencyMs: avgAiMs,
      },
    };

    const sseStatus: SystemComponentHealth = {
      status: this.sseFailuresTotal > 20 ? 'degraded' : 'healthy',
      details: {
        activeSubscribers: params.activeSseCount,
        failuresTotal: this.sseFailuresTotal,
      },
    };

    const kbStatus: SystemComponentHealth = {
      status: params.faqCount > 0 ? 'healthy' : 'degraded',
      details: {
        faqCount: params.faqCount,
        searchesTotal: this.kbSearchesTotal,
        zeroMatchesTotal: this.kbZeroMatchesTotal,
      },
    };

    const overallStatus: 'healthy' | 'degraded' | 'unhealthy' =
      !params.dbConnected
        ? 'unhealthy'
        : [apiStatus, databaseStatus, aiStatus, sseStatus, kbStatus].some((c) => c.status === 'degraded')
          ? 'degraded'
          : 'healthy';

    return {
      status: overallStatus,
      timestamp: new Date().toISOString(),
      uptimeSeconds,
      components: {
        api: apiStatus,
        database: databaseStatus,
        aiProvider: aiStatus,
        realtimeSse: sseStatus,
        knowledgeBase: kbStatus,
      },
      telemetry: {
        ai: {
          requestsTotal: this.aiRequestsTotal,
          failuresTotal: this.aiFailuresTotal,
          avgLatencyMs: avgAiMs,
          lastLatencyMs: this.aiLastLatencyMs,
        },
        http: {
          requestsTotal: this.httpRequestsTotal,
          responses2xx: this.http2xxTotal,
          responses4xx: this.http4xxTotal,
          responses5xx: this.http5xxTotal,
          avgDurationMs: avgHttpMs,
        },
        database: {
          pingLatencyMs: params.dbPingLatencyMs,
          errorsTotal: this.dbErrorsTotal,
        },
        realtimeSse: {
          activeSubscribers: params.activeSseCount,
          failuresTotal: this.sseFailuresTotal,
        },
        knowledgeBase: {
          searchesTotal: this.kbSearchesTotal,
          zeroMatchSearches: this.kbZeroMatchesTotal,
          faqCount: params.faqCount,
        },
        planLimits: {
          rejectionsTotal: this.planConversationsBlocked + this.planAiMessagesBlocked,
          conversationsBlocked: this.planConversationsBlocked,
          aiMessagesBlocked: this.planAiMessagesBlocked,
        },
        handoffs: {
          total: this.handoffsTotal,
          byReason: { ...this.handoffsByReason },
        },
      },
    };
  }

  reset(): void {
    this.aiRequestsTotal = 0;
    this.aiFailuresTotal = 0;
    this.aiLatencySumMs = 0;
    this.aiLatencyCount = 0;
    this.aiLastLatencyMs = null;
    this.httpRequestsTotal = 0;
    this.http2xxTotal = 0;
    this.http4xxTotal = 0;
    this.http5xxTotal = 0;
    this.httpDurationSumMs = 0;
    this.dbErrorsTotal = 0;
    this.dbLastPingLatencyMs = null;
    this.sseActiveSubscribers = 0;
    this.sseFailuresTotal = 0;
    this.kbSearchesTotal = 0;
    this.kbZeroMatchesTotal = 0;
    this.planConversationsBlocked = 0;
    this.planAiMessagesBlocked = 0;
    this.handoffsTotal = 0;
    this.handoffsByReason = {};
  }
}

export const telemetry = new TelemetryCollector();
