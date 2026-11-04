import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadEnvironmentConfiguration } from '../src/config/environmentConfig.js';

describe('Data Persistence & Storage Migration Configuration', () => {
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

    const config = loadEnvironmentConfiguration();
    expect(config.dataStoragePath).toBe('./data');
    expect(config.pendingTransactionsStoragePath).toBe(path.join('./data', 'pending_transactions.json'));
    expect(config.transactionMessageStoragePath).toBe(path.join('./data', 'transaction_message_mappings.json'));
  });

  it('respects DATA_STORAGE_PATH env var', () => {
    const customDataDir = path.join(tempBaseDir, 'custom_data');
    process.env.DATA_STORAGE_PATH = customDataDir;
    delete process.env.PENDING_TRANSACTIONS_STORAGE_PATH;
    delete process.env.TRANSACTION_MESSAGE_STORAGE_PATH;

    const config = loadEnvironmentConfiguration();
    expect(config.dataStoragePath).toBe(customDataDir);
    expect(config.pendingTransactionsStoragePath).toBe(path.join(customDataDir, 'pending_transactions.json'));
    expect(config.transactionMessageStoragePath).toBe(path.join(customDataDir, 'transaction_message_mappings.json'));
  });

  it('automatically migrates legacy files from whatsappSessionPath to dataStoragePath', () => {
    const legacySessionDir = path.join(tempBaseDir, 'legacy_auth_session');
    const targetDataDir = path.join(tempBaseDir, 'target_data');
    fs.mkdirSync(legacySessionDir, { recursive: true });

    const legacyPendingContent = JSON.stringify({ version: 1, pendingTransactions: [{ ticketId: 99 }] });
    const legacyMappingContent = JSON.stringify({ version: 1, mappings: { msg123: 'rec456' } });

    fs.writeFileSync(path.join(legacySessionDir, 'pending_transactions.json'), legacyPendingContent, 'utf8');
    fs.writeFileSync(path.join(legacySessionDir, 'transaction_message_mappings.json'), legacyMappingContent, 'utf8');

    process.env.WHATSAPP_SESSION_PATH = legacySessionDir;
    process.env.DATA_STORAGE_PATH = targetDataDir;
    delete process.env.PENDING_TRANSACTIONS_STORAGE_PATH;
    delete process.env.TRANSACTION_MESSAGE_STORAGE_PATH;

    const config = loadEnvironmentConfiguration();

    // Verify target file was migrated (copied) to targetDataDir
    const migratedPendingPath = path.join(targetDataDir, 'pending_transactions.json');
    const migratedMappingPath = path.join(targetDataDir, 'transaction_message_mappings.json');

    expect(fs.existsSync(migratedPendingPath)).toBe(true);
    expect(fs.readFileSync(migratedPendingPath, 'utf8')).toBe(legacyPendingContent);

    expect(fs.existsSync(migratedMappingPath)).toBe(true);
    expect(fs.readFileSync(migratedMappingPath, 'utf8')).toBe(legacyMappingContent);

    expect(config.pendingTransactionsStoragePath).toBe(migratedPendingPath);
    expect(config.transactionMessageStoragePath).toBe(migratedMappingPath);
  });

  it('does not overwrite existing target file during migration check', () => {
    const legacySessionDir = path.join(tempBaseDir, 'legacy_session');
    const targetDataDir = path.join(tempBaseDir, 'target_data');
    fs.mkdirSync(legacySessionDir, { recursive: true });
    fs.mkdirSync(targetDataDir, { recursive: true });

    const legacyContent = JSON.stringify({ version: 1, old: true });
    const existingTargetContent = JSON.stringify({ version: 1, current: true });

    fs.writeFileSync(path.join(legacySessionDir, 'pending_transactions.json'), legacyContent, 'utf8');
    fs.writeFileSync(path.join(targetDataDir, 'pending_transactions.json'), existingTargetContent, 'utf8');

    process.env.WHATSAPP_SESSION_PATH = legacySessionDir;
    process.env.DATA_STORAGE_PATH = targetDataDir;
    delete process.env.PENDING_TRANSACTIONS_STORAGE_PATH;

    const config = loadEnvironmentConfiguration();
    const targetPath = path.join(targetDataDir, 'pending_transactions.json');

    expect(fs.readFileSync(targetPath, 'utf8')).toBe(existingTargetContent);
    expect(config.pendingTransactionsStoragePath).toBe(targetPath);
  });
});
