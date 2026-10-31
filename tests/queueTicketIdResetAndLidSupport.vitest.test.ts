import { describe, expect, it, vi } from 'vitest';
import { PendingTransactionService } from '../src/core/pending.js';
import { WhatsappInboundMessageProcessor } from '../src/gateway/whatsapp.js';
import { MessageIdTracker } from '../src/gateway/whatsapp.js';
import { loadEnvironmentConfiguration } from '../src/config/environmentConfig.js';
import { proto } from '@whiskeysockets/baileys';

describe('Queue Ticket Sequential Counter Reset (Issue Fix)', () => {
  function createStandardItem(overrides?: Partial<any>) {
    return {
      sourceType: 'EMAIL' as const,
      bankDisplayName: 'Bank Jago',
      accountNameHint: 'Jago Expense',
      counterParty: 'Shopee',
      amount: -50000,
      transactionType: 'EXPENSE' as const,
      matchedAccountId: 'acc-1',
      note: 'Order payment',
      recordDate: new Date().toISOString(),
      ...overrides,
    };
  }

  function createDraftItem(overrides?: Partial<any>) {
    return {
      sourceType: 'USER' as const,
      channel: 'whatsapp' as const,
      senderIdentifier: 'user-1',
      chatIdentifier: 'chat-1',
      records: [{ amount: -25000, accountId: 'acc-1', categoryId: 'cat-1' }],
      pendingRecordIndex: 0,
      accountHint: 'Pocket',
      candidateAccounts: [{ id: 'acc-1', name: 'Main Pocket' }],
      ...overrides,
    };
  }

  it('assigns ticket #1 initially and resets back to #1 when the single pending transaction is resolved', () => {
    const service = new PendingTransactionService();
    expect(service.getNextTicketSequentialId()).toBe(1);

    const firstItem = service.addPendingTransaction(createStandardItem());
    expect(firstItem.ticketId).toBe(1);
    expect(service.getNextTicketSequentialId()).toBe(2);

    service.resolvePendingTransaction(firstItem.ticketId);
    expect(service.getAllPendingTransactions()).toHaveLength(0);
    expect(service.getNextTicketSequentialId()).toBe(1);

    const secondItem = service.addPendingTransaction(createStandardItem());
    expect(secondItem.ticketId).toBe(1);
    expect(service.getNextTicketSequentialId()).toBe(2);
  });

  it('assigns ticket #1 initially and resets back to #1 when single pending transaction is rejected', () => {
    const service = new PendingTransactionService();
    const item = service.addPendingTransaction(createStandardItem());
    expect(item.ticketId).toBe(1);

    service.rejectPendingTransaction(item.ticketId);
    expect(service.getAllPendingTransactions()).toHaveLength(0);
    expect(service.getNextTicketSequentialId()).toBe(1);

    const nextItem = service.addPendingTransaction(createStandardItem());
    expect(nextItem.ticketId).toBe(1);
  });

  it('preserves sequential ticket IDs while items are queued, and only resets to #1 when all items are cleared', () => {
    const service = new PendingTransactionService();

    const item1 = service.addPendingTransaction(createStandardItem({ note: 'Item 1' }));
    const item2 = service.addPendingTransaction(createStandardItem({ note: 'Item 2' }));
    expect(item1.ticketId).toBe(1);
    expect(item2.ticketId).toBe(2);
    expect(service.getNextTicketSequentialId()).toBe(3);

    // Resolve item 1 -> item 2 still in queue -> counter should NOT reset to 1 yet
    service.resolvePendingTransaction(item1.ticketId);
    expect(service.getAllPendingTransactions()).toHaveLength(1);
    expect(service.getPendingTransaction(item2.ticketId)).toBeDefined();
    expect(service.getNextTicketSequentialId()).toBe(3);

    // New item added while item 2 is in queue gets #3
    const item3 = service.addPendingTransaction(createStandardItem({ note: 'Item 3' }));
    expect(item3.ticketId).toBe(3);
    expect(service.getNextTicketSequentialId()).toBe(4);

    // Resolve item 2 -> item 3 remains in queue
    service.resolvePendingTransaction(item2.ticketId);
    expect(service.getNextTicketSequentialId()).toBe(4);

    // Resolve item 3 -> queue is now completely empty -> resets to 1!
    service.resolvePendingTransaction(item3.ticketId);
    expect(service.getAllPendingTransactions()).toHaveLength(0);
    expect(service.getNextTicketSequentialId()).toBe(1);

    // Next item added starts back from #1
    const nextBatchItem = service.addPendingTransaction(createStandardItem({ note: 'Next Batch' }));
    expect(nextBatchItem.ticketId).toBe(1);
  });

  it('participates with account selection drafts and resets counter when all drafts and transactions are resolved', () => {
    const service = new PendingTransactionService();

    const draft = service.addPendingAccountSelectionDraft(createDraftItem());
    expect(draft.ticketId).toBe(1);
    expect(service.getNextTicketSequentialId()).toBe(2);

    service.resolvePendingAccountSelectionDraft(draft.ticketId);
    expect(service.getAllPendingAccountSelectionDrafts()).toHaveLength(0);
    expect(service.getNextTicketSequentialId()).toBe(1);

    const nextDraft = service.addPendingAccountSelectionDraft(createDraftItem());
    expect(nextDraft.ticketId).toBe(1);
  });

  it('resets counter to 1 when resolveAllPendingTransactions or rejectAllPendingTransactions is called', () => {
    const service = new PendingTransactionService();

    service.addPendingTransaction(createStandardItem());
    service.addPendingTransaction(createStandardItem());
    expect(service.getAllPendingTransactions()).toHaveLength(2);

    service.resolveAllPendingTransactions();
    expect(service.getAllPendingTransactions()).toHaveLength(0);
    expect(service.getNextTicketSequentialId()).toBe(1);

    service.addPendingTransaction(createStandardItem());
    service.addPendingTransaction(createStandardItem());
    service.rejectAllPendingTransactions();
    expect(service.getAllPendingTransactions()).toHaveLength(0);
    expect(service.getNextTicketSequentialId()).toBe(1);
  });

  it('UNKNOWN transactions prevent resetting until explicitly resolved', () => {
    const service = new PendingTransactionService();
    const item = service.addPendingTransaction(createStandardItem());
    service.markPendingTransactionUnknown(item.ticketId);

    // Attempting normal reject on UNKNOWN item is prevented
    service.rejectPendingTransaction(item.ticketId);
    expect(service.getPendingTransactionState(item.ticketId)).toBe('UNKNOWN');
    expect(service.getNextTicketSequentialId()).toBe(2);

    // When UNKNOWN transaction is finally resolved, counter resets to 1
    service.resolvePendingTransaction(item.ticketId);
    expect(service.getAllPendingTransactions()).toHaveLength(0);
    expect(service.getNextTicketSequentialId()).toBe(1);
  });
});

describe('WhatsApp Inbound Multi-Number Whitelist and LID Mapping Support', () => {
  it('authorizes messages from comma-separated phone numbers', () => {
    const userCallback = vi.fn();
    const socketProvider = () => null;
    const sendText = vi.fn().mockResolvedValue(undefined);

    const processor = new WhatsappInboundMessageProcessor(
      ['6287888322718', '6285786231252'],
      userCallback,
      socketProvider,
      new MessageIdTracker(),
      10 * 1024 * 1024,
      sendText
    );

    expect(processor.isAuthorizedSender('6287888322718@s.whatsapp.net', false)).toBe(true);
    expect(processor.isAuthorizedSender('6285786231252@s.whatsapp.net', false)).toBe(true);
    expect(processor.isAuthorizedSender('6281234567890@s.whatsapp.net', false)).toBe(false);
  });

  it('authorizes message directly when sender LID is in allowed list', () => {
    const userCallback = vi.fn();
    const socketProvider = () => null;
    const sendText = vi.fn().mockResolvedValue(undefined);

    const processor = new WhatsappInboundMessageProcessor(
      '6287888322718, 167740232986661',
      userCallback,
      socketProvider,
      new MessageIdTracker(),
      10 * 1024 * 1024,
      sendText
    );

    expect(processor.isAuthorizedSender('167740232986661@lid', false)).toBe(true);
    expect(processor.isAuthorizedSender('999999999999999@lid', false)).toBe(false);
  });

  it('resolves LID to phone number using Baileys signalRepository.lidMapping in process()', async () => {
    const userCallback = vi.fn().mockResolvedValue(undefined);
    const sendText = vi.fn().mockResolvedValue(undefined);

    const mockSocket = {
      user: { id: '6287888322718:32@s.whatsapp.net', lid: '202868971856115:32@lid' },
      signalRepository: {
        lidMapping: {
          getPNForLID: vi.fn().mockImplementation(async (jid: string) => {
            if (jid === '167740232986661@lid') {
              return '6285786231252@s.whatsapp.net';
            }
            return undefined;
          }),
        },
      },
    };

    const processor = new WhatsappInboundMessageProcessor(
      '6287888322718, 6285786231252',
      userCallback,
      () => mockSocket as any,
      new MessageIdTracker(),
      10 * 1024 * 1024,
      sendText
    );

    const testMessage: proto.IWebMessageInfo = {
      key: {
        remoteJid: '167740232986661@lid',
        id: 'msg-lid-test-01',
        fromMe: false,
      },
      message: {
        conversation: 'Ya',
      },
    };

    await processor.process([testMessage]);

    expect(mockSocket.signalRepository.lidMapping.getPNForLID).toHaveBeenCalledWith('167740232986661@lid');
    expect(userCallback).toHaveBeenCalledTimes(1);
    expect(userCallback).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'whatsapp',
        chatIdentifier: '167740232986661@lid',
        textPayload: 'Ya',
      })
    );
  });
});

describe('Environment Configuration Multi-Phone Whitelist Parsing', () => {
  const originalEnv = { ...process.env };

  it('loads multiple comma-separated ALLOWED_PHONE_NUMBER entries into allowedPhoneNumbers', () => {
    process.env = {
      ...originalEnv,
      AI_PROVIDER: 'gemini',
      GEMINI_API_KEY: 'test-key',
      WALLET_MCP_ACCESS_TOKEN: 'test-token',
      ALLOWED_PHONE_NUMBER: '6287888322718, 085786231252',
      ENABLED_MESSENGER_CHANNELS: 'whatsapp',
    };

    const config = loadEnvironmentConfiguration();
    expect(config.allowedPhoneNumber).toBe('6287888322718');
    expect(config.allowedPhoneNumbers).toEqual(['6287888322718', '6285786231252']);
  });
});
