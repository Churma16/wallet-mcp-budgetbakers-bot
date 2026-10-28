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

  it('recovers from transient idle() errors when client remains usable', async () => {
    vi.useFakeTimers();
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wallet-email-idle-transient-'));
    const createdClients: MockImapFlowClient[] = [];

    const factory = () => {
      const client = new MockImapFlowClient();
      let idleCount = 0;
      client.idle = async () => {
        idleCount += 1;
        if (idleCount === 1) {
          throw new Error('Transient idle reset');
        }
        return new Promise(resolve => setTimeout(resolve, 10));
      };
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
      await vi.advanceTimersByTimeAsync(50);

      // Client should still be active, no reconnection scheduled
      assert.strictEqual(createdClients.length, 1);
      assert.strictEqual(createdClients[0].usable, true);
      await service.stop();
    } finally {
      vi.useRealTimers();
      fs.rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  it('does not trigger spurious reconnect when a superseded client finishes its idle cycle', async () => {
    vi.useFakeTimers();
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wallet-email-zombie-'));
    const createdClients: MockImapFlowClient[] = [];

    let unblockClient0Idle: (() => void) | null = null;

    const factory = () => {
      const client = new MockImapFlowClient();
      const index = createdClients.length;
      if (index === 0) {
        client.idle = async () => {
          return new Promise(resolve => {
            unblockClient0Idle = resolve;
          });
        };
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
      await service.startListening();
      assert.strictEqual(createdClients.length, 1);

      // Emit close to trigger reconnect while client 0 is still blocked in idle
      createdClients[0].usable = false;
      createdClients[0].emit('close');

      // Advance backoff timer so client 1 connects and becomes active
      await vi.advanceTimersByTimeAsync(8000);
      assert.strictEqual(createdClients.length, 2);

      // Now unblock client 0's idle loop, causing its runMailboxIdleCycle to complete
      if (unblockClient0Idle) {
        (unblockClient0Idle as () => void)();
      }
      await vi.advanceTimersByTimeAsync(100);

      // Advance timer again. No 3rd client should be created because client 0 was superseded
      await vi.advanceTimersByTimeAsync(15000);
      assert.strictEqual(createdClients.length, 2);

      await service.stop();
    } finally {
      vi.useRealTimers();
      fs.rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  it('tears down client and does not start idle cycle if stop() is called during connect()', async () => {
    vi.useFakeTimers();
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wallet-email-stop-connect-'));
    const createdClients: MockImapFlowClient[] = [];

    let resolveConnect: (() => void) | null = null;

    const factory = () => {
      const client = new MockImapFlowClient();
      client.connect = async () => {
        client.connectCalled += 1;
        return new Promise<void>(resolve => {
          resolveConnect = resolve;
        });
      };
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
      const startPromise = service.startListening();

      // Client was created and connect was initiated
      assert.strictEqual(createdClients.length, 1);
      assert.strictEqual(createdClients[0].connectCalled, 1);

      // Stop service while connect is pending
      await service.stop();

      // Resolve connect
      if (resolveConnect) {
        (resolveConnect as () => void)();
      }
      await startPromise;

      // Client should be closed and getMailboxLock never called
      assert.strictEqual(createdClients[0].closeCalled, 1);
      assert.strictEqual(createdClients[0].getMailboxLockCalled, 0);
    } finally {
      vi.useRealTimers();
      fs.rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  it('unregisters exists event listener when mailbox lock is released', async () => {
    vi.useFakeTimers();
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wallet-email-exists-off-'));
    const createdClients: MockImapFlowClient[] = [];

    let unblockIdle: (() => void) | null = null;
    const factory = () => {
      const client = new MockImapFlowClient();
      client.idle = async () => {
        return new Promise(resolve => {
          unblockIdle = resolve;
        });
      };
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
      // Allow async mailbox lock and initial scan microtasks to settle
      await vi.advanceTimersByTimeAsync(10);
      assert.strictEqual(createdClients.length, 1);
      assert.strictEqual(createdClients[0].listenerCount('exists'), 1);

      // Make client unusable and unblock idle so runMailboxIdleCycle exits its loop and executes finally
      createdClients[0].usable = false;
      if (unblockIdle) {
        (unblockIdle as () => void)();
      }
      await vi.advanceTimersByTimeAsync(10);

      // The exists listener should be cleanly removed by the finally block without calling stop()
      assert.strictEqual(createdClients[0].listenerCount('exists'), 0);

      await service.stop();
    } finally {
      vi.useRealTimers();
      fs.rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  it('triggers periodic fallback scan via fallbackPollTimer', async () => {
    vi.useFakeTimers();
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wallet-email-fallback-poll-'));
    let searchCount = 0;

    const factory = () => {
      const client = new MockImapFlowClient();
      client.search = async () => {
        searchCount += 1;
        return [];
      };
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
      factory,
      1000
    );

    try {
      await service.startListening();
      await vi.advanceTimersByTimeAsync(10);
      assert.strictEqual(searchCount, 1, 'initial scan should run on startup');

      await vi.advanceTimersByTimeAsync(1000);
      assert.strictEqual(searchCount, 2, 'fallback timer should trigger second scan pass');

      await service.stop();
    } finally {
      vi.useRealTimers();
      fs.rmSync(cacheDir, { recursive: true, force: true });
    }
  });
});
