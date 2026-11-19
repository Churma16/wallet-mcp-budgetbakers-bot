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

export class PrometheusMetricsRegistry {
  private static instance: PrometheusMetricsRegistry | null = null;
  private enabled: boolean = false;

  // Counter maps: key -> cumulative value
  private readonly tokenCounters: Map<string, number> = new Map();
  private readonly requestCounters: Map<string, number> = new Map();
  private readonly cacheCounters: Map<string, number> = new Map();
  private readonly fallbackCounters: Map<string, number> = new Map();

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
   * Records token usage for an AI model/provider interaction.
   */
  public recordTokens(
    provider: string,
    type: 'input' | 'output' | 'cached' | 'thinking',
    count: number
  ): void {
    if (!this.enabled || count <= 0) return;
    const key = `provider="${provider}",type="${type}"`;
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
      lines.push('wallet_ai_tokens_total{provider="gemini",type="input"} 0');
      lines.push('wallet_ai_tokens_total{provider="gemini",type="output"} 0');
      lines.push('wallet_ai_tokens_total{provider="gemini",type="cached"} 0');
      lines.push('wallet_ai_tokens_total{provider="gemini",type="thinking"} 0');
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

    // 4. Request duration histogram
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

    // 5. Context cache event counters
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

    // 6. Fallback events counter
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
