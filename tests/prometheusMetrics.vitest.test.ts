import { describe, it, expect, beforeEach } from 'vitest';
import { PrometheusMetricsRegistry, recordTransactionMetrics } from '../src/observability/metrics.js';
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

    registry.recordTokens('gemini', 'input', 500, 'text');
    registry.recordRequest('gemini', 'success');
    registry.recordDuration('gemini', 1.5);
    registry.recordCacheEvent('gemini', 'hit');
    registry.recordFallback('gemini', 'openai');
    registry.recordResolution('gemini-3.5-flash-lite', 0);
    registry.recordModelAttempt('gemini-3.5-flash-lite', 'primary', 'success');
    registry.recordTransaction('telegram', 'expense', 'synced', 'Food', 'BCA');
    registry.recordReceiptScan('parsed');
    registry.recordBankEmail('BCA', 'matched');

    const output = registry.formatPrometheusMetrics();
    expect(output).toContain('wallet_ai_tokens_total{modality="text",operation="unknown",provider="gemini",type="input"} 0');
    expect(output).toContain('wallet_ai_requests_total{provider="gemini",status="success"} 0');
    expect(output).toContain('wallet_transactions_total{channel="telegram",status="synced",type="expense"} 0');
    expect(output).not.toContain('wallet_transactions_total{channel="telegram",status="synced",type="expense"} 1');
    expect(output).not.toContain('wallet_transactions_by_category_total{');
  });

  it('records tokens, requests, durations, cache events, and fallbacks when enabled', () => {
    const registry = PrometheusMetricsRegistry.getInstance();
    registry.setEnabled(true);

    expect(registry.isEnabled()).toBe(true);

    // Record tokens
    registry.recordTokens('gemini', 'input', 1200, 'text');
    registry.recordTokens('gemini', 'output', 300, 'text');
    registry.recordTokens('gemini', 'thinking', 150, 'text');
    registry.recordTokens('gemini', 'cached', 800, 'text');
    registry.recordTokens('gemini', 'input', 1500, 'receipt');

    // Record requests & durations
    registry.recordRequest('gemini', 'success');
    registry.recordDuration('gemini', 2.1);

    registry.recordRequest('gemini', 'fallback');
    registry.recordFallback('gemini-2.5-flash', 'gemini-2.5-pro');

    // Resolution & fallback funnel
    registry.recordResolution('gemini-3.5-flash-lite', 0);
    registry.recordResolution('gemini-3.6-flash', 1);
    registry.recordModelAttempt('gemini-3.5-flash-lite', 'primary', 'success');
    registry.recordModelAttempt('gemini-3.5-flash-lite', 'primary', 'error');
    registry.recordFallbackTransition('gemini-3.5-flash-lite', 'gemini-3.6-flash', 'timeout');

    // Bookkeeping domain events
    registry.recordTransaction('telegram', 'expense', 'synced', 'Food & Beverage', 'BCA Checking');
    registry.recordTransaction('whatsapp', 'income', 'synced', 'Salary', 'Mandiri');
    registry.recordTransaction('telegram', 'expense', 'failed');
    registry.recordReceiptScan('parsed');
    registry.recordReceiptScan('ocr_failed');
    registry.recordBankEmail('BCA', 'matched');
    registry.recordBankEmail('Unknown', 'unmatched');

    // Health statuses
    registry.setBudgetBakersSessionStatus(true);
    registry.setChannelStatus('telegram', true);
    registry.setChannelStatus('whatsapp', true);
    registry.setChannelStatus('email', false);

    registry.recordCacheEvent('gemini', 'hit');
    registry.recordCacheEvent('gemini', 'miss');

    const output = registry.formatPrometheusMetrics();

    // Verify token exposition with modality and operation
    expect(output).toContain('wallet_ai_tokens_total{modality="text",operation="unknown",provider="gemini",type="input"} 1200');
    expect(output).toContain('wallet_ai_tokens_total{modality="text",operation="unknown",provider="gemini",type="output"} 300');
    expect(output).toContain('wallet_ai_tokens_total{modality="text",operation="unknown",provider="gemini",type="thinking"} 150');
    expect(output).toContain('wallet_ai_tokens_total{modality="text",operation="unknown",provider="gemini",type="cached"} 800');
    expect(output).toContain('wallet_ai_tokens_total{modality="receipt",operation="unknown",provider="gemini",type="input"} 1500');

    // Verify requests exposition
    expect(output).toContain('wallet_ai_requests_total{provider="gemini",status="success"} 1');
    expect(output).toContain('wallet_ai_requests_total{provider="gemini",status="fallback"} 1');

    // Verify resolution funnel
    expect(output).toContain('wallet_ai_resolutions_total{fallback_depth="0",resolved_by="gemini-3.5-flash-lite"} 1');
    expect(output).toContain('wallet_ai_resolutions_total{fallback_depth="1",resolved_by="gemini-3.6-flash"} 1');
    expect(output).toContain('wallet_ai_model_attempts_total{model="gemini-3.5-flash-lite",role="primary",status="success"} 1');
    expect(output).toContain('wallet_ai_model_attempts_total{model="gemini-3.5-flash-lite",role="primary",status="error"} 1');
    expect(output).toContain('wallet_ai_fallback_transitions_total{from_model="gemini-3.5-flash-lite",reason="timeout",to_model="gemini-3.6-flash"} 1');

    // Verify bookkeeping transactions & categories
    expect(output).toContain('wallet_transactions_total{channel="telegram",status="synced",type="expense"} 1');
    expect(output).toContain('wallet_transactions_total{channel="whatsapp",status="synced",type="income"} 1');
    expect(output).toContain('wallet_transactions_total{channel="telegram",status="failed",type="expense"} 1');
    expect(output).toContain('wallet_transactions_by_category_total{category="Food & Beverage"} 1');
    expect(output).toContain('wallet_transactions_by_account_total{account="BCA Checking"} 1');

    // Verify receipt & bank email metrics
    expect(output).toContain('wallet_receipt_scans_total{status="parsed"} 1');
    expect(output).toContain('wallet_receipt_scans_total{status="ocr_failed"} 1');
    expect(output).toContain('wallet_bank_emails_total{bank="BCA",status="matched"} 1');
    expect(output).toContain('wallet_bank_emails_total{bank="Unknown",status="unmatched"} 1');

    // Verify health gauges
    expect(output).toContain('wallet_budgetbakers_session_status 1');
    expect(output).toContain('wallet_channel_status{channel="telegram"} 1');
    expect(output).toContain('wallet_channel_status{channel="whatsapp"} 1');
    expect(output).toContain('wallet_channel_status{channel="email"} 0');

    // Verify cache exposition
    expect(output).toContain('wallet_ai_cache_events_total{provider="gemini",status="hit"} 1');
    expect(output).toContain('wallet_ai_cache_events_total{provider="gemini",status="miss"} 1');

    // Verify fallback exposition
    expect(output).toContain('wallet_ai_fallback_events_total{from_provider="gemini-2.5-flash",to_provider="gemini-2.5-pro"} 1');

    // Verify histogram duration
    expect(output).toContain('wallet_ai_duration_seconds_bucket{le="2.50",operation="unknown",provider="gemini"} 1');
    expect(output).toContain('wallet_ai_duration_seconds_count{operation="unknown",provider="gemini"} 1');

    // Verify default process metrics
    expect(output).toContain('process_resident_memory_bytes');
    expect(output).toContain('process_uptime_seconds');
  });

  it('records tokens and latency with explicit operation dimension', () => {
    const registry = PrometheusMetricsRegistry.getInstance();
    registry.setEnabled(true);

    registry.recordTokens('gemini', 'input', 350, 'text', 'intent_text');
    registry.recordTokens('gemini', 'output', 80, 'text', 'intent_text');
    registry.recordDuration('gemini', 0.42, 'intent_text');

    registry.recordTokens('gemini', 'input', 1200, 'receipt', 'receipt_ocr');
    registry.recordDuration('gemini', 1.85, 'receipt_ocr');

    const output = registry.formatPrometheusMetrics();
    expect(output).toContain('wallet_ai_tokens_total{modality="text",operation="intent_text",provider="gemini",type="input"} 350');
    expect(output).toContain('wallet_ai_tokens_total{modality="text",operation="intent_text",provider="gemini",type="output"} 80');
    expect(output).toContain('wallet_ai_tokens_total{modality="receipt",operation="receipt_ocr",provider="gemini",type="input"} 1200');
    expect(output).toContain('wallet_ai_duration_seconds_bucket{le="0.50",operation="intent_text",provider="gemini"} 1');
    expect(output).toContain('wallet_ai_duration_seconds_bucket{le="2.50",operation="receipt_ocr",provider="gemini"} 1');
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
      expect(response.data).toContain('wallet_ai_tokens_total{modality="text",operation="unknown",provider="gemini",type="input"} 42');
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

  it('records batch transactions via recordTransactionMetrics helper', () => {
    const registry = PrometheusMetricsRegistry.getInstance();
    registry.setEnabled(true);

    const categories = [
      { id: 'cat-1', name: 'Food & Beverage' },
      { id: 'cat-2', name: 'Salary' },
    ];
    const accounts = [
      { id: 'acc-1', name: 'BCA Checking' },
      { id: 'acc-2', name: 'Jago Pocket' },
    ];

    recordTransactionMetrics({
      channel: 'telegram',
      records: [
        { amount: -50000, categoryId: 'cat-1', accountId: 'acc-1' },
        { amount: 5000000, categoryId: 'cat-2', accountId: 'acc-2' },
        { amount: -100000, transfer: true, accountId: 'acc-1' },
      ],
      status: 'synced',
      categories,
      accounts,
    });

    recordTransactionMetrics({
      channel: 'email',
      records: [{ amount: -25000, categoryId: 'cat-1', accountId: 'acc-1' }],
      status: 'failed',
      categories,
      accounts,
    });

    const output = registry.formatPrometheusMetrics();

    // Verify channel, type, status counters
    expect(output).toContain('wallet_transactions_total{channel="telegram",status="synced",type="expense"} 1');
    expect(output).toContain('wallet_transactions_total{channel="telegram",status="synced",type="income"} 1');
    expect(output).toContain('wallet_transactions_total{channel="telegram",status="synced",type="transfer"} 1');
    expect(output).toContain('wallet_transactions_total{channel="email",status="failed",type="expense"} 1');

    // Verify categories & accounts counters
    expect(output).toContain('wallet_transactions_by_category_total{category="Food & Beverage"} 1');
    expect(output).toContain('wallet_transactions_by_category_total{category="Salary"} 1');
    expect(output).toContain('wallet_transactions_by_account_total{account="BCA Checking"} 2');
    expect(output).toContain('wallet_transactions_by_account_total{account="Jago Pocket"} 1');
  });

  it('safely escapes backslashes and double quotes in Prometheus label values', () => {
    const registry = PrometheusMetricsRegistry.getInstance();
    registry.setEnabled(true);

    registry.recordFallbackTransition('gemini-1', 'gemini-2', 'error with "quotes" and \\backslashes\\');
    registry.recordTransaction('telegram', 'expense', 'synced', 'Food \\ "Snack"', 'BCA \\ "Main"');

    const output = registry.formatPrometheusMetrics();
    expect(output).toContain('reason="error with \\"quotes\\" and \\\\backslashes\\\\"');
    expect(output).toContain('category="Food \\\\ \\"Snack\\""');
    expect(output).toContain('account="BCA \\\\ \\"Main\\""');
  });
});
