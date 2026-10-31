import { describe, expect, it } from 'vitest';
import { FinancialActionRegistry } from '../src/core/financialActionRegistry.js';
import { FastPathHandler } from '../src/core/fastPathHandler.js';

describe('PR #155 queue fast-path guard', () => {
  it('falls through safely when CHECK_QUEUE has no registered handler', async () => {
    const registry = new FinancialActionRegistry();
    const handler = new FastPathHandler(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      registry
    );

    const handled = await handler.handleFastPath(
      {
        channel: 'whatsapp',
        chatIdentifier: 'chat-queue-guard',
        senderIdentifier: 'sender-queue-guard',
        messageType: 'text',
        textPayload: 'antrean',
      } as any,
      'CHECK_QUEUE',
      Date.now()
    );

    expect(handled).toBe(false);
  });
});
