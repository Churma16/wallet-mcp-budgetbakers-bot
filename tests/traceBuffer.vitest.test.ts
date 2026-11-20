import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  AiTraceBuffer,
  sanitizeInputSample,
  extractDecisionSummary,
} from '../src/observability/traceBuffer.js';
import { tryHandleMetricsEndpoint, PrometheusMetricsRegistry } from '../src/observability/metrics.js';
import { extractInputSampleFromMessages } from '../src/brain/providers/openAiClient.js';
import http from 'node:http';

describe('AiTraceBuffer', () => {
  beforeEach(() => {
    PrometheusMetricsRegistry.resetInstance();
    PrometheusMetricsRegistry.getInstance().setEnabled(true);
    AiTraceBuffer.resetInstance();
  });

  afterEach(() => {
    delete process.env.NOTIFICATION_WEBHOOK_SECRET;
  });

  it('no-ops and does not store traces when Prometheus metrics are disabled', () => {
    PrometheusMetricsRegistry.getInstance().setEnabled(false);
    const buffer = new AiTraceBuffer(10);

    const result = buffer.record({
      operation: 'intent_text',
      provider: 'gemini',
      model: 'gemini-2.5-flash',
      role: 'primary',
      durationMs: 400,
      inputTokens: 100,
      outputTokens: 50,
      thinkingTokens: 0,
      cachedTokens: 0,
      totalTokens: 150,
      status: 'success',
    });

    expect(result).toBeNull();
    expect(buffer.size()).toBe(0);
  });

  it('records traces and retrieves them newest-first', () => {
    const buffer = new AiTraceBuffer(10);
    expect(buffer.size()).toBe(0);

    buffer.record({
      operation: 'intent_text',
      provider: 'gemini',
      model: 'gemini-2.5-flash',
      role: 'primary',
      durationMs: 400,
      inputTokens: 100,
      outputTokens: 50,
      thinkingTokens: 0,
      cachedTokens: 0,
      totalTokens: 150,
      status: 'success',
      inputSample: 'beli bensin 50rb',
      decision: 'CREATE_RECORD',
    });

    buffer.record({
      operation: 'receipt_ocr',
      provider: 'gemini',
      model: 'gemini-2.5-flash',
      role: 'primary',
      durationMs: 1200,
      inputTokens: 800,
      outputTokens: 120,
      thinkingTokens: 0,
      cachedTokens: 0,
      totalTokens: 920,
      status: 'success',
      inputSample: 'Indomaret total 75.000',
      decision: 'CREATE_RECORD',
    });

    expect(buffer.size()).toBe(2);

    const traces = buffer.getTraces();
    expect(traces).toHaveLength(2);
    expect(traces[0].operation).toBe('receipt_ocr');
    expect(traces[1].operation).toBe('intent_text');
  });

  it('evicts oldest entries when reaching max capacity (FIFO)', () => {
    const buffer = new AiTraceBuffer(3);

    for (let i = 1; i <= 3; i++) {
      buffer.record({
        operation: `op_${i}`,
        provider: 'gemini',
        model: 'm1',
        role: 'primary',
        durationMs: i * 100,
        inputTokens: i * 10,
        outputTokens: i * 5,
        thinkingTokens: 0,
        cachedTokens: 0,
        totalTokens: i * 15,
        status: 'success',
      });
    }

    expect(buffer.size()).toBe(3);

    // Add 4th entry - should evict op_1
    buffer.record({
      operation: 'op_4',
      provider: 'gemini',
      model: 'm1',
      role: 'primary',
      durationMs: 400,
      inputTokens: 40,
      outputTokens: 20,
      thinkingTokens: 0,
      cachedTokens: 0,
      totalTokens: 60,
      status: 'success',
    });

    expect(buffer.size()).toBe(3);
    const traces = buffer.getTraces();
    const ops = traces.map(t => t.operation);
    expect(ops).toEqual(['op_4', 'op_3', 'op_2']);
    expect(ops).not.toContain('op_1');
  });

  it('filters traces by operation, provider, and limit', () => {
    const buffer = new AiTraceBuffer(10);

    buffer.record({
      operation: 'intent_text',
      provider: 'gemini',
      model: 'gemini-2.5-flash',
      role: 'primary',
      durationMs: 100,
      inputTokens: 10,
      outputTokens: 5,
      thinkingTokens: 0,
      cachedTokens: 0,
      totalTokens: 15,
      status: 'success',
    });

    buffer.record({
      operation: 'receipt_ocr',
      provider: 'gemini',
      model: 'gemini-2.5-flash',
      role: 'primary',
      durationMs: 200,
      inputTokens: 20,
      outputTokens: 10,
      thinkingTokens: 0,
      cachedTokens: 0,
      totalTokens: 30,
      status: 'success',
    });

    buffer.record({
      operation: 'intent_text',
      provider: 'openai',
      model: 'gpt-4o',
      role: 'fallback',
      durationMs: 300,
      inputTokens: 30,
      outputTokens: 15,
      thinkingTokens: 0,
      cachedTokens: 0,
      totalTokens: 45,
      status: 'success',
    });

    const filteredByOp = buffer.getTraces({ operation: 'intent_text' });
    expect(filteredByOp).toHaveLength(2);

    const filteredByProvider = buffer.getTraces({ provider: 'openai' });
    expect(filteredByProvider).toHaveLength(1);
    expect(filteredByProvider[0].provider).toBe('openai');

    const limited = buffer.getTraces({ limit: 1 });
    expect(limited).toHaveLength(1);
    expect(limited[0].operation).toBe('intent_text');
  });

  it('sanitizes input samples, unwraps untrusted_user_text, and redacts auth tokens', () => {
    const raw = '   Bearer 1234567890abcdef1234567890   beli pulsa \n\n 100rb   ';
    const sanitized = sanitizeInputSample(raw);
    expect(sanitized).toBe('Bearer [REDACTED] beli pulsa 100rb');

    const wrapped = '[Timestamp: 2026-11-20T...]\n<untrusted_user_text>beli bakso 20rb</untrusted_user_text>';
    expect(sanitizeInputSample(wrapped)).toBe('beli bakso 20rb');

    const longText = 'a'.repeat(200);
    const truncated = sanitizeInputSample(longText, 100);
    expect(truncated.length).toBe(103);
    expect(truncated.endsWith('...')).toBe(true);
  });

  it('extracts input sample from OpenAI multimodal array messages', () => {
    const multimodalMessages = [
      { role: 'system', content: 'You are a bookkeeper.' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Struk belanja Alfamart' },
          { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,...' } },
        ],
      },
    ];

    expect(extractInputSampleFromMessages(multimodalMessages as any)).toBe('Struk belanja Alfamart');
  });

  it('extracts decision summary from JSON response or raw string', () => {
    const jsonAction = JSON.stringify({ action: 'CREATE_RECORD', records: [{ amount: -50000 }] });
    expect(extractDecisionSummary(jsonAction)).toBe('CREATE_RECORD');

    const jsonRecords = JSON.stringify({ records: [{ amount: -25000 }, { amount: -10000 }] });
    expect(extractDecisionSummary(jsonRecords)).toBe('CREATE_RECORD (2 items)');

    const plainText = 'Mohon sebutkan nominal transaksi Anda.';
    expect(extractDecisionSummary(plainText)).toBe(plainText);
  });

  it('authenticates and serves /api/traces and /traces via tryHandleMetricsEndpoint', async () => {
    process.env.NOTIFICATION_WEBHOOK_SECRET = 'super-secret-key';
    const buffer = AiTraceBuffer.getInstance();
    buffer.clear();
    buffer.record({
      operation: 'intent_text',
      provider: 'gemini',
      model: 'gemini-2.5-flash',
      role: 'primary',
      durationMs: 250,
      inputTokens: 120,
      outputTokens: 40,
      thinkingTokens: 0,
      cachedTokens: 0,
      totalTokens: 160,
      status: 'success',
      inputSample: 'beli kopi 25rb',
      decision: 'CREATE_RECORD',
    });

    const server = http.createServer((req, res) => {
      if (tryHandleMetricsEndpoint(req, res)) {
        return;
      }
      res.writeHead(404).end('Not Found');
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as any).port;

    try {
      // 1. Without Bearer token -> 401 Unauthorized
      const unauthResponse = await fetch(`http://127.0.0.1:${port}/api/traces?limit=10`);
      expect(unauthResponse.status).toBe(401);

      // 2. With wrong Bearer token -> 401 Unauthorized
      const wrongAuthResponse = await fetch(`http://127.0.0.1:${port}/api/traces?limit=10`, {
        headers: { Authorization: 'Bearer wrong-key' },
      });
      expect(wrongAuthResponse.status).toBe(401);

      // 3. With valid Bearer token -> 200 OK
      const authResponse = await fetch(`http://127.0.0.1:${port}/api/traces?limit=10`, {
        headers: { Authorization: 'Bearer super-secret-key' },
      });
      expect(authResponse.status).toBe(200);
      expect(authResponse.headers.get('content-type')).toContain('application/json');

      const data = await authResponse.json();
      expect(data.count).toBe(1);
      expect(data.capacity).toBe(100);
      expect(data.traces[0].operation).toBe('intent_text');
      expect(data.traces[0].inputSample).toBe('beli kopi 25rb');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('returns 404 / false when metrics are disabled for /api/traces', async () => {
    PrometheusMetricsRegistry.getInstance().setEnabled(false);

    const server = http.createServer((req, res) => {
      if (tryHandleMetricsEndpoint(req, res)) {
        return;
      }
      res.writeHead(404).end('Not Found');
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as any).port;

    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/traces`);
      expect(response.status).toBe(404);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
