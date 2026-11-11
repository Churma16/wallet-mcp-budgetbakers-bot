import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadEnvironmentConfiguration } from '../src/config/environmentConfig.js';

describe('Data Persistence & Storage Configuration', () => {
  let tempBaseDir: string;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    tempBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wallet-mcp-persist-test-'));
  });

  afterEach(() => {
    process.env = originalEnv;
    try {
      fs.rmSync(tempBaseDir, { recursive: true, force: true });
    } catch {}
  });

  it('defaults dataStoragePath to ./data and roots storage paths within it', () => {
    delete process.env.DATA_STORAGE_PATH;
    delete process.env.DATA_DIR;
    delete process.env.PENDING_TRANSACTIONS_STORAGE_PATH;
    delete process.env.TRANSACTION_MESSAGE_STORAGE_PATH;
    delete process.env.ENRICHMENT_POOL_STORAGE_PATH;
    delete process.env.INBOUND_NOTIFICATION_STORAGE_PATH;
    delete process.env.INBOUND_REFERENCE_REGISTRY_STORAGE_PATH;

    const config = loadEnvironmentConfiguration();
    expect(config.dataStoragePath).toBe('./data');
    expect(config.pendingTransactionsStoragePath).toBe(path.join('./data', 'pending_transactions.json'));
    expect(config.transactionMessageStoragePath).toBe(path.join('./data', 'transaction_message_mappings.json'));
    expect(config.enrichmentPoolStoragePath).toBe(path.join('./data', 'enrichment_pool.json'));
    expect(config.inboundNotificationStoragePath).toBe(path.join('./data', 'inbound_notifications.json'));
    expect(config.inboundReferenceRegistryStoragePath).toBe(path.join('./data', 'inbound_references.json'));
  });

  it('respects DATA_STORAGE_PATH env var', () => {
    const customDataDir = path.join(tempBaseDir, 'custom_data');
    process.env.DATA_STORAGE_PATH = customDataDir;
    delete process.env.PENDING_TRANSACTIONS_STORAGE_PATH;
    delete process.env.TRANSACTION_MESSAGE_STORAGE_PATH;
    delete process.env.ENRICHMENT_POOL_STORAGE_PATH;
    delete process.env.INBOUND_NOTIFICATION_STORAGE_PATH;
    delete process.env.INBOUND_REFERENCE_REGISTRY_STORAGE_PATH;

    const config = loadEnvironmentConfiguration();
    expect(config.dataStoragePath).toBe(customDataDir);
    expect(config.pendingTransactionsStoragePath).toBe(path.join(customDataDir, 'pending_transactions.json'));
    expect(config.transactionMessageStoragePath).toBe(path.join(customDataDir, 'transaction_message_mappings.json'));
    expect(config.enrichmentPoolStoragePath).toBe(path.join(customDataDir, 'enrichment_pool.json'));
    expect(config.inboundNotificationStoragePath).toBe(path.join(customDataDir, 'inbound_notifications.json'));
    expect(config.inboundReferenceRegistryStoragePath).toBe(path.join(customDataDir, 'inbound_references.json'));
  });

  it('respects specific file storage path overrides independently', () => {
    const customDataDir = path.join(tempBaseDir, 'custom_data');
    const customPending = path.join(tempBaseDir, 'override_pending.json');
    process.env.DATA_STORAGE_PATH = customDataDir;
    process.env.PENDING_TRANSACTIONS_STORAGE_PATH = customPending;

    const config = loadEnvironmentConfiguration();
    expect(config.pendingTransactionsStoragePath).toBe(customPending);
    expect(config.transactionMessageStoragePath).toBe(path.join(customDataDir, 'transaction_message_mappings.json'));
  });
});
