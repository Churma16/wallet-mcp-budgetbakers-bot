import { describe, it, expect, vi } from 'vitest';
import { CreateRecordActionHandler } from '../src/core/handlers/createRecordHandler.js';
import { TransactionMessageStore } from '../src/wallet/records/transactionMessageStore.js';
import type { IncomingUserMessageEvent } from '../src/gateway/index.js';

describe('CreateRecordActionHandler - TransactionMessageStore integration', () => {
  it('records message mapping when creating a single record', async () => {
    const store = new TransactionMessageStore();
    const mockMcpClient = {
      createRecords: vi.fn(async () => ({
        summary: { total: 1, succeeded: 1 },
        results: [{ id: 'rec-single-1', success: true }],
      })),
    };
    const mockCache = {
      getAccounts: vi.fn(() => [{ id: 'acc-1', name: 'BCA', balance: 1000000, currency: 'IDR' }]),
      getCategories: vi.fn(() => [{ id: 'cat-1', name: 'Makan', isAssignable: true }]),
      isLabelsLoaded: vi.fn(() => true),
    };
    const mockGateway = {
      sendMessage: vi.fn(async () => ({ messageId: 'msg-receipt-single' })),
    };
    const mockPrep = {
      prepareRecordsForDispatch: vi.fn(async (recs) => recs),
    };
    const mockAccountClarification = {
      createPendingAccountSelectionDraft: vi.fn(async () => false),
    };

    const handler = new CreateRecordActionHandler(
      mockMcpClient as any,
      mockCache as any,
      mockGateway as any,
      mockPrep as any,
      mockAccountClarification as any,
      undefined, // categoryContextService
      undefined, // categoryClarificationHandler
      undefined, // categoryResolutionMode
      undefined, // categoryClarificationConversationService
      store
    );

    const event: IncomingUserMessageEvent = {
      channel: 'telegram',
      senderIdentifier: 'user-1',
      chatIdentifier: 'chat-1',
      messageType: 'text',
      textPayload: 'beli kopi 25rb',
    };

    await handler.execute({
      action: 'CREATE_RECORD',
      event,
      records: [
        {
          accountId: 'acc-1',
          amount: -25000,
          categoryId: 'cat-1',
          note: 'beli kopi',
        },
      ],
    });

    const mapping = store.getMessageMapping('msg-receipt-single');
    expect(mapping).toBeDefined();
    expect(mapping?.recordId).toBe('rec-single-1');
    expect(mapping?.amount).toBe(-25000);
  });

  it('does NOT record message mapping when creating multiple records (avoids ambiguous edits)', async () => {
    const store = new TransactionMessageStore();
    const mockMcpClient = {
      createRecords: vi.fn(async () => ({
        summary: { total: 2, succeeded: 2 },
        results: [
          { id: 'rec-multi-1', success: true },
          { id: 'rec-multi-2', success: true },
        ],
      })),
    };
    const mockCache = {
      getAccounts: vi.fn(() => [{ id: 'acc-1', name: 'BCA', balance: 1000000, currency: 'IDR' }]),
      getCategories: vi.fn(() => [{ id: 'cat-1', name: 'Makan', isAssignable: true }]),
      isLabelsLoaded: vi.fn(() => true),
    };
    const mockGateway = {
      sendMessage: vi.fn(async () => ({ messageId: 'msg-receipt-multi' })),
    };
    const mockPrep = {
      prepareRecordsForDispatch: vi.fn(async (recs) => recs),
    };
    const mockAccountClarification = {
      createPendingAccountSelectionDraft: vi.fn(async () => false),
    };

    const handler = new CreateRecordActionHandler(
      mockMcpClient as any,
      mockCache as any,
      mockGateway as any,
      mockPrep as any,
      mockAccountClarification as any,
      undefined, // categoryContextService
      undefined, // categoryClarificationHandler
      undefined, // categoryResolutionMode
      undefined, // categoryClarificationConversationService
      store
    );

    const event: IncomingUserMessageEvent = {
      channel: 'telegram',
      senderIdentifier: 'user-1',
      chatIdentifier: 'chat-1',
      messageType: 'text',
      textPayload: 'struk makan dan minum',
    };

    await handler.execute({
      action: 'CREATE_RECORD',
      event,
      records: [
        {
          accountId: 'acc-1',
          amount: -25000,
          categoryId: 'cat-1',
          note: 'makan',
        },
        {
          accountId: 'acc-1',
          amount: -15000,
          categoryId: 'cat-1',
          note: 'minum',
        },
      ],
    });

    const mapping = store.getMessageMapping('msg-receipt-multi');
    expect(mapping).toBeUndefined();
  });
});
