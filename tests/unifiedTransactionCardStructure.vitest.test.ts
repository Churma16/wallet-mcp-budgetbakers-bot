import { describe, it, expect, beforeEach } from 'vitest';
import {
  formatRecordSuccessMessage,
  formatPendingConfirmationSuccess,
  formatRetroactivelyEnrichedWalletRecordNotification,
  formatCorrelatedWalletRecordNotification,
  formatPendingEmailTransactionNotification,
  formatEnrichedPendingEmailTransactionNotification,
} from '../src/wallet/formatters/humanResponseFormatter.js';
import { setActiveLanguage, getDictionary } from '../src/i18n/index.js';
import type { PendingTransactionItem } from '../src/services/pendingTransactionService.js';
import type { CreateRecordInputPayload, WalletAccountItem, WalletCategoryItem } from '../src/wallet/mcp/types.js';

describe('Unified Final Transaction Card Structure Parity', () => {
  const mockAccounts: WalletAccountItem[] = [
    { id: 'acc-jago', name: 'Jago Expense', currency: 'IDR' },
    { id: 'acc-bca', name: 'BCA Prioritas', currency: 'IDR' },
  ];

  const mockCategories: WalletCategoryItem[] = [
    { id: 'cat-ojol', name: 'Ojol' },
    { id: 'cat-food', name: 'Makanan & Minuman' },
  ];

  const fixedDate = new Date('2026-11-04T02:34:00.000Z'); // 09:34 WIB

  beforeEach(() => {
    setActiveLanguage('id');
  });

  it('verifies manual recording card structure as the design system baseline', () => {
    const payload: CreateRecordInputPayload[] = [
      {
        accountId: 'acc-jago',
        categoryId: 'cat-ojol',
        amount: -51000,
        note: 'GoRide ke Sarana Jaya',
        recordDate: fixedDate.toISOString(),
      },
    ];

    const card = formatRecordSuccessMessage(payload, mockAccounts, mockCategories, 'id');

    expect(card).toContain('✅ *GoRide ke Sarana Jaya* berhasil dicatat!');
    expect(card).toContain('💸 Rp 51.000  •  Jago Expense');
    expect(card).toContain('🏷️ Ojol  •  4 Nov 2026, 09:34 WIB');
  });

  it('matches manual recording structure in pending confirmation success card', () => {
    const pendingItem: PendingTransactionItem = {
      ticketId: 1,
      sourceType: 'EMAIL',
      amount: -65800,
      currency: 'IDR',
      counterParty: 'Grab',
      note: 'Grab booking A-AXTLANJGXX2TAV',
      matchedAccountId: 'acc-jago',
      accountNameHint: 'Jago Expense',
      matchedCategoryId: 'cat-ojol',
      matchedCategoryName: 'Ojol',
      transactionType: 'EXPENSE',
      recordDate: fixedDate.toISOString(),
      createdAt: fixedDate,
      expiresAt: new Date(fixedDate.getTime() + 86400000),
    };

    const card = formatPendingConfirmationSuccess(pendingItem, 'id');

    expect(card).toContain('✅ *Grab booking A-AXTLANJGXX2TAV* berhasil dicatat!');
    expect(card).toContain('💸 Rp 65.800  •  Jago Expense');
    expect(card).toContain('🏷️ Ojol  •  4 Nov 2026, 09:34 WIB');
    expect(card).not.toContain('📝'); // Note is promoted directly to title, no separate note line
    expect(card).not.toContain('321f074f'); // No raw UUID
  });

  it('matches user requirement: combines merchant and item note as title without separate note line', () => {
    const blibliItem: PendingTransactionItem = {
      ticketId: 5,
      sourceType: 'EMAIL',
      amount: -14100,
      currency: 'IDR',
      counterParty: 'Bliblimart Sarana Jaya - Offline Store',
      note: 'Nasi Uduk + Telur, Bakwan Sayur',
      matchedAccountId: 'acc-jago',
      accountNameHint: 'Jago Expense',
      matchedCategoryId: 'cat-groceries',
      matchedCategoryName: 'Groceries',
      transactionType: 'EXPENSE',
      recordDate: fixedDate.toISOString(),
      createdAt: fixedDate,
      expiresAt: new Date(fixedDate.getTime() + 86400000),
    };

    const card = formatPendingConfirmationSuccess(blibliItem, 'id');

    expect(card).toBe([
      '✅ *Bliblimart Sarana Jaya - Offline Store - Nasi Uduk + Telur, Bakwan Sayur* berhasil dicatat!',
      '',
      '💸 Rp 14.100  •  Jago Expense',
      '🏷️ Groceries  •  4 Nov 2026, 09:34 WIB',
    ].join('\n'));
    expect(card).not.toContain('📝');
  });

  it('matches manual recording structure in retroactive enrichment update card', () => {
    const card = formatRetroactivelyEnrichedWalletRecordNotification({
      recordId: '321f074f-62e6-4319-a34e-f02d82723731',
      merchant: 'Grab',
      amount: -65800,
      currency: 'IDR',
      accountName: 'Jago Expense',
      categoryName: 'Ojol',
      note: 'Grab booking A-AXTLANJGXX2TAV',
      recordDate: fixedDate,
      languageCode: 'id',
    });

    expect(card).toContain('✨ *Grab booking A-AXTLANJGXX2TAV* berhasil diperbarui!');
    expect(card).toContain('💸 Rp 65.800  •  Jago Expense');
    expect(card).toContain('🏷️ Ojol  •  4 Nov 2026, 09:34 WIB');
    expect(card).not.toContain('📝'); // Note is in the title, no separate line
    expect(card).not.toContain('321f074f-62e6-4319-a34e-f02d82723731'); // No raw UUID leak
  });

  it('matches manual recording structure in duplicate transaction correlation advisory card', () => {
    const card = formatCorrelatedWalletRecordNotification(
      '321f074f-62e6-4319-a34e-f02d82723731',
      'Grab',
      -65800,
      'IDR',
      'id',
      'Jago Expense',
      'Ojol',
      fixedDate
    );

    expect(card).toContain('ℹ️ *Grab* sudah tercatat di Wallet!');
    expect(card).toContain('💸 Rp 65.800  •  Jago Expense');
    expect(card).toContain('🏷️ Ojol  •  4 Nov 2026, 09:34 WIB');
    expect(card).toContain('_Tidak dibuat tiket duplikat._');
    expect(card).not.toContain('321f074f-62e6-4319-a34e-f02d82723731'); // No raw UUID leak
  });

  it('verifies English language parity across all final cards', () => {
    const pendingItem: PendingTransactionItem = {
      ticketId: 2,
      sourceType: 'EMAIL',
      amount: -125000,
      currency: 'IDR',
      counterParty: 'Gojek',
      note: 'GoFood: Ayam Geprek',
      accountNameHint: 'BCA Prioritas',
      matchedCategoryName: 'Makanan & Minuman',
      transactionType: 'EXPENSE',
      recordDate: fixedDate.toISOString(),
      createdAt: fixedDate,
      expiresAt: new Date(fixedDate.getTime() + 86400000),
    };

    const confirmCard = formatPendingConfirmationSuccess(pendingItem, 'en');
    expect(confirmCard).toContain('✅ *Gojek - GoFood: Ayam Geprek* successfully recorded!');
    expect(confirmCard).toContain('💸 Rp 125,000  •  BCA Prioritas');
    expect(confirmCard).toContain('🏷️ Makanan & Minuman  •  Nov 4, 2026, 09:34 WIB');
    expect(confirmCard).not.toContain('📝');

    const updateCard = formatRetroactivelyEnrichedWalletRecordNotification({
      recordId: 'rec-uuid-1',
      merchant: 'Gojek',
      amount: -125000,
      accountName: 'BCA Prioritas',
      categoryName: 'Makanan & Minuman',
      note: 'GoFood: Ayam Geprek',
      recordDate: fixedDate,
      languageCode: 'en',
    });
    expect(updateCard).toContain('✨ *Gojek - GoFood: Ayam Geprek* successfully updated!');
    expect(updateCard).toContain('💸 Rp 125,000  •  BCA Prioritas');
    expect(updateCard).toContain('🏷️ Makanan & Minuman  •  Nov 4, 2026, 09:34 WIB');
    expect(updateCard).not.toContain('📝');

    const dupCard = formatCorrelatedWalletRecordNotification(
      'rec-uuid-1',
      'Gojek',
      -125000,
      'IDR',
      'en',
      'BCA Prioritas',
      'Makanan & Minuman',
      fixedDate
    );
    expect(dupCard).toContain('ℹ️ *Gojek* already recorded!');
    expect(dupCard).toContain('💸 Rp 125,000  •  BCA Prioritas');
    expect(dupCard).toContain('🏷️ Makanan & Minuman  •  Nov 4, 2026, 09:34 WIB');
    expect(dupCard).toContain('_No duplicate ticket created._');
  });

  it('covers transfer confirmation formatting in Indonesian and English', () => {
    const transferWithDest: PendingTransactionItem = {
      ticketId: 10,
      sourceType: 'EMAIL',
      amount: -250000,
      currency: 'IDR',
      accountNameHint: 'BCA Prioritas',
      destinationAccountNameHint: 'Jago Utama',
      transactionType: 'TRANSFER',
      recordDate: fixedDate.toISOString(),
      createdAt: fixedDate,
      expiresAt: new Date(fixedDate.getTime() + 86400000),
    };

    const idCard = formatPendingConfirmationSuccess(transferWithDest, 'id');
    expect(idCard).toContain('✅ *Transfer berhasil dicatat!*');
    expect(idCard).toContain('🔁 Rp 250.000');
    expect(idCard).toContain('💳 BCA Prioritas ➔ Jago Utama');
    expect(idCard).toContain('⏰ 4 Nov 2026, 09:34 WIB');

    const enCard = formatPendingConfirmationSuccess(transferWithDest, 'en');
    expect(enCard).toContain('✅ *Transfer successfully recorded!*');
    expect(enCard).toContain('🔁 Rp 250,000');
    expect(enCard).toContain('💳 BCA Prioritas ➔ Jago Utama');
    expect(enCard).toContain('⏰ Nov 4, 2026, 09:34 WIB');

    const transferWithoutDest: PendingTransactionItem = {
      ...transferWithDest,
      ticketId: 11,
      destinationAccountNameHint: undefined,
    };
    const idSingleRoute = formatPendingConfirmationSuccess(transferWithoutDest, 'id');
    expect(idSingleRoute).toContain('💳 BCA Prioritas');
    expect(idSingleRoute).not.toContain('➔');

    const enSingleRoute = formatPendingConfirmationSuccess(transferWithoutDest, 'en');
    expect(enSingleRoute).toContain('💳 BCA Prioritas');
    expect(enSingleRoute).not.toContain('➔');
  });

  it('covers income transactions, tags/labels, and fallback defaults across all final cards', () => {
    // Income and labels in pending confirmation
    const incomeItem: PendingTransactionItem = {
      ticketId: 20,
      sourceType: 'EMAIL',
      amount: 1500000,
      currency: 'IDR',
      counterParty: 'Gaji Bonus',
      accountNameHint: 'BCA Prioritas',
      matchedCategoryName: 'Gaji',
      labels: ['bonus', 'tahunan'],
      transactionType: 'INCOME',
      recordDate: fixedDate.toISOString(),
      createdAt: fixedDate,
      expiresAt: new Date(fixedDate.getTime() + 86400000),
    };

    const confirmId = formatPendingConfirmationSuccess(incomeItem, 'id');
    expect(confirmId).toContain('💰 Rp 1.500.000  •  BCA Prioritas');
    expect(confirmId).toContain('🏷️ Gaji  •  4 Nov 2026, 09:34 WIB');
    expect(confirmId).toContain('🔖 #bonus #tahunan');

    // Income, labels, and fallback in retroactive update
    const updateWithLabels = formatRetroactivelyEnrichedWalletRecordNotification({
      recordId: 'rec-inc-1',
      merchant: 'Bonus Kinerja',
      amount: 2000000,
      currency: 'IDR',
      accountName: 'BCA Prioritas',
      categoryName: 'Pendapatan',
      labels: ['kantor'],
      recordDate: fixedDate,
      languageCode: 'id',
    });
    expect(updateWithLabels).toContain('✨ *Bonus Kinerja* berhasil diperbarui!');
    expect(updateWithLabels).toContain('💰 Rp 2.000.000  •  BCA Prioritas');
    expect(updateWithLabels).toContain('🏷️ Pendapatan  •  4 Nov 2026, 09:34 WIB');
    expect(updateWithLabels).toContain('🔖 #kantor');

    // Default fallbacks when merchant/category/account are missing
    const fallbackUpdateId = formatRetroactivelyEnrichedWalletRecordNotification({
      recordId: 'rec-fallback-1',
      merchant: '',
      amount: -50000,
      languageCode: 'id',
    });
    expect(fallbackUpdateId).toContain('✨ *Transaksi* berhasil diperbarui!');
    expect(fallbackUpdateId).toContain('💸 Rp 50.000  •  Akun');
    expect(fallbackUpdateId).toContain('🏷️ Umum');

    const fallbackUpdateEn = formatRetroactivelyEnrichedWalletRecordNotification({
      recordId: 'rec-fallback-2',
      merchant: '',
      amount: -50000,
      languageCode: 'en',
    });
    expect(fallbackUpdateEn).toContain('✨ *Transaction* successfully updated!');
    expect(fallbackUpdateEn).toContain('💸 Rp 50,000  •  Account');
    expect(fallbackUpdateEn).toContain('🏷️ General');

    // Income and fallback in correlation notice
    const dupIncomeId = formatCorrelatedWalletRecordNotification(
      'rec-inc-dup',
      'Cashback Gopay',
      25000,
      'IDR',
      'id',
      'Gopay',
      'Hadiah',
      fixedDate
    );
    expect(dupIncomeId).toContain('ℹ️ *Cashback Gopay* sudah tercatat di Wallet!');
    expect(dupIncomeId).toContain('💰 Rp 25.000  •  Gopay');
    expect(dupIncomeId).toContain('🏷️ Hadiah  •  4 Nov 2026, 09:34 WIB');

    const dupFallbackId = formatCorrelatedWalletRecordNotification('rec-dup-2', '', -30000, 'IDR', 'id');
    expect(dupFallbackId).toContain('ℹ️ *Transaksi* sudah tercatat di Wallet!');
    expect(dupFallbackId).toContain('💸 Rp 30.000  •  Akun');

    const dupFallbackEn = formatCorrelatedWalletRecordNotification('rec-dup-3', '', -30000, 'IDR', 'en');
    expect(dupFallbackEn).toContain('ℹ️ *Transaction* already recorded!');
    expect(dupFallbackEn).toContain('💸 Rp 30,000  •  Account');
  });

  it('formats incoming pending transaction prompts with dynamic arrival order and structured layout', () => {
    // Fused: Push first, then Email
    const fusedPushFirst: PendingTransactionItem = {
      ticketId: 3,
      sourceType: 'PUSH_NOTIFICATION',
      evidenceSources: ['PUSH_NOTIFICATION', 'EMAIL'],
      amount: -14100,
      currency: 'IDR',
      counterParty: 'Bliblimart Sarana Jaya - Offline Store',
      note: 'Nasi Uduk + Telur, Bakwan Sayur',
      accountNameHint: 'Jago Expense',
      matchedCategoryName: 'Makan Nafsu',
      transactionType: 'EXPENSE',
      recordDate: fixedDate.toISOString(),
      createdAt: fixedDate,
      expiresAt: new Date(fixedDate.getTime() + 86400000),
    };

    const pushFirstCard = formatPendingEmailTransactionNotification(fusedPushFirst, 1, 'id');
    expect(pushFirstCard).toContain('📲📩 *Pembayaran Baru*');
    expect(pushFirstCard).toContain('Rp 14.100 • Jago Expense');
    expect(pushFirstCard).toContain('🏪 Bliblimart Sarana Jaya - Offline Store');
    expect(pushFirstCard).toContain('🏷️ Makan Nafsu • 4 Nov 2026, 09:34 WIB');
    expect(pushFirstCard).toContain('📝 Nasi Uduk + Telur, Bakwan Sayur');
    expect(pushFirstCard).toContain('Geser (swipe) untuk edit');

    // Fused: Email first, then Push
    const fusedEmailFirst: PendingTransactionItem = {
      ...fusedPushFirst,
      sourceType: 'EMAIL',
      evidenceSources: ['EMAIL', 'PUSH_NOTIFICATION'],
    };

    const emailFirstCard = formatPendingEmailTransactionNotification(fusedEmailFirst, 1, 'id');
    expect(emailFirstCard).toContain('📩📲 *Pembayaran Baru*');

    // In-place enriched notification update
    const enrichedCard = formatEnrichedPendingEmailTransactionNotification(fusedPushFirst, 1, 'Blibli', 'id');
    expect(enrichedCard).toContain('📲📩 *Pembayaran Baru*');
    expect(enrichedCard).toContain('🏪 Bliblimart Sarana Jaya - Offline Store');
    expect(enrichedCard).toContain('_Diperbarui via 📩 Blibli_');

    // Transfer pending prompt
    const transferPending: PendingTransactionItem = {
      ticketId: 4,
      sourceType: 'EMAIL',
      amount: -500000,
      currency: 'IDR',
      accountNameHint: 'BCA Prioritas',
      destinationAccountNameHint: 'Jago Expense',
      transactionType: 'TRANSFER',
      recordDate: fixedDate.toISOString(),
      createdAt: fixedDate,
      expiresAt: new Date(fixedDate.getTime() + 86400000),
    };

    const transferCard = formatPendingEmailTransactionNotification(transferPending, 1, 'id');
    expect(transferCard).toContain('🔄 *Transfer Baru*');
    expect(transferCard).toContain('🔁 Rp 500.000');
    expect(transferCard).toContain('💳 BCA Prioritas ➔ Jago Expense');
  });

  it('standardizes edit receipt cards for expense and transfer to unified action header', () => {
    const idDict = getDictionary('id');

    const editExpenseReceipt = idDict.records.editSuccess({
      transactionTitle: 'Bliblimart Sarana Jaya - Offline Store - Nasi Uduk + Telur, Bakwan Sayur',
      formattedAmount: 'Rp 14.100',
      accountName: 'Jago Expense',
      categoryName: 'Makan Nafsu',
      recordTimestampDisplay: '4 Nov 2026, 09:34 WIB',
      transactionTypeIcon: '💸',
      labels: ['makan', '#sarapan'],
    });

    expect(editExpenseReceipt).toContain('✅ *Bliblimart Sarana Jaya - Offline Store - Nasi Uduk + Telur, Bakwan Sayur* berhasil diperbarui!');
    expect(editExpenseReceipt).toContain('💸 Rp 14.100  •  Jago Expense');
    expect(editExpenseReceipt).toContain('🏷️ Makan Nafsu  •  4 Nov 2026, 09:34 WIB');
    expect(editExpenseReceipt).toContain('🔖 #makan #sarapan');

    const editTransferReceipt = idDict.records.editSuccess({
      transactionTitle: 'Transfer',
      formattedAmount: 'Rp 500.000',
      accountName: 'BCA Prioritas',
      destinationAccountName: 'Jago Expense',
      categoryName: 'Transfer',
      recordTimestampDisplay: '4 Nov 2026, 09:34 WIB',
      transactionTypeIcon: '🔄',
      isTransfer: true,
    });

    expect(editTransferReceipt).toContain('✅ *Transfer berhasil diperbarui!*');
    expect(editTransferReceipt).toContain('🔁 Rp 500.000');
    expect(editTransferReceipt).toContain('💳 BCA Prioritas ➔ Jago Expense');
    expect(editTransferReceipt).toContain('⏰ 4 Nov 2026, 09:34 WIB');
  });

  it('standardizes delete receipt cards for expense and transfer to unified action header', () => {
    const idDict = getDictionary('id');

    const deleteExpenseReceipt = idDict.records.deleteSuccess({
      transactionTitle: 'Bliblimart Sarana Jaya - Offline Store - Nasi Uduk + Telur, Bakwan Sayur',
      formattedAmount: 'Rp 14.100',
      accountName: 'Jago Expense',
      categoryName: 'Makan Nafsu',
      recordTimestampDisplay: '4 Nov 2026, 09:34 WIB',
      transactionTypeIcon: '💸',
      labels: ['makan'],
    });

    expect(deleteExpenseReceipt).toContain('🗑️ *Bliblimart Sarana Jaya - Offline Store - Nasi Uduk + Telur, Bakwan Sayur* berhasil dihapus!');
    expect(deleteExpenseReceipt).toContain('💸 Rp 14.100  •  Jago Expense');
    expect(deleteExpenseReceipt).toContain('🏷️ Makan Nafsu  •  4 Nov 2026, 09:34 WIB');
    expect(deleteExpenseReceipt).toContain('🔖 #makan');

    const deleteTransferReceipt = idDict.records.deleteSuccess({
      transactionTitle: 'Transfer',
      formattedAmount: 'Rp 500.000',
      accountName: 'BCA Prioritas',
      destinationAccountName: 'Jago Expense',
      categoryName: 'Transfer',
      recordTimestampDisplay: '4 Nov 2026, 09:34 WIB',
      transactionTypeIcon: '🔄',
      isTransfer: true,
    });

    expect(deleteTransferReceipt).toContain('🗑️ *Transfer berhasil dihapus!*');
    expect(deleteTransferReceipt).toContain('🔁 Rp 500.000');
    expect(deleteTransferReceipt).toContain('💳 BCA Prioritas ➔ Jago Expense');
    expect(deleteTransferReceipt).toContain('⏰ 4 Nov 2026, 09:34 WIB');
  });

  it('unifies title resolution in multiple records success layout', () => {
    const payload: CreateRecordInputPayload[] = [
      {
        accountId: 'acc-jago',
        categoryId: 'cat-food',
        amount: -14100,
        counterParty: 'Bliblimart',
        note: 'Nasi Uduk',
        recordDate: fixedDate.toISOString(),
      },
      {
        accountId: 'acc-bca',
        categoryId: 'cat-ojol',
        amount: -25000,
        counterParty: 'Gojek',
        recordDate: fixedDate.toISOString(),
      },
    ];

    const card = formatRecordSuccessMessage(payload, mockAccounts, mockCategories, 'id');
    expect(card).toContain('✅ *2 transaksi* berhasil dicatat!');
    expect(card).toContain('1. 💸 Bliblimart - Nasi Uduk — *Rp 14.100* dari Jago Expense');
    expect(card).toContain('2. 💸 Gojek — *Rp 25.000* dari BCA Prioritas');
  });
});
