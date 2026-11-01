import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PendingTransactionService } from '../src/core/pending.js';
import { TicketDispatchState } from '../src/brain/constants.js';
import { buildEmailSystemInstruction } from '../src/brain/prompts/promptEmailTemplate.js';
import { resolveEmailExtractedEntities } from '../src/brain/prompts/prompts.js';
import { PendingActionHandler } from '../src/core/handlers/pendingHandler.js';
import { CategoryClarificationHandler } from '../src/core/handlers/categoryClarificationHandler.js';
import type { WalletCategoryItem, WalletAccountItem } from '../src/wallet/index.js';
import type { WalletCacheService, WalletMcpClientService } from '../src/wallet/index.js';
import type { MessagingGatewayService } from '../src/gateway/index.js';

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
        note: 'Pending transaction',
        recordDate: '2026-10-22T03:34:03.000Z',
      });

      const claimed = service1.claimPendingTransaction(item.ticketId);
      expect(claimed).toBeDefined();
      expect(service1.getPendingTransactionState(item.ticketId)).toBe('PROCESSING');

      // Restoring from storage must reset PROCESSING to PENDING to prevent orphaned tickets
      const service2 = new PendingTransactionService(storageFile);
      expect(service2.getPendingTransactionState(item.ticketId)).toBe('PENDING');
    });

    it('persists updates and enrichment to disk', () => {
      const service1 = new PendingTransactionService(storageFile);
      const item = service1.addPendingTransaction({
        sourceType: 'PUSH_NOTIFICATION',
        bankDisplayName: 'Bank Jago',
        accountNameHint: 'Jago Expense',
        counterParty: 'Tokopedia',
        amount: -50000,
        transactionType: 'EXPENSE',
        matchedAccountId: 'acc-1',
        note: 'Tokopedia order',
        recordDate: '2026-10-22T03:34:03.000Z',
      });

      service1.enrichPendingTransaction(item.ticketId, {
        referenceNumber: 'REF-12345',
        evidenceSources: ['PUSH_NOTIFICATION', 'EMAIL'],
      });

      const service2 = new PendingTransactionService(storageFile);
      const restored = service2.getPendingTransaction(item.ticketId);
      expect(restored?.referenceNumber).toBe('REF-12345');
      expect(restored?.evidenceSources).toEqual(['PUSH_NOTIFICATION', 'EMAIL']);
    });

    it('persists ticket resolution and preserves recently resolved IDs across restarts', () => {
      const service1 = new PendingTransactionService(storageFile);
      const item = service1.addPendingTransaction({
        sourceType: 'EMAIL',
        bankDisplayName: 'BCA',
        accountNameHint: 'BCA',
        counterParty: 'Kopi Kenangan',
        amount: -25000,
        transactionType: 'EXPENSE',
        matchedAccountId: 'acc-bca',
        note: 'Kopi',
        recordDate: '2026-10-22T03:34:03.000Z',
      });

      service1.resolvePendingTransaction(item.ticketId);
      expect(service1.hasPendingTransactions()).toBe(false);
      expect(service1.wasTicketRecentlyResolved(item.ticketId)).toBe(true);

      const service2 = new PendingTransactionService(storageFile);
      expect(service2.hasPendingTransactions()).toBe(false);
      expect(service2.wasTicketRecentlyResolved(item.ticketId)).toBe(true);
    });

    it('preserves UNKNOWN dispatch status across restart without reverting to PENDING', () => {
      const service1 = new PendingTransactionService(storageFile);
      const item = service1.addPendingTransaction({
        sourceType: 'EMAIL',
        bankDisplayName: 'Bank Jago',
        accountNameHint: 'Jago Expense',
        counterParty: 'Jago',
        amount: -10000,
        transactionType: 'EXPENSE',
        matchedAccountId: 'acc-1',
        note: 'Unknown outcome test',
        recordDate: '2026-10-22T03:34:03.000Z',
      });

      service1.markPendingTransactionUnknown(item.ticketId);
      expect(service1.getPendingTransactionState(item.ticketId)).toBe('UNKNOWN');

      const service2 = new PendingTransactionService(storageFile);
      expect(service2.getPendingTransactionState(item.ticketId)).toBe('UNKNOWN');
    });

    it('persists and restores pending account selection drafts, then removes them', () => {
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
        candidateAccounts: [{ id: 'acc-bca', name: 'BCA Everyday', currency: 'IDR' }],
        sourceReferenceInstant: new Date('2026-10-22T04:00:00.000Z'),
      });

      const service2 = new PendingTransactionService(storageFile);
      const restored = service2.getPendingAccountSelectionDraft(draft.ticketId);
      expect(restored).toBeDefined();
      expect(restored?.accountHint).toBe('BCA');
      expect(restored?.candidateAccounts).toHaveLength(1);
      expect(restored?.candidateAccounts[0].id).toBe('acc-bca');
      expect(restored?.sourceReferenceInstant).toBeInstanceOf(Date);

      service2.resolvePendingAccountSelectionDraft(draft.ticketId);
      expect(service2.getPendingAccountSelectionDraft(draft.ticketId)).toBeUndefined();

      const service3 = new PendingTransactionService(storageFile);
      expect(service3.getPendingAccountSelectionDraft(draft.ticketId)).toBeUndefined();
    });

    it('persists and restores category selection drafts, then removes them', () => {
      const service1 = new PendingTransactionService(storageFile);
      const draft = service1.addPendingCategorySelectionDraft({
        sourceType: 'USER',
        channel: 'telegram',
        senderIdentifier: 'user-1',
        chatIdentifier: 'chat-1',
        records: [
          {
            accountId: 'acc-1',
            amount: -50000,
            recordDate: '2026-10-22T04:00:00.000Z',
            note: 'Batagor',
          },
        ],
        pendingRecordIndex: 0,
        categoryHint: 'Cemilan',
        candidateCategories: [{ id: 'cat-snacks', name: 'Makanan Ringan / Cemilan' }],
      });

      const service2 = new PendingTransactionService(storageFile);
      const restored = service2.getPendingCategorySelectionDraft(draft.ticketId);
      expect(restored).toBeDefined();
      expect(restored?.categoryHint).toBe('Cemilan');
      expect(restored?.candidateCategories).toHaveLength(1);
      expect(restored?.candidateCategories[0].id).toBe('cat-snacks');

      service2.resolvePendingCategorySelectionDraft(draft.ticketId);
      expect(service2.getPendingCategorySelectionDraft(draft.ticketId)).toBeUndefined();

      const service3 = new PendingTransactionService(storageFile);
      expect(service3.getPendingCategorySelectionDraft(draft.ticketId)).toBeUndefined();
    });

    it('purges expired transactions and drafts during startup load', () => {
      const service1 = new PendingTransactionService(storageFile);
      const expiredItem = service1.addPendingTransaction({
        sourceType: 'EMAIL',
        bankDisplayName: 'BCA',
        accountNameHint: 'BCA',
        counterParty: 'Past Merchant',
        amount: -50000,
        transactionType: 'EXPENSE',
        matchedAccountId: 'acc-bca',
        note: 'Expired item',
        recordDate: '2026-10-01T00:00:00.000Z',
      });

      const raw = JSON.parse(fs.readFileSync(storageFile, 'utf-8'));
      raw.pendingTransactions[0].expiresAt = new Date(Date.now() - 5000).toISOString();
      fs.writeFileSync(storageFile, JSON.stringify(raw, null, 2), 'utf-8');

      const service2 = new PendingTransactionService(storageFile);
      expect(service2.hasPendingTransactions()).toBe(false);
      expect(service2.getPendingTransaction(expiredItem.ticketId)).toBeUndefined();
    });

    it('safely recovers from invalid date strings in snapshot without NaN dates', () => {
      const malformedSnapshot = {
        version: 1,
        nextTicketSequentialId: 2,
        pendingTransactions: [
          {
            ticketId: 1,
            sourceType: 'EMAIL',
            bankDisplayName: 'BCA',
            accountNameHint: 'BCA',
            counterParty: 'Kopi',
            amount: -25000,
            transactionType: 'EXPENSE',
            matchedAccountId: 'acc-bca',
            note: 'Coffee',
            recordDate: '2026-10-22T03:34:03Z',
            createdAt: 'not-a-valid-date-string',
            expiresAt: 'also-not-a-valid-date',
          },
        ],
        pendingAccountSelectionDrafts: [],
        pendingCategorySelectionDrafts: [],
        dispatchStates: [[1, 'PENDING']],
        recentlyResolvedTicketIds: [],
      };
      fs.writeFileSync(storageFile, JSON.stringify(malformedSnapshot, null, 2), 'utf-8');

      const service = new PendingTransactionService(storageFile);
      const item = service.getPendingTransaction(1);
      expect(item).toBeDefined();
      expect(Number.isNaN(item?.createdAt.getTime())).toBe(false);
      expect(Number.isNaN(item?.expiresAt.getTime())).toBe(false);
    });

    it('avoids sequential ID collision when nextTicketSequentialId is lower than active tickets', () => {
      const collisionSnapshot = {
        version: 1,
        nextTicketSequentialId: 1,
        pendingTransactions: [
          {
            ticketId: 5,
            sourceType: 'EMAIL',
            bankDisplayName: 'BCA',
            accountNameHint: 'BCA',
            counterParty: 'Merchant',
            amount: -30000,
            transactionType: 'EXPENSE',
            matchedAccountId: 'acc-bca',
            note: 'Item 5',
            recordDate: '2026-10-22T03:34:03Z',
          },
        ],
        pendingAccountSelectionDrafts: [],
        pendingCategorySelectionDrafts: [],
        dispatchStates: [[5, 'PENDING']],
        recentlyResolvedTicketIds: [],
      };
      fs.writeFileSync(storageFile, JSON.stringify(collisionSnapshot, null, 2), 'utf-8');

      const service = new PendingTransactionService(storageFile);
      expect(service.getNextTicketSequentialId()).toBe(6);
    });

    it('prunes orphaned dispatch states on restore', () => {
      const snapshotWithOrphans = {
        version: 1,
        nextTicketSequentialId: 2,
        pendingTransactions: [],
        pendingAccountSelectionDrafts: [],
        pendingCategorySelectionDrafts: [],
        dispatchStates: [[999, 'PROCESSING']],
        recentlyResolvedTicketIds: [],
      };
      fs.writeFileSync(storageFile, JSON.stringify(snapshotWithOrphans, null, 2), 'utf-8');

      const service = new PendingTransactionService(storageFile);
      expect(service.getPendingTransactionState(999)).toBeUndefined();
    });

    it('handles corrupted storage file gracefully and creates a corrupted backup', () => {
      fs.writeFileSync(storageFile, '{ invalid json', 'utf-8');
      const service = new PendingTransactionService(storageFile);
      expect(service.hasPendingTransactions()).toBe(false);
      expect(service.getNextTicketSequentialId()).toBe(1);

      const files = fs.readdirSync(tempDir);
      const backupFile = files.find(f => f.includes('.corrupted.'));
      expect(backupFile).toBeDefined();
    });

    it('cleans up temporary files if renameSync fails during saveToStorage', () => {
      const service = new PendingTransactionService(storageFile);
      const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
        throw new Error('EACCES: permission denied, rename');
      });

      expect(() => {
        service.addPendingTransaction({
          sourceType: 'EMAIL',
          bankDisplayName: 'BCA',
          accountNameHint: 'BCA',
          counterParty: 'Merchant',
          amount: -10000,
          transactionType: 'EXPENSE',
          matchedAccountId: 'acc-1',
          note: 'Fail test',
          recordDate: '2026-10-22T03:34:03Z',
        });
      }).not.toThrow();

      renameSpy.mockRestore();

      const files = fs.readdirSync(tempDir);
      const lingeringTmpFiles = files.filter(f => f.includes('.tmp.'));
      expect(lingeringTmpFiles).toHaveLength(0);
    });
  });

  describe('2. Category Safeguards & System Category Filtering', () => {
    const mockAccounts: WalletAccountItem[] = [
      { id: 'acc-jago', name: 'Jago Expense', currency: 'IDR' },
    ];

    const mockCategories: WalletCategoryItem[] = [
      { id: 'cat-internet', name: 'Internet', group: { id: 'utilities', name: 'Utilities' }, isAssignable: true },
      { id: 'cat-food', name: 'Food & Drinks', group: { id: 'food', name: 'Food' }, isAssignable: true },
      { id: 'cat-uncategorized', name: 'Uncategorized', group: { id: 'system_categories', name: 'System' }, isAssignable: false },
      { id: 'cat-transfer', name: 'Transfer', group: { id: 'system_categories', name: 'System' }, isAssignable: false },
    ];

    it('buildEmailSystemInstruction excludes unassignable system categories', () => {
      const instruction = buildEmailSystemInstruction(mockAccounts, mockCategories);
      expect(instruction).toContain('Internet');
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

      // Assignable category works normally
      const resolvedValid = resolveEmailExtractedEntities(
        {
          isTransaction: true,
          transactionType: 'EXPENSE',
          amount: 44000,
          counterParty: 'Jago',
          matchedCategoryId: 'cat-internet',
          note: 'Internet bill',
          recordDate: '2026-10-22T03:34:03Z',
          explanation: 'Test',
        },
        { passed: true },
        'Debit alert',
        new Date(),
        mockAccounts,
        mockCategories
      );
      expect(resolvedValid.matchedCategoryId).toBe('cat-internet');
      expect(resolvedValid.matchedCategoryName).toBe('Internet');
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
      expect(records[0].categoryId).toBeUndefined();
      expect(records[0].note).toBe('Kuota XL');
    });

    it('resolveEmailExtractedEntities normalizes empty and whitespace-only matchedCategoryId to undefined', () => {
      const resolvedEmpty = resolveEmailExtractedEntities(
        {
          isTransaction: true,
          transactionType: 'EXPENSE',
          amount: 44000,
          counterParty: 'Jago',
          matchedCategoryId: '',
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
      expect(resolvedEmpty.matchedCategoryId).toBeUndefined();
      expect(resolvedEmpty.matchedCategoryName).toBeUndefined();

      const resolvedWhitespace = resolveEmailExtractedEntities(
        {
          isTransaction: true,
          transactionType: 'EXPENSE',
          amount: 44000,
          counterParty: 'Jago',
          matchedCategoryId: '   ',
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
      expect(resolvedWhitespace.matchedCategoryId).toBeUndefined();
      expect(resolvedWhitespace.matchedCategoryName).toBeUndefined();
    });

    it('CategoryClarificationHandler.buildCandidateCategories excludes system categories from candidates', () => {
      const handler = new CategoryClarificationHandler(
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any
      );

      const candidates = handler.buildCandidateCategories(
        {
          index: 0,
          field: 'categoryId',
          hint: 'internet',
          candidates: [
            { id: 'cat-uncategorized', name: 'Uncategorized' },
            { id: 'cat-internet', name: 'Internet' },
          ],
        },
        mockCategories
      );

      expect(candidates).toHaveLength(1);
      expect(candidates[0].id).toBe('cat-internet');
    });
  });
});
