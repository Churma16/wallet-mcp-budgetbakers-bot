import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PendingTransactionService } from '../src/services/pendingTransactionService.js';
import { buildEmailSystemInstruction, resolveEmailExtractedEntities } from '../src/services/ai/aiPromptBuilder.js';
import { PendingActionHandler } from '../src/handlers/pendingActionHandler.js';
import type { WalletCategoryItem, WalletAccountItem } from '../src/types/walletTypes.js';
import type { WalletCacheService } from '../src/services/walletCacheService.js';
import type { WalletMcpClientService } from '../src/services/walletMcpService.js';
import type { MessagingGatewayService } from '../src/services/messagingGatewayService.js';

describe('Pending Transaction Queue Persistence & Category Safeguards', () => {
  let tempDir: string;
  let storageFile: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pending-persist-test-'));
    storageFile = path.join(tempDir, 'pending_transactions.json');
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe('1. Storage Initialization and Lifecycle Persistence', () => {
    it('initializes cleanly when storage file does not exist', () => {
      const service = new PendingTransactionService(storageFile);
      expect(service.hasPendingTransactions()).toBe(false);
      expect(service.getNextTicketSequentialId()).toBe(1);
    });

    it('sets default TTL to exactly 24 hours (1 day) for new pending transactions and drafts', () => {
      const service = new PendingTransactionService();
      const item = service.addPendingTransaction({
        sourceType: 'EMAIL',
        bankDisplayName: 'Bank Jago',
        accountNameHint: 'Jago Expense',
        counterParty: 'Jago',
        amount: -44000,
        transactionType: 'EXPENSE',
        matchedAccountId: 'acc-1',
        note: 'Kuota XL',
        recordDate: '2026-10-22T03:34:03.000Z',
      });
      const draft = service.addPendingAccountSelectionDraft({
        sourceType: 'USER',
        channel: 'telegram',
        senderIdentifier: 'user-1',
        chatIdentifier: 'chat-1',
        records: [
          {
            accountId: '',
            amount: -25000,
            recordDate: '2026-10-22T04:00:00.000Z',
            note: 'Coffee',
          },
        ],
        pendingRecordIndex: 0,
        accountHint: 'BCA',
        candidateAccounts: [],
      });

      const itemTtl = item.expiresAt.getTime() - item.createdAt.getTime();
      const draftTtl = draft.expiresAt.getTime() - draft.createdAt.getTime();

      // Expect 24 hours in milliseconds (1 day = 86,400,000 ms)
      expect(itemTtl).toBe(24 * 60 * 60 * 1000);
      expect(draftTtl).toBe(24 * 60 * 60 * 1000);
    });

    it('persists a newly registered pending transaction to disk and restores it', () => {
      const service1 = new PendingTransactionService(storageFile);
      const item = service1.addPendingTransaction({
        sourceType: 'EMAIL',
        bankDisplayName: 'Bank Jago',
        accountNameHint: 'Jago Expense',
        counterParty: 'Jago',
        amount: -44000,
        transactionType: 'EXPENSE',
        matchedAccountId: 'acc-1',
        matchedCategoryId: 'cat-internet',
        matchedCategoryName: 'Internet',
        note: 'Kuota Flexmax XL 10 GB',
        recordDate: '2026-10-22T03:34:03.000Z',
      });

      expect(fs.existsSync(storageFile)).toBe(true);

      // Spin up service2 from the persisted file
      const service2 = new PendingTransactionService(storageFile);
      expect(service2.hasPendingTransactions()).toBe(true);
      const restored = service2.getPendingTransaction(item.ticketId);

      expect(restored).toBeDefined();
      expect(restored?.ticketId).toBe(item.ticketId);
      expect(restored?.counterParty).toBe('Jago');
      expect(restored?.amount).toBe(-44000);
      expect(restored?.note).toBe('Kuota Flexmax XL 10 GB');
      expect(restored?.createdAt).toBeInstanceOf(Date);
      expect(restored?.expiresAt).toBeInstanceOf(Date);
      expect(service2.getPendingTransactionState(item.ticketId)).toBe('PENDING');
      expect(service2.getNextTicketSequentialId()).toBe(2);
    });

    it('recovers in-flight PROCESSING tickets back to PENDING on restart', () => {
      const service1 = new PendingTransactionService(storageFile);
      const item = service1.addPendingTransaction({
        sourceType: 'EMAIL',
        bankDisplayName: 'Bank Jago',
        accountNameHint: 'Jago Expense',
        counterParty: 'Jago',
        amount: -44000,
        transactionType: 'EXPENSE',
        matchedAccountId: 'acc-1',
        note: 'Pending Payment',
        recordDate: '2026-10-22T03:34:03.000Z',
      });

      // Process begins claiming ticket
      const claimed = service1.claimPendingTransaction(item.ticketId);
      expect(claimed).toBeDefined();
      expect(service1.isTicketProcessing(item.ticketId)).toBe(true);

      // Bot crashes or restarts -> service2 loads the snapshot
      const service2 = new PendingTransactionService(storageFile);
      expect(service2.isTicketProcessing(item.ticketId)).toBe(false);
      expect(service2.getPendingTransactionState(item.ticketId)).toBe('PENDING');

      // Recovered ticket can be claimed and processed again
      const reclaimed = service2.claimPendingTransaction(item.ticketId);
      expect(reclaimed).toBeDefined();
    });

    it('persists and restores pending account selection drafts', () => {
      const service1 = new PendingTransactionService(storageFile);
      const draft = service1.addPendingAccountSelectionDraft({
        sourceType: 'USER',
        channel: 'telegram',
        senderIdentifier: 'user-1',
        chatIdentifier: 'chat-1',
        records: [
          {
            accountId: '',
            amount: -25000,
            recordDate: '2026-10-22T04:00:00.000Z',
            note: 'Coffee',
          },
        ],
        pendingRecordIndex: 0,
        accountHint: 'BCA',
        candidateAccounts: [
          { id: 'acc-bca-1', name: 'BCA Main', currency: 'IDR' },
          { id: 'acc-bca-2', name: 'BCA Savings', currency: 'IDR' },
        ],
      });

      const service2 = new PendingTransactionService(storageFile);
      const restoredDraft = service2.getPendingAccountSelectionDraft(draft.ticketId);
      expect(restoredDraft).toBeDefined();
      expect(restoredDraft?.candidateAccounts).toHaveLength(2);
      expect(restoredDraft?.records[0].amount).toBe(-25000);
      expect(restoredDraft?.sourceReferenceInstant).toBeInstanceOf(Date);
      expect(service2.getPendingAccountSelectionDraftState(draft.ticketId)).toBe('PENDING');
    });

    it('persists resolution, rejection, and resets nextTicketSequentialId when empty', () => {
      const service1 = new PendingTransactionService(storageFile);
      const item1 = service1.addPendingTransaction({
        sourceType: 'EMAIL',
        bankDisplayName: 'Bank Jago',
        accountNameHint: 'Jago',
        counterParty: 'Merchant A',
        amount: -10000,
        transactionType: 'EXPENSE',
        matchedAccountId: 'acc-1',
        note: 'Item 1',
        recordDate: '2026-10-22T01:00:00Z',
      });
      const item2 = service1.addPendingTransaction({
        sourceType: 'EMAIL',
        bankDisplayName: 'Bank Jago',
        accountNameHint: 'Jago',
        counterParty: 'Merchant B',
        amount: -20000,
        transactionType: 'EXPENSE',
        matchedAccountId: 'acc-1',
        note: 'Item 2',
        recordDate: '2026-10-22T02:00:00Z',
      });

      // Resolve item 1
      service1.resolvePendingTransaction(item1.ticketId);

      const service2 = new PendingTransactionService(storageFile);
      expect(service2.getPendingTransaction(item1.ticketId)).toBeUndefined();
      expect(service2.wasTicketRecentlyResolved(item1.ticketId)).toBe(true);
      expect(service2.getPendingTransaction(item2.ticketId)).toBeDefined();

      // Reject item 2
      service2.rejectPendingTransaction(item2.ticketId);
      expect(service2.hasPendingTransactions()).toBe(false);
      expect(service2.getNextTicketSequentialId()).toBe(1);

      // Verify empty state is saved to disk
      const service3 = new PendingTransactionService(storageFile);
      expect(service3.hasPendingTransactions()).toBe(false);
      expect(service3.getNextTicketSequentialId()).toBe(1);
    });

    it('purges expired tickets automatically on startup', () => {
      const service1 = new PendingTransactionService(storageFile);
      const item = service1.addPendingTransaction({
        sourceType: 'EMAIL',
        bankDisplayName: 'Bank Jago',
        accountNameHint: 'Jago',
        counterParty: 'Expired Merchant',
        amount: -50000,
        transactionType: 'EXPENSE',
        matchedAccountId: 'acc-1',
        note: 'Old Ticket',
        recordDate: '2026-10-20T00:00:00Z',
      });
      const draft = service1.addPendingAccountSelectionDraft({
        sourceType: 'USER',
        channel: 'telegram',
        senderIdentifier: 'user-1',
        chatIdentifier: 'chat-1',
        records: [
          {
            accountId: '',
            amount: -25000,
            recordDate: '2026-10-22T04:00:00.000Z',
            note: 'Coffee',
          },
        ],
        pendingRecordIndex: 0,
        accountHint: 'BCA',
        candidateAccounts: [],
      });

      // Artificially expire both the ticket and the draft in the file
      const raw = JSON.parse(fs.readFileSync(storageFile, 'utf-8'));
      raw.pendingTransactions[0].expiresAt = new Date(Date.now() - 60000).toISOString();
      raw.pendingAccountSelectionDrafts[0].expiresAt = new Date(Date.now() - 60000).toISOString();
      fs.writeFileSync(storageFile, JSON.stringify(raw));

      const service2 = new PendingTransactionService(storageFile);
      expect(service2.getPendingTransaction(item.ticketId)).toBeUndefined();
      expect(service2.getPendingAccountSelectionDraft(draft.ticketId)).toBeUndefined();
      expect(service2.hasPendingTransactions()).toBe(false);
    });

    it('gracefully handles corrupt or empty storage files without crashing', () => {
      fs.writeFileSync(storageFile, 'not-valid-json{{{');
      const serviceCorrupt = new PendingTransactionService(storageFile);
      expect(serviceCorrupt.hasPendingTransactions()).toBe(false);
      expect(serviceCorrupt.getNextTicketSequentialId()).toBe(1);

      // Empty string content
      fs.writeFileSync(storageFile, '   \n  ');
      const serviceEmpty = new PendingTransactionService(storageFile);
      expect(serviceEmpty.hasPendingTransactions()).toBe(false);

      // Non-object primitive JSON
      fs.writeFileSync(storageFile, '12345');
      const servicePrimitive = new PendingTransactionService(storageFile);
      expect(servicePrimitive.hasPendingTransactions()).toBe(false);
    });

    it('creates parent directory recursively when storage directory does not exist', () => {
      const deepPath = path.join(tempDir, 'nested', 'subfolder', 'deep_pending.json');
      const service = new PendingTransactionService(deepPath);
      service.addPendingTransaction({
        sourceType: 'EMAIL',
        bankDisplayName: 'Bank Jago',
        accountNameHint: 'Jago',
        counterParty: 'Merchant X',
        amount: -15000,
        transactionType: 'EXPENSE',
        matchedAccountId: 'acc-1',
        note: 'Deep persistence test',
        recordDate: '2026-10-22T02:00:00Z',
      });

      expect(fs.existsSync(deepPath)).toBe(true);
    });

    it('populates missing dispatchStates on load if absent from snapshot', () => {
      const rawSnapshot = {
        version: 1,
        pendingTransactions: [
          {
            ticketId: 10,
            sourceType: 'EMAIL',
            bankDisplayName: 'Bank Jago',
            accountNameHint: 'Jago',
            counterParty: 'Merchant 10',
            amount: -10000,
            transactionType: 'EXPENSE',
            matchedAccountId: 'acc-1',
            note: 'Ticket 10',
            recordDate: '2026-10-22T01:00:00Z',
            createdAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 60000).toISOString(),
          },
        ],
        pendingAccountSelectionDrafts: [
          {
            ticketId: 11,
            sourceType: 'USER',
            channel: 'telegram',
            senderIdentifier: 'user-1',
            chatIdentifier: 'chat-1',
            records: [
              {
                accountId: '',
                amount: -10000,
                recordDate: '2026-10-22T01:00:00Z',
                note: 'Draft 11',
              },
            ],
            pendingRecordIndex: 0,
            accountHint: 'Jago',
            candidateAccounts: [],
            createdAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 60000).toISOString(),
          },
        ],
        // dispatchStates deliberately omitted
      };
      fs.writeFileSync(storageFile, JSON.stringify(rawSnapshot));

      const service = new PendingTransactionService(storageFile);
      expect(service.getPendingTransactionState(10)).toBe('PENDING');
      expect(service.getPendingAccountSelectionDraftState(11)).toBe('PENDING');
    });

    it('operates completely in-memory when no storageFilePath is provided', () => {
      const memService = new PendingTransactionService();
      const item = memService.addPendingTransaction({
        sourceType: 'EMAIL',
        bankDisplayName: 'Bank Jago',
        accountNameHint: 'Jago',
        counterParty: 'Merchant In-Mem',
        amount: -5000,
        transactionType: 'EXPENSE',
        matchedAccountId: 'acc-1',
        note: 'In-mem only',
        recordDate: '2026-10-22T01:00:00Z',
      });
      expect(memService.getPendingTransaction(item.ticketId)).toBeDefined();
      memService.resolvePendingTransaction(item.ticketId);
      expect(memService.hasPendingTransactions()).toBe(false);
    });

    it('infers nextTicketSequentialId from max existing ticket when missing in snapshot', () => {
      const rawSnapshot = {
        version: 1,
        pendingTransactions: [
          {
            ticketId: 7,
            sourceType: 'EMAIL',
            bankDisplayName: 'Bank Jago',
            accountNameHint: 'Jago',
            counterParty: 'Merchant 7',
            amount: -10000,
            transactionType: 'EXPENSE',
            matchedAccountId: 'acc-1',
            note: 'Ticket 7',
            recordDate: '2026-10-22T01:00:00Z',
            createdAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 60000).toISOString(),
          },
        ],
        pendingAccountSelectionDrafts: [],
        dispatchStates: [[7, 'PENDING']],
        recentlyResolvedTicketIds: [],
      };
      fs.writeFileSync(storageFile, JSON.stringify(rawSnapshot));

      const service = new PendingTransactionService(storageFile);
      expect(service.getNextTicketSequentialId()).toBe(8);
    });

    it('purges recently resolved ticket IDs after TTL expires', () => {
      const service = new PendingTransactionService(storageFile);
      const item = service.addPendingTransaction({
        sourceType: 'EMAIL',
        bankDisplayName: 'Bank Jago',
        accountNameHint: 'Jago',
        counterParty: 'Merchant',
        amount: -10000,
        transactionType: 'EXPENSE',
        matchedAccountId: 'acc-1',
        note: 'TTL check',
        recordDate: '2026-10-22T01:00:00Z',
      });

      service.resolvePendingTransaction(item.ticketId);
      expect(service.wasTicketRecentlyResolved(item.ticketId)).toBe(true);

      // Read snapshot and simulate time travel beyond recentResolvedTtlMilliseconds (10 minutes)
      const snapshot = JSON.parse(fs.readFileSync(storageFile, 'utf-8'));
      snapshot.recentlyResolvedTicketIds = [[item.ticketId, Date.now() - 15 * 60 * 1000]];
      fs.writeFileSync(storageFile, JSON.stringify(snapshot));

      const serviceReloaded = new PendingTransactionService(storageFile);
      expect(serviceReloaded.wasTicketRecentlyResolved(item.ticketId)).toBe(false);
    });

    it('handles saveToStorage errors gracefully without throwing', () => {
      // Use an invalid storage path where parent is a file, preventing writes
      const conflictFile = path.join(tempDir, 'conflict-file');
      fs.writeFileSync(conflictFile, 'blocking file');
      const impossiblePath = path.join(conflictFile, 'impossible', 'pending.json');

      const service = new PendingTransactionService(impossiblePath);
      expect(() => {
        service.addPendingTransaction({
          sourceType: 'EMAIL',
          bankDisplayName: 'Bank Jago',
          accountNameHint: 'Jago',
          counterParty: 'Merchant',
          amount: -10000,
          transactionType: 'EXPENSE',
          matchedAccountId: 'acc-1',
          note: 'Fail write safely',
          recordDate: '2026-10-22T01:00:00Z',
        });
      }).not.toThrow();
    });
  });

  describe('2. System Category Filtering & Safety Safeguards', () => {
    const mockAccounts: WalletAccountItem[] = [
      { id: 'acc-jago', name: 'Jago Expense', currency: 'IDR' },
    ];

    const mockCategories: WalletCategoryItem[] = [
      {
        id: 'cat-internet',
        name: 'Internet',
        isAssignable: true,
        group: { id: 'communication_pc', name: 'PC, Communication' },
      },
      {
        id: 'cat-uncategorized',
        name: 'Uncategorized',
        isAssignable: false,
        group: { id: 'system_categories', name: 'System categories' },
      },
      {
        id: 'cat-transfer',
        name: 'Transfer',
        isAssignable: false,
        group: { id: 'system_categories', name: 'System categories' },
      },
    ];

    it('buildEmailSystemInstruction excludes unassignable system categories from prompt', () => {
      const instruction = buildEmailSystemInstruction(mockAccounts, mockCategories);
      expect(instruction).toContain('Internet');
      expect(instruction).not.toContain('Uncategorized');
      expect(instruction).not.toContain('cat-uncategorized');
      expect(instruction).not.toContain('cat-transfer');
    });

    it('resolveEmailExtractedEntities suppresses system category assignment', () => {
      const resolved = resolveEmailExtractedEntities(
        {
          isTransaction: true,
          transactionType: 'EXPENSE',
          amount: 44000,
          counterParty: 'Jago',
          matchedCategoryId: 'cat-uncategorized',
          note: 'Debit',
          recordDate: '2026-10-22T03:34:03Z',
          explanation: 'Test',
        },
        { passed: true },
        'Debit alert',
        new Date(),
        mockAccounts,
        mockCategories
      );

      // System category must be sanitized to undefined
      expect(resolved.matchedCategoryId).toBeUndefined();
      expect(resolved.matchedCategoryName).toBeUndefined();

      // Resolve by assignable category name
      const resolvedByName = resolveEmailExtractedEntities(
        {
          isTransaction: true,
          transactionType: 'EXPENSE',
          amount: 44000,
          counterParty: 'Jago',
          matchedCategoryId: 'Internet',
          note: 'Debit',
          recordDate: '2026-10-22T03:34:03Z',
          explanation: 'Test',
        },
        { passed: true },
        'Debit alert',
        new Date(),
        mockAccounts,
        mockCategories
      );
      expect(resolvedByName.matchedCategoryId).toBe('cat-internet');
      expect(resolvedByName.matchedCategoryName).toBe('Internet');

      // Resolve by unassignable system category name -> sanitized to undefined
      const resolvedBySystemName = resolveEmailExtractedEntities(
        {
          isTransaction: true,
          transactionType: 'EXPENSE',
          amount: 44000,
          counterParty: 'Jago',
          matchedCategoryId: 'Uncategorized',
          note: 'Debit',
          recordDate: '2026-10-22T03:34:03Z',
          explanation: 'Test',
        },
        { passed: true },
        'Debit alert',
        new Date(),
        mockAccounts,
        mockCategories
      );
      expect(resolvedBySystemName.matchedCategoryId).toBeUndefined();
      expect(resolvedBySystemName.matchedCategoryName).toBeUndefined();

      // Resolve by unknown category name -> sanitized to undefined
      const resolvedByUnknownName = resolveEmailExtractedEntities(
        {
          isTransaction: true,
          transactionType: 'EXPENSE',
          amount: 44000,
          counterParty: 'Jago',
          matchedCategoryId: 'UnknownCategoryXYZ',
          note: 'Debit',
          recordDate: '2026-10-22T03:34:03Z',
          explanation: 'Test',
        },
        { passed: true },
        'Debit alert',
        new Date(),
        mockAccounts,
        mockCategories
      );
      expect(resolvedByUnknownName.matchedCategoryId).toBeUndefined();
      expect(resolvedByUnknownName.matchedCategoryName).toBeUndefined();
    });

    it('buildRecordsForPendingItem sanitizes unassignable categories to undefined before MCP dispatch', () => {
      const mockWalletCache = {
        getCategories: vi.fn(() => mockCategories),
      } as unknown as WalletCacheService;

      const mockClient = {
        createRecords: vi.fn(async () => ({
          summary: { total: 1, succeeded: 1 },
          results: [{ inputIndex: 0, success: true }],
        })),
      } as unknown as WalletMcpClientService;

      const mockGateway = { sendMessage: vi.fn() } as unknown as MessagingGatewayService;
      const pendingService = new PendingTransactionService();

      const handler = new PendingActionHandler(
        pendingService,
        mockClient,
        mockGateway,
        () => null,
        mockWalletCache
      );

      // Directly invoke private buildRecordsForPendingItem via prototype or handlePendingAction
      const buildRecords = (handler as any).buildRecordsForPendingItem.bind(handler);
      const records = buildRecords({
        ticketId: 1,
        sourceType: 'EMAIL',
        bankDisplayName: 'Bank Jago',
        accountNameHint: 'Jago Expense',
        counterParty: 'Jago',
        amount: -44000,
        transactionType: 'EXPENSE',
        matchedAccountId: 'acc-jago',
        matchedCategoryId: 'cat-uncategorized',
        note: 'Kuota XL',
        recordDate: '2026-10-22T03:34:03Z',
        createdAt: new Date(),
        expiresAt: new Date(),
      });

      expect(records).toHaveLength(1);
      expect(records[0].accountId).toBe('acc-jago');
      // Must be undefined so MCP does not fail with categoryId client_error
      expect(records[0].categoryId).toBeUndefined();
      expect(records[0].note).toBe('Kuota XL');
    });
  });
});
