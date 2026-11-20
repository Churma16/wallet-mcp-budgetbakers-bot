import { describe, it, expect, beforeEach } from 'vitest';
import {
  AiTraceBuffer,
  sanitizeInputSample,
  extractDecisionSummary,
} from '../src/observability/traceBuffer.js';
import { tryHandleMetricsEndpoint } from '../src/observability/metrics.js';
import http from 'node:http';

describe('AiTraceBuffer', () => {
  beforeEach(() => {
    AiTraceBuffer.resetInstance();
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
    // Newest first
    expect(traces[0].operation).toBe('receipt_ocr');
    expect(traces[1].operation).toBe('intent_text');
  });

  it('evicts oldest entries when reaching max capacity (FIFO)', () => {
    const buffer = new AiTraceBuffer(3);

    buffer.record({
      operation: 'op_1',
      provider: 'gemini',
      model: 'm1',
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
      operation: 'op_2',
      provider: 'gemini',
      model: 'm1',
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
      operation: 'op_3',
      provider: 'gemini',
      model: 'm1',
      role: 'primary',
      durationMs: 300,
      inputTokens: 30,
      outputTokens: 15,
      thinkingTokens: 0,
      cachedTokens: 0,
      totalTokens: 45,
      status: 'success',
    });

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

  it('sanitizes input samples and redacts auth tokens', () => {
    const raw = '   Bearer 1234567890abcdef1234567890   beli pulsa \n\n 100rb   ';
    const sanitized = sanitizeInputSample(raw);
    expect(sanitized).toBe('Bearer [REDACTED] beli pulsa 100rb');

    const longText = 'a'.repeat(200);
    const truncated = sanitizeInputSample(longText, 100);
    expect(truncated.length).toBe(103);
    expect(truncated.endsWith('...')).toBe(true);
  });

  it('extracts decision summary from JSON response or raw string', () => {
    const jsonAction = JSON.stringify({ action: 'CREATE_RECORD', records: [{ amount: -50000 }] });
    expect(extractDecisionSummary(jsonAction)).toBe('CREATE_RECORD');

    const jsonRecords = JSON.stringify({ records: [{ amount: -25000 }, { amount: -10000 }] });
    expect(extractDecisionSummary(jsonRecords)).toBe('CREATE_RECORD (2 items)');

    const plainText = 'Mohon sebutkan nominal transaksi Anda.';
    expect(extractDecisionSummary(plainText)).toBe(plainText);
  });

  it('serves /api/traces and /traces via tryHandleMetricsEndpoint', async () => {
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
      const response = await fetch(`http://127.0.0.1:${port}/api/traces?limit=10`);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('application/json');

      const data = await response.json();
      expect(data.count).toBe(1);
      expect(data.capacity).toBe(100);
      expect(data.traces[0].operation).toBe('intent_text');
      expect(data.traces[0].inputSample).toBe('beli kopi 25rb');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
