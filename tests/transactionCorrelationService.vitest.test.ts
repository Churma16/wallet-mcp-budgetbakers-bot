import { describe, expect, it } from 'vitest';
import { TransactionCorrelationService } from '../src/email/index.js';
import { PendingTransactionItem } from '../src/core/pending.js';
import { TransactionEvidence } from '../src/email/index.js';
import { WalletRecordItem } from '../src/wallet/index.js';
import {
  formatEnrichedPendingEmailTransactionNotification,
  formatCorrelatedWalletRecordNotification,
} from '../src/wallet/formatters/humanResponseFormatter.js';

describe('TransactionCorrelationService', () => {
  const service = new TransactionCorrelationService();

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

    it('correlates authoritative Bank Jago debit with GrabFood receipt when payment method is generic Visa, even across 27-minute delivery window', () => {
      const bankDebitCandidate = createPendingItem({
        bankDisplayName: 'Bank Jago',
        accountNameHint: 'Jago Expense',
        matchedAccountId: 'acc-jago-expense',
        counterParty: 'Bank Jago',
        amount: -54500,
        currency: 'IDR',
        transactionType: 'EXPENSE',
        matchedCategoryId: 'cat-uncategorized',
        matchedCategoryName: 'Uncategorized',
        note: 'Debit card transaction',
        recordDate: '2026-10-20T04:00:40.000Z',
        referenceNumber: undefined,
        referenceNumbers: [],
        evidenceSources: ['EMAIL_BANK'],
      });

      const grabReceiptEvidence = createEvidence({
        sourceType: 'EMAIL_PAYMENT',
        sourceId: 'Your Grab E-Receipt',
        merchant: "d'BestO - RSUD Koja",
        amount: -54500,
        currency: 'IDR',
        occurredAt: '2026-10-20T04:27:48.000Z', // 27 minutes 8 seconds later
        accountHint: 'Visa',
        accountId: 'acc-mandiri-tentative', // AI tentative guess
        note: "GrabFood dari d'BestO - RSUD Koja: 1x Paket Sadas, 1x CLBK Paha Atas, 2x Paha Atas, 1x Dada, 1x CLBK Dada",
        categoryId: 'cat-food-pokok',
        categoryName: 'Makan Pokok',
        referenceNumbers: ['A-9VQEFJMWW96JAV'],
      });

      const result = service.correlateEvidence(grabReceiptEvidence, [bankDebitCandidate]);

      expect(result.confidence).toBe('HIGH');
      expect(result.suggestedAction).toBe('MERGE_PENDING');

      const fused = result.fusedPendingItem!;
      // Bank Jago remains the authoritative account
      expect(fused.matchedAccountId).toBe('acc-jago-expense');
      expect(fused.accountNameHint).toBe('Jago Expense');
      // Merchant and note are enriched by Grab
      expect(fused.counterParty).toBe("d'BestO - RSUD Koja");
      expect(fused.note).toContain("GrabFood dari d'BestO - RSUD Koja");
      expect(fused.matchedCategoryName).toBe('Makan Pokok');
      expect(fused.referenceNumbers).toContain('A-9VQEFJMWW96JAV');
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

    it('never merges when transaction occurred outside the correlation window (> 2 hours)', () => {
      const candidate = createPendingItem({
        recordDate: '2026-10-14T08:00:00.000Z',
      });
      const evidence = createEvidence({
        occurredAt: '2026-10-14T11:00:00.000Z', // 180 minutes later (> 120 mins)
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

  describe('Wallet record correlation edge branches', () => {
    it('ignores Wallet records with mismatched currency, direction, amount, or expired time window', () => {
      const baseRecord: WalletRecordItem = {
        id: 'rec-test-1',
        accountId: 'acc-mandiri-123',
        amount: -16700,
        currency: 'IDR',
        recordDate: '2026-10-14T10:18:00.000Z',
        recordType: 'expense',
      };

      const evidence = createEvidence({ occurredAt: '2026-10-14T10:18:00.000Z' });

      // Currency mismatch
      expect(
        service.correlateEvidence(evidence, [], [{ ...baseRecord, currency: 'USD' }]).suggestedAction
      ).toBe('CREATE_INDEPENDENT');

      // Direction mismatch
      expect(
        service.correlateEvidence(evidence, [], [{ ...baseRecord, recordType: 'income' }]).suggestedAction
      ).toBe('CREATE_INDEPENDENT');

      // Amount mismatch
      expect(
        service.correlateEvidence(evidence, [], [{ ...baseRecord, amount: -20000 }]).suggestedAction
      ).toBe('CREATE_INDEPENDENT');

      // Time difference > 2 hours
      expect(
        service.correlateEvidence(evidence, [], [
          { ...baseRecord, recordDate: '2026-10-14T05:00:00.000Z' },
        ]).suggestedAction
      ).toBe('CREATE_INDEPENDENT');

      // Account matches but neither merchant nor bank_sync matches
      expect(
        service.correlateEvidence(
          createEvidence({ merchant: 'Completely Different Payee', referenceNumbers: [] }),
          [],
          [{ ...baseRecord, counterParty: 'Some Other Store', source: 'manual' }]
        ).suggestedAction
      ).toBe('CREATE_INDEPENDENT');
    });

    it('prevents false-positive deduplication on bank-synced accounts when merchants conflict (Finding 1)', () => {
      // Existing Wallet record from bank-sync: Rp 50.000 spent at Alfamart
      const alfamartRecord: WalletRecordItem = {
        id: 'rec-mandiri-alfamart',
        accountId: 'acc-mandiri-123',
        amount: -50000,
        currency: 'IDR',
        recordDate: '2026-10-14T10:00:00.000Z',
        recordType: 'expense',
        counterParty: 'ALFAMART KUDUS',
        source: 'bank_sync',
      };

      // 40 minutes later, user spends Rp 50.000 at Starbucks with the same Mandiri account
      const starbucksEvidence = createEvidence({
        sourceType: 'EMAIL_BANK',
        merchant: 'Starbucks Coffee',
        accountId: 'acc-mandiri-123',
        amount: -50000,
        occurredAt: '2026-10-14T10:40:00.000Z',
        referenceNumbers: ['MANDIRI-REF-STARBUCKS'],
      });

      const result = service.correlateEvidence(starbucksEvidence, [], [alfamartRecord]);

      // Must NOT attach to Alfamart! Must remain separate (CREATE_INDEPENDENT)
      expect(result.suggestedAction).toBe('CREATE_INDEPENDENT');
      expect(result.confidence).toBe('LOW');
    });

    it('attaches to bank-sync Wallet record when merchant matches or reference matches', () => {
      const alfamartRecord: WalletRecordItem = {
        id: 'rec-mandiri-alfamart',
        accountId: 'acc-mandiri-123',
        amount: -50000,
        currency: 'IDR',
        recordDate: '2026-10-14T10:00:00.000Z',
        recordType: 'expense',
        counterParty: 'ALFAMART KUDUS',
        source: 'bank_sync',
      };

      // Same merchant (Alfamart) arrives
      const alfamartEvidence = createEvidence({
        sourceType: 'EMAIL_BANK',
        merchant: 'Alfamart',
        accountId: 'acc-mandiri-123',
        amount: -50000,
        occurredAt: '2026-10-14T10:05:00.000Z',
        referenceNumbers: [],
      });

      const result = service.correlateEvidence(alfamartEvidence, [], [alfamartRecord]);
      expect(result.suggestedAction).toBe('ATTACH_WALLET_RECORD');
      expect(result.confidence).toBe('HIGH');
    });

    it('correlates TRANSFER transactions against Wallet transfer records (Finding 2)', () => {
      const transferRecord: WalletRecordItem = {
        id: 'rec-transfer-1',
        accountId: 'acc-mandiri-123',
        amount: -250000,
        currency: 'IDR',
        recordDate: '2026-10-14T10:00:00.000Z',
        recordType: 'transfer',
        counterParty: 'Transfer ke BCA',
        note: 'REF-TRF-12345',
        transfer: {
          type: 'transfer',
          transferId: 'trf-12345',
        },
      };

      const transferEvidence = createEvidence({
        transactionType: 'TRANSFER',
        amount: -250000,
        currency: 'IDR',
        accountId: 'acc-mandiri-123',
        occurredAt: '2026-10-14T10:05:00.000Z',
        referenceNumbers: ['REF-TRF-12345'],
      });

      const result = service.correlateEvidence(transferEvidence, [], [transferRecord]);
      expect(result.suggestedAction).toBe('ATTACH_WALLET_RECORD');
      expect(result.confidence).toBe('HIGH');
    });

    it('does not match non-transfer expense evidence against a transfer record (Finding 2)', () => {
      const transferRecord: WalletRecordItem = {
        id: 'rec-transfer-1',
        accountId: 'acc-mandiri-123',
        amount: -250000,
        currency: 'IDR',
        recordDate: '2026-10-14T10:00:00.000Z',
        recordType: 'transfer',
      };

      const expenseEvidence = createEvidence({
        transactionType: 'EXPENSE',
        amount: -250000,
        currency: 'IDR',
        accountId: 'acc-mandiri-123',
        occurredAt: '2026-10-14T10:05:00.000Z',
        referenceNumbers: [],
      });

      const result = service.correlateEvidence(expenseEvidence, [], [transferRecord]);
      expect(result.suggestedAction).toBe('CREATE_INDEPENDENT');
    });

    it('notes sync delay reason when account is bank-synced and no record found (Finding 3)', () => {
      const evidence = createEvidence({
        isBankSyncedAccount: true,
        referenceNumbers: [],
      });

      const result = service.correlateEvidence(evidence, [], []);
      expect(result.suggestedAction).toBe('CREATE_INDEPENDENT');
      expect(result.reasons).toContain('Account is bank-synced; Wallet record may arrive later with sync delay');
    });

    it('preserves isBankSyncedAccount in fuseCandidateWithEvidence (Finding 3)', () => {
      const candidate = createPendingItem({ isBankSyncedAccount: false });
      const incoming = createEvidence({ isBankSyncedAccount: true });

      const fused = service.fuseCandidateWithEvidence(candidate, incoming);
      expect(fused.isBankSyncedAccount).toBe(true);
    });
  });

  describe('note and category fusion permutations', () => {
    it('preserves existing rich note when incoming bank debit has generic note', () => {
      const candidate = createPendingItem({
        note: '2x Bakwan Sayur, 1x Nasi Uduk',
        evidenceSources: ['EMAIL_PAYMENT'],
      });
      const evidence = createEvidence({
        sourceType: 'EMAIL_BANK',
        note: 'Pembayaran QRIS',
      });

      const fused = service.fuseCandidateWithEvidence(candidate, evidence);
      expect(fused.note).toBe('2x Bakwan Sayur, 1x Nasi Uduk');
    });

    it('concatenates two descriptive notes if both contain unique details', () => {
      const candidate = createPendingItem({
        note: 'Catatan Kasir #1',
        evidenceSources: ['EMAIL_BANK'],
      });
      const evidence = createEvidence({
        sourceType: 'EMAIL_PAYMENT',
        note: 'Voucher Diskon Rp 5.000 Digunakan',
      });

      const fused = service.fuseCandidateWithEvidence(candidate, evidence);
      expect(fused.note).toBe('Catatan Kasir #1 • Voucher Diskon Rp 5.000 Digunakan');
    });
  });

  describe('humanResponseFormatter localization for correlated transactions', () => {
    it('formats enriched pending notification in English and Indonesian with single and multiple ticket prompts', () => {
      const item = createPendingItem({
        counterParty: 'Blibli Offline Store',
        note: '2x Bakwan Sayur',
        matchedCategoryName: 'Makanan & Minuman',
      });

      const singleId = formatEnrichedPendingEmailTransactionNotification(item, 1, 'Blibli', 'id');
      expect(singleId).toContain('Transaksi Diperkaya');
      expect(singleId).toContain('Balas *Ya* atau *Catat* (atau *Ya 1*)');
      expect(singleId).toContain('Balas *Ya: <catatan> cat:<kategori> #<tag>* untuk tambah rincian');

      const bulkId = formatEnrichedPendingEmailTransactionNotification(item, 3, 'Blibli', 'id');
      expect(bulkId).toContain('Balas *Ya 1* (atau *Ya semua*)');
      expect(bulkId).toContain('Balas *Ya 1: <catatan> cat:<kategori> #<tag>* untuk tambah rincian');

      const singleEn = formatEnrichedPendingEmailTransactionNotification(item, 1, 'Blibli', 'en');
      expect(singleEn).toContain('Transaction Enriched');
      expect(singleEn).toContain('Reply *Yes* or *Record* (or *Yes 1*)');
      expect(singleEn).toContain('Reply *Yes: <note> cat:<category> #<tag>* to add details');

      const bulkEn = formatEnrichedPendingEmailTransactionNotification(item, 3, 'Blibli', 'en');
      expect(bulkEn).toContain('Reply *Yes 1* (or *Yes all*)');
      expect(bulkEn).toContain('Reply *Yes 1: <note> cat:<category> #<tag>* to add details');
    });

    it('formats correlated Wallet record notification in English and Indonesian', () => {
      const notifId = formatCorrelatedWalletRecordNotification('rec-123', 'Blibli Store', -16700, 'IDR', 'id');
      expect(notifId).toContain('Transaksi Sudah Tercatat');
      expect(notifId).toContain('rec-123');

      const notifEn = formatCorrelatedWalletRecordNotification('rec-123', 'Blibli Store', -16700, 'IDR', 'en');
      expect(notifEn).toContain('Transaction Already Recorded');
      expect(notifEn).toContain('rec-123');
    });
  });

  describe('Ride receipt latency and generic bank debit correlation (Grab + Bank Jago scenario)', () => {
    const defaultService = new TransactionCorrelationService(); // Uses default 2-hour window

    it('correlates a Grab receipt arriving 46 minutes after a Bank Jago debit card charge with Unknown merchant', () => {
      // 17:27 WIB (10:27 UTC): Jago debit card charge notification
      const jagoDebitCandidate = createPendingItem({
        ticketId: 3,
        bankDisplayName: 'Jago',
        accountNameHint: 'Jago',
        matchedAccountId: 'a7a51081-350c-4013-b99c-ffdaae10651d',
        counterParty: 'Unknown',
        amount: -68100,
        currency: 'IDR',
        transactionType: 'EXPENSE',
        matchedCategoryId: 'cat-shopping',
        matchedCategoryName: 'Shopping',
        note: 'Transaksi menggunakan kartu debit Jago',
        recordDate: '2026-10-15T10:27:22.000Z',
        referenceNumber: undefined,
        referenceNumbers: [],
        evidenceSources: ['EMAIL_BANK'],
      });

      // 18:13 WIB (11:13 UTC, received 11:21 UTC): Grab E-Receipt issued 46 minutes later
      const grabReceiptEvidence = createEvidence({
        sourceType: 'EMAIL_PAYMENT',
        sourceId: 'Your Grab E-Receipt',
        merchant: 'Grab',
        amount: -68100,
        currency: 'IDR',
        transactionType: 'EXPENSE',
        accountHint: 'Jago Expense',
        accountId: 'a7a51081-350c-4013-b99c-ffdaae10651d',
        matchedCategoryId: 'cat-ojol',
        matchedCategoryName: 'Ojol',
        categoryId: 'cat-ojol',
        categoryName: 'Ojol',
        note: 'Grab ride',
        occurredAt: '2026-10-15T11:13:34.000Z', // 46m 12s after debit
        referenceNumbers: ['A-9V6UNX7W38J9AV'],
      });

      const result = defaultService.correlateEvidence(grabReceiptEvidence, [jagoDebitCandidate]);

      expect(result.confidence).toBe('HIGH');
      expect(result.suggestedAction).toBe('MERGE_PENDING');
      expect(result.matchTarget.type).toBe('PENDING_TRANSACTION');
      if (result.matchTarget.type === 'PENDING_TRANSACTION') {
        expect(result.matchTarget.pendingItem.ticketId).toBe(3);
      }

      const fused = result.fusedPendingItem!;
      expect(fused).toBeDefined();
      // Counterparty upgraded from "Unknown" to "Grab"
      expect(fused.counterParty).toBe('Grab');
      // Category upgraded from generic "Shopping" to specific "Ojol"
      expect(fused.matchedCategoryName).toBe('Ojol');
      expect(fused.matchedCategoryId).toBe('cat-ojol');
      // Note replaced from generic debit card note to "Grab ride"
      expect(fused.note).toBe('Grab ride');
      // Account preserved
      expect(fused.matchedAccountId).toBe('a7a51081-350c-4013-b99c-ffdaae10651d');
      // Reference merged
      expect(fused.referenceNumbers).toContain('A-9V6UNX7W38J9AV');
      // Both sources recorded
      expect(fused.evidenceSources).toEqual(['EMAIL_BANK', 'EMAIL_PAYMENT']);
    });

    it('guarantees arrival order invariance when Grab receipt arrives before Bank debit', () => {
      // Scenario: Grab receipt arrives first
      const grabReceiptCandidate = createPendingItem({
        ticketId: 4,
        bankDisplayName: 'Grab',
        accountNameHint: 'Jago Expense',
        matchedAccountId: 'a7a51081-350c-4013-b99c-ffdaae10651d',
        counterParty: 'Grab',
        amount: -68100,
        currency: 'IDR',
        transactionType: 'EXPENSE',
        matchedCategoryId: 'cat-ojol',
        matchedCategoryName: 'Ojol',
        note: 'Grab ride',
        recordDate: '2026-10-15T11:13:34.000Z',
        referenceNumber: 'A-9V6UNX7W38J9AV',
        referenceNumbers: ['A-9V6UNX7W38J9AV'],
        evidenceSources: ['EMAIL_PAYMENT'],
      });

      // Bank debit arrives second with generic "Unknown" and "Shopping"
      const jagoDebitEvidence = createEvidence({
        sourceType: 'EMAIL_BANK',
        sourceId: 'Debit Card Notification',
        merchant: 'Unknown',
        amount: -68100,
        currency: 'IDR',
        transactionType: 'EXPENSE',
        accountHint: 'Jago',
        accountId: 'a7a51081-350c-4013-b99c-ffdaae10651d',
        categoryId: 'cat-shopping',
        categoryName: 'Shopping',
        note: 'Transaksi menggunakan kartu debit Jago',
        occurredAt: '2026-10-15T11:15:00.000Z',
        referenceNumbers: [],
      });

      const result = defaultService.correlateEvidence(jagoDebitEvidence, [grabReceiptCandidate]);

      expect(result.confidence).toBe('HIGH');
      expect(result.suggestedAction).toBe('MERGE_PENDING');

      const fused = result.fusedPendingItem!;
      expect(fused.counterParty).toBe('Grab');
      expect(fused.matchedCategoryName).toBe('Ojol');
      expect(fused.note).toBe('Grab ride');
      expect(fused.matchedAccountId).toBe('a7a51081-350c-4013-b99c-ffdaae10651d');
      expect(fused.referenceNumbers).toContain('A-9V6UNX7W38J9AV');
      expect(fused.evidenceSources?.sort()).toEqual(['EMAIL_BANK', 'EMAIL_PAYMENT'].sort());
    });

    it('correlates incoming Grab receipt with an existing Wallet record that has Unknown merchant', () => {
      const existingWalletRecord: WalletRecordItem = {
        id: 'rec-jago-unknown-1',
        accountId: 'a7a51081-350c-4013-b99c-ffdaae10651d',
        amount: -68100,
        currency: 'IDR',
        recordDate: '2026-10-15T10:27:22.000Z',
        recordType: 'expense',
        counterParty: 'Unknown',
        note: 'Transaksi menggunakan kartu debit Jago',
      };

      const grabReceiptEvidence = createEvidence({
        sourceType: 'EMAIL_PAYMENT',
        merchant: 'Grab',
        amount: -68100,
        currency: 'IDR',
        accountId: 'a7a51081-350c-4013-b99c-ffdaae10651d',
        occurredAt: '2026-10-15T11:13:34.000Z',
        referenceNumbers: ['A-9V6UNX7W38J9AV'],
      });

      const result = defaultService.correlateEvidence(grabReceiptEvidence, [], [existingWalletRecord]);

      expect(result.confidence).toBe('HIGH');
      expect(result.suggestedAction).toBe('ATTACH_WALLET_RECORD');
      if (result.matchTarget.type === 'WALLET_RECORD') {
        expect(result.matchTarget.record.id).toBe('rec-jago-unknown-1');
      }
    });

    it('does not merge transactions occurring outside the 2-hour window (> 120 mins)', () => {
      const jagoDebitCandidate = createPendingItem({
        counterParty: 'Unknown',
        amount: -68100,
        recordDate: '2026-10-15T10:00:00.000Z',
      });

      const grabReceiptEvidence = createEvidence({
        merchant: 'Grab',
        amount: -68100,
        occurredAt: '2026-10-15T12:30:00.000Z', // 150 minutes later (> 120 mins)
      });

      const result = defaultService.correlateEvidence(grabReceiptEvidence, [jagoDebitCandidate]);

      expect(result.confidence).toBe('LOW');
      expect(result.suggestedAction).toBe('CREATE_INDEPENDENT');
    });

    it('prevents attaching to generic Wallet record when incoming evidence is another generic bank notification (Finding 1)', () => {
      // Existing Wallet record manually created without payee
      const existingWalletRecord: WalletRecordItem = {
        id: 'rec-manual-no-payee',
        accountId: 'acc-mandiri-123',
        amount: -50000,
        currency: 'IDR',
        recordDate: '2026-10-15T10:00:00.000Z',
        recordType: 'expense',
        counterParty: '', // Empty payee
      };

      // Second incoming transaction is also a generic bank debit, NOT a specific merchant receipt
      const incomingBankEvidence = createEvidence({
        sourceType: 'EMAIL_BANK',
        merchant: 'Unknown',
        amount: -50000,
        currency: 'IDR',
        accountId: 'acc-mandiri-123',
        occurredAt: '2026-10-15T10:20:00.000Z', // 20m later
        referenceNumbers: [],
      });

      const result = defaultService.correlateEvidence(incomingBankEvidence, [], [existingWalletRecord]);

      // Should NOT attach to the generic manual record, preventing false-positive record swallowing
      expect(result.suggestedAction).toBe('CREATE_INDEPENDENT');
    });

    it('accurately distinguishes generic tokens from legitimate merchants like Pos Indonesia and Deposit (Finding 2)', () => {
      // Legitimate merchants must NOT be marked generic
      expect(defaultService.isGenericMerchant('Pos Indonesia')).toBe(false);
      expect(defaultService.isGenericMerchant('PT Pos Indonesia')).toBe(false);
      expect(defaultService.isGenericMerchant('Deposit Box')).toBe(false);
      expect(defaultService.isGenericMerchant('Mastercard Secure')).toBe(false);
      expect(defaultService.isGenericMerchant('Grab')).toBe(false);
      expect(defaultService.isGenericMerchant('Blibli')).toBe(false);

      // Generic placeholders and payment gateways MUST be marked generic
      expect(defaultService.isGenericMerchant('Unknown')).toBe(true);
      expect(defaultService.isGenericMerchant('unknown')).toBe(true);
      expect(defaultService.isGenericMerchant('Kartu Debit')).toBe(true);
      expect(defaultService.isGenericMerchant('Debit Card')).toBe(true);
      expect(defaultService.isGenericMerchant('POS Debit')).toBe(true);
      expect(defaultService.isGenericMerchant('EDC')).toBe(true);
      expect(defaultService.isGenericMerchant('QRIS')).toBe(true);
      expect(defaultService.isGenericMerchant(undefined)).toBe(true);
      expect(defaultService.isGenericMerchant(null)).toBe(true);
      expect(defaultService.isGenericMerchant('')).toBe(true);
    });

    it('accurately identifies generic note boilerplate vs specific items and order numbers', () => {
      // Boilerplate bank notes
      expect(defaultService.isGenericNote('Transaction using Jago debit card')).toBe(true);
      expect(defaultService.isGenericNote('Transaksi menggunakan kartu debit')).toBe(true);
      expect(defaultService.isGenericNote('Pembayaran QRIS')).toBe(true);
      expect(defaultService.isGenericNote('Kartu Debit')).toBe(true);
      expect(defaultService.isGenericNote('QRIS')).toBe(true);
      expect(defaultService.isGenericNote('')).toBe(true);
      expect(defaultService.isGenericNote(undefined)).toBe(true);

      // Notes repeating merchant name
      expect(defaultService.isGenericNote('Shopee', 'Shopee')).toBe(true);
      expect(defaultService.isGenericNote('Grab', 'Grab')).toBe(true);

      // Generic e-receipts and debit card patterns
      expect(defaultService.isGenericNote('Debit card transaction via Bank Jago')).toBe(true);
      expect(defaultService.isGenericNote('Debit card transaction')).toBe(true);
      expect(defaultService.isGenericNote('Grab E-Receipt')).toBe(true);
      expect(defaultService.isGenericNote('Tokopedia Receipt')).toBe(true);
      expect(defaultService.isGenericNote('Bukti Pembayaran')).toBe(true);

      // Rich merchant and receipt notes (MUST NOT be generic)
      expect(defaultService.isGenericNote('Pembayaran pesanan Shopee (#261015PF5NYVHP)')).toBe(false);
      expect(defaultService.isGenericNote('Grab ride')).toBe(false);
      expect(defaultService.isGenericNote('GrabBike: Stasiun Gambir -> Grand Indonesia')).toBe(false);
      expect(defaultService.isGenericNote('GrabCar: Bandara Soekarno Hatta -> Hotel')).toBe(false);
      expect(defaultService.isGenericNote('2x Bakwan Sayur, 1x Nasi Uduk')).toBe(false);
      expect(defaultService.isGenericNote('Kopi Kenangan Mantan')).toBe(false);
    });
  });

  describe('E-commerce platform orders and authoritative bank debit correlation (Shopee + Bank Jago scenario)', () => {
    const defaultService = new TransactionCorrelationService();

    it('correlates a Bank Jago debit with a Shopee order receipt where candidate has Shopeepay platform account', () => {
      // 21:07 WIB: Shopee order receipt arrives first (parsed with Shopeepay account from platform)
      const shopeeCandidate = createPendingItem({
        ticketId: 1,
        sourceType: 'EMAIL',
        bankDisplayName: 'Shopee',
        accountNameHint: 'Shopeepay',
        matchedAccountId: '46ffbd52-9ca6-4c0f-9e30-c3c48c4fe226',
        counterParty: 'Shopee',
        amount: -47664,
        currency: 'IDR',
        transactionType: 'EXPENSE',
        matchedCategoryId: 'cat-shopping',
        matchedCategoryName: 'Shopping',
        note: 'Pembayaran pesanan Shopee (#261015PF5NYVHP, #261015PF5NYVHQ)',
        recordDate: '2026-10-15T14:06:26.000Z',
        referenceNumber: '261015PF5NYVHP',
        referenceNumbers: ['261015PF5NYVHP'],
        evidenceSources: ['EMAIL_PAYMENT'],
      });

      // 21:07 WIB: Bank Jago debit card charge arrives in the same minute
      const jagoDebitEvidence = createEvidence({
        sourceType: 'EMAIL_BANK',
        sourceId: 'You have made a transaction using your debit card',
        merchant: 'Unknown',
        amount: -47664,
        currency: 'IDR',
        transactionType: 'EXPENSE',
        accountHint: 'Jago Expense',
        accountId: 'a7a51081-350c-4013-b99c-ffdaae10651d',
        categoryId: 'cat-shopping',
        categoryName: 'Shopping',
        note: 'Transaction using Jago debit card',
        occurredAt: '2026-10-15T14:06:26.000Z',
        referenceNumbers: [],
      });

      const result = defaultService.correlateEvidence(jagoDebitEvidence, [shopeeCandidate]);

      expect(result.confidence).toBe('HIGH');
      expect(result.suggestedAction).toBe('MERGE_PENDING');
      expect(result.matchTarget.type).toBe('PENDING_TRANSACTION');

      const fused = result.fusedPendingItem!;
      expect(fused).toBeDefined();
      // Authoritative bank account overrides platform Shopeepay wallet
      expect(fused.matchedAccountId).toBe('a7a51081-350c-4013-b99c-ffdaae10651d');
      expect(fused.accountNameHint).toBe('Jago Expense');
      expect(fused.counterParty).toBe('Shopee');
      expect(fused.note).toBe('Pembayaran pesanan Shopee (#261015PF5NYVHP, #261015PF5NYVHQ)');
      expect(fused.referenceNumbers).toContain('261015PF5NYVHP');
      expect(fused.evidenceSources?.sort()).toEqual(['EMAIL_BANK', 'EMAIL_PAYMENT'].sort());
    });

    it('guarantees arrival order invariance when Bank Jago debit arrives before Shopee receipt', () => {
      // Scenario: Bank Jago arrives first
      const jagoCandidate = createPendingItem({
        ticketId: 2,
        sourceType: 'EMAIL',
        bankDisplayName: 'Bank Jago',
        accountNameHint: 'Jago Expense',
        matchedAccountId: 'a7a51081-350c-4013-b99c-ffdaae10651d',
        counterParty: 'Unknown',
        amount: -47664,
        currency: 'IDR',
        transactionType: 'EXPENSE',
        matchedCategoryId: 'cat-shopping',
        matchedCategoryName: 'Shopping',
        note: 'Transaction using Jago debit card',
        recordDate: '2026-10-15T14:06:26.000Z',
        referenceNumber: undefined,
        referenceNumbers: [],
        evidenceSources: ['EMAIL_BANK'],
      });

      // Shopee receipt arrives second
      const shopeeEvidence = createEvidence({
        sourceType: 'EMAIL_PAYMENT',
        sourceId: 'Pembayaranmu Berhasil Dikonfirmasi',
        merchant: 'Shopee',
        amount: -47664,
        currency: 'IDR',
        transactionType: 'EXPENSE',
        accountHint: 'Shopeepay',
        accountId: '46ffbd52-9ca6-4c0f-9e30-c3c48c4fe226',
        categoryId: 'cat-shopping',
        categoryName: 'Shopping',
        note: 'Pembayaran pesanan Shopee (#261015PF5NYVHP, #261015PF5NYVHQ)',
        occurredAt: '2026-10-15T14:06:26.000Z',
        referenceNumbers: ['261015PF5NYVHP'],
      });

      const result = defaultService.correlateEvidence(shopeeEvidence, [jagoCandidate]);

      expect(result.confidence).toBe('HIGH');
      expect(result.suggestedAction).toBe('MERGE_PENDING');

      const fused = result.fusedPendingItem!;
      expect(fused.matchedAccountId).toBe('a7a51081-350c-4013-b99c-ffdaae10651d');
      expect(fused.accountNameHint).toBe('Jago Expense');
      expect(fused.counterParty).toBe('Shopee');
      expect(fused.note).toBe('Pembayaran pesanan Shopee (#261015PF5NYVHP, #261015PF5NYVHQ)');
      expect(fused.referenceNumbers).toContain('261015PF5NYVHP');
      expect(fused.evidenceSources?.sort()).toEqual(['EMAIL_BANK', 'EMAIL_PAYMENT'].sort());
    });

    it('correlates a Bank Jago debit with a Grab ride receipt and fuses route details over generic debit card boilerplate', () => {
      // 10:29 UTC: Bank Jago debit card candidate
      const jagoCandidate = createPendingItem({
        ticketId: 1,
        sourceType: 'EMAIL',
        bankDisplayName: 'Bank Jago',
        accountNameHint: 'Jago Expense',
        matchedAccountId: 'a7a51081-350c-4013-b99c-ffdaae10651d',
        counterParty: 'Unknown',
        amount: -65800,
        currency: 'IDR',
        transactionType: 'EXPENSE',
        matchedCategoryId: 'cat-uncat',
        matchedCategoryName: 'Uncategorized',
        note: 'Debit card transaction via Bank Jago',
        recordDate: '2026-10-19T10:28:41.000Z',
        evidenceSources: ['EMAIL_BANK'],
      });

      // 11:15 UTC: Grab E-Receipt arrives with ride route
      const grabEvidence = createEvidence({
        sourceType: 'EMAIL_PAYMENT',
        sourceId: 'Your Grab E-Receipt',
        merchant: 'Grab',
        amount: -65800,
        currency: 'IDR',
        transactionType: 'EXPENSE',
        accountHint: 'Grab',
        categoryId: 'eb6133fd-2918-48f6-bef7-f4941a43ff2c',
        categoryName: 'Ojol',
        note: 'GrabBike: Stasiun Gambir -> Grand Indonesia',
        occurredAt: '2026-10-19T11:14:53.000Z',
        referenceNumbers: ['A-9VNE5TRGWUABAV'],
      });

      const result = defaultService.correlateEvidence(grabEvidence, [jagoCandidate]);

      expect(result.confidence).toBe('HIGH');
      expect(result.suggestedAction).toBe('MERGE_PENDING');

      const fused = result.fusedPendingItem!;
      expect(fused.matchedAccountId).toBe('a7a51081-350c-4013-b99c-ffdaae10651d');
      expect(fused.accountNameHint).toBe('Jago Expense');
      expect(fused.counterParty).toBe('Grab');
      expect(fused.matchedCategoryName).toBe('Ojol');
      expect(fused.note).toBe('GrabBike: Stasiun Gambir -> Grand Indonesia');
      expect(fused.referenceNumbers).toContain('A-9VNE5TRGWUABAV');
      expect(fused.evidenceSources?.sort()).toEqual(['EMAIL_BANK', 'EMAIL_PAYMENT'].sort());
    });
  });
});

