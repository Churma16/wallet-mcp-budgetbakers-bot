import { beforeEach, describe, expect, it } from 'vitest';
import { TransactionCorrelationEngine } from '../src/email/index.js';
import { InformationDensityResolver } from '../src/email/correlation/densityResolver.js';
import { InboundReferenceRegistry } from '../src/core/referenceRegistry.js';
import { TransactionEvidence } from '../src/email/types.js';
import { PendingTransactionItem } from '../src/core/pending.js';
import { WalletRecordItem } from '../src/wallet/types.js';

describe('Correlation Golden Matrix & Real-World Reproduction Tests', () => {
  let service: TransactionCorrelationEngine;
  let registry: InboundReferenceRegistry;
  let densityResolver: InformationDensityResolver;

  beforeEach(() => {
    service = new TransactionCorrelationEngine();
    registry = InboundReferenceRegistry.getInstance();
    registry.clear();
    densityResolver = new InformationDensityResolver();
  });

  describe('Case A: Production GrabFood 3-Way Event Triangle', () => {
    it('correlates Jago debit, GrabFood receipt, and 40-minute delayed Grab push notification deterministically via Gate 2', () => {
      // 1. 16:24:26 WIB - Bank Jago debit card push notification arrives
      const jagoDebitPending: PendingTransactionItem = {
        ticketId: 101,
        sourceType: 'PUSH_NOTIFICATION',
        bankDisplayName: 'Bank Jago',
        accountNameHint: 'Jago Main',
        matchedAccountId: 'acc-jago-main',
        counterParty: 'Unknown',
        amount: -54500,
        currency: 'IDR',
        transactionType: 'EXPENSE',
        matchedCategoryId: 'cat-shopping',
        matchedCategoryName: 'Shopping',
        note: "You've paid Rp54.500 using your debit card",
        recordDate: '2026-10-31T09:24:26.000Z',
        referenceNumbers: [],
        evidenceSources: ['PUSH_NOTIFICATION'],
        createdAt: new Date('2026-10-31T09:24:26.000Z'),
        expiresAt: new Date('2026-11-01T09:24:26.000Z'),
      };

      // 2. 16:24:26 WIB - GrabFood itemized email receipt arrives concurrently
      const grabFoodEmailEvidence: TransactionEvidence = {
        sourceType: 'EMAIL_PAYMENT',
        sourceId: 'email-grabfood-receipt-1',
        merchant: "d'BestO - RSUD Koja",
        amount: -54500,
        currency: 'IDR',
        transactionType: 'EXPENSE',
        accountHint: 'Visa 4295',
        categoryId: 'cat-food',
        categoryName: 'Makanan & Minuman',
        note: "1x Paket Sadas 1, 1x Nasi Putih dari d'BestO - RSUD Koja",
        occurredAt: '2026-10-31T09:24:26.000Z',
        referenceNumbers: ['A-A25H64IGWHTNAV'],
      };

      // Correlate receipt with pending bank debit
      const correlation1 = service.correlateEvidence(grabFoodEmailEvidence, [jagoDebitPending], []);
      expect(correlation1.confidence).toBe('HIGH');
      expect(correlation1.suggestedAction).toBe('MERGE_PENDING');

      const fusedPending = correlation1.fusedPendingItem!;
      expect(fusedPending.counterParty).toBe("d'BestO - RSUD Koja");
      expect(fusedPending.matchedAccountId).toBe('acc-jago-main');
      expect(fusedPending.matchedCategoryName).toBe('Makanan & Minuman');
      expect(fusedPending.referenceNumbers).toContain('A-A25H64IGWHTNAV');

      // System records to Wallet MCP and registers reference in shared registry
      const createdRecordId = 'rec-wallet-jago-dbesto-101';
      registry.recordReferences(fusedPending.referenceNumbers || ['A-A25H64IGWHTNAV'], {
        recordId: createdRecordId,
        amount: -54500,
        currency: 'IDR',
        accountId: 'acc-jago-main',
        source: 'email',
      });

      const existingRecord: WalletRecordItem = {
        id: createdRecordId,
        accountId: 'acc-jago-main',
        amount: -54500,
        currency: 'IDR',
        recordDate: '2026-10-31T09:24:26.000Z',
        recordType: 'expense',
        counterParty: "d'BestO - RSUD Koja",
        note: "1x Paket Sadas 1, 1x Nasi Putih dari d'BestO - RSUD Koja",
      };

      // 3. 17:04:21 WIB (40 mins later) - Grab completion push notification arrives
      const grabCompletionPushEvidence: TransactionEvidence = {
        sourceType: 'PUSH_NOTIFICATION',
        sourceId: 'push-grab-completion-1',
        merchant: 'Grab',
        amount: -54500,
        currency: 'IDR',
        transactionType: 'EXPENSE',
        accountHint: 'Visa 4295',
        note: 'Your Visa 4295 has been charged RP 54.500,00 for booking A-A25H64IGWHTNAV',
        occurredAt: '2026-10-31T10:04:21.000Z', // 40 minutes later
        referenceNumbers: ['A-A25H64IGWHTNAV'],
      };

      // Correlate completion push notification against existing Wallet record
      const correlation2 = service.correlateEvidence(grabCompletionPushEvidence, [], [existingRecord]);

      // Gate 2 must immediately lock and attach without probabilistic score degradation
      expect(correlation2.confidence).toBe('HIGH');
      expect(correlation2.suggestedAction).toBe('ATTACH_WALLET_RECORD');
      if (correlation2.matchTarget.type === 'WALLET_RECORD') {
        expect(correlation2.matchTarget.record.id).toBe(createdRecordId);
      }
      expect(correlation2.reasons.some(r => r.includes('A-A25H64IGWHTNAV'))).toBe(true);
    });
  });

  describe('Case B: GoPay + Bliblimart Sarana Jaya Token Overlap', () => {
    it('correlates bank debit with Bliblimart receipt via literal token overlap without external platform taxonomy', () => {
      const bankCandidate: PendingTransactionItem = {
        ticketId: 201,
        sourceType: 'EMAIL',
        bankDisplayName: 'BCA',
        accountNameHint: 'BCA Utama',
        matchedAccountId: 'acc-bca-main',
        counterParty: 'BLIBLI.COM KUDUS - ID',
        amount: -35900,
        currency: 'IDR',
        transactionType: 'EXPENSE',
        matchedCategoryId: 'cat-general',
        matchedCategoryName: 'Belanja',
        note: 'Pembayaran EDC BCA',
        recordDate: '2026-11-01T04:00:00.000Z',
        referenceNumbers: ['BCA-TX-3388'],
        createdAt: new Date('2026-11-01T04:00:00.000Z'),
        expiresAt: new Date('2026-11-02T04:00:00.000Z'),
      };

      const blibliReceiptEvidence: TransactionEvidence = {
        sourceType: 'EMAIL_PAYMENT',
        sourceId: 'blibli-order-5544',
        merchant: 'Bliblimart Sarana Jaya',
        amount: -35900,
        currency: 'IDR',
        transactionType: 'EXPENSE',
        note: '1x Susu Ultra Milk 1L, 1x Roti Tawar Kupas',
        occurredAt: '2026-11-01T04:01:10.000Z',
        referenceNumbers: ['BLI-ORDER-5544'],
      };

      const result = service.correlateEvidence(blibliReceiptEvidence, [bankCandidate], []);
      expect(result.confidence).toBe('HIGH');
      expect(result.suggestedAction).toBe('MERGE_PENDING');
      expect(result.fusedPendingItem?.counterParty).toBe('Bliblimart Sarana Jaya');
      expect(result.fusedPendingItem?.matchedAccountId).toBe('acc-bca-main');
      expect(result.fusedPendingItem?.note).toContain('1x Susu Ultra Milk 1L, 1x Roti Tawar Kupas');
    });
  });

  describe('Case C: Jago + Gojez Store QRIS Token Overlap', () => {
    it('correlates QRIS debit mentioning merchant with merchant receipt', () => {
      const jagoQrisPending: PendingTransactionItem = {
        ticketId: 301,
        sourceType: 'PUSH_NOTIFICATION',
        bankDisplayName: 'Bank Jago',
        accountNameHint: 'Jago Main',
        matchedAccountId: 'acc-jago-main',
        counterParty: 'Gojez Store Kudus',
        amount: -25000,
        currency: 'IDR',
        transactionType: 'EXPENSE',
        matchedCategoryId: 'cat-general',
        matchedCategoryName: 'Belanja',
        note: 'Pembayaran QRIS Rp 25.000 di Gojez Store Kudus',
        recordDate: '2026-11-02T08:00:00.000Z',
        referenceNumbers: [],
        createdAt: new Date('2026-11-02T08:00:00.000Z'),
        expiresAt: new Date('2026-11-03T08:00:00.000Z'),
      };

      const merchantReceiptEvidence: TransactionEvidence = {
        sourceType: 'RECEIPT',
        sourceId: 'rec-gojez-001',
        merchant: 'Gojez Store',
        amount: -25000,
        currency: 'IDR',
        transactionType: 'EXPENSE',
        note: '2x Kopi Susu Aren Gula Aren',
        occurredAt: '2026-11-02T08:00:30.000Z',
        referenceNumbers: ['GOJEZ-REC-001'],
      };

      const result = service.correlateEvidence(merchantReceiptEvidence, [jagoQrisPending], []);
      expect(result.confidence).toBe('HIGH');
      expect(result.suggestedAction).toBe('MERGE_PENDING');
      expect(result.fusedPendingItem?.counterParty).toBe('Gojez Store');
      expect(result.fusedPendingItem?.note).toContain('2x Kopi Susu Aren Gula Aren');
    });
  });

  describe('Case D: Jago + GrabUnlimited Subscription', () => {
    it('correlates generic Jago debit card fee with GrabUnlimited subscription receipt', () => {
      const jagoDebitPending: PendingTransactionItem = {
        ticketId: 401,
        sourceType: 'EMAIL',
        bankDisplayName: 'Bank Jago',
        accountNameHint: 'Jago Main',
        matchedAccountId: 'acc-jago-main',
        counterParty: 'Unknown',
        amount: -9000,
        currency: 'IDR',
        transactionType: 'EXPENSE',
        matchedCategoryId: 'cat-general',
        matchedCategoryName: 'Belanja',
        note: 'Transaksi Kartu Debit Bank Jago',
        recordDate: '2026-11-03T02:00:00.000Z',
        referenceNumbers: [],
        createdAt: new Date('2026-11-03T02:00:00.000Z'),
        expiresAt: new Date('2026-11-04T02:00:00.000Z'),
      };

      const subscriptionEvidence: TransactionEvidence = {
        sourceType: 'EMAIL_PAYMENT',
        sourceId: 'email-grabunlimited-1',
        merchant: 'GrabUnlimited Subscription',
        amount: -9000,
        currency: 'IDR',
        transactionType: 'EXPENSE',
        accountHint: 'Visa 4295',
        note: 'Biaya Langganan Bulanan GrabUnlimited',
        occurredAt: '2026-11-03T02:00:15.000Z',
        referenceNumbers: ['GRAB-SUB-9000'],
      };

      const result = service.correlateEvidence(subscriptionEvidence, [jagoDebitPending], []);
      expect(result.confidence).toBe('HIGH');
      expect(result.suggestedAction).toBe('MERGE_PENDING');
      expect(result.fusedPendingItem?.counterParty).toBe('GrabUnlimited Subscription');
      expect(result.fusedPendingItem?.note).toBe('Biaya Langganan Bulanan GrabUnlimited');
    });
  });

  describe('Case E: Distinct Conflicting Stores Anti-Merge (Safety Veto)', () => {
    it('vetoes merging when stores conflict even if amount, currency, and time align', () => {
      const starbucksRecord: WalletRecordItem = {
        id: 'rec-sbux-1',
        accountId: 'acc-bca-main',
        amount: -55000,
        currency: 'IDR',
        recordDate: '2026-11-04T09:00:00.000Z',
        recordType: 'expense',
        counterParty: 'Starbucks Coffee',
        note: '1x Caramel Macchiato',
      };

      const indomaretEvidence: TransactionEvidence = {
        sourceType: 'EMAIL_PAYMENT',
        sourceId: 'indomaret-01',
        merchant: 'Indomaret Point',
        amount: -55000,
        currency: 'IDR',
        transactionType: 'EXPENSE',
        note: '1x Belanja Indomaret Point',
        occurredAt: '2026-11-04T09:01:00.000Z',
        referenceNumbers: ['IND-REF-1'],
      };

      const result = service.correlateEvidence(indomaretEvidence, [], [starbucksRecord]);
      expect(result.confidence).toBe('LOW');
      expect(result.suggestedAction).toBe('CREATE_INDEPENDENT');
      expect(result.reasons.some(r => r.includes('conflicting stores veto'))).toBe(true);
    });
  });

  describe('Case F: Multi-Candidate Disambiguation Circuit Breaker', () => {
    it('triggers clarification when two candidate transactions score closely within delta < 0.08', () => {
      const candidateTrip1: PendingTransactionItem = {
        ticketId: 601,
        sourceType: 'PUSH_NOTIFICATION',
        bankDisplayName: 'Bank Jago',
        accountNameHint: 'Jago Main',
        matchedAccountId: 'acc-jago-main',
        counterParty: 'Unknown',
        amount: -24000,
        currency: 'IDR',
        transactionType: 'EXPENSE',
        matchedCategoryId: 'cat-transport',
        matchedCategoryName: 'Transportasi',
        note: 'Debit card charge Rp24.000 trip 1',
        recordDate: '2026-11-05T01:00:00.000Z',
        referenceNumbers: [],
        createdAt: new Date('2026-11-05T01:00:00.000Z'),
        expiresAt: new Date('2026-11-06T01:00:00.000Z'),
      };

      const candidateTrip2: PendingTransactionItem = {
        ticketId: 602,
        sourceType: 'PUSH_NOTIFICATION',
        bankDisplayName: 'Bank Jago',
        accountNameHint: 'Jago Main',
        matchedAccountId: 'acc-jago-main',
        counterParty: 'Unknown',
        amount: -24000,
        currency: 'IDR',
        transactionType: 'EXPENSE',
        matchedCategoryId: 'cat-transport',
        matchedCategoryName: 'Transportasi',
        note: 'Debit card charge Rp24.000 trip 2',
        recordDate: '2026-11-05T01:05:00.000Z',
        referenceNumbers: [],
        createdAt: new Date('2026-11-05T01:05:00.000Z'),
        expiresAt: new Date('2026-11-06T01:05:00.000Z'),
      };

      // Grab receipt arrives at 01:06 (1m after trip 2, 6m after trip 1) without booking ref
      const grabReceiptEvidence: TransactionEvidence = {
        sourceType: 'EMAIL_PAYMENT',
        sourceId: 'grab-trip-ambiguous',
        merchant: 'GrabBike',
        amount: -24000,
        currency: 'IDR',
        transactionType: 'EXPENSE',
        note: 'GrabBike trip',
        occurredAt: '2026-11-05T01:06:00.000Z',
        referenceNumbers: [],
      };

      const result = service.correlateEvidence(
        grabReceiptEvidence,
        [candidateTrip1, candidateTrip2],
        []
      );

      // Disambiguation circuit breaker must prevent blind auto-merge
      expect(result.confidence).toBe('MEDIUM');
      expect(result.suggestedAction).toBe('CLARIFY');
      expect(result.clarificationPrompt).toBeDefined();
      expect(result.reasons.some(r => r.includes('disambiguation delta'))).toBe(true);
    });
  });

  describe('Case G: Arrival Order Invariance', () => {
    it('produces identical fused state regardless of whether Bank Debit arrives first or Merchant Receipt arrives first', () => {
      const bankEvent = {
        sourceType: 'EMAIL' as const,
        bankDisplayName: 'Bank Mandiri (Livin)',
        accountNameHint: 'Mandiri',
        matchedAccountId: 'acc-mandiri-123',
        counterParty: 'MANDIRI EDC KUDUS',
        amount: -45000,
        currency: 'IDR',
        note: 'Transaksi Debit Mandiri',
        recordDate: '2026-11-06T03:00:00.000Z',
        referenceNumbers: ['MANDIRI-REF-1'],
      };

      const receiptEvent: TransactionEvidence = {
        sourceType: 'EMAIL_PAYMENT',
        sourceId: 'tokopedia-order-1',
        merchant: 'Tokopedia Official Store',
        amount: -45000,
        currency: 'IDR',
        transactionType: 'EXPENSE',
        accountHint: 'Cash',
        accountId: 'acc-cash',
        note: '2x Buku Tulis Sinar Dunia 58 Lembar',
        occurredAt: '2026-11-06T03:01:00.000Z',
        referenceNumbers: ['TOPED-REF-1'],
        categoryId: 'cat-books',
        categoryName: 'Buku & Alat Tulis',
      };

      // Order A: Bank candidate first, then Receipt arrives
      const candidateA: PendingTransactionItem = {
        ticketId: 701,
        ...bankEvent,
        transactionType: 'EXPENSE',
        createdAt: new Date(bankEvent.recordDate),
        expiresAt: new Date(Date.parse(bankEvent.recordDate) + 86400000),
      };
      const resultA = service.correlateEvidence(receiptEvent, [candidateA], []);
      expect(resultA.confidence).toBe('HIGH');
      const fusedA = resultA.fusedPendingItem!;

      // Order B: Receipt candidate first, then Bank arrives
      const candidateB: PendingTransactionItem = {
        ticketId: 702,
        sourceType: 'EMAIL',
        counterParty: receiptEvent.merchant,
        amount: receiptEvent.amount,
        currency: receiptEvent.currency,
        transactionType: 'EXPENSE',
        accountNameHint: receiptEvent.accountHint,
        matchedAccountId: receiptEvent.accountId,
        matchedCategoryId: receiptEvent.categoryId,
        matchedCategoryName: receiptEvent.categoryName,
        note: receiptEvent.note,
        recordDate: receiptEvent.occurredAt,
        referenceNumbers: receiptEvent.referenceNumbers,
        createdAt: new Date(receiptEvent.occurredAt),
        expiresAt: new Date(Date.parse(receiptEvent.occurredAt) + 86400000),
      };

      const bankEvidence: TransactionEvidence = {
        sourceType: 'EMAIL_BANK',
        sourceId: 'mandiri-email-1',
        amount: bankEvent.amount,
        currency: bankEvent.currency,
        transactionType: 'EXPENSE',
        accountId: bankEvent.matchedAccountId,
        accountHint: bankEvent.accountNameHint,
        merchant: bankEvent.counterParty,
        note: bankEvent.note,
        occurredAt: bankEvent.recordDate,
        referenceNumbers: bankEvent.referenceNumbers,
      };

      const resultB = service.correlateEvidence(bankEvidence, [candidateB], []);
      expect(resultB.confidence).toBe('HIGH');
      const fusedB = resultB.fusedPendingItem!;

      // Both must resolve to the authoritative bank account
      expect(fusedA.matchedAccountId).toBe('acc-mandiri-123');
      expect(fusedB.matchedAccountId).toBe('acc-mandiri-123');

      // Both must resolve to the clean merchant name
      expect(fusedA.counterParty).toBe('Tokopedia Official Store');
      expect(fusedB.counterParty).toBe('Tokopedia Official Store');

      // Both must retain the itemized rich note
      expect(fusedA.note).toContain('2x Buku Tulis Sinar Dunia');
      expect(fusedB.note).toContain('2x Buku Tulis Sinar Dunia');

      // Both must retain combined reference numbers
      expect(fusedA.referenceNumbers).toContain('MANDIRI-REF-1');
      expect(fusedA.referenceNumbers).toContain('TOPED-REF-1');
      expect(fusedB.referenceNumbers).toContain('MANDIRI-REF-1');
      expect(fusedB.referenceNumbers).toContain('TOPED-REF-1');
    });
  });
});
