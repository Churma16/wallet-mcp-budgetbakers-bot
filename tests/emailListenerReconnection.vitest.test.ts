import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, vi } from 'vitest';
import { EmailListenerService } from '../src/services/emailListenerService.js';
import type { ImapFlow } from 'imapflow';

class MockImapFlowClient extends EventEmitter {
  public usable = true;
  public connectCalled = 0;
  public logoutCalled = 0;
  public closeCalled = 0;
  public getMailboxLockCalled = 0;
  public idleCalled = 0;
  public failOnConnect = false;

  public async connect(): Promise<void> {
    this.connectCalled += 1;
    if (this.failOnConnect) {
      throw new Error('Connection refused mock');
    }
    this.usable = true;
  }

  public async getMailboxLock(_mailbox: string): Promise<{ release: () => void }> {
    this.getMailboxLockCalled += 1;
    return {
      release: () => {
        // no-op
      },
    };
  }

  public async search(): Promise<number[]> {
    return [];
  }

  public async idle(): Promise<void> {
    this.idleCalled += 1;
    // Simulate idle waiting or interruption
    return new Promise(resolve => setTimeout(resolve, 10));
  }

  public close(): void {
    this.closeCalled += 1;
    this.usable = false;
  }

  public async logout(): Promise<void> {
    this.logoutCalled += 1;
    this.usable = false;
  }
}

describe('email listener reconnection resilience', () => {
  it('instantiates a new ImapFlow client and reconnects when close event fires', async () => {
    vi.useFakeTimers();
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wallet-email-reconnect-'));
    const createdClients: MockImapFlowClient[] = [];

    const factory = () => {
      const client = new MockImapFlowClient();
      createdClients.push(client);
      return client as unknown as ImapFlow;
    };

    const service = new EmailListenerService(
      'imap.example.com',
      993,
      'test@example.com',
      'password',
      10,
      async () => {},
      cacheDir,
      factory
    );

    try {
      // 1. Initial start
      await service.startListening();

      assert.strictEqual(createdClients.length, 1);
      assert.strictEqual(createdClients[0].connectCalled, 1);

      // 2. Simulate connection close on client 0
      createdClients[0].usable = false;
      createdClients[0].emit('close');

      // Fast-forward backoff delay (max 2000ms jitter + 5000ms base = 7000ms)
      await vi.advanceTimersByTimeAsync(8000);

      // A new client should have been instantiated and connected
      assert.strictEqual(createdClients.length, 2);
      assert.strictEqual(createdClients[1].connectCalled, 1);
      assert.strictEqual(createdClients[0].closeCalled, 1);

      // 3. Stop service
      await service.stop();
      assert.strictEqual(createdClients[1].logoutCalled, 1);
    } finally {
      vi.useRealTimers();
      fs.rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  it('schedules retry when initial connection fails', async () => {
    vi.useFakeTimers();
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wallet-email-retry-'));
    const createdClients: MockImapFlowClient[] = [];

    const factory = () => {
      const client = new MockImapFlowClient();
      if (createdClients.length === 0) {
        client.failOnConnect = true;
      }
      createdClients.push(client);
      return client as unknown as ImapFlow;
    };

    const service = new EmailListenerService(
      'imap.example.com',
      993,
      'test@example.com',
      'password',
      10,
      async () => {},
      cacheDir,
      factory
    );

    try {
      // Start listening (should reject initial connect, but schedule reconnect)
      await assert.rejects(async () => {
        await service.startListening();
      }, /Connection refused mock/);

      assert.strictEqual(createdClients.length, 1);

      // Advance timers to trigger reconnect
      await vi.advanceTimersByTimeAsync(8000);

      // Client 2 should be created and successfully connected
      assert.strictEqual(createdClients.length, 2);
      assert.strictEqual(createdClients[1].connectCalled, 1);

      await service.stop();
    } finally {
      vi.useRealTimers();
      fs.rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  it('cancels pending reconnect timer on stop()', async () => {
    vi.useFakeTimers();
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wallet-email-stop-'));
    const createdClients: MockImapFlowClient[] = [];

    const factory = () => {
      const client = new MockImapFlowClient();
      createdClients.push(client);
      return client as unknown as ImapFlow;
    };

    const service = new EmailListenerService(
      'imap.example.com',
      993,
      'test@example.com',
      'password',
      10,
      async () => {},
      cacheDir,
      factory
    );

    try {
      await service.startListening();
      assert.strictEqual(createdClients.length, 1);

      // Emit close to trigger reconnect schedule
      createdClients[0].emit('close');

      // Stop immediately while timer is pending
      await service.stop();

      // Advance timers past backoff delay
      await vi.advanceTimersByTimeAsync(15000);

      // No new client should have been created because stop() cleared the timer
      assert.strictEqual(createdClients.length, 1);
    } finally {
      vi.useRealTimers();
      fs.rmSync(cacheDir, { recursive: true, force: true });
    }
  });
});
