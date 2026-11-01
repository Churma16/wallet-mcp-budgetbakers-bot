import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  postProcessEmailTransactionResponse,
} from '../src/brain/index.js';
import { AiResponseParseError } from '../src/brain/index.js';
import { FallbackAiProvider } from '../src/brain/index.js';
import { EmailListenerService, DeadLetterQueueItem } from '../src/email/index.js';
import { EmailTransactionHandler } from '../src/core/index.js';
import { PendingTransactionService } from '../src/core/pending.js';
import { TransactionCorrelationService } from '../src/email/index.js';
import { BANK_EMAIL_RULES } from '../src/email/index.js';
import { GateEvaluationResult } from '../src/email/index.js';

describe('Email AI Error Propagation, Retry DLQ, and Idempotency', () => {
  const dummyGateResult: GateEvaluationResult = {
    passed: true,
    matchedBankRule: {
      bankKey: 'shopee',
      displayName: 'Shopee',
      senderDomains: ['shopee.co.id'],
      subjectKeywords: ['pembayaranmu berhasil dikonfirmasi'],
      blacklistKeywords: [],
      bodyRequiredPatterns: [],
      amountPriorityPatterns: [],
      referencePatterns: [],
      transferOrTopupKeywords: [],
      ruleCategory: 'MERCHANT_RECEIPT',
      accountNameHint: 'Cash',
    },
    candidateAmount: 38431,
    referenceNumber: '261029VNREYMEW',
    isTransferCandidate: false,
    originalDate: '2026-10-29T15:05:15.000Z',
  };

  describe('postProcessEmailTransactionResponse error handling', () => {
    it('throws AiResponseParseError when AI returns non-JSON text (e.g. guardrail output)', () => {
      expect(() => {
        postProcessEmailTransactionResponse(
          { responseText: 'User Safety: safe' },
          dummyGateResult,
          'Pembayaranmu Berhasil Dikonfirmasi',
          new Date('2026-10-29T15:05:15.000Z'),
          [],
          [],
          'OpenRouter'
        );
      }).toThrowError(AiResponseParseError);
    });

    it('throws AiResponseParseError when AI response is missing isTransaction boolean', () => {
      expect(() => {
        postProcessEmailTransactionResponse(
          { responseText: JSON.stringify({ amount: 38431, counterParty: 'Shopee' }) },
          dummyGateResult,
          'Pembayaranmu Berhasil Dikonfirmasi',
          new Date('2026-10-29T15:05:15.000Z'),
          [],
          [],
          'Gemini'
        );
      }).toThrowError(AiResponseParseError);
    });

    it('cleanly returns parsed non-transaction when AI legitimately decides isTransaction: false', () => {
      const result = postProcessEmailTransactionResponse(
        {
          responseText: JSON.stringify({
            isTransaction: false,
            explanation: 'Newsletter / Promo email',
          }),
        },
        dummyGateResult,
        'Shopee 11.11 Promo',
        new Date('2026-10-29T15:05:15.000Z'),
        [],
        [],
        'Gemini'
      );

      expect(result.isTransaction).toBe(false);
      expect(result.explanation).toContain('Newsletter / Promo');
    });

    it('cleanly parses valid transaction data when AI output conforms to schema', () => {
      const result = postProcessEmailTransactionResponse(
        {
          responseText: JSON.stringify({
            isTransaction: true,
            transactionType: 'EXPENSE',
            amount: 38431,
            counterParty: 'Nu Fit',
            accountNameHint: 'Jago Expense',
            matchedAccountId: 'acc-jago',
            matchedCategoryId: 'cat-clothes',
            matchedCategoryName: 'Clothes & shoes',
            note: '1x Nu Fit - Kaos Kaki Olahraga',
            recordDate: '2026-10-29T15:05:15.000Z',
            referenceNumber: '261029VNREYMEW',
          }),
        },
        dummyGateResult,
        'Pembayaranmu Berhasil Dikonfirmasi',
        new Date('2026-10-29T15:05:15.000Z'),
        [{ id: 'acc-jago', name: 'Jago Expense', currency: 'IDR' }],
        [{ id: 'cat-clothes', name: 'Clothes & shoes' }],
        'Gemini'
      );

      expect(result.isTransaction).toBe(true);
      expect(result.amount).toBe(38431);
      expect(result.counterParty).toBe('Nu Fit');
      expect(result.matchedCategoryId).toBe('cat-clothes');
    });
  });

  describe('FallbackAiProvider failover on parsing errors', () => {
    it('fails over to secondary provider when primary provider returns malformed output', async () => {
      const mockPrimary = {
        providerName: 'PrimaryBroken',
        processEmailTransactionMessage: vi.fn().mockRejectedValue(
          new AiResponseParseError('Failed to parse JSON response: User Safety: safe')
        ),
        processTextMessage: vi.fn(),
        processImageMessage: vi.fn(),
      };

      const mockSecondary = {
        providerName: 'SecondaryHealthy',
        processEmailTransactionMessage: vi.fn().mockResolvedValue({
          isTransaction: true,
          transactionType: 'EXPENSE',
          amount: 38431,
          counterParty: 'Nu Fit',
          accountNameHint: 'Jago Expense',
          matchedAccountId: 'acc-jago',
          note: '1x Nu Fit - Kaos Kaki Olahraga',
          recordDate: '2026-10-29T15:05:15.000Z',
        }),
        processTextMessage: vi.fn(),
        processImageMessage: vi.fn(),
      };

      const fallbackProvider = new FallbackAiProvider([mockPrimary as any, mockSecondary as any]);

      const result = await fallbackProvider.processEmailTransactionMessage(
        dummyGateResult,
        'Pembayaranmu Berhasil Dikonfirmasi',
        'info@mail.shopee.co.id',
        'Clean body text',
        new Date('2026-10-29T15:05:15.000Z'),
        [],
        []
      );

      expect(result.isTransaction).toBe(true);
      expect(result.counterParty).toBe('Nu Fit');
      expect(mockPrimary.processEmailTransactionMessage).toHaveBeenCalledTimes(1);
      expect(mockSecondary.processEmailTransactionMessage).toHaveBeenCalledTimes(1);
    });
  });

  describe('EmailListenerService Retry & Dead Letter Queue (DLQ)', () => {
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

    it('retries transient failures and routes to DLQ after reaching max attempts', async () => {
      const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wallet-dlq-test-'));
      const recordedDlqItems: DeadLetterQueueItem[] = [];
      let callbackAttempts = 0;

      const messageId = 'failing-message-1@example.com';
      const rawEmail = buildRawEmail(
        messageId,
        'Notifikasi Transaksi',
        'notifications@bankmandiri.co.id',
        'Nominal: Rp 75.000\nNo. Referensi: REF-FAIL-99'
      );

      try {
        const service = new EmailListenerService(
          'imap.example.com',
          993,
          'user@example.com',
          'password',
          10,
          async () => {
            callbackAttempts += 1;
            throw new Error(`Persistent failure attempt ${callbackAttempts}`);
          },
          cacheDir,
          undefined,
          undefined,
          3, // max retry attempts
          dlqItem => {
            recordedDlqItems.push(dlqItem);
          }
        );

        // Attach fake IMAP client
        (service as any).imapClient = {
          usable: true,
          search: async () => [1],
          fetchOne: async () => ({
            source: rawEmail,
            internalDate: new Date(),
            envelope: { from: [{ address: 'notifications@bankmandiri.co.id' }], messageId: `<${messageId}>` },
          }),
        };

        // Scan 1: Attempt 1
        await service.scanRecentMessages();
        expect(callbackAttempts).toBe(1);
        expect(service.getFailedAttemptCount(messageId)).toBe(1);
        expect(service.isMessageAlreadyProcessed(messageId)).toBe(false);
        expect(service.getDeadLetterQueue()).toHaveLength(0);

        // Scan 2: Attempt 2
        await service.scanRecentMessages();
        expect(callbackAttempts).toBe(2);
        expect(service.getFailedAttemptCount(messageId)).toBe(2);
        expect(service.isMessageAlreadyProcessed(messageId)).toBe(false);
        expect(service.getDeadLetterQueue()).toHaveLength(0);

        // Scan 3: Attempt 3 (Reaches max attempts -> DLQ)
        await service.scanRecentMessages();
        expect(callbackAttempts).toBe(3);
        expect(service.isMessageAlreadyProcessed(messageId)).toBe(true);
        expect(service.getDeadLetterQueue()).toHaveLength(1);
        expect(recordedDlqItems).toHaveLength(1);
        expect(recordedDlqItems[0].messageId).toBe(`<${messageId}>`);
        expect(recordedDlqItems[0].attempts).toBe(3);
        expect(recordedDlqItems[0].lastError).toContain('Persistent failure attempt 3');

        // Scan 4: Terminal check -> Message is marked processed, no further callback calls
        await service.scanRecentMessages();
        expect(callbackAttempts).toBe(3); // Unchanged!
      } finally {
        fs.rmSync(cacheDir, { recursive: true, force: true });
      }
    });

    it('resets failure tracking when candidate succeeds on retry before max attempts', async () => {
      const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wallet-retry-recovery-'));
      let callbackAttempts = 0;

      const messageId = 'transient-recover@example.com';
      const rawEmail = buildRawEmail(
        messageId,
        'Notifikasi Transaksi',
        'notifications@bankmandiri.co.id',
        'Nominal: Rp 45.000\nNo. Referensi: REF-REC-12'
      );

      try {
        const service = new EmailListenerService(
          'imap.example.com',
          993,
          'user@example.com',
          'password',
          10,
          async () => {
            callbackAttempts += 1;
            if (callbackAttempts === 1) {
              throw new Error('Transient network timeout');
            }
          },
          cacheDir,
          undefined,
          undefined,
          3
        );

        (service as any).imapClient = {
          usable: true,
          search: async () => [1],
          fetchOne: async () => ({
            source: rawEmail,
            internalDate: new Date(),
            envelope: { from: [{ address: 'notifications@bankmandiri.co.id' }], messageId: `<${messageId}>` },
          }),
        };

        // Scan 1: Fails
        await service.scanRecentMessages();
        expect(callbackAttempts).toBe(1);
        expect(service.getFailedAttemptCount(messageId)).toBe(1);
        expect(service.isMessageAlreadyProcessed(messageId)).toBe(false);

        // Scan 2: Succeeds
        await service.scanRecentMessages();
        expect(callbackAttempts).toBe(2);
        expect(service.getFailedAttemptCount(messageId)).toBe(0); // Cleared!
        expect(service.isMessageAlreadyProcessed(messageId)).toBe(true); // Persisted!
        expect(service.getDeadLetterQueue()).toHaveLength(0); // Not in DLQ!
      } finally {
        fs.rmSync(cacheDir, { recursive: true, force: true });
      }
    });
  });

  describe('Idempotency on Retry', () => {
    function createMockWalletCache() {
      return {
        getAccounts: vi.fn().mockReturnValue([
          { id: 'acc-jago', name: 'Jago Expense', currency: 'IDR' },
          { id: 'acc-cash', name: 'Cash', currency: 'IDR' },
        ]),
        getCategories: vi.fn().mockReturnValue([
          { id: 'cat-clothes', name: 'Clothes & shoes' },
          { id: 'cat-general', name: 'Shopping' },
        ]),
        getLabels: vi.fn().mockReturnValue([]),
      };
    }

    it('merges seamlessly into pending transaction created in the meantime without duplicating tickets', async () => {
      const pendingService = new PendingTransactionService();
      const correlationService = new TransactionCorrelationService();
      const mockMessaging = {
        broadcastNotification: vi.fn().mockResolvedValue(undefined),
        sendMessage: vi.fn().mockResolvedValue(undefined),
      };

      const mockAiProvider = {
        providerName: 'mock-ai',
        processEmailTransactionMessage: vi.fn().mockResolvedValue({
          isTransaction: true,
          transactionType: 'EXPENSE',
          amount: 38431,
          counterParty: 'Nu Fit (Shopee)',
          accountNameHint: 'Cash',
          matchedAccountId: 'acc-cash',
          matchedCategoryId: 'cat-clothes',
          matchedCategoryName: 'Clothes & shoes',
          note: '1x Nu Fit - Kaos Kaki Olahraga',
          recordDate: '2026-10-29T15:05:15.000Z',
          referenceNumber: '261029VNREYMEW',
        }),
        processTextMessage: vi.fn(),
        processImageMessage: vi.fn(),
      };

      // Step 1: Bank debit card transaction arrived earlier and created pending ticket #1
      const initialPending = pendingService.addPendingTransaction({
        sourceType: 'EMAIL',
        bankDisplayName: 'Bank Jago',
        accountNameHint: 'Jago Expense',
        matchedAccountId: 'acc-jago',
        amount: -38431,
        currency: 'IDR',
        transactionType: 'EXPENSE',
        counterParty: 'Jago Debit Card',
        note: 'Transaksi kartu debit Jago sebesar Rp38.431',
        recordDate: '2026-10-29T15:05:13.000Z',
        matchedCategoryId: 'cat-general',
        matchedCategoryName: 'Shopping',
        referenceNumbers: [],
        evidenceSources: ['EMAIL_BANK'],
      });

      expect(pendingService.getAllPendingTransactions()).toHaveLength(1);
      expect(initialPending.ticketId).toBe(1);

      // Step 2: Shopee email retries after transient failure and runs through handler
      const handler = new EmailTransactionHandler(
        mockAiProvider as any,
        createMockWalletCache() as any,
        pendingService,
        mockMessaging as any,
        'IDR',
        correlationService
      );

      await handler.handleEmailTransactionDetected({
        gateResult: dummyGateResult,
        emailSubject: 'Pembayaranmu Berhasil Dikonfirmasi',
        emailSender: 'info@mail.shopee.co.id',
        emailDate: new Date('2026-10-29T15:05:15.000Z'),
        cleanedBodyText: 'Nu Fit Kaos Kaki Olahraga Rp 38.431',
        rawMessageId: '<shopee-261029VNREYMEW@mail.shopee.co.id>',
      });

      // Verification: Still exactly 1 pending transaction, successfully fused!
      const allPending = pendingService.getAllPendingTransactions();
      expect(allPending).toHaveLength(1);
      expect(allPending[0].ticketId).toBe(1);
      expect(allPending[0].counterParty).toBe('Nu Fit (Shopee)');
      expect(allPending[0].note).toBe('1x Nu Fit - Kaos Kaki Olahraga');
      expect(allPending[0].referenceNumbers).toContain('261029VNREYMEW');
      expect(mockMessaging.broadcastNotification).toHaveBeenCalledWith(
        expect.stringContaining('Transaksi Diperkaya')
      );
    });

    it('attaches cleanly to existing Wallet record if user confirmed bank transaction earlier', async () => {
      const pendingService = new PendingTransactionService();
      const correlationService = new TransactionCorrelationService();
      const mockMessaging = {
        broadcastNotification: vi.fn().mockResolvedValue(undefined),
        sendMessage: vi.fn().mockResolvedValue(undefined),
      };

      const mockWalletClient = {
        fetchRecords: vi.fn().mockResolvedValue({
          records: [
            {
              id: 'rec-wallet-jago-99',
              amount: -38431,
              currency: 'IDR',
              recordType: 'expense',
              recordDate: '2026-10-29T15:05:13.000Z',
              accountId: 'acc-jago',
              note: 'Debit Card Jago',
            },
          ],
        }),
      };

      const mockAiProvider = {
        providerName: 'mock-ai',
        processEmailTransactionMessage: vi.fn().mockResolvedValue({
          isTransaction: true,
          transactionType: 'EXPENSE',
          amount: 38431,
          counterParty: 'Shopee',
          accountNameHint: 'Jago Expense',
          matchedAccountId: 'acc-jago',
          matchedCategoryId: 'cat-clothes',
          matchedCategoryName: 'Clothes & shoes',
          note: 'Kaos Kaki',
          recordDate: '2026-10-29T15:05:15.000Z',
          referenceNumber: '261029VNREYMEW',
        }),
        processTextMessage: vi.fn(),
        processImageMessage: vi.fn(),
      };

      const handler = new EmailTransactionHandler(
        mockAiProvider as any,
        createMockWalletCache() as any,
        pendingService,
        mockMessaging as any,
        'IDR',
        correlationService,
        undefined,
        mockWalletClient as any
      );

      await handler.handleEmailTransactionDetected({
        gateResult: dummyGateResult,
        emailSubject: 'Pembayaranmu Berhasil Dikonfirmasi',
        emailSender: 'info@mail.shopee.co.id',
        emailDate: new Date('2026-10-29T15:05:15.000Z'),
        cleanedBodyText: 'Shopee Rp 38.431',
        rawMessageId: '<shopee-261029VNREYMEW@mail.shopee.co.id>',
      });

      // No new pending item created
      expect(pendingService.getAllPendingTransactions()).toHaveLength(0);
      expect(mockMessaging.broadcastNotification).toHaveBeenCalledWith(
        expect.stringContaining('rec-wallet-jago-99')
      );
    });
  });
});
