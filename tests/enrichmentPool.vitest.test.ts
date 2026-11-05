import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  EnrichmentPoolService,
  isEligibleForEnrichmentPool,
  DEFAULT_ENRICHMENT_POOL_TTL_MS,
} from '../src/wallet/records/enrichmentPool.js';

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
  });
});
