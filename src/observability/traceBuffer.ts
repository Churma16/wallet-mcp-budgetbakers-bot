/**
 * Zero-dependency In-Memory Rolling Ring Buffer for AI Call Traces.
 * Keeps the last N execution traces in memory for rapid prompt tuning inspection.
 */

import { PrometheusMetricsRegistry } from './metrics.js';

export interface AiCallTraceEntry {
  id: string;
  timestamp: string;
  operation: string;
  provider: string;
  model: string;
  role: 'primary' | 'fallback';
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  cachedTokens: number;
  totalTokens: number;
  status: 'success' | 'error';
  errorMessage?: string;
  inputSample?: string;
  decision?: string;
}

export interface TraceQueryOptions {
  limit?: number;
  operation?: string;
  provider?: string;
}

export function sanitizeInputSample(input: string, maxLength: number = 150): string {
  if (!input) return '';
  let cleaned = input;
  // If wrapped in <untrusted_user_text>...</untrusted_user_text>, extract actual user text
  const userTextMatch = cleaned.match(/<untrusted_user_text>([\s\S]*?)<\/untrusted_user_text>/i);
  if (userTextMatch && userTextMatch[1] && userTextMatch[1].trim().length > 0) {
    cleaned = userTextMatch[1];
  }
  // Collapse excessive whitespaces and newlines
  const collapsed = cleaned.replace(/\s+/g, ' ').trim();
  // Mask obvious bearer tokens or credentials if present
  const masked = collapsed.replace(/bearer\s+[a-zA-Z0-9_\-\.]{15,}/gi, 'Bearer [REDACTED]');
  return masked.length > maxLength ? `${masked.slice(0, maxLength)}...` : masked;
}

export function extractDecisionSummary(responseText: string): string | undefined {
  if (!responseText) return undefined;
  try {
    const parsed = JSON.parse(responseText);
    if (parsed && typeof parsed.action === 'string') {
      return parsed.action;
    }
    if (parsed && typeof parsed.decision === 'string') {
      return parsed.decision;
    }
    if (Array.isArray(parsed.records) && parsed.records.length > 0) {
      return `CREATE_RECORD (${parsed.records.length} items)`;
    }
  } catch {
    // not valid JSON, treat as text
  }
  const singleLine = responseText.replace(/\s+/g, ' ').trim();
  return singleLine.length > 60 ? `${singleLine.slice(0, 60)}...` : singleLine;
}

export class AiTraceBuffer {
  private static instance: AiTraceBuffer | null = null;
  private readonly maxCapacity: number;
  private readonly entries: AiCallTraceEntry[] = [];

  constructor(maxCapacity: number = 100) {
    this.maxCapacity = Math.max(1, maxCapacity);
  }

  public static getInstance(): AiTraceBuffer {
    if (!AiTraceBuffer.instance) {
      AiTraceBuffer.instance = new AiTraceBuffer(100);
    }
    return AiTraceBuffer.instance;
  }

  public static resetInstance(): void {
    AiTraceBuffer.instance = null;
  }

  public record(
    entry: Omit<AiCallTraceEntry, 'id' | 'timestamp'> & { id?: string; timestamp?: string }
  ): AiCallTraceEntry | null {
    if (!PrometheusMetricsRegistry.getInstance().isEnabled()) {
      return null;
    }

    const fullEntry: AiCallTraceEntry = {
      ...entry,
      id: entry.id || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: entry.timestamp || new Date().toISOString(),
      inputSample: entry.inputSample ? sanitizeInputSample(entry.inputSample) : undefined,
    };

    if (this.entries.length >= this.maxCapacity) {
      this.entries.shift();
    }
    this.entries.push(fullEntry);
    return fullEntry;
  }

  public getTraces(options?: TraceQueryOptions): AiCallTraceEntry[] {
    let result = [...this.entries];
    if (options?.operation) {
      result = result.filter(e => e.operation === options.operation);
    }
    if (options?.provider) {
      result = result.filter(e => e.provider === options.provider);
    }
    result.reverse();
    if (options?.limit && options.limit > 0) {
      result = result.slice(0, options.limit);
    }
    return result;
  }

  public size(): number {
    return this.entries.length;
  }

  public clear(): void {
    this.entries.length = 0;
  }
}
