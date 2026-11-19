import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * Zero-dependency Prometheus Metrics Registry for Wallet MCP.
 * Implements standard Prometheus text exposition format (version 0.0.4).
 * Fully guarded by PROMETHEUS_METRICS_ENABLED configuration toggle.
 */

export interface HistogramBucketState {
  counts: number[];
  sum: number;
  count: number;
}

function escapePrometheusLabel(value: string, maxLength: number = 60): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .slice(0, maxLength);
}

export class PrometheusMetricsRegistry {
  private static instance: PrometheusMetricsRegistry | null = null;
  private enabled: boolean = false;

  // AI & Token Counters: key -> cumulative value
  private readonly tokenCounters: Map<string, number> = new Map();
  private readonly requestCounters: Map<string, number> = new Map();
  private readonly cacheCounters: Map<string, number> = new Map();
  private readonly fallbackCounters: Map<string, number> = new Map();

  // AI Resolution & Fallback Funnel
  private readonly resolutionCounters: Map<string, number> = new Map();
  private readonly modelAttemptCounters: Map<string, number> = new Map();
  private readonly fallbackTransitionCounters: Map<string, number> = new Map();

  // Bookkeeping & Ingestion Domain Counters
  private readonly transactionCounters: Map<string, number> = new Map();
  private readonly categoryCounters: Map<string, number> = new Map();
  private readonly accountCounters: Map<string, number> = new Map();
  private readonly receiptScanCounters: Map<string, number> = new Map();
  private readonly bankEmailCounters: Map<string, number> = new Map();

  // Gauges: Session Health & Ingestion Channel State
  private budgetbakersSessionStatus: number = 1;
  private readonly channelStatuses: Map<string, number> = new Map([
    ['telegram', 0],
    ['whatsapp', 0],
    ['email', 0],
  ]);

  // Histograms: key -> HistogramBucketState
  private readonly durationBuckets: readonly number[] = [0.25, 0.5, 1.0, 2.5, 5.0, 10.0, 30.0, 60.0];
  private readonly durationHistograms: Map<string, HistogramBucketState> = new Map();

  private constructor() {}

  public static getInstance(): PrometheusMetricsRegistry {
    if (!PrometheusMetricsRegistry.instance) {
      PrometheusMetricsRegistry.instance = new PrometheusMetricsRegistry();
    }
    return PrometheusMetricsRegistry.instance;
  }

  /**
   * Resets singleton instance state (primarily used in unit testing).
   */
  public static resetInstance(): void {
    PrometheusMetricsRegistry.instance = null;
  }

  public setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  public isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Records token usage for an AI model/provider interaction with optional modality tag.
   */
  public recordTokens(
    provider: string,
    type: 'input' | 'output' | 'cached' | 'thinking',
    count: number,
    modality: 'text' | 'receipt' = 'text'
  ): void {
    if (!this.enabled || count <= 0) return;
    const key = `modality="${modality}",provider="${provider}",type="${type}"`;
    this.tokenCounters.set(key, (this.tokenCounters.get(key) || 0) + count);
  }

  /**
   * Records completion status of an AI generation request.
   */
  public recordRequest(provider: string, status: 'success' | 'fallback' | 'error'): void {
    if (!this.enabled) return;
    const key = `provider="${provider}",status="${status}"`;
    this.requestCounters.set(key, (this.requestCounters.get(key) || 0) + 1);
  }

  /**
   * Records resolution depth for an end-to-end user request.
   * fallbackDepth: 0 = primary hit, 1 = rescued by fallback 1, etc., or 'exhausted' = all models failed.
   */
  public recordResolution(resolvedBy: string, fallbackDepth: number | 'exhausted'): void {
    if (!this.enabled) return;
    const key = `fallback_depth="${fallbackDepth}",resolved_by="${resolvedBy}"`;
    this.resolutionCounters.set(key, (this.resolutionCounters.get(key) || 0) + 1);
  }

  /**
   * Records individual candidate model attempts (initial vs fallback).
   */
  public recordModelAttempt(model: string, role: 'primary' | 'fallback', status: 'success' | 'error'): void {
    if (!this.enabled) return;
    const key = `model="${model}",role="${role}",status="${status}"`;
    this.modelAttemptCounters.set(key, (this.modelAttemptCounters.get(key) || 0) + 1);
  }

  /**
   * Records fallback transition between models with concise reason.
   */
  public recordFallbackTransition(fromModel: string, toModel: string, reason: string): void {
    if (!this.enabled) return;
    const cleanReason = escapePrometheusLabel(reason, 60);
    const key = `from_model="${fromModel}",reason="${cleanReason}",to_model="${toModel}"`;
    this.fallbackTransitionCounters.set(key, (this.fallbackTransitionCounters.get(key) || 0) + 1);
  }

  /**
   * Records bookkeeping transactions by channel, type, status, and optional category/account.
   */
  public recordTransaction(
    channel: string,
    type: string,
    status: 'synced' | 'failed' | 'rejected',
    category?: string,
    account?: string
  ): void {
    if (!this.enabled) return;
    const key = `channel="${channel}",status="${status}",type="${type}"`;
    this.transactionCounters.set(key, (this.transactionCounters.get(key) || 0) + 1);

    if (category && status === 'synced') {
      const safeCat = escapePrometheusLabel(category, 40);
      this.categoryCounters.set(safeCat, (this.categoryCounters.get(safeCat) || 0) + 1);
    }
    if (account && status === 'synced') {
      const safeAcc = escapePrometheusLabel(account, 40);
      this.accountCounters.set(safeAcc, (this.accountCounters.get(safeAcc) || 0) + 1);
    }
  }

  /**
   * Records receipt OCR parsing outcomes.
   */
  public recordReceiptScan(status: 'parsed' | 'ocr_failed'): void {
    if (!this.enabled) return;
    this.receiptScanCounters.set(status, (this.receiptScanCounters.get(status) || 0) + 1);
  }

  /**
   * Records bank notification email evaluation.
   */
  public recordBankEmail(bank: string, status: 'matched' | 'unmatched' | 'ignored'): void {
    if (!this.enabled) return;
    const key = `bank="${bank}",status="${status}"`;
    this.bankEmailCounters.set(key, (this.bankEmailCounters.get(key) || 0) + 1);
  }

  /**
   * Sets current BudgetBakers MCP authentication session health (1=valid, 0=expired).
   */
  public setBudgetBakersSessionStatus(isValid: boolean): void {
    if (!this.enabled) return;
    this.budgetbakersSessionStatus = isValid ? 1 : 0;
  }

  /**
   * Sets connection state for an ingestion channel (1=connected, 0=disconnected).
   */
  public setChannelStatus(channel: 'whatsapp' | 'telegram' | 'email', isConnected: boolean): void {
    if (!this.enabled) return;
    this.channelStatuses.set(channel, isConnected ? 1 : 0);
  }

  /**
   * Records execution latency for an AI generation request in seconds.
   */
  public recordDuration(provider: string, seconds: number): void {
    if (!this.enabled || seconds < 0) return;
    const key = `provider="${provider}"`;
    let hist = this.durationHistograms.get(key);
    if (!hist) {
      hist = {
        counts: new Array(this.durationBuckets.length).fill(0),
        sum: 0,
        count: 0,
      };
      this.durationHistograms.set(key, hist);
    }
    hist.sum += seconds;
    hist.count += 1;
    for (let i = 0; i < this.durationBuckets.length; i++) {
      if (seconds <= this.durationBuckets[i]) {
        hist.counts[i] += 1;
      }
    }
  }

  /**
   * Records context cache hit or miss event.
   */
  public recordCacheEvent(provider: string, status: 'hit' | 'miss'): void {
    if (!this.enabled) return;
    const key = `provider="${provider}",status="${status}"`;
    this.cacheCounters.set(key, (this.cacheCounters.get(key) || 0) + 1);
  }

  /**
   * Records fallback transition between models or providers.
   */
  public recordFallback(fromProvider: string, toProvider: string): void {
    if (!this.enabled) return;
    const key = `from_provider="${fromProvider}",to_provider="${toProvider}"`;
    this.fallbackCounters.set(key, (this.fallbackCounters.get(key) || 0) + 1);
  }

  /**
   * Formats all recorded metrics into Prometheus exposition text format 0.0.4.
   */
  public formatPrometheusMetrics(): string {
    const lines: string[] = [];

    // 1. Process default metrics
    lines.push('# HELP process_resident_memory_bytes Resident memory size in bytes');
    lines.push('# TYPE process_resident_memory_bytes gauge');
    lines.push(`process_resident_memory_bytes ${process.memoryUsage().rss}`);
    lines.push('');

    lines.push('# HELP process_cpu_seconds_total Total user and system CPU time spent in seconds');
    lines.push('# TYPE process_cpu_seconds_total counter');
    const cpu = process.cpuUsage();
    lines.push(`process_cpu_seconds_total ${(cpu.user + cpu.system) / 1e6}`);
    lines.push('');

    lines.push('# HELP process_uptime_seconds Process uptime in seconds');
    lines.push('# TYPE process_uptime_seconds gauge');
    lines.push(`process_uptime_seconds ${Math.floor(process.uptime())}`);
    lines.push('');

    // 2. Token counters
    lines.push('# HELP wallet_ai_tokens_total Cumulative AI tokens consumed by Wallet MCP');
    lines.push('# TYPE wallet_ai_tokens_total counter');
    if (this.tokenCounters.size === 0) {
      lines.push('wallet_ai_tokens_total{modality="text",provider="gemini",type="input"} 0');
      lines.push('wallet_ai_tokens_total{modality="text",provider="gemini",type="output"} 0');
      lines.push('wallet_ai_tokens_total{modality="text",provider="gemini",type="cached"} 0');
      lines.push('wallet_ai_tokens_total{modality="text",provider="gemini",type="thinking"} 0');
    } else {
      for (const [labels, value] of this.tokenCounters.entries()) {
        lines.push(`wallet_ai_tokens_total{${labels}} ${value}`);
      }
    }
    lines.push('');

    // 3. Request counters
    lines.push('# HELP wallet_ai_requests_total Total AI requests handled');
    lines.push('# TYPE wallet_ai_requests_total counter');
    if (this.requestCounters.size === 0) {
      lines.push('wallet_ai_requests_total{provider="gemini",status="success"} 0');
      lines.push('wallet_ai_requests_total{provider="gemini",status="fallback"} 0');
      lines.push('wallet_ai_requests_total{provider="gemini",status="error"} 0');
    } else {
      for (const [labels, value] of this.requestCounters.entries()) {
        lines.push(`wallet_ai_requests_total{${labels}} ${value}`);
      }
    }
    lines.push('');

    // 4. AI Resolution Funnel Counters
    lines.push('# HELP wallet_ai_resolutions_total Cumulative AI requests resolved by candidate model layer');
    lines.push('# TYPE wallet_ai_resolutions_total counter');
    if (this.resolutionCounters.size === 0) {
      lines.push('wallet_ai_resolutions_total{fallback_depth="0",resolved_by="primary"} 0');
    } else {
      for (const [labels, value] of this.resolutionCounters.entries()) {
        lines.push(`wallet_ai_resolutions_total{${labels}} ${value}`);
      }
    }
    lines.push('');

    // 5. Model Attempt Counters
    lines.push('# HELP wallet_ai_model_attempts_total Cumulative attempts per candidate model');
    lines.push('# TYPE wallet_ai_model_attempts_total counter');
    for (const [labels, value] of this.modelAttemptCounters.entries()) {
      lines.push(`wallet_ai_model_attempts_total{${labels}} ${value}`);
    }
    lines.push('');

    // 6. Fallback Transition Counters
    lines.push('# HELP wallet_ai_fallback_transitions_total Fallback transitions between models with error reasons');
    lines.push('# TYPE wallet_ai_fallback_transitions_total counter');
    for (const [labels, value] of this.fallbackTransitionCounters.entries()) {
      lines.push(`wallet_ai_fallback_transitions_total{${labels}} ${value}`);
    }
    lines.push('');

    // 7. Bookkeeping Transactions
    lines.push('# HELP wallet_transactions_total Cumulative transactions processed by channel and type');
    lines.push('# TYPE wallet_transactions_total counter');
    if (this.transactionCounters.size === 0) {
      lines.push('wallet_transactions_total{channel="telegram",status="synced",type="expense"} 0');
    } else {
      for (const [labels, value] of this.transactionCounters.entries()) {
        lines.push(`wallet_transactions_total{${labels}} ${value}`);
      }
    }
    lines.push('');

    // 8. Categories
    lines.push('# HELP wallet_transactions_by_category_total Cumulative transactions by category');
    lines.push('# TYPE wallet_transactions_by_category_total counter');
    for (const [cat, value] of this.categoryCounters.entries()) {
      lines.push(`wallet_transactions_by_category_total{category="${cat}"} ${value}`);
    }
    lines.push('');

    // 9. Accounts
    lines.push('# HELP wallet_transactions_by_account_total Cumulative transactions by target account');
    lines.push('# TYPE wallet_transactions_by_account_total counter');
    for (const [acc, value] of this.accountCounters.entries()) {
      lines.push(`wallet_transactions_by_account_total{account="${acc}"} ${value}`);
    }
    lines.push('');

    // 10. Receipt Scans
    lines.push('# HELP wallet_receipt_scans_total Cumulative receipt OCR vision extractions');
    lines.push('# TYPE wallet_receipt_scans_total counter');
    if (this.receiptScanCounters.size === 0) {
      lines.push('wallet_receipt_scans_total{status="parsed"} 0');
      lines.push('wallet_receipt_scans_total{status="ocr_failed"} 0');
    } else {
      for (const [status, value] of this.receiptScanCounters.entries()) {
        lines.push(`wallet_receipt_scans_total{status="${status}"} ${value}`);
      }
    }
    lines.push('');

    // 11. Bank Emails
    lines.push('# HELP wallet_bank_emails_total Cumulative bank notification emails evaluated');
    lines.push('# TYPE wallet_bank_emails_total counter');
    if (this.bankEmailCounters.size === 0) {
      lines.push('wallet_bank_emails_total{bank="bca",status="matched"} 0');
    } else {
      for (const [labels, value] of this.bankEmailCounters.entries()) {
        lines.push(`wallet_bank_emails_total{${labels}} ${value}`);
      }
    }
    lines.push('');

    // 12. Gauges: BudgetBakers Session & Ingestion Channels
    lines.push('# HELP wallet_budgetbakers_session_status Current BudgetBakers MCP authentication session health (1=valid, 0=expired)');
    lines.push('# TYPE wallet_budgetbakers_session_status gauge');
    lines.push(`wallet_budgetbakers_session_status ${this.budgetbakersSessionStatus}`);
    lines.push('');

    lines.push('# HELP wallet_channel_status Ingestion channel connection state (1=connected, 0=disconnected)');
    lines.push('# TYPE wallet_channel_status gauge');
    for (const [channel, status] of this.channelStatuses.entries()) {
      lines.push(`wallet_channel_status{channel="${channel}"} ${status}`);
    }
    lines.push('');

    // 13. Request duration histogram
    lines.push('# HELP wallet_ai_duration_seconds Latency of AI requests in seconds');
    lines.push('# TYPE wallet_ai_duration_seconds histogram');
    if (this.durationHistograms.size === 0) {
      for (const le of this.durationBuckets) {
        lines.push(`wallet_ai_duration_seconds_bucket{le="${le.toFixed(2)}",provider="gemini"} 0`);
      }
      lines.push('wallet_ai_duration_seconds_bucket{le="+Inf",provider="gemini"} 0');
      lines.push('wallet_ai_duration_seconds_sum{provider="gemini"} 0.0');
      lines.push('wallet_ai_duration_seconds_count{provider="gemini"} 0');
    } else {
      for (const [labels, hist] of this.durationHistograms.entries()) {
        for (let i = 0; i < this.durationBuckets.length; i++) {
          const le = this.durationBuckets[i];
          lines.push(`wallet_ai_duration_seconds_bucket{le="${le.toFixed(2)}",${labels}} ${hist.counts[i]}`);
        }
        lines.push(`wallet_ai_duration_seconds_bucket{le="+Inf",${labels}} ${hist.count}`);
        lines.push(`wallet_ai_duration_seconds_sum{${labels}} ${hist.sum.toFixed(4)}`);
        lines.push(`wallet_ai_duration_seconds_count{${labels}} ${hist.count}`);
      }
    }
    lines.push('');

    // 14. Context cache event counters
    lines.push('# HELP wallet_ai_cache_events_total Context cache hit and miss events');
    lines.push('# TYPE wallet_ai_cache_events_total counter');
    if (this.cacheCounters.size === 0) {
      lines.push('wallet_ai_cache_events_total{provider="gemini",status="hit"} 0');
      lines.push('wallet_ai_cache_events_total{provider="gemini",status="miss"} 0');
    } else {
      for (const [labels, value] of this.cacheCounters.entries()) {
        lines.push(`wallet_ai_cache_events_total{${labels}} ${value}`);
      }
    }
    lines.push('');

    // 15. Fallback events counter
    lines.push('# HELP wallet_ai_fallback_events_total Fallback events between AI providers or models');
    lines.push('# TYPE wallet_ai_fallback_events_total counter');
    if (this.fallbackCounters.size === 0) {
      lines.push('wallet_ai_fallback_events_total{from_provider="none",to_provider="none"} 0');
    } else {
      for (const [labels, value] of this.fallbackCounters.entries()) {
        lines.push(`wallet_ai_fallback_events_total{${labels}} ${value}`);
      }
    }
    lines.push('');

    return lines.join('\n');
  }
}

/**
 * Handles incoming HTTP requests for the /metrics or /api/metrics endpoint.
 * Returns true if the request was handled, false otherwise.
 */
export function tryHandleMetricsEndpoint(req: IncomingMessage, res: ServerResponse): boolean {
  const method = req.method?.toUpperCase();
  if (method !== 'GET') {
    return false;
  }

  const parsedUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const pathname = parsedUrl.pathname;

  if (pathname === '/metrics' || pathname === '/api/metrics') {
    const metrics = PrometheusMetricsRegistry.getInstance();
    if (metrics.isEnabled()) {
      res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' });
      res.end(metrics.formatPrometheusMetrics());
      return true;
    }
  }

  return false;
}

export interface RecordTransactionMetricsOptions {
  channel: string;
  records: Array<{
    amount: number;
    transfer?: unknown;
    categoryId?: string;
    accountId?: string;
  }>;
  status: 'synced' | 'failed' | 'rejected';
  categories?: Array<{ id: string; name: string }>;
  accounts?: Array<{ id: string; name: string }>;
}

/**
 * Convenient batch helper to record transaction domain metrics from dispatched records.
 */
export function recordTransactionMetrics(options: RecordTransactionMetricsOptions): void {
  const { channel, records, status, categories = [], accounts = [] } = options;
  const registry = PrometheusMetricsRegistry.getInstance();
  if (!registry.isEnabled()) return;

  for (const record of records) {
    const catName = categories.find(c => c.id === record.categoryId)?.name || 'Uncategorized';
    const accName = accounts.find(a => a.id === record.accountId)?.name || 'Unknown';
    const recordType = Boolean(record.transfer) ? 'transfer' : record.amount < 0 ? 'expense' : 'income';
    registry.recordTransaction(
      channel,
      recordType,
      status,
      catName,
      accName
    );
  }
}

