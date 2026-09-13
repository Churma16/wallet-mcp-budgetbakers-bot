import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDefaultFinancialActionRegistry } from '../src/actions/index.js';
import { PendingTransactionService } from '../src/services/pendingTransactionService.js';
import {
  buildItemViewModelFromClarificationDraft,
  buildItemViewModelFromPendingItem,
  buildTransactionAttentionSummary,
  TransactionAttentionItemViewModel,
} from '../src/services/transactionStatusViewModel.js';
import {
  formatTransactionAttentionSummary,
  formatUncertainOutcomeResponse,
} from '../src/utils/transactionStatusFormatter.js';
import { detectReconciliationAction } from '../src/utils/fastPathIntentDetector.js';
import {
  englishDictionary,
  indonesianDictionary,
  setActiveLanguage,
} from '../src/i18n/index.js';
import { formatAccountSelectionUnknownOutcome } from '../src/utils/accountClarificationFormatter.js';
import { IncomingUserMessageEvent } from '../src/services/messaging/index.js';

function event(text = 'status'): IncomingUserMessageEvent {
  return {
    channel: 'whatsapp',
    chatIdentifier: '+6281234567890',
    senderIdentifier: 'coverage-user',
    messageType: 'text',
    textPayload: text,
  };
}

function registryDependencies(
  messagingGateway: { sendMessage: ReturnType<typeof vi.fn> },
  pendingTransactionService?: PendingTransactionService
) {
  return {
    financialActionExecutor: {} as any,
    walletMcpClient: {} as any,
    walletCacheService: {} as any,
    messagingGateway: messagingGateway as any,
    recordPreparationService: {} as any,
    accountClarificationHandler: {} as any,
    pendingTransactionService,
  };
}

describe('PR #155 new-code branch coverage', () => {
  beforeEach(() => {
    setActiveLanguage('id');
  });

  it('registers CHECK_QUEUE only when a pending transaction service is supplied', async () => {
    const messagingGateway = {
      sendMessage: vi.fn().mockResolvedValue(undefined),
    };

    const withoutQueue = createDefaultFinancialActionRegistry(
      registryDependencies(messagingGateway)
    );
    expect(withoutQueue.hasHandler('CHECK_QUEUE')).toBe(false);

    const pendingService = new PendingTransactionService();
    const withQueue = createDefaultFinancialActionRegistry(
      registryDependencies(messagingGateway, pendingService)
    );
    expect(withQueue.hasHandler('CHECK_QUEUE')).toBe(true);

    await withQueue.execute({
      action: 'CHECK_QUEUE',
      event: event(),
      processingStartTimestamp: Date.now(),
      routingSource: 'fast-path',
    });

    expect(messagingGateway.sendMessage).toHaveBeenCalledWith(
      'whatsapp',
      '+6281234567890',
      expect.stringContaining('Tidak ada transaksi yang memerlukan perhatian')
    );
  });

  it.each([
    'sudah ada #0',
    'sudah ada 0',
    'belum ada #0',
    'belum ada 0',
    'sudah #0',
    'belum #0',
  ])('rejects zero ticket IDs instead of creating reconciliation intents: %s', text => {
    expect(detectReconciliationAction(text)).toBeNull();
  });

  it('covers fallback labels and both action modes for standard transaction view models', () => {
    const pendingService = new PendingTransactionService();
    const item = pendingService.addPendingTransaction({
      sourceType: 'WHATSAPP',
      amount: 125000,
      transactionType: 'TRANSFER',
      matchedAccountId: 'acc-1',
      currency: 'IDR',
      recordDate: '2026-09-13',
    });

    const needsCheck = buildItemViewModelFromPendingItem(item, 'NEEDS_CHECK', 'id');
    expect(needsCheck.description).toBe('Transaksi');
    expect(needsCheck.accountName).toBe('Akun');
    expect(needsCheck.isTransfer).toBe(true);
    expect(needsCheck.destinationAccountName).toBeUndefined();
    expect(needsCheck.primaryAction).toBe('MARK_PRESENT');
    expect(needsCheck.secondaryAction).toBe('MARK_ABSENT');

    const waiting = buildItemViewModelFromPendingItem(
      item,
      'WAITING_FOR_CONFIRMATION',
      'id'
    );
    expect(waiting.primaryAction).toBe('CONFIRM');
    expect(waiting.secondaryAction).toBe('CANCEL');
  });

  it('covers empty-record clarification fallbacks and both clarification action modes', () => {
    const draft = {
      ticketId: 88,
      channel: 'whatsapp',
      chatIdentifier: '+6281234567890',
      senderIdentifier: 'coverage-user',
      records: [],
      pendingRecordIndex: 0,
      candidateAccounts: [],
      createdAt: new Date('2026-09-13T00:00:00.000Z'),
      expiresAt: new Date('2026-09-13T01:00:00.000Z'),
    } as any;

    const waiting = buildItemViewModelFromClarificationDraft(
      draft,
      'WAITING_FOR_ACCOUNT',
      'id'
    );
    expect(waiting.amount).toBe(0);
    expect(waiting.currency).toBeUndefined();
    expect(waiting.description).toBe('Transaksi');
    expect(waiting.accountName).toBe('Akun');
    expect(waiting.primaryAction).toBe('SELECT_ACCOUNT');
    expect(waiting.secondaryAction).toBe('CANCEL');

    const needsCheck = buildItemViewModelFromClarificationDraft(draft, 'NEEDS_CHECK', 'en');
    expect(needsCheck.primaryAction).toBe('MARK_PRESENT');
    expect(needsCheck.secondaryAction).toBe('MARK_ABSENT');
  });

  it('omits PROCESSING items from the transaction attention summary', () => {
    const pendingService = new PendingTransactionService();
    const item = pendingService.addPendingTransaction({
      sourceType: 'WHATSAPP',
      counterParty: 'Processing Merchant',
      amount: 42000,
      transactionType: 'EXPENSE',
      matchedAccountId: 'acc-1',
      currency: 'IDR',
      recordDate: '2026-09-13',
    });

    expect(pendingService.claimPendingTransaction(item.ticketId)).toBeDefined();
    const summary = buildTransactionAttentionSummary(pendingService, 'id');

    expect(summary.totalNeedingAttention).toBe(0);
    expect(summary.needsCheckItems).toEqual([]);
    expect(summary.waitingConfirmationItems).toEqual([]);
    expect(summary.waitingAccountItems).toEqual([]);
  });

  it('uses short confirmation commands for a single pending item in both languages', () => {
    const baseItem: TransactionAttentionItemViewModel = {
      ticketId: 9,
      status: 'WAITING_FOR_CONFIRMATION',
      amount: 15000,
      currency: 'IDR',
      formattedAmount: 'Rp 15.000',
      description: 'Snack',
      accountName: 'BCA',
      isTransfer: false,
      createdAt: new Date('2026-09-13T00:00:00.000Z'),
      primaryAction: 'CONFIRM',
      secondaryAction: 'CANCEL',
      sourceKind: 'STANDARD',
    };
    const summary = {
      totalNeedingAttention: 1,
      needsCheckItems: [],
      waitingConfirmationItems: [baseItem],
      waitingAccountItems: [],
    };

    const id = formatTransactionAttentionSummary(summary, 'id');
    expect(id).toContain('Balas *Ya* atau *Batal*.');
    expect(id).not.toContain('Ya #9');

    const en = formatTransactionAttentionSummary(summary, 'en');
    expect(en).toContain('Reply *Yes* or *Cancel*.');
    expect(en).not.toContain('Yes #9');
  });

  it('formats multiple uncertain items in English with and without account labels', () => {
    const first: TransactionAttentionItemViewModel = {
      ticketId: 11,
      status: 'NEEDS_CHECK',
      amount: 10000,
      currency: 'IDR',
      formattedAmount: 'Rp 10,000',
      description: 'Merchant A',
      accountName: '',
      isTransfer: false,
      createdAt: new Date('2026-09-13T00:00:00.000Z'),
      primaryAction: 'MARK_PRESENT',
      secondaryAction: 'MARK_ABSENT',
      sourceKind: 'STANDARD',
    };
    const second = {
      ...first,
      ticketId: 12,
      description: 'Merchant B',
      accountName: 'Checking',
    };

    const formatted = formatUncertainOutcomeResponse([first, second], 'en');
    expect(formatted).toContain('Merchant A (#11)');
    expect(formatted).toContain('Merchant B (#12)');
    expect(formatted).toContain('Account: Checking');
    expect(formatted).not.toContain('Account: \n');
    expect(formatted).toContain('Already exists #11');
    expect(formatted).toContain('Not there #12');
  });

  it('covers email-notification fallback chains for merchant and transfer labels', () => {
    const categoryFallback = indonesianDictionary.emailPending.formatNotification({
      ticketId: 21,
      typeIcon: '📩',
      typeLabel: 'Pembayaran',
      formattedAmount: 'Rp 30.000',
      formattedTime: '13 Sep 2026',
      matchedCategoryName: 'Belanja',
      bankDisplayName: 'BCA',
      totalPendingCount: 1,
    });
    expect(categoryFallback).toContain('Rp 30.000* • Belanja');
    expect(categoryFallback).toContain('Kategori: Belanja');

    const destinationFallback = indonesianDictionary.emailPending.formatNotification({
      ticketId: 22,
      typeIcon: '🔄',
      typeLabel: 'Transfer',
      formattedAmount: 'Rp 40.000',
      formattedTime: '13 Sep 2026',
      accountNameHint: 'BCA',
      totalPendingCount: 1,
    });
    expect(destinationFallback).toContain('BCA ➔ Tujuan');

    const sourceFallback = englishDictionary.emailPending.formatNotification({
      ticketId: 23,
      typeIcon: '🔄',
      typeLabel: 'Transfer',
      formattedAmount: '$5.00',
      formattedTime: 'Sep 13, 2026',
      destinationAccountNameHint: 'Savings',
      totalPendingCount: 1,
    });
    expect(sourceFallback).toContain('Account ➔ Savings');
  });

  it('uses localized transaction and account fallbacks for unknown account-selection outcomes', () => {
    const draft = {
      ticketId: 31,
      channel: 'whatsapp',
      chatIdentifier: '+6281234567890',
      senderIdentifier: 'coverage-user',
      records: [{
        accountId: '',
        amount: -5000,
        recordDate: '2026-09-13',
      }],
      pendingRecordIndex: 0,
      candidateAccounts: [],
      createdAt: new Date('2026-09-13T00:00:00.000Z'),
      expiresAt: new Date('2026-09-13T01:00:00.000Z'),
    } as any;

    setActiveLanguage('id');
    const id = formatAccountSelectionUnknownOutcome(draft);
    expect(id).toContain('• Transaksi (#31)');
    expect(id).toContain('Akun: Akun');

    setActiveLanguage('en');
    const en = formatAccountSelectionUnknownOutcome(draft);
    expect(en).toContain('• Transaction (#31)');
    expect(en).toContain('Account: Account');
  });
});
