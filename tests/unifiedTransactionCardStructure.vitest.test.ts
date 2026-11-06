import { describe, it, expect, beforeEach } from 'vitest';
import {
  formatRecordSuccessMessage,
  formatPendingConfirmationSuccess,
  formatRetroactivelyEnrichedWalletRecordNotification,
  formatCorrelatedWalletRecordNotification,
} from '../src/wallet/formatters/humanResponseFormatter.js';
import { setActiveLanguage } from '../src/i18n/index.js';
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

    expect(card).toContain('✅ *Grab* berhasil dicatat! (#1)');
    expect(card).toContain('💸 Rp 65.800  •  Jago Expense');
    expect(card).toContain('🏷️ Ojol  •  4 Nov 2026, 09:34 WIB');
    expect(card).toContain('📝 _Grab booking A-AXTLANJGXX2TAV_');
    expect(card).not.toContain('321f074f'); // No raw UUID
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

    expect(card).toContain('✨ *Grab* berhasil diperbarui!');
    expect(card).toContain('💸 Rp 65.800  •  Jago Expense');
    expect(card).toContain('🏷️ Ojol  •  4 Nov 2026, 09:34 WIB');
    expect(card).toContain('📝 _Grab booking A-AXTLANJGXX2TAV_');
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
    expect(confirmCard).toContain('✅ *Gojek* successfully recorded! (#2)');
    expect(confirmCard).toContain('💸 Rp 125,000  •  BCA Prioritas');
    expect(confirmCard).toContain('🏷️ Makanan & Minuman  •  Nov 4, 2026, 09:34 WIB');
    expect(confirmCard).toContain('📝 _GoFood: Ayam Geprek_');

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
    expect(updateCard).toContain('✨ *Gojek* successfully updated!');
    expect(updateCard).toContain('💸 Rp 125,000  •  BCA Prioritas');
    expect(updateCard).toContain('🏷️ Makanan & Minuman  •  Nov 4, 2026, 09:34 WIB');

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
});
