import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  EnrichmentPoolService,
  isEligibleForEnrichmentPool,
  DEFAULT_ENRICHMENT_POOL_TTL_MS,
} from '../src/wallet/records/enrichmentPool.js';
import { TransactionMessageStore } from '../src/wallet/records/transactionMessageStore.js';
import { formatRetroactivelyEnrichedWalletRecordNotification } from '../src/wallet/formatters/humanResponseFormatter.js';
import { PendingActionHandler } from '../src/core/handlers/pendingHandler.js';
import { PendingTransactionService } from '../src/core/pending.js';

describe('EnrichmentPoolService and Eligibility', () => {
  let tempDir: string;
  let tempStoragePath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'enrichment-pool-test-'));
    tempStoragePath = path.join(tempDir, 'enrichment_pool.json');
  });

  afterEach(() => {
    try {
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    } catch {}
  });

  describe('isEligibleForEnrichmentPool', () => {
    it('returns true for generic merchant names', () => {
      expect(isEligibleForEnrichmentPool({
        counterParty: 'Merchant',
        categoryName: 'Makanan',
        categoryId: 'cat-food',
        note: 'Makan siang di resto',
      })).toBe(true);

      expect(isEligibleForEnrichmentPool({
        counterParty: 'Bank Jago',
        categoryName: 'Transportasi',
        categoryId: 'cat-transport',
        note: 'Naik taksi',
      })).toBe(true);
    });

    it('returns true for generic or missing category', () => {
      expect(isEligibleForEnrichmentPool({
        counterParty: 'Grab',
        categoryName: 'Unknown expense',
        categoryId: 'cat-unknown',
        note: 'GrabCar kantor',
      })).toBe(true);

      expect(isEligibleForEnrichmentPool({
        counterParty: 'Tokopedia',
        categoryName: undefined,
        categoryId: undefined,
        note: 'Beli kabel',
      })).toBe(true);

      expect(isEligibleForEnrichmentPool({
        counterParty: 'Shopee',
        categoryName: 'Lain-lain',
        categoryId: 'cat-other',
        note: 'Beli aksesoris',
      })).toBe(true);
    });

    it('returns true for boilerplate bank notes', () => {
      expect(isEligibleForEnrichmentPool({
        counterParty: 'Grab',
        categoryName: 'Ojol',
        categoryId: 'cat-ojol',
        note: 'Pembayaran kartu debit Bank Jago',
      })).toBe(true);

      expect(isEligibleForEnrichmentPool({
        counterParty: 'Grab',
        categoryName: 'Ojol',
        categoryId: 'cat-ojol',
        note: 'Pembayaran QRIS',
      })).toBe(true);

      expect(isEligibleForEnrichmentPool({
        counterParty: 'SHOPEE.CO.ID',
        categoryName: 'Financial expenses',
        categoryId: 'cat-fin',
        note: 'Debit card payment • Debit card transaction of Rp51.612 using Jago debit card',
      })).toBe(true);
    });

    it('returns true for online platform and web domain counterparties', () => {
      expect(isEligibleForEnrichmentPool({
        counterParty: 'SHOPEE.CO.ID',
        categoryName: 'Shopping',
        categoryId: 'cat-shop',
        note: 'Pembelian barang',
      })).toBe(true);

      expect(isEligibleForEnrichmentPool({
        counterParty: 'BLIBLI.COM',
        categoryName: 'Shopping',
        categoryId: 'cat-shop',
        note: 'Belanja online',
      })).toBe(true);
    });

    it('returns false when merchant, category, and note are all specific', () => {
      expect(isEligibleForEnrichmentPool({
        counterParty: 'Starbucks Reserve Thamrin',
        categoryName: 'Kopi & Minuman',
        categoryId: 'cat-beverage',
        note: '1x Caramel Macchiato Venti oat milk',
      })).toBe(false);
    });
  });

  describe('EnrichmentPoolService CRUD and Lifecycle', () => {
    it('adds and retrieves active candidates', () => {
      const pool = new EnrichmentPoolService(tempStoragePath);
      pool.addCandidate({
        recordId: 'rec-123',
        accountId: 'acc-jago',
        accountName: 'Jago Expense',
        amount: -65800,
        currency: 'IDR',
        recordDate: '2026-11-05T18:32:00.000Z',
        counterParty: 'Merchant',
        note: 'Pembayaran kartu debit Bank Jago (Merchant)',
        categoryName: 'Unknown expense',
      });

      expect(pool.size()).toBe(1);
      const retrieved = pool.getCandidate('rec-123');
      expect(retrieved).toBeDefined();
      expect(retrieved?.recordId).toBe('rec-123');
      expect(retrieved?.counterParty).toBe('Merchant');
      expect(retrieved?.amount).toBe(-65800);
    });

    it('persists candidates to disk and reloads on startup', () => {
      const pool1 = new EnrichmentPoolService(tempStoragePath);
      pool1.addCandidate({
        recordId: 'rec-persist-1',
        accountId: 'acc-1',
        amount: -50000,
        recordDate: '2026-11-05T10:00:00.000Z',
        counterParty: 'Merchant',
      });

      expect(fs.existsSync(tempStoragePath)).toBe(true);

      const pool2 = new EnrichmentPoolService(tempStoragePath);
      expect(pool2.size()).toBe(1);
      const item = pool2.getCandidate('rec-persist-1');
      expect(item).toBeDefined();
      expect(item?.amount).toBe(-50000);
    });

    it('removes candidate on deletion', () => {
      const pool = new EnrichmentPoolService(tempStoragePath);
      pool.addCandidate({
        recordId: 'rec-del',
        accountId: 'acc-1',
        amount: -10000,
        recordDate: '2026-11-05T10:00:00.000Z',
      });

      expect(pool.removeCandidate('rec-del')).toBe(true);
      expect(pool.getCandidate('rec-del')).toBeUndefined();
      expect(pool.removeCandidate('rec-del')).toBe(false);
    });

    it('updates candidate fields in place and persists', () => {
      const pool = new EnrichmentPoolService(tempStoragePath);
      pool.addCandidate({
        recordId: 'rec-upd',
        accountId: 'acc-1',
        amount: -25000,
        recordDate: '2026-11-05T10:00:00.000Z',
      });

      pool.updateCandidate('rec-upd', {
        notificationMessageIds: { telegram: 'msg-999' },
        counterParty: 'Updated Merchant',
      });

      const updated = pool.getCandidate('rec-upd');
      expect(updated?.notificationMessageIds).toEqual({ telegram: 'msg-999' });
      expect(updated?.counterParty).toBe('Updated Merchant');
    });

    it('prunes expired entries based on TTL', () => {
      const pool = new EnrichmentPoolService(tempStoragePath, { maxTtlMilliseconds: 50 });
      pool.addCandidate({
        recordId: 'rec-expired',
        accountId: 'acc-1',
        amount: -15000,
        recordDate: '2026-11-05T10:00:00.000Z',
        ttlMs: 10,
        createdAt: Date.now() - 100, // already in the past
      });

      expect(pool.getCandidate('rec-expired')).toBeUndefined();
      expect(pool.getAllCandidates()).toHaveLength(0);
    });

    it('caps maximum entries by pruning oldest entries', () => {
      const now = Date.now();
      const pool = new EnrichmentPoolService(tempStoragePath, { maxEntries: 2 });
      pool.addCandidate({
        recordId: 'rec-1',
        accountId: 'acc-1',
        amount: -1000,
        recordDate: '2026-11-05T10:00:00.000Z',
        createdAt: now - 3000,
      });
      pool.addCandidate({
        recordId: 'rec-2',
        accountId: 'acc-1',
        amount: -2000,
        recordDate: '2026-11-05T10:01:00.000Z',
        createdAt: now - 2000,
      });
      pool.addCandidate({
        recordId: 'rec-3',
        accountId: 'acc-1',
        amount: -3000,
        recordDate: '2026-11-05T10:02:00.000Z',
        createdAt: now - 1000,
      });

      expect(pool.size()).toBe(2);
      expect(pool.getCandidate('rec-1')).toBeUndefined(); // oldest pruned
      expect(pool.getCandidate('rec-2')).toBeDefined();
      expect(pool.getCandidate('rec-3')).toBeDefined();
    });

    it('finds matching candidates by amount, currency, account, and timestamp', () => {
      const pool = new EnrichmentPoolService(tempStoragePath);
      pool.addCandidate({
        recordId: 'rec-grab',
        accountId: 'acc-jago',
        amount: -65800,
        currency: 'IDR',
        recordDate: '2026-11-05T18:32:00.000Z',
        counterParty: 'Merchant',
      });

      // 1. Matches when evidence aligns
      const match = pool.findMatchingCandidate({
        sourceType: 'EMAIL_PAYMENT',
        amount: -65800,
        currency: 'IDR',
        occurredAt: '2026-11-05T19:21:00.000Z',
        accountId: 'acc-jago',
      });
      expect(match?.recordId).toBe('rec-grab');

      // 2. Matches when evidence account is cash fallback
      const cashMatch = pool.findMatchingCandidate({
        sourceType: 'EMAIL_PAYMENT',
        amount: -65800,
        currency: 'IDR',
        occurredAt: '2026-11-05T19:21:00.000Z',
        accountId: 'acc-cash',
      });
      expect(cashMatch?.recordId).toBe('rec-grab');

      // 3. Fails when amount differs
      const amountMismatch = pool.findMatchingCandidate({
        sourceType: 'EMAIL_PAYMENT',
        amount: -70000,
        currency: 'IDR',
        occurredAt: '2026-11-05T19:21:00.000Z',
        accountId: 'acc-jago',
      });
      expect(amountMismatch).toBeUndefined();

      // 4. Fails when currency differs
      const currencyMismatch = pool.findMatchingCandidate({
        sourceType: 'EMAIL_PAYMENT',
        amount: -65800,
        currency: 'USD',
        occurredAt: '2026-11-05T19:21:00.000Z',
        accountId: 'acc-jago',
      });
      expect(currencyMismatch).toBeUndefined();

      // 5. Fails when distinct non-cash account differs
      const accountMismatch = pool.findMatchingCandidate({
        sourceType: 'EMAIL_PAYMENT',
        amount: -65800,
        currency: 'IDR',
        occurredAt: '2026-11-05T19:21:00.000Z',
        accountId: 'acc-mandiri',
      });
      expect(accountMismatch).toBeUndefined();

      // 6. Fails when time exceeds max difference
      const timeMismatch = pool.findMatchingCandidate({
        sourceType: 'EMAIL_PAYMENT',
        amount: -65800,
        currency: 'IDR',
        occurredAt: '2026-11-10T18:32:00.000Z',
        accountId: 'acc-jago',
      });
      expect(timeMismatch).toBeUndefined();
    });

    it('rejects candidates when evidence or stored recordDate is malformed (NaN)', () => {
      const pool = new EnrichmentPoolService(tempStoragePath);
      pool.addCandidate({
        recordId: 'rec-valid-date',
        accountId: 'acc-jago',
        amount: -50000,
        currency: 'IDR',
        recordDate: '2026-11-05T18:32:00.000Z',
        counterParty: 'Merchant',
      });
      pool.addCandidate({
        recordId: 'rec-invalid-date',
        accountId: 'acc-jago',
        amount: -75000,
        currency: 'IDR',
        recordDate: 'not-a-valid-date',
        counterParty: 'Merchant',
      });

      const invalidEvidenceDateMatch = pool.findMatchingCandidate({
        sourceType: 'EMAIL_PAYMENT',
        amount: -50000,
        currency: 'IDR',
        occurredAt: 'invalid-occurred-at',
        accountId: 'acc-jago',
      });
      expect(invalidEvidenceDateMatch).toBeUndefined();

      const invalidItemDateMatch = pool.findMatchingCandidate({
        sourceType: 'EMAIL_PAYMENT',
        amount: -75000,
        currency: 'IDR',
        occurredAt: '2026-11-05T18:32:00.000Z',
        accountId: 'acc-jago',
      });
      expect(invalidItemDateMatch).toBeUndefined();
    });

    it('clears pool completely', () => {
      const pool = new EnrichmentPoolService(tempStoragePath);
      pool.addCandidate({
        recordId: 'rec-c1',
        accountId: 'acc-1',
        amount: -1000,
        recordDate: '2026-11-05T10:00:00.000Z',
      });
      expect(pool.size()).toBe(1);
      pool.clear();
      expect(pool.size()).toBe(0);
      expect(pool.getAllCandidates()).toHaveLength(0);
    });
  });

  describe('TransactionMessageStore Record-Id Queries', () => {
    it('finds and updates message mappings by record ID', () => {
      const messageStorePath = path.join(tempDir, 'messages.json');
      const store = new TransactionMessageStore(messageStorePath);

      store.recordMessageMapping('msg-100', {
        recordId: 'rec-target-1',
        accountId: 'acc-jago',
        amount: -50000,
        currency: 'IDR',
        recordDate: '2026-11-05T10:00:00.000Z',
        counterParty: 'Merchant',
      });

      const found = store.findMessageMappingsByRecordId('rec-target-1');
      expect(found).toHaveLength(1);
      expect(found[0].messageId).toBe('msg-100');
      expect(found[0].mapping.counterParty).toBe('Merchant');

      expect(store.findMessageMappingsByRecordId('non-existent')).toHaveLength(0);

      store.updateMessageMappingsByRecordId('rec-target-1', {
        counterParty: 'Starbucks',
        categoryName: 'Kopi',
      });

      const updated = store.getMessageMapping('msg-100');
      expect(updated?.counterParty).toBe('Starbucks');
      expect(updated?.categoryName).toBe('Kopi');
    });
  });

  describe('HumanResponseFormatter Retroactive Enrichment Formatting', () => {
    it('formats English retroactive notification correctly', () => {
      const formattedEn = formatRetroactivelyEnrichedWalletRecordNotification({
        recordId: 'rec-en-1',
        merchant: 'Uber',
        amount: -25.5,
        currency: 'USD',
        categoryName: 'Rideshare',
        accountName: 'Chase Sapphire',
        note: 'Ride to airport',
        languageCode: 'en',
      });

      expect(formattedEn).toContain('successfully updated!');
      expect(formattedEn).toContain('Uber');
      expect(formattedEn).toContain('Chase Sapphire');
      expect(formattedEn).toContain('Rideshare');
      expect(formattedEn).toContain('Ride to airport');
    });
  });

  describe('PendingActionHandler Integration with EnrichmentPool', () => {
    it('adds confirmed transaction with generic details to enrichment pool and updates notificationMessageIds', async () => {
      const pool = new EnrichmentPoolService(tempStoragePath);
      const pending = new PendingTransactionService();
      const messageStorePath = path.join(tempDir, 'handler_messages.json');
      const messageStore = new TransactionMessageStore(messageStorePath);

      const ticket = pending.addPendingTransaction({
        sourceType: 'PUSH_NOTIFICATION',
        bankDisplayName: 'Bank Jago',
        accountNameHint: 'Jago Expense',
        counterParty: 'Merchant',
        amount: -65800,
        currency: 'IDR',
        transactionType: 'EXPENSE',
        matchedAccountId: 'acc-jago',
        matchedCategoryId: 'cat-unknown',
        matchedCategoryName: 'Unknown expense',
        note: 'Pembayaran kartu debit',
        recordDate: '2026-11-05T18:32:00.000Z',
      });

      const mockMcpClient = {
        createRecords: vi.fn().mockResolvedValue({
          results: [{ id: 'rec-created-456' }],
        }),
      };

      const mockGateway = {
        sendMessage: vi.fn().mockResolvedValue({ messageId: 'tg-msg-777' }),
      };

      const handler = new PendingActionHandler(
        pending,
        mockMcpClient as any,
        mockGateway as any,
        () => null,
        undefined,
        messageStore,
        undefined,
        undefined,
        pool
      );

      await handler.handlePendingAction(
        {
          channel: 'telegram',
          chatIdentifier: '12345',
          senderIdentifier: 'user-1',
          messageText: 'Ya 1',
        } as any,
        {
          actionType: 'CONFIRM',
          targetScope: ticket.ticketId,
        } as any,
        Date.now()
      );

      expect(pool.size()).toBe(1);
      const poolItem = pool.getCandidate('rec-created-456');
      expect(poolItem).toBeDefined();
      expect(poolItem?.counterParty).toBe('Merchant');
      expect(poolItem?.notificationMessageIds).toEqual({ telegram: 'tg-msg-777' });
    });
  });
});
