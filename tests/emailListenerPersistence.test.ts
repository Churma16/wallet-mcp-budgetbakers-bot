import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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

async function testInFlightCandidateIsSkipped(): Promise<void> {
  const cacheDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'wallet-email-inflight-'));
  const messageId = 'inflight-transaction@example.com';
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

    const internalService = attachFakeImapClient(
      service,
      buildRawEmail(
        messageId,
        'Notifikasi Transaksi',
        'notifications@bankmandiri.co.id',
        'Nominal: Rp 65.000\nNo. Referensi: REF-INFLIGHT-75'
      )
    );

    internalService.inFlightMessageIdSet.add(`<${messageId}>`);
    await service.scanRecentMessages();

    assert.equal(callbackCount, 0, 'an in-flight candidate must not be dispatched again');
    assert.deepEqual(readProcessedMessageIds(cacheDirectory), [], 'in-flight state must remain memory-only');
  } finally {
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

async function runEmailListenerPersistenceTests(): Promise<void> {
  console.log('[test] Email listener transactional persistence (Issue #75)');

  await testSuccessfulCandidateCommitsAfterCallback();
  console.log('  [PASS] successful candidate commits after downstream callback');

  await testFailedCandidateRemainsRetryable();
  console.log('  [PASS] downstream failure remains retryable and commits on retry');

  await testInFlightCandidateIsSkipped();
  console.log('  [PASS] in-flight candidate is skipped without persistent commit');

  await testGateOneRejectionCachesImmediately();
  console.log('  [PASS] Gate 1 rejection is cached immediately');
}

runEmailListenerPersistenceTests().catch((error: unknown) => {
  console.error('[FAIL] Email listener persistence regression suite failed:', error);
  process.exit(1);
});
