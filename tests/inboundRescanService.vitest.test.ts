import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  parseRescanDurationMinutes,
  InboundRescanService,
  MIN_RESCAN_DURATION_MINUTES,
  MAX_RESCAN_DURATION_MINUTES,
  DEFAULT_RESCAN_DURATION_MINUTES,
} from '../src/core/inboundRescanService.js';
import { formatInboundRescanResponse } from '../src/wallet/formatters/inboundRescanFormatter.js';
import type { PushNotificationPayload } from '../src/gateway/webhook.js';

describe('InboundRescanService and Rescan Infrastructure', () => {
  describe('parseRescanDurationMinutes', () => {
    it('returns default duration when input is undefined, empty, or whitespace', () => {
      expect(parseRescanDurationMinutes()).toBe(DEFAULT_RESCAN_DURATION_MINUTES);
      expect(parseRescanDurationMinutes('')).toBe(DEFAULT_RESCAN_DURATION_MINUTES);
      expect(parseRescanDurationMinutes('   ')).toBe(DEFAULT_RESCAN_DURATION_MINUTES);
    });

    it('parses raw numbers as minutes', () => {
      expect(parseRescanDurationMinutes('30')).toBe(30);
      expect(parseRescanDurationMinutes('45')).toBe(45);
      expect(parseRescanDurationMinutes('120')).toBe(120);
    });

    it('parses minute units correctly', () => {
      expect(parseRescanDurationMinutes('30m')).toBe(30);
      expect(parseRescanDurationMinutes('45 min')).toBe(45);
      expect(parseRescanDurationMinutes('15 menit')).toBe(15);
      expect(parseRescanDurationMinutes('20 minutes')).toBe(20);
    });

    it('parses hour units into minutes', () => {
      expect(parseRescanDurationMinutes('1h')).toBe(60);
      expect(parseRescanDurationMinutes('2 jam')).toBe(120);
      expect(parseRescanDurationMinutes('3 hours')).toBe(180);
      expect(parseRescanDurationMinutes('4 hr')).toBe(240);
    });

    it('parses day units into minutes', () => {
      expect(parseRescanDurationMinutes('1d')).toBe(1440);
      expect(parseRescanDurationMinutes('2 hari')).toBe(2880);
      expect(parseRescanDurationMinutes('3 days')).toBe(4320);
    });

    it('clamps values below minimum (5 minutes)', () => {
      expect(parseRescanDurationMinutes('1')).toBe(MIN_RESCAN_DURATION_MINUTES);
      expect(parseRescanDurationMinutes('2m')).toBe(MIN_RESCAN_DURATION_MINUTES);
    });

    it('clamps values above maximum (7 days / 10080 minutes)', () => {
      expect(parseRescanDurationMinutes('10d')).toBe(MAX_RESCAN_DURATION_MINUTES);
      expect(parseRescanDurationMinutes('999999')).toBe(MAX_RESCAN_DURATION_MINUTES);
    });

    it('falls back to default for unparseable input', () => {
      expect(parseRescanDurationMinutes('invalid')).toBe(DEFAULT_RESCAN_DURATION_MINUTES);
      expect(parseRescanDurationMinutes('abc')).toBe(DEFAULT_RESCAN_DURATION_MINUTES);
    });
  });

  describe('formatInboundRescanResponse', () => {
    it('formats Indonesian response with minutes and hours correctly', () => {
      const resultMinutes = {
        durationMinutes: 45,
        notificationsReplayed: 3,
        emailsScanned: 8,
        emailsDetected: 1,
        reconciledPendingCount: 1,
      };

      const idOutputMin = formatInboundRescanResponse(resultMinutes, 'id');
      expect(idOutputMin).toContain('Rescan Transaksi Selesai!');
      expect(idOutputMin).toContain('45 menit terakhir');
      expect(idOutputMin).toContain('Push Notification Dievaluasi*: 3');
      expect(idOutputMin).toContain('Email Diperiksa*: 8 (1 transaksi terdeteksi)');
      expect(idOutputMin).toContain('Tiket Pending Diselaraskan*: 1');

      const resultHours = {
        durationMinutes: 120,
        notificationsReplayed: 0,
        emailsScanned: 15,
        emailsDetected: 0,
        reconciledPendingCount: 0,
      };
      const idOutputHour = formatInboundRescanResponse(resultHours, 'id');
      expect(idOutputHour).toContain('2 jam terakhir');

      const resultMixed = {
        durationMinutes: 90,
        notificationsReplayed: 1,
        emailsScanned: 5,
        emailsDetected: 0,
        reconciledPendingCount: 0,
      };
      const idOutputMixed = formatInboundRescanResponse(resultMixed, 'id');
      expect(idOutputMixed).toContain('90 menit terakhir');
    });

    it('formats English response correctly', () => {
      const result = {
        durationMinutes: 60,
        notificationsReplayed: 5,
        emailsScanned: 10,
        emailsDetected: 2,
        reconciledPendingCount: 2,
      };

      const enOutput = formatInboundRescanResponse(result, 'en');
      expect(enOutput).toContain('Inbound Rescan Complete!');
      expect(enOutput).toContain('last 1 hour(s)');
      expect(enOutput).toContain('Push Notifications Evaluated*: 5');
      expect(enOutput).toContain('Emails Scanned*: 10 (2 transactions detected)');
      expect(enOutput).toContain('Pending Tickets Reconciled*: 2');

      const resultEnMixed = {
        durationMinutes: 90,
        notificationsReplayed: 1,
        emailsScanned: 2,
        emailsDetected: 0,
        reconciledPendingCount: 0,
      };
      const enOutputMixed = formatInboundRescanResponse(resultEnMixed, 'en');
      expect(enOutputMixed).toContain('last 90 minutes');
    });
  });

  describe('InboundRescanService execution', () => {
    let mockNotificationStore: any;
    let mockNotificationHandler: any;
    let mockEmailListener: any;
    let mockPendingManager: any;
    let mockCorrelationService: any;
    let mockWalletCacheService: any;
    let mockMessagingGateway: any;
    let mockWalletMcpClient: any;
    let mockTransactionMessageStore: any;
    let mockEnrichmentPoolService: any;

    beforeEach(() => {
      mockNotificationStore = {
        getNotificationsSince: vi.fn().mockReturnValue([]),
      };
      mockNotificationHandler = {
        handleNotificationReceived: vi.fn().mockResolvedValue(undefined),
      };
      mockEmailListener = {
        isConnected: vi.fn().mockReturnValue(true),
        rescanMessages: vi.fn().mockResolvedValue({ scannedUids: 12, detectedCount: 1 }),
      };
      mockPendingManager = {
        hasPendingTransactions: vi.fn().mockReturnValue(false),
        getAllPendingTransactions: vi.fn().mockReturnValue([]),
        getPendingTransactionState: vi.fn().mockReturnValue('PENDING'),
        rejectPendingTransaction: vi.fn().mockReturnValue(undefined),
      };
      mockCorrelationService = {
        correlateEvidence: vi.fn().mockReturnValue({ suggestedAction: 'NONE' }),
      };
      mockWalletCacheService = {
        getAccounts: vi.fn().mockReturnValue([
          { id: 'acc-jago', name: 'Jago Expense', currency: 'IDR' },
        ]),
        getCategories: vi.fn().mockReturnValue([
          { id: 'cat-ojol', name: 'Ojol' },
          { id: 'cat-unknown', name: 'Unknown expense' },
        ]),
      };
      mockMessagingGateway = {
        broadcastNotification: vi.fn().mockResolvedValue(undefined),
      };
      mockWalletMcpClient = {
        fetchRecords: vi.fn().mockResolvedValue({ records: [] }),
        patchRecords: vi.fn().mockResolvedValue(undefined),
      };
      mockTransactionMessageStore = {
        updateMessageMappingsByRecordId: vi.fn(),
      };
      mockEnrichmentPoolService = {
        getAllCandidates: vi.fn().mockReturnValue([]),
        getCandidate: vi.fn().mockReturnValue(undefined),
        removeCandidate: vi.fn(),
      };
    });

    it('replays push notifications within lookback window, skipping companion app test pings', async () => {
      const now = Date.now();
      const storedItems = [
        {
          id: 'notif-1',
          receivedAt: now - 30000,
          payload: {
            packageName: 'com.grabtaxi.passenger',
            title: 'Grab',
            text: 'Pembayaran Rp 65.800 berhasil',
            timestamp: now - 30000,
          } as PushNotificationPayload,
        },
        {
          id: 'notif-test',
          receivedAt: now - 20000,
          payload: {
            packageName: 'codes.churma.walletforwarder',
            title: 'Wallet Forwarder',
            text: 'Test ping',
            isTest: true,
          } as PushNotificationPayload,
        },
      ];

      mockNotificationStore.getNotificationsSince.mockReturnValue(storedItems);

      const service = new InboundRescanService({
        notificationStore: mockNotificationStore,
        notificationHandler: mockNotificationHandler,
        emailListener: mockEmailListener,
        pendingTransactionManager: mockPendingManager,
        correlationService: mockCorrelationService,
        walletCacheService: mockWalletCacheService,
        messagingGateway: mockMessagingGateway,
        walletMcpClient: mockWalletMcpClient,
      });

      const rescanResult = await service.rescanInbound(60);

      expect(mockNotificationStore.getNotificationsSince).toHaveBeenCalled();
      expect(mockNotificationHandler.handleNotificationReceived).toHaveBeenCalledTimes(1);
      expect(mockNotificationHandler.handleNotificationReceived).toHaveBeenCalledWith(
        storedItems[0].payload,
        { skipStoreRecord: true, isReplay: true }
      );
      expect(rescanResult.notificationsReplayed).toBe(1);
    });

    it('triggers email listener rescan with cache bypass when connected', async () => {
      const service = new InboundRescanService({
        notificationStore: mockNotificationStore,
        notificationHandler: mockNotificationHandler,
        emailListener: mockEmailListener,
        pendingTransactionManager: mockPendingManager,
        correlationService: mockCorrelationService,
        walletCacheService: mockWalletCacheService,
        messagingGateway: mockMessagingGateway,
        walletMcpClient: mockWalletMcpClient,
      });

      const rescanResult = await service.rescanInbound(45);

      expect(mockEmailListener.isConnected).toHaveBeenCalled();
      expect(mockEmailListener.rescanMessages).toHaveBeenCalledWith(45, { bypassProcessedCache: true });
      expect(rescanResult.emailsScanned).toBe(12);
      expect(rescanResult.emailsDetected).toBe(1);
    });

    it('skips email rescan when listener is disconnected or null', async () => {
      mockEmailListener.isConnected.mockReturnValue(false);

      const service = new InboundRescanService({
        notificationStore: mockNotificationStore,
        notificationHandler: mockNotificationHandler,
        emailListener: mockEmailListener,
        pendingTransactionManager: mockPendingManager,
        correlationService: mockCorrelationService,
        walletCacheService: mockWalletCacheService,
        messagingGateway: mockMessagingGateway,
        walletMcpClient: mockWalletMcpClient,
      });

      const rescanResult = await service.rescanInbound(60);

      expect(mockEmailListener.rescanMessages).not.toHaveBeenCalled();
      expect(rescanResult.emailsScanned).toBe(0);
      expect(rescanResult.emailsDetected).toBe(0);
    });

    it('reconciles dangling pending queue tickets against existing Wallet MCP records (Grab Rp 65.800 scenario)', async () => {
      // Pending Grab ticket #1
      const pendingTicket = {
        ticketId: 1,
        sourceType: 'PUSH_NOTIFICATION',
        bankDisplayName: 'Grab',
        accountNameHint: 'Jago Expense',
        counterParty: 'Grab',
        amount: -65800,
        currency: 'IDR',
        transactionType: 'EXPENSE',
        matchedAccountId: 'acc-jago',
        matchedCategoryId: 'cat-ojol',
        matchedCategoryName: 'Ojol',
        note: 'GrabCar - Pembayaran',
        recordDate: '2026-11-05T11:32:00.000Z',
        referenceNumber: 'A-AXTLANJGXX2TAV',
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 86400000),
      };

      // Existing generic Bank Jago record in Wallet MCP
      const walletRecord = {
        id: '321f074f-62e6-4319-a34e-f02d82723731',
        accountId: 'acc-jago',
        accountName: 'Jago Expense',
        amount: -65800,
        currency: 'IDR',
        recordDate: '2026-11-05T11:32:00.000Z',
        recordType: 'expense',
        counterParty: 'Pembayaran kartu debit Bank Jago (Merchant)',
        category: { id: 'cat-unknown', name: 'Unknown expense' },
        note: 'Pembayaran kartu debit Bank Jago (Merchant)',
      };

      mockPendingManager.hasPendingTransactions.mockReturnValue(true);
      mockPendingManager.getAllPendingTransactions.mockReturnValue([pendingTicket]);
      mockPendingManager.getPendingTransactionState.mockReturnValue('PENDING');

      mockWalletMcpClient.fetchRecords.mockResolvedValue({ records: [walletRecord] });

      mockCorrelationService.correlateEvidence.mockReturnValue({
        confidence: 'HIGH',
        matchTarget: { type: 'WALLET_RECORD', record: walletRecord },
        suggestedAction: 'ATTACH_WALLET_RECORD',
      });

      const service = new InboundRescanService({
        notificationStore: mockNotificationStore,
        notificationHandler: mockNotificationHandler,
        emailListener: mockEmailListener,
        pendingTransactionManager: mockPendingManager,
        correlationService: mockCorrelationService,
        walletCacheService: mockWalletCacheService,
        messagingGateway: mockMessagingGateway,
        walletMcpClient: mockWalletMcpClient,
        transactionMessageStore: mockTransactionMessageStore,
        enrichmentPoolService: mockEnrichmentPoolService,
      });

      const rescanResult = await service.rescanInbound(60);

      // Verify Wallet MCP record was patched with specific Grab merchant and Ojol category
      expect(mockWalletMcpClient.patchRecords).toHaveBeenCalledTimes(1);
      expect(mockWalletMcpClient.patchRecords).toHaveBeenCalledWith([
        {
          id: '321f074f-62e6-4319-a34e-f02d82723731',
          counterParty: 'Grab',
          categoryId: 'cat-ojol',
          note: 'GrabCar - Pembayaran',
        },
      ]);

      // Verify candidate was pruned from enrichment pool
      expect(mockEnrichmentPoolService.removeCandidate).toHaveBeenCalledWith('321f074f-62e6-4319-a34e-f02d82723731');

      // Verify message store mappings were updated
      expect(mockTransactionMessageStore.updateMessageMappingsByRecordId).toHaveBeenCalledWith(
        '321f074f-62e6-4319-a34e-f02d82723731',
        expect.objectContaining({
          counterParty: 'Grab',
          categoryId: 'cat-ojol',
          categoryName: 'Ojol',
          note: 'GrabCar - Pembayaran',
        })
      );

      // Verify pending ticket #1 was dismissed/rejected
      expect(mockPendingManager.rejectPendingTransaction).toHaveBeenCalledWith(1);

      // Verify notification broadcasted
      expect(mockMessagingGateway.broadcastNotification).toHaveBeenCalledTimes(1);
      expect(mockMessagingGateway.broadcastNotification).toHaveBeenCalledWith(
        expect.stringContaining('Detail Transaksi Diperbarui')
      );

      // Verify summary count
      expect(rescanResult.reconciledPendingCount).toBe(1);
    });

    it('enforces concurrency guard and throws when a rescan is already running', async () => {
      const service = new InboundRescanService({
        notificationStore: mockNotificationStore,
        notificationHandler: mockNotificationHandler,
        emailListener: mockEmailListener,
        pendingTransactionManager: mockPendingManager,
        correlationService: mockCorrelationService,
        walletCacheService: mockWalletCacheService,
        messagingGateway: mockMessagingGateway,
        walletMcpClient: mockWalletMcpClient,
      });

      // Mock notification handler with delay to simulate running rescan
      mockNotificationStore.getNotificationsSince.mockReturnValue([
        {
          id: 'notif-1',
          receivedAt: Date.now(),
          payload: { packageName: 'com.test', title: 'Test', text: 'Text' },
        },
      ]);

      let resolveHandler: any;
      const slowPromise = new Promise(resolve => {
        resolveHandler = resolve;
      });
      mockNotificationHandler.handleNotificationReceived.mockImplementation(() => slowPromise);

      const firstRunPromise = service.rescanInbound(60);
      expect(service.isRunning()).toBe(true);

      // Second concurrent invocation must throw
      await expect(service.rescanInbound(60)).rejects.toThrow('A rescan is already in progress');

      resolveHandler();
      await firstRunPromise;
      expect(service.isRunning()).toBe(false);
    });

    it('handles notification replay handler errors gracefully and continues', async () => {
      mockNotificationStore.getNotificationsSince.mockReturnValue([
        {
          id: 'notif-fail',
          receivedAt: Date.now(),
          payload: { packageName: 'com.fail', title: 'Fail', text: 'Error' },
        },
        {
          id: 'notif-ok',
          receivedAt: Date.now(),
          payload: { packageName: 'com.ok', title: 'Ok', text: 'Success' },
        },
      ]);

      mockNotificationHandler.handleNotificationReceived
        .mockRejectedValueOnce(new Error('Handler crashed'))
        .mockResolvedValueOnce(undefined);

      const service = new InboundRescanService({
        notificationStore: mockNotificationStore,
        notificationHandler: mockNotificationHandler,
        emailListener: mockEmailListener,
        pendingTransactionManager: mockPendingManager,
        correlationService: mockCorrelationService,
        walletCacheService: mockWalletCacheService,
        messagingGateway: mockMessagingGateway,
        walletMcpClient: mockWalletMcpClient,
      });

      const result = await service.rescanInbound(30);
      expect(result.notificationsReplayed).toBe(1);
    });

    it('handles email rescan and pending reconciliation errors gracefully', async () => {
      mockEmailListener.rescanMessages.mockRejectedValue(new Error('IMAP network drop'));
      mockPendingManager.hasPendingTransactions.mockReturnValue(true);
      mockWalletMcpClient.fetchRecords.mockRejectedValue(new Error('MCP server down'));

      const service = new InboundRescanService({
        notificationStore: mockNotificationStore,
        notificationHandler: mockNotificationHandler,
        emailListener: mockEmailListener,
        pendingTransactionManager: mockPendingManager,
        correlationService: mockCorrelationService,
        walletCacheService: mockWalletCacheService,
        messagingGateway: mockMessagingGateway,
        walletMcpClient: mockWalletMcpClient,
      });

      const result = await service.rescanInbound(60);
      expect(result.emailsScanned).toBe(0);
      expect(result.reconciledPendingCount).toBe(0);
    });

    it('handles pending reconciliation with non-pending tickets and non-enrichable records', async () => {
      const ticketProcessing = {
        ticketId: 10,
        sourceType: 'PUSH_NOTIFICATION',
        bankDisplayName: 'Bank',
        accountNameHint: 'Jago Expense',
        counterParty: 'Merchant',
        amount: -50000,
        currency: 'IDR',
        transactionType: 'EXPENSE',
        matchedAccountId: 'acc-jago',
        note: 'Note',
        recordDate: '2026-11-05T10:00:00.000Z',
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 86400000),
      };

      const ticketAlreadySpecific = {
        ticketId: 11,
        sourceType: 'PUSH_NOTIFICATION',
        bankDisplayName: 'Bank',
        accountNameHint: 'Jago Expense',
        counterParty: 'Starbucks',
        amount: -45000,
        currency: 'IDR',
        transactionType: 'EXPENSE',
        matchedAccountId: 'acc-jago',
        matchedCategoryName: 'Ojol',
        note: 'Coffee',
        recordDate: '2026-11-05T10:00:00.000Z',
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 86400000),
      };

      const specificWalletRecord = {
        id: 'rec-specific',
        accountId: 'acc-jago',
        accountName: 'Jago Expense',
        amount: -45000,
        currency: 'IDR',
        recordDate: '2026-11-05T10:00:00.000Z',
        recordType: 'expense',
        counterParty: 'Starbucks',
        category: { id: 'cat-ojol', name: 'Ojol' },
        note: 'Coffee',
      };

      mockPendingManager.hasPendingTransactions.mockReturnValue(true);
      mockPendingManager.getAllPendingTransactions.mockReturnValue([ticketProcessing, ticketAlreadySpecific]);
      mockPendingManager.getPendingTransactionState.mockImplementation((id: number) => {
        return id === 10 ? 'PROCESSING' : 'PENDING';
      });

      mockWalletMcpClient.fetchRecords.mockResolvedValue({ records: [specificWalletRecord] });

      mockCorrelationService.correlateEvidence.mockReturnValue({
        confidence: 'HIGH',
        matchTarget: { type: 'WALLET_RECORD', record: specificWalletRecord },
        suggestedAction: 'ATTACH_WALLET_RECORD',
      });

      const service = new InboundRescanService({
        notificationStore: mockNotificationStore,
        notificationHandler: mockNotificationHandler,
        emailListener: mockEmailListener,
        pendingTransactionManager: mockPendingManager,
        correlationService: mockCorrelationService,
        walletCacheService: mockWalletCacheService,
        messagingGateway: mockMessagingGateway,
        walletMcpClient: mockWalletMcpClient,
        enrichmentPoolService: {
          getAllCandidates: vi.fn().mockReturnValue([
            { recordId: 'pool-1', accountId: 'acc-jago', accountName: 'Jago', amount: -20000, recordDate: '2026-11-05' },
          ]),
          getCandidate: vi.fn().mockReturnValue(undefined),
          removeCandidate: vi.fn(),
        } as any,
      });

      const result = await service.rescanInbound(60);

      // Ticket 10 was PROCESSING so skipped. Ticket 11 was already specific so no patchRecords call, but correlation notification broadcasted and ticket rejected.
      expect(mockWalletMcpClient.patchRecords).not.toHaveBeenCalled();
      expect(mockMessagingGateway.broadcastNotification).toHaveBeenCalledWith(
        expect.stringContaining('Transaksi Sudah Tercatat')
      );
      expect(mockPendingManager.rejectPendingTransaction).toHaveBeenCalledWith(11);
      expect(result.reconciledPendingCount).toBe(1);
    });

    it('handles patchRecords error gracefully during pending reconciliation', async () => {
      const ticketToPatch = {
        ticketId: 20,
        sourceType: 'PUSH_NOTIFICATION',
        bankDisplayName: 'Grab',
        accountNameHint: 'Jago Expense',
        counterParty: 'Grab',
        amount: -65800,
        currency: 'IDR',
        transactionType: 'EXPENSE',
        matchedAccountId: 'acc-jago',
        matchedCategoryName: 'ojol', // lowercase to test case-insensitive match
        note: 'Trip',
        recordDate: '2026-11-05T10:00:00.000Z',
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 86400000),
      };

      const genericRecord = {
        id: 'rec-generic-err',
        accountId: 'acc-jago',
        accountName: 'Jago Expense',
        amount: -65800,
        currency: 'IDR',
        recordDate: '2026-11-05T10:00:00.000Z',
        recordType: 'expense',
        counterParty: 'Merchant',
        category: { id: 'cat-unknown', name: 'Unknown expense' },
        note: 'Pembayaran kartu debit',
      };

      mockPendingManager.hasPendingTransactions.mockReturnValue(true);
      mockPendingManager.getAllPendingTransactions.mockReturnValue([ticketToPatch]);
      mockPendingManager.getPendingTransactionState.mockReturnValue('PENDING');

      mockWalletMcpClient.fetchRecords.mockResolvedValue({ records: [genericRecord] });
      mockWalletMcpClient.patchRecords.mockRejectedValue(new Error('Network timeout'));

      mockCorrelationService.correlateEvidence.mockReturnValue({
        confidence: 'HIGH',
        matchTarget: { type: 'WALLET_RECORD', record: genericRecord },
        suggestedAction: 'ATTACH_WALLET_RECORD',
      });

      const service = new InboundRescanService({
        notificationStore: mockNotificationStore,
        notificationHandler: mockNotificationHandler,
        emailListener: mockEmailListener,
        pendingTransactionManager: mockPendingManager,
        correlationService: mockCorrelationService,
        walletCacheService: mockWalletCacheService,
        messagingGateway: mockMessagingGateway,
        walletMcpClient: mockWalletMcpClient,
        enrichmentPoolService: mockEnrichmentPoolService,
        transactionMessageStore: mockTransactionMessageStore,
      });

      const result = await service.rescanInbound(60);
      expect(mockPendingManager.rejectPendingTransaction).not.toHaveBeenCalled();
      expect(result.reconciledPendingCount).toBe(0);
      expect(mockEnrichmentPoolService.removeCandidate).toHaveBeenCalledWith('rec-generic-err');
    });

    it('returns 0 reconciled when recentRecords is empty or walletMcpClient is missing', async () => {
      mockPendingManager.hasPendingTransactions.mockReturnValue(true);
      mockWalletMcpClient.fetchRecords.mockResolvedValue({ records: [] });

      const service = new InboundRescanService({
        notificationStore: mockNotificationStore,
        notificationHandler: mockNotificationHandler,
        emailListener: mockEmailListener,
        pendingTransactionManager: mockPendingManager,
        correlationService: mockCorrelationService,
        walletCacheService: mockWalletCacheService,
        messagingGateway: mockMessagingGateway,
        walletMcpClient: mockWalletMcpClient,
      });

      const result = await service.rescanInbound(60);
      expect(result.reconciledPendingCount).toBe(0);
    });
  });

  describe('MessageDispatcher /rescan command routing', () => {
    it('handles /rescan command and sends progress and completion messages', async () => {
      const { createTestUserMessageHandler } = await import('./fixtures/testContext.js');
      const messages: string[] = [];
      const gateway = {
        sendTypingPresence: vi.fn().mockResolvedValue(undefined),
        clearTypingPresence: vi.fn().mockResolvedValue(undefined),
        sendMessage: vi.fn(async (_channel: string, _chat: string, message: string) => {
          messages.push(message);
        }),
      };

      const mockRescanService = {
        isRunning: vi.fn().mockReturnValue(false),
        rescanInbound: vi.fn().mockResolvedValue({
          durationMinutes: 30,
          notificationsReplayed: 2,
          emailsScanned: 5,
          emailsDetected: 1,
          reconciledPendingCount: 1,
        }),
      };

      const handler = createTestUserMessageHandler({
        messagingGateway: gateway,
      } as any);

      // Inject rescan service override
      (handler as any).inboundRescanService = mockRescanService;

      await handler.handleIncomingUserMessage({
        channel: 'telegram',
        chatIdentifier: 'chat-1',
        senderIdentifier: 'user-1',
        messageType: 'text',
        textPayload: '/rescan 30',
      } as any);

      expect(mockRescanService.rescanInbound).toHaveBeenCalledWith(
        30,
        expect.objectContaining({ onProgress: expect.any(Function) })
      );
      expect(messages).toHaveLength(2);
      expect(messages[0]).toContain('Memulai rescan transaksi');
      expect(messages[0]).toContain('30 menit');
      expect(messages[1]).toContain('Rescan Transaksi Selesai!');
      expect(messages[1]).toContain('Push Notification Dievaluasi*: 2');
    });

    it('warns user when rescan is already running', async () => {
      const { createTestUserMessageHandler } = await import('./fixtures/testContext.js');
      const messages: string[] = [];
      const gateway = {
        sendTypingPresence: vi.fn().mockResolvedValue(undefined),
        clearTypingPresence: vi.fn().mockResolvedValue(undefined),
        sendMessage: vi.fn(async (_channel: string, _chat: string, message: string) => {
          messages.push(message);
        }),
      };

      const mockRescanService = {
        isRunning: vi.fn().mockReturnValue(true),
        rescanInbound: vi.fn(),
      };

      const handler = createTestUserMessageHandler({
        messagingGateway: gateway,
      } as any);

      (handler as any).inboundRescanService = mockRescanService;

      await handler.handleIncomingUserMessage({
        channel: 'telegram',
        chatIdentifier: 'chat-1',
        senderIdentifier: 'user-1',
        messageType: 'text',
        textPayload: '/rescan',
      } as any);

      expect(mockRescanService.rescanInbound).not.toHaveBeenCalled();
      expect(messages).toHaveLength(1);
      expect(messages[0]).toContain('Proses rescan transaksi sedang berjalan');
    });

    it('presents 2-column duration inline keyboard when /rescan is called without duration in Telegram', async () => {
      const { createTestUserMessageHandler } = await import('./fixtures/testContext.js');
      const sentPayloads: any[] = [];
      const gateway = {
        sendTypingPresence: vi.fn().mockResolvedValue(undefined),
        clearTypingPresence: vi.fn().mockResolvedValue(undefined),
        sendMessage: vi.fn(async (_channel: string, _chat: string, message: string, options?: any) => {
          sentPayloads.push({ message, options });
        }),
      };

      const mockRescanService = {
        isRunning: vi.fn().mockReturnValue(false),
        rescanInbound: vi.fn(),
      };

      const handler = createTestUserMessageHandler({
        messagingGateway: gateway,
      } as any);
      (handler as any).inboundRescanService = mockRescanService;

      await handler.handleIncomingUserMessage({
        channel: 'telegram',
        chatIdentifier: 'chat-1',
        senderIdentifier: 'user-1',
        messageType: 'text',
        textPayload: '/rescan',
      } as any);

      expect(mockRescanService.rescanInbound).not.toHaveBeenCalled();
      expect(sentPayloads).toHaveLength(1);
      expect(sentPayloads[0].message).toContain('Pilih Rentang Waktu Rescan');
      expect(sentPayloads[0].options?.replyMarkup).toBeDefined();
    });

    it('updates progress in real-time via gateway.editMessage', async () => {
      const { createTestUserMessageHandler } = await import('./fixtures/testContext.js');
      const editedMessages: string[] = [];
      const gateway = {
        sendTypingPresence: vi.fn().mockResolvedValue(undefined),
        clearTypingPresence: vi.fn().mockResolvedValue(undefined),
        sendMessage: vi.fn(async () => ({ messageId: 'msg-start-123' })),
        editMessage: vi.fn(async (_chan, _chat, _id, text) => {
          editedMessages.push(text);
          return true;
        }),
      };

      const mockRescanService = {
        isRunning: vi.fn().mockReturnValue(false),
        rescanInbound: vi.fn(async (_minutes: number, options?: any) => {
          await options?.onProgress?.('notifications');
          await options?.onProgress?.('emails');
          await options?.onProgress?.('pending');
          await options?.onProgress?.('completed');
          return {
            durationMinutes: 60,
            notificationsReplayed: 1,
            emailsScanned: 2,
            emailsDetected: 1,
            reconciledPendingCount: 1,
          };
        }),
      };

      const handler = createTestUserMessageHandler({
        messagingGateway: gateway,
      } as any);
      (handler as any).inboundRescanService = mockRescanService;

      await handler.handleIncomingUserMessage({
        channel: 'telegram',
        chatIdentifier: 'chat-1',
        senderIdentifier: 'user-1',
        messageType: 'text',
        textPayload: '/rescan 60m',
      } as any);

      expect(gateway.editMessage).toHaveBeenCalledTimes(4);
      expect(editedMessages[0]).toContain('Memeriksa push notification');
      expect(editedMessages[1]).toContain('Memindai email masuk');
      expect(editedMessages[2]).toContain('Menyelaraskan tiket pending');
      expect(editedMessages[3]).toContain('Selesai');
    });
  });

  describe('NotificationTransactionHandler options and error recovery', () => {
    it('skips storing notification when options.skipStoreRecord is true', async () => {
      const { NotificationTransactionHandler } = await import('../src/core/handlers/inboundHandlers.js');
      const mockStore = {
        recordNotification: vi.fn(),
      };
      const mockGateway = {
        broadcastNotification: vi.fn(),
      };
      const mockCache = {
        getAccounts: vi.fn().mockReturnValue([]),
        getCategories: vi.fn().mockReturnValue([]),
      };
      const mockAi = {
        processEmailTransactionMessage: vi.fn().mockResolvedValue({ isTransaction: false }),
      };

      const handler = new NotificationTransactionHandler(
        mockAi as any,
        mockCache as any,
        {} as any,
        mockGateway as any,
        'IDR',
        {} as any,
        undefined,
        undefined,
        undefined,
        mockStore as any
      );

      // Replay call with skipStoreRecord: true
      await handler.handleNotificationReceived(
        { packageName: 'com.bca', title: 'BCA', text: 'Transfer Rp 50.000' },
        { skipStoreRecord: true, isReplay: true }
      );

      expect(mockStore.recordNotification).not.toHaveBeenCalled();

      // Normal call without options
      await handler.handleNotificationReceived({
        packageName: 'com.bca',
        title: 'BCA',
        text: 'Transfer Rp 50.000',
      });

      expect(mockStore.recordNotification).toHaveBeenCalledTimes(1);
    });

    it('catches notificationStore.recordNotification error and proceeds', async () => {
      const { NotificationTransactionHandler } = await import('../src/core/handlers/inboundHandlers.js');
      const mockStore = {
        recordNotification: vi.fn().mockImplementation(() => {
          throw new Error('Disk full');
        }),
      };
      const mockAi = {
        processEmailTransactionMessage: vi.fn().mockResolvedValue({ isTransaction: false }),
      };

      const handler = new NotificationTransactionHandler(
        mockAi as any,
        { getAccounts: () => [], getCategories: () => [] } as any,
        {} as any,
        { broadcastNotification: vi.fn() } as any,
        'IDR',
        {} as any,
        undefined,
        undefined,
        undefined,
        mockStore as any
      );

      await expect(
        handler.handleNotificationReceived({
          packageName: 'com.bca',
          title: 'BCA',
          text: 'Transfer Rp 50.000',
        })
      ).resolves.not.toThrow();
    });
  });

  describe('EmailListenerService.rescanMessages offline safety', () => {
    it('returns { scannedUids: 0, detectedCount: 0 } when not connected', async () => {
      const { EmailListenerService } = await import('../src/email/listener.js');
      const listener = new EmailListenerService({
        imapHost: 'imap.gmail.com',
        imapPort: 993,
        imapUser: 'test@gmail.com',
        imapPassword: 'password',
        onTransactionDetected: vi.fn(),
      } as any);

      expect(listener.isConnected()).toBe(false);
      const res = await listener.rescanMessages(60);
      expect(res).toEqual({ scannedUids: 0, detectedCount: 0 });
    });
  });
});
