import { describe, it, expect } from 'vitest';
import type { WalletRecordItem } from '../src/wallet/types.js';
import type { BankMutationItem } from '../src/core/reconciliation/types.js';
import {
  compareMutationsWithWalletRecords,
  getCalendarDayDifference,
} from '../src/core/reconciliation/comparisonEngine.js';
import {
  applyReconciliationRules,
  jagoGopayRule,
} from '../src/core/reconciliation/rules/jagoGopayRules.js';
import { parseStatementExtractionResponse } from '../src/brain/parsers/statementParser.js';
import {
  formatReconciliationCards,
  buildOverviewCard,
  buildMatchedCard,
  buildWrongAccountCard,
  buildMissingCard,
  buildSingleMissingItemBubble,
  buildPaginationInlineKeyboard,
  handleReconciliationPagination,
} from '../src/core/reconciliation/reconciliationCardFormatter.js';
import { reconciliationSessionStore } from '../src/core/reconciliation/reconciliationSessionStore.js';
import { extractReconciliationAccountHint, isReconciliationCommand } from '../src/core/handlers/reconciliationHandler.js';

describe('Reconciliation Engine - Distance Priority & Exact Matching', () => {
  it('calculates calendar day difference accurately', () => {
    expect(getCalendarDayDifference('2026-11-06T12:00:00Z', '2026-11-06')).toBe(0);
    expect(getCalendarDayDifference('2026-11-05T23:30:00Z', '2026-11-06')).toBe(1);
    expect(getCalendarDayDifference('2026-11-04', '2026-11-06')).toBe(2);
  });

  it('correctly matches exact amount on the exact same day (delta 0)', () => {
    const mutations: BankMutationItem[] = [
      {
        id: 'm1',
        date: '2026-11-06',
        amount: 54500,
        direction: 'DEBIT',
        counterParty: 'Grab',
      },
    ];

    const records: WalletRecordItem[] = [
      {
        id: 'rec-1',
        accountId: 'acc-jago',
        amount: -54500,
        currency: 'IDR',
        recordDate: '2026-11-06T10:00:00Z',
        recordType: 'expense',
      },
    ];

    const result = compareMutationsWithWalletRecords(
      mutations,
      'acc-jago',
      'Bank Jago',
      records
    );

    expect(result.matched.length).toBe(1);
    expect(result.matched[0].walletRecord.id).toBe('rec-1');
    expect(result.missing.length).toBe(0);
    expect(result.wrongAccount.length).toBe(0);
  });

  it('prioritizes exact same day (delta 0) over adjacent day (delta 1) in greedy pairing', () => {
    // Two mutations with the same amount: one on Nov 5, one on Nov 6
    const mutations: BankMutationItem[] = [
      {
        id: 'm-nov5',
        date: '2026-11-05',
        amount: 65800,
        direction: 'DEBIT',
        counterParty: 'Grab Nov 5',
      },
      {
        id: 'm-nov6',
        date: '2026-11-06',
        amount: 65800,
        direction: 'DEBIT',
        counterParty: 'Grab Nov 6',
      },
    ];

    // Two Wallet records: one on Nov 5, one on Nov 6
    const records: WalletRecordItem[] = [
      {
        id: 'rec-nov6',
        accountId: 'acc-jago',
        amount: -65800,
        currency: 'IDR',
        recordDate: '2026-11-06T15:00:00Z',
        recordType: 'expense',
      },
      {
        id: 'rec-nov5',
        accountId: 'acc-jago',
        amount: -65800,
        currency: 'IDR',
        recordDate: '2026-11-05T09:00:00Z',
        recordType: 'expense',
      },
    ];

    const result = compareMutationsWithWalletRecords(
      mutations,
      'acc-jago',
      'Bank Jago',
      records
    );

    expect(result.matched.length).toBe(2);
    // Nov 5 mutation must pair with Nov 5 record
    const matchNov5 = result.matched.find(m => m.mutation.id === 'm-nov5');
    expect(matchNov5?.walletRecord.id).toBe('rec-nov5');

    // Nov 6 mutation must pair with Nov 6 record
    const matchNov6 = result.matched.find(m => m.mutation.id === 'm-nov6');
    expect(matchNov6?.walletRecord.id).toBe('rec-nov6');
  });

  it('detects cross-wallet mismatch when record exists under another account', () => {
    const mutations: BankMutationItem[] = [
      {
        id: 'm-gojez',
        date: '2026-11-06',
        amount: 27000,
        direction: 'DEBIT',
        counterParty: 'Gojez Store',
      },
    ];

    // Recorded under BCA instead of Jago
    const records: WalletRecordItem[] = [
      {
        id: 'rec-bca',
        accountId: 'acc-bca',
        accountName: 'BCA Utama',
        amount: -27000,
        currency: 'IDR',
        recordDate: '2026-11-06T14:00:00Z',
        recordType: 'expense',
      },
    ];

    const result = compareMutationsWithWalletRecords(
      mutations,
      'acc-jago',
      'Bank Jago',
      records
    );

    expect(result.matched.length).toBe(0);
    expect(result.wrongAccount.length).toBe(1);
    expect(result.wrongAccount[0].actualAccountName).toBe('BCA Utama');
    expect(result.wrongAccount[0].walletRecord.id).toBe('rec-bca');
    expect(result.missing.length).toBe(0);
  });

  it('flags unrecorded transactions as missing', () => {
    const mutations: BankMutationItem[] = [
      {
        id: 'm-william',
        date: '2026-11-04',
        amount: 15000,
        direction: 'DEBIT',
        counterParty: 'William Gunawan',
      },
    ];

    const result = compareMutationsWithWalletRecords(
      mutations,
      'acc-jago',
      'Bank Jago',
      [] // empty wallet
    );

    expect(result.matched.length).toBe(0);
    expect(result.wrongAccount.length).toBe(0);
    expect(result.missing.length).toBe(1);
    expect(result.missing[0].mutation.counterParty).toBe('William Gunawan');
  });
});

describe('Reconciliation Custom Rules - Bank Jago x GoPay', () => {
  it('transforms GoPay mutation into Gojek via Jago for Bank Jago target wallet', () => {
    const mutations: BankMutationItem[] = [
      {
        id: 'm1',
        date: '2026-11-06',
        amount: 58500,
        direction: 'DEBIT',
        counterParty: 'GoPay',
        note: 'Outgoing',
      },
      {
        id: 'm2',
        date: '2026-11-06',
        amount: 14000,
        direction: 'DEBIT',
        counterParty: 'Grab',
      },
    ];

    const enriched = applyReconciliationRules('Kantong Jago Utama', mutations);

    expect(enriched[0].counterParty).toBe('Gojek via Jago');
    expect(enriched[0].note).toBe('Gojek via Jago');
    expect(enriched[1].counterParty).toBe('Grab'); // untouched
  });

  it('leaves GoPay mutation untouched if target wallet is not Jago', () => {
    const mutations: BankMutationItem[] = [
      {
        id: 'm1',
        date: '2026-11-06',
        amount: 58500,
        direction: 'DEBIT',
        counterParty: 'GoPay',
      },
    ];

    const enriched = applyReconciliationRules('BCA Digital', mutations);
    expect(enriched[0].counterParty).toBe('GoPay');
  });
});

describe('Statement Vision Parser - Extraction & Deduplication', () => {
  it('parses structured JSON and dedupes overlapping screenshots', () => {
    const rawLlmOutput = `
\`\`\`json
{
  "mutations": [
    {
      "date": "2026-11-06",
      "amount": "-Rp58.500",
      "direction": "DEBIT",
      "counterParty": "GoPay",
      "note": "Outgoing"
    },
    {
      "date": "2026-11-06",
      "amount": 58500,
      "direction": "DEBIT",
      "counterParty": "GoPay",
      "note": "Outgoing"
    },
    {
      "date": "2026-11-04",
      "amount": "- Rp 38.000,00",
      "direction": "DEBIT",
      "counterParty": "QR Bayar ke BLIBLI.COM"
    }
  ]
}
\`\`\`
    `;

    const parsed = parseStatementExtractionResponse(rawLlmOutput);
    expect(parsed.length).toBe(2); // The duplicate 58500 row is filtered out!
    expect(parsed[0].amount).toBe(58500);
    expect(parsed[0].direction).toBe('DEBIT');
    expect(parsed[1].amount).toBe(38000);
    expect(parsed[1].counterParty).toBe('QR Bayar ke BLIBLI.COM');
  });
});

describe('Reconciliation Card Formatter & Command Parser', () => {
  it('detects reconciliation commands and extracts account hints', () => {
    expect(isReconciliationCommand('/reconciliation jago')).toBe(true);
    expect(isReconciliationCommand('/reconciliation')).toBe(true);
    expect(isReconciliationCommand('/reconciliation@wallet_mcp_churma_bot mandiri')).toBe(true);
    expect(isReconciliationCommand('/reconciliation@wallet_mcp_churma_bot')).toBe(true);
    expect(isReconciliationCommand('reconciliation jago')).toBe(false);

    expect(extractReconciliationAccountHint('/reconciliation jago')).toBe('jago');
    expect(extractReconciliationAccountHint('/reconciliation Blu BCA Digital')).toBe('Blu BCA Digital');
    expect(extractReconciliationAccountHint('/reconciliation@wallet_mcp_churma_bot mandiri')).toBe('mandiri');
    expect(extractReconciliationAccountHint('/reconciliation@wallet_mcp_churma_bot')).toBe('');
    expect(extractReconciliationAccountHint('/reconciliation')).toBe('');
  });

  it('formats clean, mobile-optimized card response with tickets', () => {
    const comparisonResult = {
      targetAccountId: 'acc-jago',
      targetAccountName: 'Bank Jago',
      dateRange: { startDate: '2026-11-04', endDate: '2026-11-06' },
      totalMutations: 3,
      matched: [
        {
          mutation: { id: 'm1', date: '2026-11-06', amount: 54500, direction: 'DEBIT' as const, counterParty: 'Grab' },
          walletRecord: { id: 'r1', accountId: 'acc-jago', amount: -54500, currency: 'IDR', recordDate: '2026-11-06', recordType: 'expense' as const },
        },
      ],
      wrongAccount: [
        {
          mutation: { id: 'm2', date: '2026-11-06', amount: 27000, direction: 'DEBIT' as const, counterParty: 'Gojez Store' },
          walletRecord: { id: 'r2', accountId: 'acc-bca', amount: -27000, currency: 'IDR', recordDate: '2026-11-06', recordType: 'expense' as const },
          actualAccountName: 'BCA',
        },
      ],
      missing: [
        {
          mutation: { id: 'm3', date: '2026-11-04', amount: 15000, direction: 'DEBIT' as const, counterParty: 'William Gunawan' },
          note: 'William Gunawan',
        },
      ],
      extraInWallet: [],
    };

    const cards = formatReconciliationCards('test-session', comparisonResult, {
      ticketReferences: [{ mutationId: 'm3', ticketId: 101 }],
    });

    expect(cards.overview).toContain('Hasil Rekonsiliasi: Bank Jago');
    expect(cards.matched?.text).toContain('Sudah Sesuai (Total 1)');
    expect(cards.wrongAccount?.text).toContain('Salah Wallet / Akun (Total 1)');
    expect(cards.missing?.text).toContain('Terlewat / Belum Tercatat (Total 1)');
    expect(cards.missing?.text).toContain('[Tiket #101]');
    expect(cards.missing?.text).toContain('Balas *Ya #101*');
  });

  it('builds overview card with status breakdown and celebration on 100% matched', () => {
    const allMatched = {
      targetAccountId: 'acc-jago',
      targetAccountName: 'Bank Jago',
      dateRange: { startDate: '2026-11-04', endDate: '2026-11-06' },
      totalMutations: 2,
      matched: [
        {
          mutation: { id: 'm1', date: '2026-11-06', amount: 50000, direction: 'DEBIT' as const, counterParty: 'Store 1' },
          walletRecord: { id: 'r1', accountId: 'acc-jago', amount: -50000, currency: 'IDR', recordDate: '2026-11-06', recordType: 'expense' as const },
        },
      ],
      wrongAccount: [],
      missing: [],
      extraInWallet: [],
    };

    const overview = buildOverviewCard(allMatched);
    expect(overview).toContain('Sudah Sesuai: *1 transaksi*');
    expect(overview).toContain('Salah Akun / Wallet: *0 transaksi*');
    expect(overview).toContain('Belum Tercatat: *0 transaksi*');
    expect(overview).toContain('Semua transaksi mutasi tercatat lengkap di Wallet!');
  });

  it('formats matched card with 2-line numbered items and continuous page numbering', () => {
    const pairs = Array.from({ length: 7 }, (_, i) => ({
      mutation: {
        id: `m-${i + 1}`,
        date: '2026-11-06',
        amount: (i + 1) * 10000,
        direction: 'DEBIT' as const,
        counterParty: `Merchant ${i + 1}`,
      },
      walletRecord: {
        id: `r-${i + 1}`,
        accountId: 'acc-jago',
        amount: -((i + 1) * 10000),
        currency: 'IDR',
        recordDate: '2026-11-06',
        recordType: 'expense' as const,
      },
    }));

    // Page 1 (items 1..5)
    const page1 = buildMatchedCard(pairs, 1, 5);
    expect(page1).toContain('🟢 *Sudah Sesuai (Hal 1/2 - Total 7)*');
    expect(page1).toContain('1. *Merchant 1*\n   Rp10.000 • _6 Nov_');
    expect(page1).toContain('5. *Merchant 5*\n   Rp50.000 • _6 Nov_');
    expect(page1).not.toContain('6. *Merchant 6*');

    // Page 2 (items 6..7)
    const page2 = buildMatchedCard(pairs, 2, 5);
    expect(page2).toContain('🟢 *Sudah Sesuai (Hal 2/2 - Total 7)*');
    expect(page2).toContain('6. *Merchant 6*\n   Rp60.000 • _6 Nov_');
    expect(page2).toContain('7. *Merchant 7*\n   Rp70.000 • _6 Nov_');
    expect(page2).not.toContain('1. *Merchant 1*');

    // Empty list returns empty string
    expect(buildMatchedCard([])).toBe('');
  });

  it('splits 19 matched items into 5 pages with 4 items per page', () => {
    const pairs = Array.from({ length: 19 }, (_, i) => ({
      mutation: { id: `m-${i + 1}`, date: '2026-11-06', amount: 10000, direction: 'DEBIT' as const, counterParty: `Item ${i + 1}` },
      walletRecord: { id: `r-${i + 1}`, accountId: 'acc-1', amount: -10000, currency: 'IDR', recordDate: '2026-11-06', recordType: 'expense' as const },
    }));

    const page1 = buildMatchedCard(pairs, 1);
    expect(page1).toContain('🟢 *Sudah Sesuai (Hal 1/5 - Total 19)*');
    expect(page1).toContain('1. *Item 1*');
    expect(page1).toContain('4. *Item 4*');
    expect(page1).not.toContain('5. *Item 5*');

    const keyboard = buildPaginationInlineKeyboard('sess1', 'm', 1, 5);
    expect(keyboard?.inline_keyboard[0][0].text).toBe('1/5');
    expect(keyboard?.inline_keyboard[0][1].text).toBe('Next ➡️');
  });

  it('formats wrong account card with 2-line detail and actual account note', () => {
    const wrong = [
      {
        mutation: { id: 'm1', date: '2026-11-05', amount: 15799, direction: 'DEBIT' as const, counterParty: 'Tokopedia' },
        walletRecord: { id: 'r1', accountId: 'acc-mandiri', amount: -15799, currency: 'IDR', recordDate: '2026-11-05', recordType: 'expense' as const },
        actualAccountName: 'Mandiri Debit Card',
      },
    ];

    const card = buildWrongAccountCard(wrong, 'Jago Expense');
    expect(card).toContain('🟡 *Salah Wallet / Akun (Total 1)*');
    expect(card).toContain('1. *Tokopedia*');
    expect(card).toContain('*Rp15.799* • _5 Nov_');
    expect(card).toContain('↳ Tercatat di: *Mandiri Debit Card* (seharusnya Jago Expense)');
    expect(buildWrongAccountCard([], 'Jago Expense')).toBe('');
  });

  it('formats missing card with ticket references and confirmation prompt', () => {
    const missing = [
      {
        mutation: { id: 'm1', date: '2026-11-04', amount: 50000, direction: 'DEBIT' as const, counterParty: 'Kopi Kenangan' },
      },
      {
        mutation: { id: 'm2', date: '2026-11-04', amount: 35000, direction: 'DEBIT' as const, counterParty: 'Roti O' },
      },
    ];

    const ticketMap = new Map([
      ['m1', 1],
      ['m2', 2],
    ]);

    const card = buildMissingCard(missing, ticketMap);
    expect(card).toContain('🔴 *Terlewat / Belum Tercatat (Total 2)*');
    expect(card).toContain('1. *Kopi Kenangan*');
    expect(card).toContain('*[Tiket #1] Rp50.000* • _4 Nov_');
    expect(card).toContain('2. *Roti O*');
    expect(card).toContain('*[Tiket #2] Rp35.000* • _4 Nov_');
    expect(card).toContain('Tekan tombol di bawah untuk catat per transaksi, atau balas *Ya semua*.');
    expect(buildMissingCard([], new Map())).toBe('');
  });

  it('formats single missing item bubble for direct swipe-reply interaction', () => {
    const bubble = buildSingleMissingItemBubble(
      { mutation: { id: 'm1', date: '2026-11-04', amount: 50000, direction: 'DEBIT' as const, counterParty: 'Kopi Kenangan', note: 'Order #123' } },
      1
    );
    expect(bubble).toContain('🔴 *Belum Tercatat [Tiket #1]*');
    expect(bubble).toContain('*Kopi Kenangan*');
    expect(bubble).toContain('Rp50.000 • _4 Nov_');
    expect(bubble).toContain('_Order #123_');
    expect(bubble).toContain('swipe reply');
  });

  it('builds pagination inline keyboard properly with boundary guards', () => {
    // Single page returns undefined
    expect(buildPaginationInlineKeyboard('sess1', 'm', 1, 1)).toBeUndefined();

    // First page of multi-page
    const p1 = buildPaginationInlineKeyboard('sess1', 'm', 1, 3);
    expect(p1?.inline_keyboard[0].length).toBe(2);
    expect(p1?.inline_keyboard[0][0].text).toBe('1/3');
    expect(p1?.inline_keyboard[0][1].text).toBe('Next ➡️');
    expect(p1?.inline_keyboard[0][1].callback_data).toBe('recon:sess1:m:2');

    // Middle page of multi-page
    const p2 = buildPaginationInlineKeyboard('sess1', 'm', 2, 3);
    expect(p2?.inline_keyboard[0].length).toBe(3);
    expect(p2?.inline_keyboard[0][0].text).toBe('⬅️ Prev');
    expect(p2?.inline_keyboard[0][1].text).toBe('2/3');
    expect(p2?.inline_keyboard[0][2].text).toBe('Next ➡️');

    // Last page of multi-page
    const p3 = buildPaginationInlineKeyboard('sess1', 'm', 3, 3);
    expect(p3?.inline_keyboard[0].length).toBe(2);
    expect(p3?.inline_keyboard[0][0].text).toBe('⬅️ Prev');
    expect(p3?.inline_keyboard[0][1].text).toBe('3/3');
  });

  it('manages reconciliation session store lifecycle and pruning', () => {
    reconciliationSessionStore.clear();

    const dummyResult = {
      targetAccountId: 'acc-1',
      targetAccountName: 'Jago',
      dateRange: { startDate: '2026-11-01', endDate: '2026-11-02' },
      totalMutations: 0,
      matched: [],
      wrongAccount: [],
      missing: [],
      extraInWallet: [],
    };

    const sessId = reconciliationSessionStore.createSession('chat-1', 'Jago', dummyResult, []);
    expect(sessId).toBeDefined();

    const session = reconciliationSessionStore.getSession(sessId);
    expect(session?.chatId).toBe('chat-1');

    reconciliationSessionStore.deleteSession(sessId);
    expect(reconciliationSessionStore.getSession(sessId)).toBeUndefined();
  });

  it('handles reconciliation pagination callback queries correctly', () => {
    reconciliationSessionStore.clear();

    const result = {
      targetAccountId: 'acc-jago',
      targetAccountName: 'Bank Jago',
      dateRange: { startDate: '2026-11-01', endDate: '2026-11-02' },
      totalMutations: 6,
      matched: Array.from({ length: 6 }, (_, i) => ({
        mutation: { id: `m-${i}`, date: '2026-11-01', amount: 10000, direction: 'DEBIT' as const, counterParty: `M${i}` },
        walletRecord: { id: `r-${i}`, accountId: 'acc-jago', amount: -10000, currency: 'IDR', recordDate: '2026-11-01', recordType: 'expense' as const },
      })),
      wrongAccount: [
        {
          mutation: { id: 'w1', date: '2026-11-01', amount: 20000, direction: 'DEBIT' as const, counterParty: 'WrongStore' },
          walletRecord: { id: 'rw1', accountId: 'acc-other', amount: -20000, currency: 'IDR', recordDate: '2026-11-01', recordType: 'expense' as const },
          actualAccountName: 'OtherBank',
        },
      ],
      missing: [
        {
          mutation: { id: 'x1', date: '2026-11-01', amount: 30000, direction: 'DEBIT' as const, counterParty: 'MissingStore' },
        },
      ],
      extraInWallet: [],
    };

    const sessId = reconciliationSessionStore.createSession('chat-1', 'Bank Jago', result, [
      { mutationId: 'x1', ticketId: 42 },
    ]);

    // Ignored / invalid callbacks
    expect(handleReconciliationPagination('other:command')).toBeNull();
    expect(handleReconciliationPagination('recon:noop')).toBeNull();
    expect(handleReconciliationPagination('recon:sess:invalid')).toBeNull();
    expect(handleReconciliationPagination('recon:non-existent:m:1')).toBeNull();

    // Valid matched page 2
    const mPage2 = handleReconciliationPagination(`recon:${sessId}:m:2`);
    expect(mPage2).not.toBeNull();
    expect(mPage2?.text).toContain('🟢 *Sudah Sesuai (Hal 2/2 - Total 6)*');
    expect(mPage2?.text).toContain('6. *M5*');

    // Valid wrong account page 1
    const wPage1 = handleReconciliationPagination(`recon:${sessId}:w:1`);
    expect(wPage1?.text).toContain('🟡 *Salah Wallet / Akun (Total 1)*');

    // Valid missing page 1
    const xPage1 = handleReconciliationPagination(`recon:${sessId}:x:1`);
    expect(xPage1?.text).toContain('🔴 *Terlewat / Belum Tercatat (Total 1)*');
    expect(xPage1?.text).toContain('[Tiket #42]');
  });
});

describe('ReconciliationHandler Workflow Integration', () => {
  function createMockDependencies() {
    const sentMessages: Array<{ channel: string; chatIdentifier: string; text: string; options?: any }> = [];
    const addedTickets: any[] = [];

    const mockGateway = {
      sendMessage: async (channel: string, chatIdentifier: string, text: string, options?: any) => {
        sentMessages.push({ channel, chatIdentifier, text, options });
      },
      sendTypingPresence: async () => {},
    };

    const mockWalletCache = {
      getAccounts: () => [
        { id: 'acc-jago', name: 'Bank Jago', currency: 'IDR' },
        { id: 'acc-bca', name: 'BCA Utama', currency: 'IDR' },
      ],
      getCategories: () => [
        { id: 'cat-transport', name: 'Transportasi' },
        { id: 'cat-food', name: 'Makanan & Minuman' },
      ],
    };

    const mockWalletClient = {
      fetchRecords: async (_opts?: any) => ({
        records: [
          {
            id: 'rec-1',
            accountId: 'acc-jago',
            amount: -54500,
            currency: 'IDR',
            recordDate: '2026-11-06T10:00:00Z',
            recordType: 'expense' as const,
          },
        ],
      }),
    };

    let nextTicketId = 1;
    const mockPendingManager = {
      addPendingTransaction: (data: any) => {
        const ticketId = nextTicketId++;
        const item = { ...data, ticketId };
        addedTickets.push(item);
        return item;
      },
    };

    const mockBrainProvider = {
      processStatementImages: async () => [
        {
          id: 'mut-1',
          date: '2026-11-06',
          amount: 54500,
          direction: 'DEBIT' as const,
          counterParty: 'Grab',
        },
        {
          id: 'mut-2',
          date: '2026-11-06',
          amount: 58500,
          direction: 'DEBIT' as const,
          counterParty: 'GoPay',
        },
      ],
    };

    return {
      sentMessages,
      addedTickets,
      deps: {
        gateway: mockGateway as any,
        walletCache: mockWalletCache as any,
        walletClient: mockWalletClient as any,
        pendingTransactionManager: mockPendingManager as any,
        brainProvider: mockBrainProvider as any,
      },
    };
  }

  it('returns false when incoming message is not a reconciliation command', async () => {
    const { deps } = createMockDependencies();
    const handler = new (await import('../src/core/handlers/reconciliationHandler.js')).ReconciliationHandler(deps);

    const handled = await handler.handleReconciliationRequest({
      channel: 'telegram',
      senderIdentifier: 'user-1',
      chatIdentifier: 'chat-1',
      messageType: 'text',
      textPayload: 'Kopi kenangan 28rb',
    });

    expect(handled).toBe(false);
  });

  it('prompts user when account hint is missing in command', async () => {
    const { deps, sentMessages } = createMockDependencies();
    const handler = new (await import('../src/core/handlers/reconciliationHandler.js')).ReconciliationHandler(deps);

    const handled = await handler.handleReconciliationRequest({
      channel: 'telegram',
      senderIdentifier: 'user-1',
      chatIdentifier: 'chat-1',
      messageType: 'image',
      textPayload: '/reconciliation',
      imageBuffer: Buffer.from('fake-image'),
    });

    expect(handled).toBe(true);
    expect(sentMessages[0].text).toContain('Sertakan nama wallet/akun');
  });

  it('reports error when specified account is not found in cache', async () => {
    const { deps, sentMessages } = createMockDependencies();
    const handler = new (await import('../src/core/handlers/reconciliationHandler.js')).ReconciliationHandler(deps);

    const handled = await handler.handleReconciliationRequest({
      channel: 'telegram',
      senderIdentifier: 'user-1',
      chatIdentifier: 'chat-1',
      messageType: 'image',
      textPayload: '/reconciliation mandiri',
      imageBuffer: Buffer.from('fake-image'),
    });

    expect(handled).toBe(true);
    expect(sentMessages[0].text).toContain('mandiri');
    expect(sentMessages[0].text).toContain('tidak ditemukan');
  });

  it('reports warning when no image buffers are attached', async () => {
    const { deps, sentMessages } = createMockDependencies();
    const handler = new (await import('../src/core/handlers/reconciliationHandler.js')).ReconciliationHandler(deps);

    const handled = await handler.handleReconciliationRequest({
      channel: 'telegram',
      senderIdentifier: 'user-1',
      chatIdentifier: 'chat-1',
      messageType: 'text',
      textPayload: '/reconciliation jago',
    });

    expect(handled).toBe(true);
    expect(sentMessages[0].text).toContain('Mohon lampirkan foto/screenshot');
  });

  it('reports warning when vision extraction produces 0 mutations', async () => {
    const { deps, sentMessages } = createMockDependencies();
    deps.brainProvider.processStatementImages = async () => [];
    const handler = new (await import('../src/core/handlers/reconciliationHandler.js')).ReconciliationHandler(deps);

    const handled = await handler.handleReconciliationRequest({
      channel: 'telegram',
      senderIdentifier: 'user-1',
      chatIdentifier: 'chat-1',
      messageType: 'image',
      textPayload: '/reconciliation jago',
      imageBuffer: Buffer.from('fake-image'),
    });

    expect(handled).toBe(true);
    expect(sentMessages[0].text).toContain('Tidak dapat membaca baris transaksi');
  });

  it('successfully extracts mutations, applies Jago-GoPay rule, adds missing tickets, and sends card', async () => {
    const { deps, sentMessages, addedTickets } = createMockDependencies();
    const handler = new (await import('../src/core/handlers/reconciliationHandler.js')).ReconciliationHandler(deps);

    const handled = await handler.handleReconciliationRequest({
      channel: 'telegram',
      senderIdentifier: 'user-1',
      chatIdentifier: 'chat-1',
      messageType: 'image',
      textPayload: '/reconciliation jago',
      imageBuffers: [Buffer.from('img-1'), Buffer.from('img-2')],
    });

    expect(handled).toBe(true);
    // Grab Rp54.500 matches existing rec-1.
    // GoPay Rp58.500 is transformed by jagoGopayRule to "Gojek via Jago" (Transportasi) and enqueued as missing!
    expect(addedTickets.length).toBe(1);
    expect(addedTickets[0].counterParty).toBe('Gojek via Jago');
    expect(addedTickets[0].amount).toBe(-58500);
    expect(addedTickets[0].matchedCategoryId).toBe('cat-transport');

    // Sent messages: Bubble 1 (Overview), Bubble 2 (Matched), Bubble 3 (Missing)
    expect(sentMessages.length).toBe(3);
    expect(sentMessages[0].text).toContain('Hasil Rekonsiliasi: Bank Jago');
    expect(sentMessages[0].text).toContain('Sudah Sesuai: *1 transaksi*');
    expect(sentMessages[0].text).toContain('Belum Tercatat: *1 transaksi*');

    expect(sentMessages[1].text).toContain('🟢 *Sudah Sesuai (Total 1)*');
    expect(sentMessages[1].text).toContain('Grab');

    expect(sentMessages[2].text).toContain('🔴 *Terlewat / Belum Tercatat (Total 1)*');
    expect(sentMessages[2].text).toContain('Gojek via Jago');
    expect(sentMessages[2].text).toContain('Rp58.500');
    expect(sentMessages[2].options?.replyMarkup?.inline_keyboard[0][0].text).toBe('✍️ Catat Per Transaksi');

    // Trigger CTA spawn to expand into individual bubbles
    const sessions = (reconciliationSessionStore as any).sessions;
    const sessId = Array.from(sessions.keys()).pop() as string;
    await handler.handleSpawnMissingRequest({
      channel: 'telegram',
      senderIdentifier: 'user-1',
      chatIdentifier: 'chat-1',
      messageType: 'text',
      textPayload: `/recon_spawn ${sessId}`,
    }, sessId);

    expect(sentMessages.length).toBe(4);
    expect(sentMessages[3].text).toContain('🔴 *Belum Tercatat [Tiket #1]*');
    expect(sentMessages[3].text).toContain('Gojek via Jago');
  });

  it('reports warning when brainProvider does not support processStatementImages', async () => {
    const { deps, sentMessages } = createMockDependencies();
    deps.brainProvider = {} as any;
    const handler = new (await import('../src/core/handlers/reconciliationHandler.js')).ReconciliationHandler(deps);
    const handled = await handler.handleReconciliationRequest({
      channel: 'telegram',
      senderIdentifier: 'user-1',
      chatIdentifier: 'chat-1',
      messageType: 'image',
      textPayload: '/reconciliation jago',
      imageBuffer: Buffer.from('fake'),
    });
    expect(handled).toBe(true);
    expect(sentMessages[0].text).toContain('belum mendukung ekstraksi mutasi');
  });

  it('handles walletClient fetch error gracefully', async () => {
    const { deps, sentMessages } = createMockDependencies();
    deps.walletClient.fetchRecords = async () => {
      throw new Error('Network error');
    };
    const handler = new (await import('../src/core/handlers/reconciliationHandler.js')).ReconciliationHandler(deps);
    const handled = await handler.handleReconciliationRequest({
      channel: 'telegram',
      senderIdentifier: 'user-1',
      chatIdentifier: 'chat-1',
      messageType: 'image',
      textPayload: '/reconciliation jago',
      imageBuffer: Buffer.from('fake'),
    });
    expect(handled).toBe(true);
    expect(sentMessages[0].text).toContain('Hasil Rekonsiliasi: Bank Jago');
  });

  it('enqueues income missing item without category correctly', async () => {
    const { deps, addedTickets } = createMockDependencies();
    deps.brainProvider.processStatementImages = async () => [
      {
        id: 'mut-income',
        date: '2026-11-06',
        amount: 100000,
        direction: 'CREDIT' as const,
        counterParty: 'Gaji Masuk',
      },
    ];
    const handler = new (await import('../src/core/handlers/reconciliationHandler.js')).ReconciliationHandler(deps);
    const handled = await handler.handleReconciliationRequest({
      channel: 'telegram',
      senderIdentifier: 'user-1',
      chatIdentifier: 'chat-1',
      messageType: 'image',
      textPayload: '/reconciliation jago',
      imageBuffer: Buffer.from('fake'),
    });
    expect(handled).toBe(true);
    expect(addedTickets[0].amount).toBe(100000);
    expect(addedTickets[0].transactionType).toBe('INCOME');
  });
});

describe('Provider Statement Processing Coverage', () => {
  it('FallbackAiProvider delegates processStatementImages to active provider', async () => {
    const { FallbackAiProvider } = await import('../src/brain/providers/fallbackProvider.js');
    const mockProvider = {
      providerName: 'gemini',
      processStatementImages: async () => [
        { id: 'm1', date: '2026-11-06', amount: 50000, direction: 'DEBIT' as const, counterParty: 'Grab' },
      ],
    };
    const fallback = new FallbackAiProvider([mockProvider as any]);
    const result = await fallback.processStatementImages([Buffer.from('test')], 'image/jpeg', 'test');
    expect(result.length).toBe(1);
    expect(result[0].amount).toBe(50000);

    const fallbackWithoutStatement = new FallbackAiProvider([{ providerName: 'no-stmt' } as any]);
    const empty = await fallbackWithoutStatement.processStatementImages([Buffer.from('test')], 'image/jpeg', 'test');
    expect(empty).toEqual([]);
  });

  it('GeminiAiProvider.processStatementImages parses extraction output', async () => {
    const { GeminiAiProvider } = await import('../src/brain/providers/geminiProvider.js');
    const provider = new GeminiAiProvider('test-api-key', 'gemini-3.8-flash');
    (provider as any).executeGeneration = async () => ({
      responseText: JSON.stringify({
        mutations: [
          { date: '2026-11-06', amount: 54500, direction: 'DEBIT', counterParty: 'Grab' },
        ],
      }),
    });
    const mutations = await provider.processStatementImages([Buffer.from('img')], 'image/jpeg', 'test');
    expect(mutations.length).toBe(1);
    expect(mutations[0].amount).toBe(54500);
    expect(mutations[0].counterParty).toBe('Grab');
  });

  it('formats card when all transactions matched 100% and previews >4 items', () => {
    const comparisonResult = {
      targetAccountId: 'acc-jago',
      targetAccountName: 'Bank Jago',
      dateRange: { startDate: '2026-11-01', endDate: '2026-11-06' },
      totalMutations: 6,
      matched: [
        { mutation: { id: 'm1', date: '2026-11-01', amount: 10000, direction: 'DEBIT' as const, counterParty: 'T1' }, walletRecord: {} as any },
        { mutation: { id: 'm2', date: '2026-11-02', amount: 20000, direction: 'DEBIT' as const, counterParty: 'T2' }, walletRecord: {} as any },
        { mutation: { id: 'm3', date: '2026-11-03', amount: 30000, direction: 'DEBIT' as const, counterParty: 'T3' }, walletRecord: {} as any },
        { mutation: { id: 'm4', date: '2026-11-04', amount: 40000, direction: 'DEBIT' as const, counterParty: 'T4' }, walletRecord: {} as any },
        { mutation: { id: 'm5', date: '2026-11-05', amount: 50000, direction: 'DEBIT' as const, counterParty: 'T5' }, walletRecord: {} as any },
        { mutation: { id: 'm6', date: '2026-11-06', amount: 60000, direction: 'DEBIT' as const, counterParty: 'T6' }, walletRecord: {} as any },
      ],
      wrongAccount: [],
      missing: [],
      extraInWallet: [],
    };

    const cards = formatReconciliationCards('test-session', comparisonResult);
    expect(cards.overview).toContain('Semua transaksi mutasi tercatat lengkap di Wallet!');
    expect(cards.matched?.text).toContain('🟢 *Sudah Sesuai (Hal 1/2 - Total 6)*');
    expect(cards.matched?.text).toContain('1. *T1*');
  });

  it('covers statement parser edge cases and date fallback', () => {
    expect(parseStatementExtractionResponse('not a json at all')).toEqual([]);
    expect(parseStatementExtractionResponse(JSON.stringify({ mutations: 'not-array' }))).toEqual([]);
    expect(parseStatementExtractionResponse(JSON.stringify({ other: 123 }))).toEqual([]);

    const textWithJson = 'Result: {"mutations": [{"amount": 10000, "direction": "CREDIT", "date": "invalid-date"}]}';
    const parsed = parseStatementExtractionResponse(textWithJson);
    expect(parsed.length).toBe(1);
    expect(parsed[0].direction).toBe('CREDIT');
    expect(parsed[0].date).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    const zeroAmount = JSON.stringify({
      mutations: [
        { amount: 0, direction: 'DEBIT', counterParty: 'Zero' },
        { amount: -50, direction: 'DEBIT', counterParty: 'Negative' },
        { amount: 'invalid-amount', direction: 'DEBIT', counterParty: 'Bad' },
      ],
    });
    const parsedZero = parseStatementExtractionResponse(zeroAmount);
    expect(parsedZero.length).toBe(1);
    expect(parsedZero[0].counterParty).toBe('Negative');
  });

  it('covers card formatter date edge cases', () => {
    const result = {
      targetAccountId: 'acc-1',
      targetAccountName: 'Test Wallet',
      dateRange: { startDate: 'invalid_date', endDate: 'invalid_date' },
      totalMutations: 0,
      matched: [],
      wrongAccount: [],
      missing: [],
      extraInWallet: [],
    };
    const cards = formatReconciliationCards('test-session', result);
    expect(cards.overview).toContain('invalid_date');
  });

  it('covers CREDIT/income matching in comparison engine', () => {
    const mutations: BankMutationItem[] = [
      { id: 'm-inc', date: '2026-11-06', amount: 5000000, direction: 'CREDIT', counterParty: 'Gaji' },
    ];
    const records: WalletRecordItem[] = [
      { id: 'r-inc', accountId: 'acc-jago', amount: 5000000, currency: 'IDR', recordDate: '2026-11-06', recordType: 'income' },
    ];
    const result = compareMutationsWithWalletRecords(mutations, 'acc-jago', 'Jago', records);
    expect(result.matched.length).toBe(1);
    expect(result.matched[0].walletRecord.id).toBe('r-inc');
  });

  it('covers statement prompt without caption', async () => {
    const { buildStatementPrompt } = await import('../src/brain/prompts/promptStatementTemplate.js');
    const prompt = buildStatementPrompt();
    expect(prompt).not.toContain('User Context Caption');
  });
});
