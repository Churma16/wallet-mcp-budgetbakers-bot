import { describe, expect, it } from 'vitest';
import { SemanticToolBoundary } from '../src/services/ai/semanticToolBoundary.js';
import { IncomingUserMessageEvent } from '../src/services/messaging/index.js';

const event: IncomingUserMessageEvent = {
  channel: 'whatsapp',
  senderIdentifier: '6281234567890',
  chatIdentifier: '6281234567890@s.whatsapp.net',
  messageType: 'image',
};

function evaluate(records: Record<string, unknown>[]) {
  return new SemanticToolBoundary().evaluate({
    proposal: {
      tool: 'propose_transaction',
      arguments: { records },
    },
    authorization: { isAuthorized: true, source: 'test-policy' },
    event,
    availableAccountList: [
      { id: 'acc-1', name: 'BCA', balance: 1_000_000, currency: 'IDR' },
    ],
    availableCategoryList: [],
  });
}

describe('SemanticToolBoundary deterministic validation delegation', () => {
  it('accepts a structurally safe partial record with no account so clarification remains downstream', () => {
    const decision = evaluate([{ amount: 25_000, note: 'receipt item' }]);

    expect(decision).toMatchObject({
      accepted: true,
      tool: 'propose_transaction',
      context: {
        action: 'CREATE_RECORD',
        records: [{ amount: 25_000, note: 'receipt item' }],
      },
    });
  });

  it('accepts bounded OCR amount strings so the deterministic amount parser remains authoritative', () => {
    const decision = evaluate([{
      accountId: 'acc-1',
      amount: '-Rp10.079',
      note: 'receipt item',
    }]);

    expect(decision).toMatchObject({
      accepted: true,
      context: {
        action: 'CREATE_RECORD',
        records: [{ amount: '-Rp10.079' }],
      },
    });
  });
});
