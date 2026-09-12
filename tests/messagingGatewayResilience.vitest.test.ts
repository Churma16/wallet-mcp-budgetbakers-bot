import { describe, expect, it } from 'vitest';
import { MessagingGatewayService } from '../src/services/messaging/messagingGatewayService.js';

describe('MessagingGatewayService.calculateReconnectDelay', () => {
  it('preserves exponential scaling and the configured dynamic jitter bounds', () => {
    const gateway = new MessagingGatewayService({
      backgroundReconnectBaseDelayMs: 1000,
      backgroundReconnectMaxDelayMs: 5000,
    });

    for (let iteration = 0; iteration < 25; iteration++) {
      const delayMs = gateway.calculateReconnectDelay(2);

      expect(delayMs).toBeGreaterThanOrEqual(4250);
      expect(delayMs).toBeLessThan(5000);
    }
  });

  it('caps the exponential component before adding the existing gateway jitter', () => {
    const gateway = new MessagingGatewayService({
      backgroundReconnectBaseDelayMs: 1000,
      backgroundReconnectMaxDelayMs: 5000,
    });

    for (let iteration = 0; iteration < 25; iteration++) {
      const delayMs = gateway.calculateReconnectDelay(5);

      expect(delayMs).toBeGreaterThanOrEqual(5250);
      expect(delayMs).toBeLessThan(6000);
    }
  });

  it('preserves the narrower jitter range used with small base delays', () => {
    const gateway = new MessagingGatewayService({
      backgroundReconnectBaseDelayMs: 20,
      backgroundReconnectMaxDelayMs: 100,
    });

    for (let iteration = 0; iteration < 25; iteration++) {
      const delayMs = gateway.calculateReconnectDelay(0);

      expect(delayMs).toBeGreaterThanOrEqual(25);
      expect(delayMs).toBeLessThan(40);
    }
  });
});
