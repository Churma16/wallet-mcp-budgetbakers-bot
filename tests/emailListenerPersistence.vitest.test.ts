import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'vitest';
import { EmailListenerService } from '../src/services/emailListenerService.js';

interface FakeImapClient {
  usable: boolean;
  search: () => Promise<number[]>;
  fetchOne: () => Promise<{
    source: Buffer;
    internalDate: Date;
    envelope: { from: Array<{ address: string }> };
  }>;
}

interface EmailListenerTestAccess {
  imapClient: FakeImapClient | null;
  isHandlingIncomingMail: boolean;
  processedMessageIdSet: Set<string>;
  inFlightMessageIdSet: Set<string>;
}

function buildRawEmail(messageId: string, subject: string, sender: string, body: string): Buffer {
  const rawEmail = [
    `From: ${sender}`,
    `To: user@example.com`,
    `Subject: ${subject}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${messageId}>`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    body,
  ].join('\r\n');

  return Buffer.from(rawEmail, 'utf8');
}

function attachFakeImapClient(service: EmailListenerService, source: Buffer): EmailListenerTestAccess {
  const fakeClient: FakeImapClient = {
    usable: true,
    search: async () => [1],
    fetchOne: async () => ({
      source,
      internalDate: new Date(),
      envelope: { from: [{ address: 'notifications@bankmandiri.co.id' }] },
    }),
  };

  const internalService = service as unknown as EmailListenerTestAccess;
  internalService.imapClient = fakeClient;
  return internalService;
}

function readProcessedMessageIds(cacheDirectory: string): string[] {
  const cachePath = path.join(cacheDirectory, 'processed_transaction_cache.json');
  if (!fs.existsSync(cachePath)) {
    return [];
  }

  const parsed = JSON.parse(fs.readFileSync(cachePath, 'utf8')) as { processedMessageIds?: string[] };
  return parsed.processedMessageIds ?? [];
}

async function waitForCondition(condition: () => boolean): Promise<void> {
  const timeoutAt = Date.now() + 1000;

  while (!condition()) {
    if (Date.now() >= timeoutAt) {
      throw new Error('Timed out waiting for test condition');
    }
    await new Promise(resolve => setTimeout(resolve, 1));
  }
}

async function testSuccessfulCandidateCommitsAfterCallback(): Promise<void> {
  const cacheDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'wallet-email-success-'));
  const messageId = 'success-transaction@example.com';
  let callbackCount = 0;

  try {
    const service = new EmailListenerService(
      'imap.example.com',
      993,
      'user@example.com',
      'password',
      10,
      async () => {
        callbackCount += 1;
      },
      cacheDirectory
    );

    attachFakeImapClient(
      service,
      buildRawEmail(
        messageId,
        'Notifikasi Transaksi',
        'notifications@bankmandiri.co.id',
        'Nominal: Rp 45.000\nNo. Referensi: REF-SUCCESS-75'
      )
    );

    await service.scanRecentMessages();

    assert.equal(callbackCount, 1, 'transaction callback should run exactly once');
    assert.deepEqual(
      readProcessedMessageIds(cacheDirectory),
      [`<${messageId}>`],
      'message ID should be persisted only after successful downstream handling'
    );

    await service.scanRecentMessages();
    assert.equal(callbackCount, 1, 'persisted message must be skipped on later scans');
  } finally {
    fs.rmSync(cacheDirectory, { recursive: true, force: true });
  }
}

async function testFailedCandidateRemainsRetryable(): Promise<void> {
  const cacheDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'wallet-email-retry-'));
  const messageId = 'retry-transaction@example.com';
  let callbackCount = 0;

  try {
    const service = new EmailListenerService(
      'imap.example.com',
      993,
      'user@example.com',
      'password',
      10,
      async () => {
        callbackCount += 1;
        if (callbackCount === 1) {
          throw new Error('simulated downstream failure');
        }
      },
      cacheDirectory
    );

    const internalService = attachFakeImapClient(
      service,
      buildRawEmail(
        messageId,
        'Notifikasi Transaksi',
        'notifications@bankmandiri.co.id',
        'Nominal: Rp 55.000\nNo. Referensi: REF-RETRY-75'
      )
    );

    await service.scanRecentMessages();

    assert.equal(callbackCount, 1, 'first scan should attempt downstream handling');
    assert.deepEqual(readProcessedMessageIds(cacheDirectory), [], 'failed candidate must not be persisted');
    assert.equal(
      internalService.inFlightMessageIdSet.has(`<${messageId}>`),
      false,
      'failed candidate must be released from the in-flight set'
    );

    await service.scanRecentMessages();

    assert.equal(callbackCount, 2, 'failed candidate should be retried on the next scan');
    assert.deepEqual(
      readProcessedMessageIds(cacheDirectory),
      [`<${messageId}>`],
      'successful retry should commit the message ID'
    );
  } finally {
    fs.rmSync(cacheDirectory, { recursive: true, force: true });
  }
}

async function testProductionInFlightClaimPreventsDuplicateDispatch(): Promise<void> {
  const cacheDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'wallet-email-inflight-'));
  const messageId = 'inflight-transaction@example.com';
  let callbackCount = 0;
  let releaseCallback: (() => void) | undefined;
  const callbackBarrier = new Promise<void>(resolve => {
    releaseCallback = resolve;
  });

  try {
    const service = new EmailListenerService(
      'imap.example.com',
      993,
      'user@example.com',
      'password',
      10,
      async () => {
        callbackCount += 1;
        await callbackBarrier;
      },
      cacheDirectory
    );

    const internalService = attachFakeImapClient(
      service,
      buildRawEmail(
        messageId,
        'Notifikasi Transaksi',
        'notifications@bankmandiri.co.id',
        'Nominal: Rp 65.000\nNo. Referensi: REF-INFLIGHT-75'
      )
    );

    const firstScanPromise = service.scanRecentMessages();
    await waitForCondition(() => callbackCount === 1);

    assert.equal(
      internalService.inFlightMessageIdSet.has(`<${messageId}>`),
      true,
      'production scan must claim the candidate before awaiting downstream handling'
    );
    assert.deepEqual(
      readProcessedMessageIds(cacheDirectory),
      [],
      'in-flight candidate must not be persisted before downstream success'
    );

    // Bypass the outer scan serialization guard so this invocation exercises the
    // message-level in-flight deduplication path while the first callback is pending.
    internalService.isHandlingIncomingMail = false;
    await service.scanRecentMessages();

    assert.equal(callbackCount, 1, 'a competing scan must not dispatch an in-flight candidate again');

    releaseCallback?.();
    await firstScanPromise;

    assert.equal(
      internalService.inFlightMessageIdSet.has(`<${messageId}>`),
      false,
      'successful downstream completion must release the in-flight claim'
    );
    assert.deepEqual(
      readProcessedMessageIds(cacheDirectory),
      [`<${messageId}>`],
      'successful downstream completion should persist the processed message ID'
    );
  } finally {
    releaseCallback?.();
    fs.rmSync(cacheDirectory, { recursive: true, force: true });
  }
}

async function testGateOneRejectionCachesImmediately(): Promise<void> {
  const cacheDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'wallet-email-gate-skip-'));
  const messageId = 'promo-email@example.com';
  let callbackCount = 0;

  try {
    const service = new EmailListenerService(
      'imap.example.com',
      993,
      'user@example.com',
      'password',
      10,
      async () => {
        callbackCount += 1;
      },
      cacheDirectory
    );

    attachFakeImapClient(
      service,
      buildRawEmail(
        messageId,
        'Promo spesial untuk kamu',
        'promo@bankmandiri.co.id',
        'Dapatkan diskon dan penawaran khusus hari ini.'
      )
    );

    await service.scanRecentMessages();

    assert.equal(callbackCount, 0, 'Gate 1 rejection must not invoke downstream transaction handling');
    assert.deepEqual(
      readProcessedMessageIds(cacheDirectory),
      [`<${messageId}>`],
      'Gate 1 rejection should still be cached immediately'
    );
  } finally {
    fs.rmSync(cacheDirectory, { recursive: true, force: true });
  }
}

async function testQueuedScanProcessesConcurrentIncomingMail(): Promise<void> {
  const cacheDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'wallet-email-queued-'));
  const messageId1 = 'msg-1@example.com';
  const messageId2 = 'msg-2@example.com';
  const processedUids: string[] = [];

  let releaseFirstCallback: (() => void) | undefined;
  const callback1Deferred = new Promise<void>(resolve => {
    releaseFirstCallback = resolve;
  });

  const mailStore: Record<
    number,
    { source: Buffer; envelope: { from: Array<{ address: string }>; messageId?: string } }
  > = {
    1: {
      source: buildRawEmail(
        messageId1,
        'Notifikasi Transaksi 1',
        'notifications@bankmandiri.co.id',
        'Nominal: Rp 10.000\nNo. Referensi: REF-CONCURRENT-1'
      ),
      envelope: {
        from: [{ address: 'notifications@bankmandiri.co.id' }],
        messageId: `<${messageId1}>`,
      },
    },
    2: {
      source: buildRawEmail(
        messageId2,
        'Notifikasi Transaksi 2',
        'notifications@bankmandiri.co.id',
        'Nominal: Rp 20.000\nNo. Referensi: REF-CONCURRENT-2'
      ),
      envelope: {
        from: [{ address: 'notifications@bankmandiri.co.id' }],
        messageId: `<${messageId2}>`,
      },
    },
  };

  let searchCalls = 0;
  const fakeClient = {
    usable: true,
    search: async () => {
      searchCalls += 1;
      if (searchCalls === 1) {
        return [1];
      }
      return [1, 2];
    },
    fetchOne: async (uid: string) => {
      const num = Number(uid);
      const item = mailStore[num];
      return {
        source: item.source,
        internalDate: new Date(),
        envelope: item.envelope,
      };
    },
  };

  try {
    let callbackCount = 0;
    let onFirstCallback: (() => void) | undefined;
    const firstCallbackPromise = new Promise<void>(res => {
      onFirstCallback = res;
    });

    const service = new EmailListenerService(
      'imap.example.com',
      993,
      'user@example.com',
      'password',
      10,
      async event => {
        callbackCount += 1;
        processedUids.push(event.rawMessageId);
        if (callbackCount === 1) {
          onFirstCallback?.();
          await callback1Deferred;
        }
      },
      cacheDirectory
    );

    const internalService = service as unknown as EmailListenerTestAccess;
    internalService.imapClient = fakeClient as unknown as FakeImapClient;

    const scanPromise = service.scanRecentMessages();

    await firstCallbackPromise;
    assert.equal(callbackCount, 1);
    assert.equal(internalService.isHandlingIncomingMail, true);

    const concurrentScanPromise = service.scanRecentMessages();
    await concurrentScanPromise;

    releaseFirstCallback?.();
    await scanPromise;

    assert.equal(callbackCount, 2, 'both emails must be processed by the queued scan loop');
    assert.deepEqual(processedUids, [`<${messageId1}>`, `<${messageId2}>`]);
    assert.deepEqual(
      readProcessedMessageIds(cacheDirectory).sort(),
      [`<${messageId1}>`, `<${messageId2}>`].sort(),
      'both message IDs must be persisted in cache'
    );
  } finally {
    releaseFirstCallback?.();
    fs.rmSync(cacheDirectory, { recursive: true, force: true });
  }
}

async function testEnvelopeDeduplicationPreCheckSkipsParsing(): Promise<void> {
  const cacheDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'wallet-email-envelope-skip-'));
  const messageId = 'cached-envelope@example.com';
  let callbackCount = 0;

  try {
    const service = new EmailListenerService(
      'imap.example.com',
      993,
      'user@example.com',
      'password',
      10,
      async () => {
        callbackCount += 1;
      },
      cacheDirectory
    );

    service.recordProcessedTransaction(`<${messageId}>`);

    const fakeClient = {
      usable: true,
      search: async () => [1],
      fetchOne: async () => ({
        source: Buffer.from('NOT A VALID MIME AND SHOULD NEVER BE PARSED'),
        internalDate: new Date(),
        envelope: {
          from: [{ address: 'notifications@bankmandiri.co.id' }],
          messageId: `<${messageId}>`,
        },
      }),
    };

    const internalService = service as unknown as EmailListenerTestAccess;
    internalService.imapClient = fakeClient as unknown as FakeImapClient;

    await service.scanRecentMessages();
    assert.equal(callbackCount, 0, 'cached envelope messageId must be skipped before parsing');
  } finally {
    fs.rmSync(cacheDirectory, { recursive: true, force: true });
  }
}

describe('email listener transactional persistence', () => {
  it('commits a successful candidate after the downstream callback', async () => {
    await testSuccessfulCandidateCommitsAfterCallback();
  });

  it('keeps a downstream failure retryable and commits it on retry', async () => {
    await testFailedCandidateRemainsRetryable();
  });

  it('prevents duplicate in-flight dispatch and cleans up the claim', async () => {
    await testProductionInFlightClaimPreventsDuplicateDispatch();
  });

  it('caches a Gate 1 rejection immediately', async () => {
    await testGateOneRejectionCachesImmediately();
  });

  it('queues and processes follow-up scans when concurrent mail arrives', async () => {
    await testQueuedScanProcessesConcurrentIncomingMail();
  });

  it('skips parsing raw MIME source when envelope messageId is already in cache', async () => {
    await testEnvelopeDeduplicationPreCheckSkipsParsing();
  });
});
