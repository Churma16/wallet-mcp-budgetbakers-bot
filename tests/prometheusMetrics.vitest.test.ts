import { describe, it, expect, beforeEach } from 'vitest';
import { PrometheusMetricsRegistry } from '../src/observability/metrics.js';
import { NotificationWebhookServer } from '../src/gateway/webhook.js';
import http from 'node:http';

describe('PrometheusMetricsRegistry', () => {
  beforeEach(() => {
    PrometheusMetricsRegistry.resetInstance();
  });

  it('no-ops when metrics are disabled', () => {
    const registry = PrometheusMetricsRegistry.getInstance();
    registry.setEnabled(false);

    expect(registry.isEnabled()).toBe(false);

    registry.recordTokens('gemini', 'input', 500);
    registry.recordRequest('gemini', 'success');
    registry.recordDuration('gemini', 1.5);
    registry.recordCacheEvent('gemini', 'hit');
    registry.recordFallback('gemini', 'openai');

    const output = registry.formatPrometheusMetrics();
    expect(output).toContain('wallet_ai_tokens_total{provider="gemini",type="input"} 0');
    expect(output).toContain('wallet_ai_requests_total{provider="gemini",status="success"} 0');
  });

  it('records tokens, requests, durations, cache events, and fallbacks when enabled', () => {
    const registry = PrometheusMetricsRegistry.getInstance();
    registry.setEnabled(true);

    expect(registry.isEnabled()).toBe(true);

    // Record tokens
    registry.recordTokens('gemini', 'input', 1200);
    registry.recordTokens('gemini', 'output', 300);
    registry.recordTokens('gemini', 'thinking', 150);
    registry.recordTokens('gemini', 'cached', 800);

    // Record requests & durations
    registry.recordRequest('gemini', 'success');
    registry.recordDuration('gemini', 2.1);

    registry.recordRequest('gemini', 'fallback');
    registry.recordFallback('gemini-2.5-flash', 'gemini-2.5-pro');

    registry.recordCacheEvent('gemini', 'hit');
    registry.recordCacheEvent('gemini', 'miss');

    const output = registry.formatPrometheusMetrics();

    // Verify token exposition
    expect(output).toContain('wallet_ai_tokens_total{provider="gemini",type="input"} 1200');
    expect(output).toContain('wallet_ai_tokens_total{provider="gemini",type="output"} 300');
    expect(output).toContain('wallet_ai_tokens_total{provider="gemini",type="thinking"} 150');
    expect(output).toContain('wallet_ai_tokens_total{provider="gemini",type="cached"} 800');

    // Verify requests exposition
    expect(output).toContain('wallet_ai_requests_total{provider="gemini",status="success"} 1');
    expect(output).toContain('wallet_ai_requests_total{provider="gemini",status="fallback"} 1');

    // Verify cache exposition
    expect(output).toContain('wallet_ai_cache_events_total{provider="gemini",status="hit"} 1');
    expect(output).toContain('wallet_ai_cache_events_total{provider="gemini",status="miss"} 1');

    // Verify fallback exposition
    expect(output).toContain('wallet_ai_fallback_events_total{from_provider="gemini-2.5-flash",to_provider="gemini-2.5-pro"} 1');

    // Verify histogram duration
    expect(output).toContain('wallet_ai_duration_seconds_bucket{le="2.50",provider="gemini"} 1');
    expect(output).toContain('wallet_ai_duration_seconds_count{provider="gemini"} 1');

    // Verify default process metrics
    expect(output).toContain('process_resident_memory_bytes');
    expect(output).toContain('process_uptime_seconds');
  });

  it('serves /metrics via NotificationWebhookServer when enabled', async () => {
    const registry = PrometheusMetricsRegistry.getInstance();
    registry.setEnabled(true);
    registry.recordTokens('gemini', 'input', 42);

    const server = new NotificationWebhookServer({
      port: 0, // dynamic port
      host: '127.0.0.1',
      onNotificationReceived: async () => {},
    });

    await server.start();
    const boundPort = (server as any).server?.address()?.port;

    try {
      const response = await new Promise<{ statusCode: number; data: string; contentType: string }>((resolve, reject) => {
        http.get(`http://127.0.0.1:${boundPort}/metrics`, res => {
          let data = '';
          res.on('data', chunk => {
            data += chunk;
          });
          res.on('end', () => {
            resolve({
              statusCode: res.statusCode || 0,
              data,
              contentType: res.headers['content-type'] || '',
            });
          });
        }).on('error', reject);
      });

      expect(response.statusCode).toBe(200);
      expect(response.contentType).toContain('text/plain');
      expect(response.data).toContain('wallet_ai_tokens_total{provider="gemini",type="input"} 42');
    } finally {
      await server.stop();
    }
  });

  it('returns 404 for /metrics when metrics are disabled', async () => {
    const registry = PrometheusMetricsRegistry.getInstance();
    registry.setEnabled(false);

    const server = new NotificationWebhookServer({
      port: 0,
      host: '127.0.0.1',
      onNotificationReceived: async () => {},
    });

    await server.start();
    const boundPort = (server as any).server?.address()?.port;

    try {
      const response = await new Promise<{ statusCode: number }>((resolve, reject) => {
        http.get(`http://127.0.0.1:${boundPort}/metrics`, res => {
          resolve({ statusCode: res.statusCode || 0 });
        }).on('error', reject);
      });

      expect(response.statusCode).toBe(404);
    } finally {
      await server.stop();
    }
  });
});
