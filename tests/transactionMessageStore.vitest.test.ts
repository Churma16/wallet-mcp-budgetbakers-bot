import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TransactionMessageStore } from '../src/wallet/records/transactionMessageStore.js';

describe('TransactionMessageStore', () => {
  let tempDir: string;
  let storageFile: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msg-store-test-'));
    storageFile = path.join(tempDir, 'message_mappings.json');
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('records, retrieves, and checks existence of message mappings', () => {
    const store = new TransactionMessageStore(storageFile);
    expect(store.hasMapping('msg-101')).toBe(false);

    store.recordMessageMapping('msg-101', {
      recordId: 'rec-12345',
      accountId: 'acc-bca',
      note: 'Kopi Kenangan',
      categoryId: 'cat-food',
      amount: -25000,
    });

    expect(store.hasMapping('msg-101')).toBe(true);
    const retrieved = store.getMessageMapping('msg-101');
    expect(retrieved).toBeDefined();
    expect(retrieved?.recordId).toBe('rec-12345');
    expect(retrieved?.accountId).toBe('acc-bca');
    expect(retrieved?.note).toBe('Kopi Kenangan');
    expect(retrieved?.amount).toBe(-25000);
  });

  it('persists mappings to disk and restores them on re-instantiation', () => {
    const store1 = new TransactionMessageStore(storageFile);
    store1.recordMessageMapping('msg-202', {
      recordId: 'rec-999',
      accountId: 'acc-jago',
      note: 'Kuota XL',
    });

    expect(fs.existsSync(storageFile)).toBe(true);

    const store2 = new TransactionMessageStore(storageFile);
    expect(store2.hasMapping('msg-202')).toBe(true);
    const restored = store2.getMessageMapping('msg-202');
    expect(restored?.recordId).toBe('rec-999');
    expect(restored?.accountId).toBe('acc-jago');
    expect(restored?.note).toBe('Kuota XL');
  });

  it('updates an existing message mapping with partial updates', () => {
    const store = new TransactionMessageStore(storageFile);
    store.recordMessageMapping('msg-303', {
      recordId: 'rec-303',
      accountId: 'acc-bca',
      note: 'Initial Note',
    });

    store.updateMessageMapping('msg-303', {
      note: 'Updated Note',
      categoryId: 'cat-new',
    });

    const updated = store.getMessageMapping('msg-303');
    expect(updated?.note).toBe('Updated Note');
    expect(updated?.categoryId).toBe('cat-new');
    expect(updated?.accountId).toBe('acc-bca');
  });

  it('prunes expired mappings exceeding maxTtlMilliseconds', () => {
    const store1 = new TransactionMessageStore(storageFile, { maxTtlMilliseconds: 100 });
    store1.recordMessageMapping('msg-expire', {
      recordId: 'rec-exp',
      accountId: 'acc-1',
      createdAt: Date.now() - 200, // already expired
    });

    // Calling getMessageMapping removes expired entry
    expect(store1.getMessageMapping('msg-expire')).toBeUndefined();
    expect(store1.hasMapping('msg-expire')).toBe(false);
  });

  it('caps total entries to maxEntries and prunes oldest entries', () => {
    const store = new TransactionMessageStore(storageFile, { maxEntries: 2 });
    const now = Date.now();
    store.recordMessageMapping('msg-1', { recordId: 'rec-1', accountId: 'acc-1', createdAt: now - 3000 });
    store.recordMessageMapping('msg-2', { recordId: 'rec-2', accountId: 'acc-1', createdAt: now - 2000 });
    store.recordMessageMapping('msg-3', { recordId: 'rec-3', accountId: 'acc-1', createdAt: now - 1000 });

    expect(store.size()).toBe(2);
    expect(store.hasMapping('msg-1')).toBe(false); // oldest entry pruned
    expect(store.hasMapping('msg-2')).toBe(true);
    expect(store.hasMapping('msg-3')).toBe(true);
  });

  it('handles corrupted storage file gracefully and creates a corrupted backup', () => {
    fs.writeFileSync(storageFile, '{ invalid json', 'utf-8');
    const store = new TransactionMessageStore(storageFile);
    expect(store.size()).toBe(0);

    const files = fs.readdirSync(tempDir);
    const backupFile = files.find(f => f.includes('.corrupted.'));
    expect(backupFile).toBeDefined();
  });

  it('cleans up temporary files if renameSync fails during saveToStorage', () => {
    const store = new TransactionMessageStore(storageFile);
    const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
      throw new Error('EACCES: permission denied, rename');
    });

    expect(() => {
      store.recordMessageMapping('msg-err', {
        recordId: 'rec-err',
        accountId: 'acc-err',
      });
    }).not.toThrow();

    renameSpy.mockRestore();

    const files = fs.readdirSync(tempDir);
    const lingeringTmp = files.filter(f => f.includes('.tmp.'));
    expect(lingeringTmp).toHaveLength(0);
  });
});
