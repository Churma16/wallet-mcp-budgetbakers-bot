import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EmailListenerService } from '../src/email/index.js';

interface FakeMailItem {
  source: Buffer;
  internalDate?: Date;
  envelope?: {
    from?: Array<{ address: string }>;
    messageId?: string;
  };
}

interface FakeImapClient {
  usable: boolean;
  search: (criteria?: unknown, options?: unknown) => Promise<number[]>;
  fetchOne: (
    uid: string,
    fetchOptions?: unknown,
    searchOptions?: unknown
  ) => Promise<{
    source: Buffer;
    internalDate: Date;
    envelope?: { from?: Array<{ address: string }>; messageId?: string };
  }>;
}

interface EmailListenerTestAccess {
  imapClient: FakeImapClient | null;
  isHandlingIncomingMail: boolean;
  processedMessageIdSet: Set<string>;
  inFlightMessageIdSet: Set<string>;
  cacheFilePath: string;
  claimMessageInFlight: (messageId: string) => void;
  releaseMessageInFlight: (messageId: string) => void;
}

function buildRawEmail(messageId: string, subject: string, sender: string, body: string): Buffer {
  const rawEmail = [
    `From: ${sender}`,
    'To: recipient@example.com',
    `Subject: ${subject}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${messageId}>`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    body,
  ].join('\r\n');

  return Buffer.from(rawEmail, 'utf8');
}

function createFakeImapClient(
  mailStore: Record<number, FakeMailItem>,
  uids: number[] = Object.keys(mailStore).map(Number)
): FakeImapClient {
  return {
    usable: true,
    search: async () => [...uids],
    fetchOne: async (uid: string) => {
      const item = mailStore[Number(uid)];
      if (!item) {
        throw new Error(`Message UID ${uid} not found`);
      }
      return {
        source: item.source,
        internalDate: item.internalDate || new Date(),
        envelope: item.envelope,
      };
    },
  };
}

describe('EmailListenerService atomic writes, concurrency serialization, and in-flight deduplication', () => {
  let tempCacheDir: string;

  beforeEach(() => {
    tempCacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wallet-email-service-test-'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (fs.existsSync(tempCacheDir)) {
      fs.rmSync(tempCacheDir, { recursive: true, force: true });
    }
  });

  describe('atomic cache writes via temporary file and fs.renameSync', () => {
    it('writes cache via temporary file and renames atomically with fs.renameSync', () => {
      const renameSyncSpy = vi.spyOn(fs, 'renameSync');
      const service = new EmailListenerService(
        'imap.example.com',
        993,
        'user@example.com',
        'password',
        10,
        async () => {},
        tempCacheDir
      );

      service.recordProcessedTransaction('test-message-1@example.com', 'REF-TEST-001');

      expect(renameSyncSpy).toHaveBeenCalled();
      const lastCallArgs = renameSyncSpy.mock.calls[renameSyncSpy.mock.calls.length - 1];
      const sourceTempPath = String(lastCallArgs[0]);
      const targetDestinationPath = String(lastCallArgs[1]);

      expect(targetDestinationPath).toBe(path.join(tempCacheDir, 'processed_transaction_cache.json'));
      expect(sourceTempPath).toContain('processed_transaction_cache.json.tmp.');
      expect(path.dirname(sourceTempPath)).toBe(tempCacheDir);

      const cacheContent = JSON.parse(
        fs.readFileSync(targetDestinationPath, 'utf8')
      ) as { processedMessageIds: string[]; processedReferenceNumbers: string[] };

      expect(cacheContent.processedMessageIds).toContain('test-message-1@example.com');
      expect(cacheContent.processedReferenceNumbers).toContain('REF-TEST-001');

      const remainingFiles = fs.readdirSync(tempCacheDir);
      const tmpFiles = remainingFiles.filter(fileName => fileName.includes('.tmp.'));
      expect(tmpFiles).toHaveLength(0);
    });

    it('cleans up temporary file if write or rename throws', () => {
      const service = new EmailListenerService(
        'imap.example.com',
        993,
        'user@example.com',
        'password',
        10,
        async () => {},
        tempCacheDir
      );

      vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
        throw new Error('simulated disk failure on rename');
      });

      expect(() => {
        service.recordProcessedTransaction('test-error@example.com', 'REF-ERR-001');
      }).not.toThrow();

      const remainingFiles = fs.readdirSync(tempCacheDir);
      const tmpFiles = remainingFiles.filter(fileName => fileName.includes('.tmp.'));
      expect(tmpFiles).toHaveLength(0);
    });
  });

  describe('concurrency serialization in rescanMessages', () => {
    it('serializes rescanMessages against active incoming mail handling', async () => {
      let isFirstCallbackActive = false;
      let resolveFirstCallback: (() => void) | undefined;
      const firstCallbackGate = new Promise<void>(resolve => {
        resolveFirstCallback = resolve;
      });

      const messageId1 = 'concurrent-1@example.com';
      const mailStore: Record<number, FakeMailItem> = {
        1: {
          source: buildRawEmail(
            messageId1,
            'Notifikasi Transaksi',
            'notifications@bankmandiri.co.id',
            'Nominal: Rp 50.000\nNo. Referensi: REF-CONC-01'
          ),
          envelope: {
            from: [{ address: 'notifications@bankmandiri.co.id' }],
            messageId: `<${messageId1}>`,
          },
        },
      };

      const executionLog: string[] = [];
      let isFirstRun = true;
      const service = new EmailListenerService(
        'imap.example.com',
        993,
        'user@example.com',
        'password',
        10,
        async () => {
          if (isFirstRun) {
            isFirstRun = false;
            isFirstCallbackActive = true;
            executionLog.push('incoming-callback-started');
            await firstCallbackGate;
            executionLog.push('incoming-callback-finished');
          } else {
            executionLog.push('rescan-callback-executed');
          }
        },
        tempCacheDir
      );

      const internalService = service as unknown as EmailListenerTestAccess;
      internalService.imapClient = createFakeImapClient(mailStore);

      const incomingScanPromise = service.scanRecentMessages();

      while (!isFirstCallbackActive) {
        await new Promise(resolve => setTimeout(resolve, 5));
      }

      expect(internalService.isHandlingIncomingMail).toBe(true);

      let rescanFinished = false;
      const rescanPromise = service
        .rescanMessages(60, { bypassProcessedCache: true })
        .then(result => {
          rescanFinished = true;
          executionLog.push('rescan-completed');
          return result;
        });

      await new Promise(resolve => setTimeout(resolve, 30));
      expect(rescanFinished).toBe(false);
      expect(executionLog).toEqual(['incoming-callback-started']);

      resolveFirstCallback?.();
      await incomingScanPromise;
      await rescanPromise;

      expect(executionLog).toEqual([
        'incoming-callback-started',
        'incoming-callback-finished',
        'rescan-callback-executed',
        'rescan-completed',
      ]);
      expect(internalService.isHandlingIncomingMail).toBe(false);
    });

    it('serializes multiple concurrent rescanMessages calls sequentially', async () => {
      const callLog: string[] = [];
      let rescanCount = 0;

      const messageId = 'rescan-seq@example.com';
      const mailStore: Record<number, FakeMailItem> = {
        1: {
          source: buildRawEmail(
            messageId,
            'Notifikasi Transaksi',
            'notifications@bankmandiri.co.id',
            'Nominal: Rp 75.000\nNo. Referensi: REF-SEQ-01'
          ),
          envelope: {
            from: [{ address: 'notifications@bankmandiri.co.id' }],
            messageId: `<${messageId}>`,
          },
        },
      };

      const service = new EmailListenerService(
        'imap.example.com',
        993,
        'user@example.com',
        'password',
        10,
        async () => {
          rescanCount++;
          callLog.push(`callback-run-${rescanCount}`);
          await new Promise(resolve => setTimeout(resolve, 20));
        },
        tempCacheDir
      );

      const internalService = service as unknown as EmailListenerTestAccess;
      internalService.imapClient = createFakeImapClient(mailStore);

      const [resultA, resultB] = await Promise.all([
        service.rescanMessages(60, { bypassProcessedCache: true }),
        service.rescanMessages(60, { bypassProcessedCache: true }),
      ]);

      expect(resultA.scannedUids).toBe(1);
      expect(resultB.scannedUids).toBe(1);
      expect(callLog).toEqual(['callback-run-1', 'callback-run-2']);
      expect(internalService.isHandlingIncomingMail).toBe(false);
    });

    it('queues incoming mail scan arriving while rescanMessages is in progress', async () => {
      let isRescanCallbackActive = false;
      let resolveRescanCallback: (() => void) | undefined;
      const rescanCallbackGate = new Promise<void>(resolve => {
        resolveRescanCallback = resolve;
      });

      const messageId1 = 'rescan-msg@example.com';
      const messageId2 = 'incoming-queued@example.com';

      const mailStore: Record<number, FakeMailItem> = {
        1: {
          source: buildRawEmail(
            messageId1,
            'Notifikasi Transaksi 1',
            'notifications@bankmandiri.co.id',
            'Nominal: Rp 30.000\nNo. Referensi: REF-RS-01'
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
            'Nominal: Rp 40.000\nNo. Referensi: REF-RS-02'
          ),
          envelope: {
            from: [{ address: 'notifications@bankmandiri.co.id' }],
            messageId: `<${messageId2}>`,
          },
        },
      };

      const processedIds: string[] = [];
      const service = new EmailListenerService(
        'imap.example.com',
        993,
        'user@example.com',
        'password',
        10,
        async event => {
          processedIds.push(event.rawMessageId);
          if (event.rawMessageId.includes(messageId1)) {
            isRescanCallbackActive = true;
            await rescanCallbackGate;
          }
        },
        tempCacheDir
      );

      let currentUids = [1];
      const fakeClient: FakeImapClient = {
        usable: true,
        search: async () => currentUids,
        fetchOne: async (uid: string) => {
          const item = mailStore[Number(uid)];
          return {
            source: item.source,
            internalDate: new Date(),
            envelope: item.envelope,
          };
        },
      };

      const internalService = service as unknown as EmailListenerTestAccess;
      internalService.imapClient = fakeClient;

      const rescanPromise = service.rescanMessages(60, { bypassProcessedCache: true });

      while (!isRescanCallbackActive) {
        await new Promise(resolve => setTimeout(resolve, 5));
      }

      currentUids = [1, 2];
      const incomingScanPromise = service.scanRecentMessages();
      await incomingScanPromise;

      resolveRescanCallback?.();
      await rescanPromise;

      while (processedIds.length < 2) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }

      expect(processedIds).toEqual([`<${messageId1}>`, `<${messageId2}>`]);
      expect(internalService.isHandlingIncomingMail).toBe(false);
    });
  });

  describe('in-flight skipping in performMessagesScan', () => {
    it('skips message when message ID is currently in-flight even if bypassProcessedCache is true', async () => {
      const messageId = 'inflight-rescan@example.com';
      const mailStore: Record<number, FakeMailItem> = {
        1: {
          source: buildRawEmail(
            messageId,
            'Notifikasi Transaksi',
            'notifications@bankmandiri.co.id',
            'Nominal: Rp 100.000\nNo. Referensi: REF-INFLIGHT-RES'
          ),
          envelope: {
            from: [{ address: 'notifications@bankmandiri.co.id' }],
            messageId: `<${messageId}>`,
          },
        },
      };

      let callbackCallCount = 0;
      const service = new EmailListenerService(
        'imap.example.com',
        993,
        'user@example.com',
        'password',
        10,
        async () => {
          callbackCallCount++;
        },
        tempCacheDir
      );

      const internalService = service as unknown as EmailListenerTestAccess;
      internalService.imapClient = createFakeImapClient(mailStore);

      internalService.claimMessageInFlight(`<${messageId}>`);
      expect(service.isMessageInFlight(messageId)).toBe(true);

      const scanResult = await service.rescanMessages(60, { bypassProcessedCache: true });

      expect(scanResult.scannedUids).toBe(1);
      expect(scanResult.detectedCount).toBe(0);
      expect(callbackCallCount).toBe(0);

      internalService.releaseMessageInFlight(`<${messageId}>`);
      expect(service.isMessageInFlight(messageId)).toBe(false);

      const secondScanResult = await service.rescanMessages(60, { bypassProcessedCache: true });
      expect(secondScanResult.detectedCount).toBe(1);
      expect(callbackCallCount).toBe(1);
    });

    it('skips message at envelope pre-check when envelope messageId is in-flight', async () => {
      const envelopeId = 'envelope-inflight@example.com';
      let fetchCount = 0;

      const mailStore: Record<number, FakeMailItem> = {
        1: {
          source: buildRawEmail(
            'different-raw-id@example.com',
            'Notifikasi Transaksi',
            'notifications@bankmandiri.co.id',
            'Nominal: Rp 200.000\nNo. Referensi: REF-ENV-01'
          ),
          envelope: {
            from: [{ address: 'notifications@bankmandiri.co.id' }],
            messageId: `<${envelopeId}>`,
          },
        },
      };

      let callbackCalled = false;
      const service = new EmailListenerService(
        'imap.example.com',
        993,
        'user@example.com',
        'password',
        10,
        async () => {
          callbackCalled = true;
        },
        tempCacheDir
      );

      const fakeClient: FakeImapClient = {
        usable: true,
        search: async () => [1],
        fetchOne: async (uid: string) => {
          fetchCount++;
          const item = mailStore[Number(uid)];
          return {
            source: item.source,
            internalDate: new Date(),
            envelope: item.envelope,
          };
        },
      };

      const internalService = service as unknown as EmailListenerTestAccess;
      internalService.imapClient = fakeClient;

      internalService.claimMessageInFlight(`<${envelopeId}>`);

      const scanResult = await service.rescanMessages(60, { bypassProcessedCache: true });

      expect(fetchCount).toBe(1);
      expect(scanResult.detectedCount).toBe(0);
      expect(callbackCalled).toBe(false);
    });

    it('re-evaluates already-processed message when bypassProcessedCache is true and message is not in-flight', async () => {
      const messageId = 'already-processed@example.com';
      const mailStore: Record<number, FakeMailItem> = {
        1: {
          source: buildRawEmail(
            messageId,
            'Notifikasi Transaksi',
            'notifications@bankmandiri.co.id',
            'Nominal: Rp 88.000\nNo. Referensi: REF-ALREADY-01'
          ),
          envelope: {
            from: [{ address: 'notifications@bankmandiri.co.id' }],
            messageId: `<${messageId}>`,
          },
        },
      };

      let callbackCallCount = 0;
      const service = new EmailListenerService(
        'imap.example.com',
        993,
        'user@example.com',
        'password',
        10,
        async () => {
          callbackCallCount++;
        },
        tempCacheDir
      );

      const internalService = service as unknown as EmailListenerTestAccess;
      internalService.imapClient = createFakeImapClient(mailStore);

      await service.scanRecentMessages();
      expect(callbackCallCount).toBe(1);
      expect(service.isMessageAlreadyProcessed(messageId)).toBe(true);
      expect(service.isMessageInFlight(messageId)).toBe(false);

      await service.scanRecentMessages();
      expect(callbackCallCount).toBe(1);

      const rescanResult = await service.rescanMessages(60, { bypassProcessedCache: true });
      expect(rescanResult.detectedCount).toBe(1);
      expect(callbackCallCount).toBe(2);
    });
  });
});
