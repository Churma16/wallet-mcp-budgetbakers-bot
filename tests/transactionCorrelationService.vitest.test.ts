import { describe, expect, it } from 'vitest';
import { TransactionCorrelationService } from '../src/services/transactionCorrelationService.js';
import { PendingTransactionItem } from '../src/services/pendingTransactionService.js';
import { TransactionEvidence } from '../src/types/transactionCorrelationTypes.js';
import { WalletRecordItem } from '../src/types/walletTypes.js';

describe('TransactionCorrelationService (Issue #153)', () => {
  const service = new TransactionCorrelationService({
    maxCorrelationWindowMilliseconds: 30 * 60 * 1000,
    tightWindowMilliseconds: 15 * 60 * 1000,
  });

  const baseInstant = '2026-10-14T10:18:00.000Z';

  function createPendingItem(overrides: Partial<PendingTransactionItem> = {}): PendingTransactionItem {
    return {
      ticketId: 1,
      sourceType: 'EMAIL',
      bankDisplayName: 'Bank Mandiri (Livin)',
      accountNameHint: 'Mandiri',
      counterParty: 'BLIBLI.COM KUDUS - ID',
      amount: -16700,
      currency: 'IDR',
      transactionType: 'EXPENSE',
      matchedAccountId: 'acc-mandiri-123',
      matchedCategoryId: 'cat-general',
      matchedCategoryName: 'Belanja',
      note: 'Pembayaran QRIS',
      recordDate: baseInstant,
      referenceNumber: '2610131121541342066',
      referenceNumbers: ['2610131121541342066'],
      evidenceSources: ['EMAIL_BANK'],
      createdAt: new Date(baseInstant),
      expiresAt: new Date(Date.parse(baseInstant) + 86400000),
      ...overrides,
    };
  }

  function createEvidence(overrides: Partial<TransactionEvidence> = {}): TransactionEvidence {
    return {
      sourceType: 'EMAIL_PAYMENT',
      sourceId: 'Pembayaran QRIS Anda Telah Kami Terima',
      amount: -16700,
      currency: 'IDR',
      occurredAt: '2026-10-14T10:18:15.000Z', // 15 seconds later
      merchant: 'Blibli Offline Store',
      accountHint: 'Cash',
      accountId: 'acc-cash',
      referenceNumbers: ['12198693563'],
      note: '2x Bakwan Sayur [1pcs], 1x NASI UDUK + TELUR',
      categoryId: 'cat-food',
      categoryName: 'Makanan & Minuman',
      transactionType: 'EXPENSE',
      ...overrides,
    };
  }

  describe('cross-source correlation (Bank debit + Merchant receipt)', () => {
    it('correlates a Blibli merchant receipt with an existing Mandiri bank debit candidate', () => {
      const bankCandidate = createPendingItem();
      const blibliEvidence = createEvidence();

      const result = service.correlateEvidence(blibliEvidence, [bankCandidate]);

      expect(result.confidence).toBe('HIGH');
      expect(result.suggestedAction).toBe('MERGE_PENDING');
      expect(result.matchTarget.type).toBe('PENDING_TRANSACTION');
      if (result.matchTarget.type === 'PENDING_TRANSACTION') {
        expect(result.matchTarget.pendingItem.ticketId).toBe(1);
      }

      // Verify fused fields
      const fused = result.fusedPendingItem;
      expect(fused).toBeDefined();
      expect(fused?.matchedAccountId).toBe('acc-mandiri-123'); // Kept authoritative bank account
      expect(fused?.accountNameHint).toBe('Mandiri');
      expect(fused?.counterParty).toBe('Blibli Offline Store'); // Refined clean merchant name
      expect(fused?.note).toBe('2x Bakwan Sayur [1pcs], 1x NASI UDUK + TELUR'); // Rich item breakdown
      expect(fused?.matchedCategoryId).toBe('cat-food'); // Specific food category
      expect(fused?.matchedCategoryName).toBe('Makanan & Minuman');
      expect(fused?.referenceNumbers).toContain('2610131121541342066'); // Bank ref
      expect(fused?.referenceNumbers).toContain('12198693563'); // Blibli order ID
      expect(fused?.evidenceSources).toContain('EMAIL_BANK');
      expect(fused?.evidenceSources).toContain('EMAIL_PAYMENT');
    });

    it('correlates a Grab e-receipt with an existing bank debit mentioning Grab', () => {
      const bankCandidate = createPendingItem({
        bankDisplayName: 'BCA',
        matchedAccountId: 'acc-bca',
        accountNameHint: 'BCA',
        counterParty: 'GRAB JAKARTA ID',
        amount: -70100,
        referenceNumber: 'BCA-REF-9988',
        referenceNumbers: ['BCA-REF-9988'],
        note: 'Transaksi Debit BCA',
      });

      const grabEvidence = createEvidence({
        sourceType: 'EMAIL_PAYMENT',
        merchant: 'GrabBike',
        amount: -70100,
        referenceNumbers: ['A-9UQLPJWGW8CCAV'],
        note: 'Perjalanan GrabBike ke Kantor',
        categoryId: 'cat-transport',
        categoryName: 'Transportasi',
      });

      const result = service.correlateEvidence(grabEvidence, [bankCandidate]);

      expect(result.confidence).toBe('HIGH');
      expect(result.suggestedAction).toBe('MERGE_PENDING');
      expect(result.fusedPendingItem?.matchedAccountId).toBe('acc-bca');
      expect(result.fusedPendingItem?.counterParty).toBe('GrabBike');
      expect(result.fusedPendingItem?.matchedCategoryName).toBe('Transportasi');
      expect(result.fusedPendingItem?.referenceNumbers).toContain('A-9UQLPJWGW8CCAV');
    });

    it('guarantees arrival order invariance: (Bank then Receipt) === (Receipt then Bank)', () => {
      // Scenario A: Bank arrives first, Receipt arrives second
      const bankCandidateA = createPendingItem({
        bankDisplayName: 'Bank Mandiri (Livin)',
        accountNameHint: 'Mandiri',
        matchedAccountId: 'acc-mandiri-123',
        counterParty: 'BLIBLI.COM KUDUS - ID',
        note: 'Pembayaran QRIS',
        matchedCategoryId: 'cat-general',
        matchedCategoryName: 'Belanja',
        referenceNumber: 'MANDIRI-REF-1',
        referenceNumbers: ['MANDIRI-REF-1'],
        evidenceSources: ['EMAIL_BANK'],
      });
      const receiptEvidenceA = createEvidence({
        merchant: 'Blibli Offline Store',
        note: '2x Bakwan Sayur, 1x Nasi Uduk',
        categoryId: 'cat-food',
        categoryName: 'Makanan & Minuman',
        referenceNumbers: ['ORDER-BLIBLI-99'],
        sourceType: 'EMAIL_PAYMENT',
      });
      const resultA = service.correlateEvidence(receiptEvidenceA, [bankCandidateA]);

      // Scenario B: Receipt arrives first, Bank arrives second
      const receiptCandidateB = createPendingItem({
        bankDisplayName: 'Blibli',
        accountNameHint: 'Cash',
        matchedAccountId: 'acc-cash',
        counterParty: 'Blibli Offline Store',
        note: '2x Bakwan Sayur, 1x Nasi Uduk',
        matchedCategoryId: 'cat-food',
        matchedCategoryName: 'Makanan & Minuman',
        referenceNumber: 'ORDER-BLIBLI-99',
        referenceNumbers: ['ORDER-BLIBLI-99'],
        evidenceSources: ['EMAIL_PAYMENT'],
      });
      const bankEvidenceB = createEvidence({
        sourceType: 'EMAIL_BANK',
        merchant: 'BLIBLI.COM KUDUS - ID',
        accountHint: 'Mandiri',
        accountId: 'acc-mandiri-123',
        note: 'Pembayaran QRIS',
        categoryId: 'cat-general',
        categoryName: 'Belanja',
        referenceNumbers: ['MANDIRI-REF-1'],
      });
      const resultB = service.correlateEvidence(bankEvidenceB, [receiptCandidateB]);

      expect(resultA.confidence).toBe('HIGH');
      expect(resultB.confidence).toBe('HIGH');

      const fusedA = resultA.fusedPendingItem!;
      const fusedB = resultB.fusedPendingItem!;

      // Both must resolve to Mandiri account
      expect(fusedA.matchedAccountId).toBe('acc-mandiri-123');
      expect(fusedB.matchedAccountId).toBe('acc-mandiri-123');
      expect(fusedA.accountNameHint).toBe('Mandiri');
      expect(fusedB.accountNameHint).toBe('Mandiri');

      // Both must resolve to clean merchant and items
      expect(fusedA.counterParty).toBe('Blibli Offline Store');
      expect(fusedB.counterParty).toBe('Blibli Offline Store');
      expect(fusedA.note).toBe('2x Bakwan Sayur, 1x Nasi Uduk');
      expect(fusedB.note).toBe('2x Bakwan Sayur, 1x Nasi Uduk');

      // Both must retain specific category
      expect(fusedA.matchedCategoryName).toBe('Makanan & Minuman');
      expect(fusedB.matchedCategoryName).toBe('Makanan & Minuman');

      // Both must contain all references and sources
      expect(fusedA.referenceNumbers?.sort()).toEqual(['MANDIRI-REF-1', 'ORDER-BLIBLI-99'].sort());
      expect(fusedB.referenceNumbers?.sort()).toEqual(['MANDIRI-REF-1', 'ORDER-BLIBLI-99'].sort());
      expect(fusedA.evidenceSources?.sort()).toEqual(['EMAIL_BANK', 'EMAIL_PAYMENT'].sort());
      expect(fusedB.evidenceSources?.sort()).toEqual(['EMAIL_BANK', 'EMAIL_PAYMENT'].sort());
    });
  });

  describe('correlation with existing native Wallet records', () => {
    it('correlates incoming email with an existing bank-synced Wallet record to prevent duplicate write', () => {
      const existingWalletRecord: WalletRecordItem = {
        id: 'rec-wallet-bank-sync-1',
        accountId: 'acc-mandiri-123',
        amount: -16700,
        currency: 'IDR',
        recordDate: '2026-10-14T10:15:00.000Z',
        recordType: 'expense',
        counterParty: 'BLIBLI.COM KUDUS - ID',
        source: 'bank_sync',
      };

      const emailEvidence = createEvidence({
        sourceType: 'EMAIL_BANK',
        accountId: 'acc-mandiri-123',
        amount: -16700,
        currency: 'IDR',
        occurredAt: '2026-10-14T10:18:00.000Z',
      });

      const result = service.correlateEvidence(emailEvidence, [], [existingWalletRecord]);

      expect(result.confidence).toBe('HIGH');
      expect(result.suggestedAction).toBe('ATTACH_WALLET_RECORD');
      expect(result.matchTarget.type).toBe('WALLET_RECORD');
      if (result.matchTarget.type === 'WALLET_RECORD') {
        expect(result.matchTarget.record.id).toBe('rec-wallet-bank-sync-1');
      }
    });

    it('correlates incoming email with an existing manually created Wallet record by reference ID', () => {
      const existingWalletRecord: WalletRecordItem = {
        id: 'rec-manual-1',
        accountId: 'acc-mandiri-123',
        amount: -16700,
        currency: 'IDR',
        recordDate: '2026-10-14T10:17:00.000Z',
        recordType: 'expense',
        note: 'Order ID: 12198693563',
      };

      const emailEvidence = createEvidence({
        referenceNumbers: ['12198693563'],
      });

      const result = service.correlateEvidence(emailEvidence, [], [existingWalletRecord]);

      expect(result.confidence).toBe('HIGH');
      expect(result.suggestedAction).toBe('ATTACH_WALLET_RECORD');
      if (result.matchTarget.type === 'WALLET_RECORD') {
        expect(result.matchTarget.record.id).toBe('rec-manual-1');
      }
    });
  });

  describe('false-positive protection (Safety Requirements)', () => {
    it('never merges when amounts are different', () => {
      const candidate = createPendingItem({ amount: -16700 });
      const evidence = createEvidence({ amount: -25000 });

      const result = service.correlateEvidence(evidence, [candidate]);

      expect(result.confidence).toBe('LOW');
      expect(result.suggestedAction).toBe('CREATE_INDEPENDENT');
    });

    it('never merges different currencies (IDR vs USD)', () => {
      const candidate = createPendingItem({ currency: 'IDR', amount: -100 });
      const evidence = createEvidence({ currency: 'USD', amount: -100 });

      const result = service.correlateEvidence(evidence, [candidate]);

      expect(result.confidence).toBe('LOW');
      expect(result.suggestedAction).toBe('CREATE_INDEPENDENT');
    });

    it('never merges expense and income with the same absolute amount', () => {
      const expenseCandidate = createPendingItem({
        amount: -50000,
        transactionType: 'EXPENSE',
      });
      const incomeEvidence = createEvidence({
        amount: 50000,
        transactionType: 'INCOME',
      });

      const result = service.correlateEvidence(incomeEvidence, [expenseCandidate]);

      expect(result.confidence).toBe('LOW');
      expect(result.suggestedAction).toBe('CREATE_INDEPENDENT');
    });

    it('never merges distinct conflicting merchants (Indomaret vs Starbucks)', () => {
      const candidate = createPendingItem({
        counterParty: 'Indomaret Point Kudus',
        amount: -35000,
      });
      const evidence = createEvidence({
        merchant: 'Starbucks Coffee',
        amount: -35000,
      });

      const result = service.correlateEvidence(evidence, [candidate]);

      expect(result.confidence).toBe('LOW');
      expect(result.suggestedAction).toBe('CREATE_INDEPENDENT');
    });

    it('never merges when transaction occurred outside the correlation window (> 30 mins)', () => {
      const candidate = createPendingItem({
        recordDate: '2026-10-14T08:00:00.000Z',
      });
      const evidence = createEvidence({
        occurredAt: '2026-10-14T09:15:00.000Z', // 75 minutes later
      });

      const result = service.correlateEvidence(evidence, [candidate]);

      expect(result.confidence).toBe('LOW');
      expect(result.suggestedAction).toBe('CREATE_INDEPENDENT');
    });
  });

  describe('medium confidence / clarification handling', () => {
    it('returns MEDIUM confidence and suggests clarification when amount and time match but merchant evidence is ambiguous', () => {
      const anonymousCandidate = createPendingItem({
        counterParty: '',
        bankDisplayName: 'Bank Transfer',
        note: 'Transfer',
        amount: -100000,
        referenceNumbers: [],
        referenceNumber: undefined,
      });

      const anonymousEvidence = createEvidence({
        merchant: '',
        note: 'Transfer Masuk / Keluar',
        amount: -100000,
        referenceNumbers: [],
        occurredAt: '2026-10-14T10:19:00.000Z',
      });

      const result = service.correlateEvidence(anonymousEvidence, [anonymousCandidate]);

      expect(result.confidence).toBe('MEDIUM');
      expect(result.suggestedAction).toBe('CLARIFY');
      expect(result.clarificationPrompt).toBeDefined();
    });
  });
});
