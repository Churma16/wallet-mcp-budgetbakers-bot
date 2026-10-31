import { randomInt } from 'node:crypto';

export interface ExponentialBackoffOptions {
  attempt: number;
  baseMs: number;
  maxMs: number;
  jitterMinMs: number;
  jitterMaxMs: number;
}

/**
 * Calculates bounded exponential delay and adds jitter sampled from the configured range.
 * The exponential component is capped before jitter, preserving provider-specific retry timing semantics.
 */
export function calculateExponentialBackoff({
  attempt,
  baseMs,
  maxMs,
  jitterMinMs,
  jitterMaxMs,
}: ExponentialBackoffOptions): number {
  const exponentialDelayMs = baseMs * Math.pow(2, attempt);
  const boundedDelayMs = Math.min(maxMs, exponentialDelayMs);
  const jitterMs = randomInt(jitterMinMs, jitterMaxMs);
  return boundedDelayMs + jitterMs;
}
