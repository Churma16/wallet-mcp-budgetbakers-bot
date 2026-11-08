import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  InboundReferenceRegistry,
  normalizeReferenceNumber,
} from '../src/core/referenceRegistry.js';

describe('InboundReferenceRegistry', () => {
  let tempDir: string;
  let storageFile: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ref-registry-test-'));
    storageFile = path.join(tempDir, 'inbound_references.json');
    InboundReferenceRegistry.resetInstance();
  });

  afterEach(() => {
    InboundReferenceRegistry.resetInstance();
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe('normalizeReferenceNumber', () => {
    it('normalizes string references correctly', () => {
      expect(normalizeReferenceNumber('  abc-123  ')).toBe('ABC-123');
      expect(normalizeReferenceNumber(null)).toBe('');
      expect(normalizeReferenceNumber(undefined)).toBe('');
      expect(normalizeReferenceNumber('')).toBe('');
    });
  });

  describe('Singleton Pattern', () => {
    it('returns the same instance and resets properly', () => {
      const inst1 = InboundReferenceRegistry.getInstance();
      const inst2 = InboundReferenceRegistry.getInstance();
      expect(inst1).toBe(inst2);

      InboundReferenceRegistry.resetInstance();
      const inst3 = InboundReferenceRegistry.getInstance();
      expect(inst3).not.toBe(inst1);
    });
  });

  describe('Recording and Retrieving References', () => {
    it('ignores invalid, short, or unknown reference numbers', () => {
      const registry = new InboundReferenceRegistry(storageFile);
      registry.recordReference('');
      registry.recordReference('  ');
      registry.recordReference('AB');
      registry.recordReference('unknown');
      registry.recordReference('UNKNOWN');

      expect(registry.size()).toBe(0);
      expect(registry.getAllReferences()).toEqual([]);
    });

    it('records valid reference and merges metadata on updates', () => {
      const registry = new InboundReferenceRegistry(storageFile);
      registry.recordReference('GF-12345', {
        source: 'EMAIL',
        amount: 50000,
        currency: 'IDR',
        accountId: 'acc-jago',
      });

      expect(registry.hasReference('gf-12345')).toBe(true);
      expect(registry.size()).toBe(1);

      const entry = registry.getReference('GF-12345');
      expect(entry).toBeDefined();
      expect(entry?.reference).toBe('GF-12345');
      expect(entry?.source).toBe('EMAIL');
      expect(entry?.amount).toBe(50000);
      expect(entry?.currency).toBe('IDR');
      expect(entry?.accountId).toBe('acc-jago');

      // Update with recordId & ticketId
      registry.recordReference('gf-12345', {
        recordId: 'rec-wal-1',
        ticketId: 42,
      });

      const updated = registry.getReference('GF-12345');
      expect(updated?.recordId).toBe('rec-wal-1');
      expect(updated?.ticketId).toBe(42);
      expect(updated?.source).toBe('EMAIL'); // preserved
      expect(updated?.amount).toBe(50000); // preserved

      expect(registry.getRecordIdForReference('gf-12345')).toBe('rec-wal-1');
      expect(registry.getTicketIdForReference('gf-12345')).toBe(42);
    });

    it('records multiple references at once via recordReferences', () => {
      const registry = new InboundReferenceRegistry(storageFile);
      registry.recordReferences(['REF-1', 'REF-2', 'REF-3'], {
        source: 'NOTIFICATION',
        ticketId: 99,
      });

      expect(registry.size()).toBe(3);
      expect(registry.hasReference('REF-1')).toBe(true);
      expect(registry.hasReference('REF-2')).toBe(true);
      expect(registry.hasReference('REF-3')).toBe(true);
      expect(registry.getTicketIdForReference('REF-2')).toBe(99);

      // Handle non-array or empty safely
      registry.recordReferences([] as any);
      registry.recordReferences(null as any);
      expect(registry.size()).toBe(3);
    });

    it('returns false/undefined for non-existent or null references', () => {
      const registry = new InboundReferenceRegistry(storageFile);
      expect(registry.hasReference(null)).toBe(false);
      expect(registry.hasReference('NON-EXISTENT')).toBe(false);
      expect(registry.getReference(null)).toBeUndefined();
      expect(registry.getReference('NON-EXISTENT')).toBeUndefined();
      expect(registry.getRecordIdForReference(null)).toBeUndefined();
      expect(registry.getTicketIdForReference(null)).toBeUndefined();
    });

    it('clears all references', () => {
      const registry = new InboundReferenceRegistry(storageFile);
      registry.recordReference('REF-A');
      registry.recordReference('REF-B');
      expect(registry.size()).toBe(2);

      registry.clear();
      expect(registry.size()).toBe(0);
      expect(registry.getAllReferences()).toEqual([]);
    });
  });

  describe('Expiration and Capacity Pruning', () => {
    it('prunes expired references upon lookup', () => {
      const registry = new InboundReferenceRegistry(storageFile, { ttlMs: 50 });
      registry.recordReference('EXP-1', { ttlMs: 10 });

      // Artificial wait or advance
      const now = Date.now();
      const entry = (registry as any).referencesMap.get('EXP-1');
      if (entry) {
        entry.expiresAt = now - 1000;
      }

      expect(registry.hasReference('EXP-1')).toBe(false);
      expect(registry.getReference('EXP-1')).toBeUndefined();
      expect(registry.size()).toBe(0);
    });

    it('prunes excess references when exceeding maxEntries (FIFO by recordedAt)', () => {
      const registry = new InboundReferenceRegistry(storageFile, { maxEntries: 3 });
      const baseTime = 1000000;

      registry.recordReference('ITEM-1');
      registry.recordReference('ITEM-2');
      registry.recordReference('ITEM-3');

      // Adjust recordedAt timestamps
      (registry as any).referencesMap.get('ITEM-1').recordedAt = baseTime;
      (registry as any).referencesMap.get('ITEM-2').recordedAt = baseTime + 10;
      (registry as any).referencesMap.get('ITEM-3').recordedAt = baseTime + 20;

      expect(registry.size()).toBe(3);

      // Add 4th item, exceeding capacity of 3
      registry.recordReference('ITEM-4');
      (registry as any).referencesMap.get('ITEM-4').recordedAt = baseTime + 30;
      registry.pruneExpired();

      expect(registry.size()).toBe(3);
      expect(registry.hasReference('ITEM-1')).toBe(false); // oldest removed
      expect(registry.hasReference('ITEM-2')).toBe(true);
      expect(registry.hasReference('ITEM-3')).toBe(true);
      expect(registry.hasReference('ITEM-4')).toBe(true);
    });
  });

  describe('Disk Persistence and Fault Tolerance', () => {
    it('persists references to disk and reloads on instantiation', () => {
      const registry1 = new InboundReferenceRegistry(storageFile);
      registry1.recordReference('DISK-REF-1', { recordId: 'rec-d1', amount: 15000 });
      registry1.recordReference('DISK-REF-2', { recordId: 'rec-d2', amount: 25000 });

      expect(fs.existsSync(storageFile)).toBe(true);

      const registry2 = new InboundReferenceRegistry(storageFile);
      expect(registry2.size()).toBe(2);
      expect(registry2.getRecordIdForReference('DISK-REF-1')).toBe('rec-d1');
      expect(registry2.getRecordIdForReference('DISK-REF-2')).toBe('rec-d2');
    });

    it('gracefully handles corrupted snapshot JSON', () => {
      fs.writeFileSync(storageFile, '{ invalid-json', 'utf-8');
      const registry = new InboundReferenceRegistry(storageFile);
      expect(registry.size()).toBe(0);
    });

    it('gracefully catches saveToStorage errors', () => {
      const registry = new InboundReferenceRegistry(storageFile);
      const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
        throw new Error('EACCES: permission denied');
      });

      expect(() => {
        registry.recordReference('SAFE-REF');
      }).not.toThrow();

      renameSpy.mockRestore();
    });
  });
});
