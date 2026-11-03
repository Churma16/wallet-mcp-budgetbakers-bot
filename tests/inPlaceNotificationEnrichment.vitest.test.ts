import { describe, expect, it, vi } from 'vitest';
import { resolveEvidenceSourceIcons } from '../src/wallet/formatters/humanResponseFormatter.js';
import { TelegramMessagingAdapter } from '../src/gateway/telegram.js';
import { MessagingGatewayService } from '../src/gateway/coordinator.js';
import { coordinateInboundTransactionCandidate } from '../src/core/inboundCoordinator.js';
import { PendingTransactionService } from '../src/core/pending.js';
import { TransactionCorrelationService } from '../src/email/correlation.js';

describe('In-Place Notification Enrichment and Channel Source Icons', () => {
  describe('resolveEvidenceSourceIcons', () => {
    it('resolves single EMAIL evidence source to 📩', () => {
      expect(resolveEvidenceSourceIcons('EMAIL', ['EMAIL'])).toBe('📩');
      expect(resolveEvidenceSourceIcons('EMAIL')).toBe('📩');
    });

    it('resolves single PUSH_NOTIFICATION evidence source to 📲', () => {
      expect(resolveEvidenceSourceIcons('PUSH_NOTIFICATION', ['PUSH_NOTIFICATION'])).toBe('📲');
      expect(resolveEvidenceSourceIcons('PUSH_NOTIFICATION')).toBe('📲');
    });

    it('resolves fused push notification and email sources to 📲📩', () => {
      expect(resolveEvidenceSourceIcons('PUSH_NOTIFICATION', ['PUSH_NOTIFICATION', 'EMAIL'])).toBe('📲📩');
    });

    it('resolves fused email and push notification sources to 📩📲', () => {
      expect(resolveEvidenceSourceIcons('EMAIL', ['EMAIL', 'PUSH_NOTIFICATION'])).toBe('📩📲');
    });

    it('deduplicates repetitive evidence sources', () => {
      expect(resolveEvidenceSourceIcons('EMAIL', ['EMAIL', 'EMAIL'])).toBe('📩');
    });

    it('defaults to 📩 when sources are empty or undefined', () => {
      expect(resolveEvidenceSourceIcons(undefined, [])).toBe('📩');
    });
  });

  describe('TelegramMessagingAdapter.editBroadcastNotification', () => {
    const dummyToken = '123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ';
    const dummyUserId = '11894947';

    it('edits broadcast message using HTML format', async () => {
      const adapter = new TelegramMessagingAdapter(dummyToken, dummyUserId, vi.fn());
      const mockEditMessageText = vi.fn().mockResolvedValue(true);
      (adapter as any).botInstance = {
        api: {
          editMessageText: mockEditMessageText,
        },
      };

      const result = await adapter.editBroadcastNotification('1042', '*Updated Content*');
      expect(result).toBe(true);
      expect(mockEditMessageText).toHaveBeenCalledWith(
        dummyUserId,
        1042,
        '<b>Updated Content</b>',
        { parse_mode: 'HTML' }
      );
    });

    it('treats "message is not modified" as successful edit', async () => {
      const adapter = new TelegramMessagingAdapter(dummyToken, dummyUserId, vi.fn());
      const mockEditMessageText = vi.fn().mockRejectedValue(new Error('Bad Request: message is not modified'));
      (adapter as any).botInstance = {
        api: {
          editMessageText: mockEditMessageText,
        },
      };

      const result = await adapter.editBroadcastNotification('1042', 'Identical content');
      expect(result).toBe(true);
    });

    it('falls back to plain text edit when HTML parsing fails', async () => {
      const adapter = new TelegramMessagingAdapter(dummyToken, dummyUserId, vi.fn());
      const mockEditMessageText = vi
        .fn()
        .mockRejectedValueOnce(new Error('can\'t parse entities'))
        .mockResolvedValueOnce(true);
      (adapter as any).botInstance = {
        api: {
          editMessageText: mockEditMessageText,
        },
      };

      const result = await adapter.editBroadcastNotification('1042', 'Malformed <unclosed>');
      expect(result).toBe(true);
      expect(mockEditMessageText).toHaveBeenCalledTimes(2);
      expect(mockEditMessageText).toHaveBeenNthCalledWith(2, dummyUserId, 1042, 'Malformed <unclosed>');
    });

    it('returns false when bot instance or user id is not configured', async () => {
      const adapter = new TelegramMessagingAdapter(dummyToken, '', vi.fn());
      const result = await adapter.editBroadcastNotification('1042', 'Content');
      expect(result).toBe(false);
    });

    it('returns false for invalid numeric message ID', async () => {
      const adapter = new TelegramMessagingAdapter(dummyToken, dummyUserId, vi.fn());
      (adapter as any).botInstance = { api: { editMessageText: vi.fn() } };
      const result = await adapter.editBroadcastNotification('invalid-id', 'Content');
      expect(result).toBe(false);
    });
  });

  describe('MessagingGatewayService in-place edit orchestration', () => {
    it('dispatches editBroadcastNotification to connected adapters and returns true if any succeed', async () => {
      const gateway = new MessagingGatewayService();
      const mockTelegramAdapter = {
        channelName: 'telegram' as const,
        startConnection: vi.fn(),
        sendTextMessage: vi.fn(),
        sendTypingPresence: vi.fn(),
        clearTypingPresence: vi.fn(),
        sendBroadcastNotification: vi.fn(),
        editBroadcastNotification: vi.fn().mockResolvedValue(true),
        getConnectionState: () => 'connected' as const,
      };

      gateway.registerAdapter(mockTelegramAdapter);
      (gateway as any).adapterStateMap.set('telegram', 'connected');

      const edited = await gateway.editBroadcastNotification({ telegram: '1042' }, 'Updated text');
      expect(edited).toBe(true);
      expect(mockTelegramAdapter.editBroadcastNotification).toHaveBeenCalledWith('1042', 'Updated text');
    });

    it('returns false when no adapter can edit the notification', async () => {
      const gateway = new MessagingGatewayService();
      const mockConsoleAdapter = {
        channelName: 'console' as const,
        startConnection: vi.fn(),
        sendTextMessage: vi.fn(),
        sendTypingPresence: vi.fn(),
        clearTypingPresence: vi.fn(),
        sendBroadcastNotification: vi.fn(),
        getConnectionState: () => 'connected' as const,
      };

      gateway.registerAdapter(mockConsoleAdapter);
      (gateway as any).adapterStateMap.set('console', 'connected');

      const edited = await gateway.editBroadcastNotification({ console: '1042' }, 'Updated text');
      expect(edited).toBe(false);
    });
  });

  describe('InboundCoordinator in-place edit on transaction fusion', () => {
    it('stores notificationMessageIds on ticket creation and edits bubble instead of broadcasting on enrichment', async () => {
      const pendingManager = new PendingTransactionService();
      const mockMessaging = {
        broadcastNotification: vi.fn().mockResolvedValue({ telegram: '1001' }),
        editBroadcastNotification: vi.fn().mockResolvedValue(true),
      };

      const correlationService = new TransactionCorrelationService();
      const walletCache = {
        getAccounts: () => [{ id: 'acc-mandiri', name: 'Mandiri Debit', isBankSynced: false } as any],
        getCategories: () => [],
      };

      // 1. Initial Bank debit arrives
      await coordinateInboundTransactionCandidate(
        {
          sourceType: 'EMAIL',
          evidenceSourceType: 'EMAIL_BANK',
          sourceId: 'msg-bank-1',
          sourceDate: new Date('2026-11-04T00:00:00Z'),
          sourceDisplayName: 'Mandiri Alert',
          parsedData: {
            amount: -50000,
            currency: 'IDR',
            counterParty: 'MANDIRI DEBIT',
            transactionType: 'EXPENSE',
            referenceNumbers: ['REF-MANDIRI-1'],
          },
          extractedRefs: ['REF-MANDIRI-1'],
          gateResult: { matchedBankRule: { displayName: 'Mandiri Debit' } } as any,
          fallbackNote: 'Debit alert',
        },
        {
          walletCacheService: walletCache as any,
          pendingTransactionManager: pendingManager,
          messagingGateway: mockMessaging as any,
          defaultCurrency: 'IDR',
          correlationService,
        }
      );

      expect(mockMessaging.broadcastNotification).toHaveBeenCalledTimes(1);
      const tickets = pendingManager.getAllPendingTransactions();
      expect(tickets).toHaveLength(1);
      expect(tickets[0].notificationMessageIds).toEqual({ telegram: '1001' });

      // 2. Merchant receipt arrives (Blibli) -> MERGE_PENDING
      await coordinateInboundTransactionCandidate(
        {
          sourceType: 'EMAIL',
          evidenceSourceType: 'RECEIPT',
          sourceId: 'msg-merchant-1',
          sourceDate: new Date('2026-11-04T00:00:10Z'),
          sourceDisplayName: 'Blibli',
          parsedData: {
            amount: -50000,
            currency: 'IDR',
            counterParty: 'Blibli Offline Store',
            note: '2x Bakwan Sayur, 1x Nasi Uduk',
            transactionType: 'EXPENSE',
            matchedCategoryName: 'Makanan & Minuman',
            referenceNumbers: ['ORDER-BLIBLI-1'],
          },
          extractedRefs: ['ORDER-BLIBLI-1'],
          gateResult: { matchedBankRule: undefined } as any,
          fallbackNote: 'Blibli receipt',
        },
        {
          walletCacheService: walletCache as any,
          pendingTransactionManager: pendingManager,
          messagingGateway: mockMessaging as any,
          defaultCurrency: 'IDR',
          correlationService,
        }
      );

      // Crucial: editBroadcastNotification was called with ticket's message ID
      expect(mockMessaging.editBroadcastNotification).toHaveBeenCalledTimes(1);
      const [editedMessageIds, editedText] = mockMessaging.editBroadcastNotification.mock.calls[0];
      expect(editedMessageIds).toEqual({ telegram: '1001' });
      expect(editedText).toContain('Blibli Offline Store');
      expect(editedText).toContain('2x Bakwan Sayur');
      expect(editedText).toContain('Diperbarui via 📩 Blibli');
      expect(editedText).not.toContain('✨');

      // broadcastNotification should NOT have been called a second time!
      expect(mockMessaging.broadcastNotification).toHaveBeenCalledTimes(1);
    });

    it('falls back to broadcastNotification if editBroadcastNotification fails', async () => {
      const pendingManager = new PendingTransactionService();
      const mockMessaging = {
        broadcastNotification: vi.fn().mockResolvedValue({ telegram: '1002' }),
        editBroadcastNotification: vi.fn().mockResolvedValue(false), // edit failed
      };

      const correlationService = new TransactionCorrelationService();
      const walletCache = {
        getAccounts: () => [],
        getCategories: () => [],
      };

      // Initial
      await coordinateInboundTransactionCandidate(
        {
          sourceType: 'PUSH_NOTIFICATION',
          evidenceSourceType: 'PUSH_NOTIFICATION',
          sourceId: 'push-1',
          sourceDate: new Date('2026-11-04T00:00:00Z'),
          sourceDisplayName: 'BCA Mobile',
          parsedData: {
            amount: -25000,
            currency: 'IDR',
            counterParty: 'BCA DEBIT',
            transactionType: 'EXPENSE',
            referenceNumbers: ['BCA-REF-1'],
          },
          extractedRefs: ['BCA-REF-1'],
          gateResult: {} as any,
          fallbackNote: 'Push',
        },
        {
          walletCacheService: walletCache as any,
          pendingTransactionManager: pendingManager,
          messagingGateway: mockMessaging as any,
          defaultCurrency: 'IDR',
          correlationService,
        }
      );

      // Merchant receipt arrives
      await coordinateInboundTransactionCandidate(
        {
          sourceType: 'EMAIL',
          evidenceSourceType: 'RECEIPT',
          sourceId: 'email-1',
          sourceDate: new Date('2026-11-04T00:00:05Z'),
          sourceDisplayName: 'Indomaret',
          parsedData: {
            amount: -25000,
            currency: 'IDR',
            counterParty: 'Indomaret Point',
            transactionType: 'EXPENSE',
            referenceNumbers: ['INDO-REF-1'],
          },
          extractedRefs: ['INDO-REF-1'],
          gateResult: {} as any,
          fallbackNote: 'Indomaret',
        },
        {
          walletCacheService: walletCache as any,
          pendingTransactionManager: pendingManager,
          messagingGateway: mockMessaging as any,
          defaultCurrency: 'IDR',
          correlationService,
        }
      );

      expect(mockMessaging.editBroadcastNotification).toHaveBeenCalledTimes(1);
      // Fallback broadcast was executed because edit returned false
      expect(mockMessaging.broadcastNotification).toHaveBeenCalledTimes(2);
    });

    it('skips edit if ticket is no longer active pending', async () => {
      const pendingManager = new PendingTransactionService();
      const mockMessaging = {
        broadcastNotification: vi.fn().mockResolvedValue({ telegram: '1003' }),
        editBroadcastNotification: vi.fn().mockResolvedValue(true),
      };

      const correlationService = new TransactionCorrelationService();
      const walletCache = {
        getAccounts: () => [],
        getCategories: () => [],
      };

      // Initial
      await coordinateInboundTransactionCandidate(
        {
          sourceType: 'EMAIL',
          evidenceSourceType: 'EMAIL_BANK',
          sourceId: 'msg-1',
          sourceDate: new Date('2026-11-04T00:00:00Z'),
          sourceDisplayName: 'Bank Alert',
          parsedData: {
            amount: -30000,
            currency: 'IDR',
            counterParty: 'Merchant',
            transactionType: 'EXPENSE',
            referenceNumbers: ['REF-1'],
          },
          extractedRefs: ['REF-1'],
          gateResult: {} as any,
          fallbackNote: 'Alert',
        },
        {
          walletCacheService: walletCache as any,
          pendingTransactionManager: pendingManager,
          messagingGateway: mockMessaging as any,
          defaultCurrency: 'IDR',
          correlationService,
        }
      );

      // Simulate user already claimed the ticket for processing (e.g. replied "Ya")
      pendingManager.claimPendingTransaction(1);

      // Subsequent evidence arrives
      await coordinateInboundTransactionCandidate(
        {
          sourceType: 'EMAIL',
          evidenceSourceType: 'RECEIPT',
          sourceId: 'msg-2',
          sourceDate: new Date('2026-11-04T00:00:15Z'),
          sourceDisplayName: 'Store',
          parsedData: {
            amount: -30000,
            currency: 'IDR',
            counterParty: 'Store Official',
            transactionType: 'EXPENSE',
            referenceNumbers: ['REF-2'],
          },
          extractedRefs: ['REF-2'],
          gateResult: {} as any,
          fallbackNote: 'Store',
        },
        {
          walletCacheService: walletCache as any,
          pendingTransactionManager: pendingManager,
          messagingGateway: mockMessaging as any,
          defaultCurrency: 'IDR',
          correlationService,
        }
      );

      // Should not call edit or broadcast
      expect(mockMessaging.editBroadcastNotification).not.toHaveBeenCalled();
      expect(mockMessaging.broadcastNotification).toHaveBeenCalledTimes(1);
    });
  });
});
