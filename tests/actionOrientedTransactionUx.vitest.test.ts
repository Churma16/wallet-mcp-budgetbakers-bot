import { describe, it, expect, beforeEach, vi } from 'vitest';
import { UserMessageHandler } from '../src/handlers/userMessageHandler.js';
import {
  setActiveLanguage,
  getDictionary,
  indonesianDictionary,
  englishDictionary,
} from '../src/i18n/index.js';
import {
  formatPendingEmailTransactionNotification,
} from '../src/utils/humanResponseFormatter.js';
import {
  formatUncertainOutcomeResponse,
  formatTransactionAttentionSummary,
  formatReconciliationRecordedResponse,
  formatReconciliationAbsentResponse,
  formatReconciliationNotFoundResponse,
  formatReconciliationAmbiguousResponse,
} from '../src/utils/transactionStatusFormatter.js';
import {
  buildTransactionAttentionSummary,
  buildItemViewModelFromClarificationDraft,
  buildItemViewModelFromPendingItem,
  TransactionAttentionItemViewModel,
} from '../src/services/transactionStatusViewModel.js';
import {
  PendingTransactionService,
  PendingTransactionItem,
  PendingAccountSelectionDraft,
} from '../src/services/pendingTransactionService.js';
import { PendingActionHandler } from '../src/handlers/pendingActionHandler.js';
import { FastPathHandler } from '../src/handlers/fastPathHandler.js';
import { createTestUserMessageHandler } from './fixtures/compositionFixtures.js';
import { FinancialActionRegistry } from '../src/actions/index.js';
import {
  WalletMcpRequestError,
} from '../src/services/walletMcpService.js';
import {
  CreateRecordInputPayload,
  WalletCreateRecordsResponse,
  WalletAccountItem,
} from '../src/types/walletTypes.js';
import { IncomingUserMessageEvent } from '../src/services/messaging/index.js';
import {
  detectFastPathAction,
  detectReconciliationAction,
} from '../src/utils/fastPathIntentDetector.js';
import { CheckQueueActionHandler } from '../src/actions/readActionHandlers.js';
import {
  formatAccountSelectionPrompt,
  formatAccountSelectionCancellation,
  formatAccountSelectionProcessing,
  formatAccountSelectionRetry,
  formatAccountSelectionUnknownOutcome,
  formatAccountSelectionUnknownDismissal,
} from '../src/utils/accountClarificationFormatter.js';

class MockWalletMcpClient {
  public readonly calls: CreateRecordInputPayload[][] = [];
  private shouldFailWithUnknown = false;
  private customDispatchHandler?: (records: CreateRecordInputPayload[]) => Promise<WalletCreateRecordsResponse>;

  setUnknownFailure(fail: boolean): void {
    this.shouldFailWithUnknown = fail;
  }

  setCustomDispatchHandler(
    handler?: (records: CreateRecordInputPayload[]) => Promise<WalletCreateRecordsResponse>
  ): void {
    this.customDispatchHandler = handler;
  }

  async createRecords(records: CreateRecordInputPayload[]): Promise<WalletCreateRecordsResponse> {
    this.calls.push(records.map(record => ({ ...record })));
    if (this.customDispatchHandler) {
      return this.customDispatchHandler(records);
    }
    if (this.shouldFailWithUnknown) {
      throw new WalletMcpRequestError('Wallet API Gateway timeout', 'UNKNOWN');
    }
    return {
      summary: { total: records.length, succeeded: records.length, failed: 0 },
      results: records.map((_r, index) => ({ id: `rec-${index}`, success: true })),
    };
  }
}

class MockMessagingGateway {
  public readonly messages: Array<{ channel: string; chatId: string; content: string }> = [];

  async sendMessage(channel: string, chatId: string, content: string): Promise<void> {
    this.messages.push({ channel, chatId, content });
  }

  async sendTypingPresence(_channel: string, _chatId: string): Promise<void> {}
  async clearTypingPresence(_channel: string, _chatId: string): Promise<void> {}

  get lastMessage(): string | undefined {
    return this.messages[this.messages.length - 1]?.content;
  }

  clear(): void {
    this.messages.length = 0;
  }
}

function createMockEvent(messageContent: string): IncomingUserMessageEvent {
  return {
    channel: 'whatsapp',
    chatIdentifier: '+6281234567890',
    senderIdentifier: 'user_123',
    messageType: 'text',
    textPayload: messageContent,
  };
}

describe('Issue #154: Action-Oriented Pending & Uncertain Transaction UX', () => {
  beforeEach(() => {
    setActiveLanguage('id');
  });

  describe('1. Pending Email Notification UX', () => {
    const singlePendingItem: PendingTransactionItem = {
      ticketId: 101,
      sourceType: 'EMAIL_AUTO_DETECTED',
      bankDisplayName: 'BCA',
      counterParty: 'Starbucks Coffee',
      amount: 58000,
      transactionType: 'EXPENSE',
      matchedAccountId: 'acc-1',
      accountNameHint: 'BCA Prioritas',
      matchedCategoryId: 'cat-food',
      note: 'Coffee Break',
      recordDate: '2026-09-13T08:00:00.000Z',
      currency: 'IDR',
      createdAt: new Date('2026-09-13T08:00:00.000Z'),
    };

    it('formats single pending notification with transaction details as primary headline and ticket ID as secondary', () => {
      setActiveLanguage('id');
      const formatted = formatPendingEmailTransactionNotification(singlePendingItem, 1);

      // Primary emphasis: merchant, amount, account
      expect(formatted).toContain('Pembayaran Baru');
      expect(formatted).toContain('Rp 58.000');
      expect(formatted).toContain('Starbucks Coffee');
      expect(formatted).toContain('BCA Prioritas');

      // For single unambiguous item, ticket ID is not required in the headline
      expect(formatted).not.toContain('(#101)');

      // Clear action choices without jargon
      expect(formatted).toContain('Balas *Ya* atau *Catat*');
      expect(formatted).toContain('Balas *Batal*');

      // Does not expose queue implementation jargon
      expect(formatted).not.toContain('antrean pending');
    });

    it('formats multi-item pending notification with secondary ticket ID and count of others', () => {
      setActiveLanguage('id');
      const formatted = formatPendingEmailTransactionNotification(singlePendingItem, 3);

      expect(formatted).toContain('Pembayaran Baru');
      expect(formatted).toContain('Starbucks Coffee');
      expect(formatted).toContain('2 transaksi lain');
      expect(formatted).toContain('(#101)');
      expect(formatted).toContain('Balas *Ya 101*');
      expect(formatted).toContain('Balas *Batal 101*');
      expect(formatted).toContain('*Ya semua*');
    });

    it('localizes pending notification to English cleanly', () => {
      setActiveLanguage('en');
      const formatted = formatPendingEmailTransactionNotification(singlePendingItem, 1);

      expect(formatted).toContain('New Payment');
      expect(formatted).toContain('Starbucks Coffee');
      expect(formatted).toContain('BCA Prioritas');
      expect(formatted).not.toContain('(#101)');
      expect(formatted).toContain('Reply *Yes* or *Record*');
      expect(formatted).toContain('Reply *Cancel*');
    });
  });

  describe('2. Uncertain Write Outcome Formatting', () => {
    const mockViewModel = {
      ticketId: 202,
      status: 'NEEDS_CHECK' as const,
      amount: 76500,
      currency: 'IDR',
      formattedAmount: 'Rp 76.500',
      description: 'Ambarahere Resto',
      accountName: 'Jago Utama',
      isTransfer: false,
      createdAt: new Date(),
      primaryAction: 'Sudah ada #202',
      secondaryAction: 'Belum ada #202',
      sourceKind: 'STANDARD' as const,
    };

    it('answers the 3 key questions, warns against duplicate retries, and gives clear action commands', () => {
      setActiveLanguage('id');
      const formatted = formatUncertainOutcomeResponse(mockViewModel);

      // Question 1 & 2: What happened & did it go through?
      expect(formatted).toContain('Belum bisa memastikan transaksi sudah tercatat');
      expect(formatted).toContain('Jangan kirim ulang transaksi ini dulu agar tidak tercatat dua kali');
      expect(formatted).toContain('tidak akan dikirim ulang otomatis');

      // Transaction details headline
      expect(formatted).toContain('Rp 76.500');
      expect(formatted).toContain('Ambarahere Resto');
      expect(formatted).toContain('Jago Utama');
      expect(formatted).toContain('(#202)');

      // Question 3: What should user do?
      expect(formatted).toContain('Cek Wallet, lalu balas:');
      expect(formatted).toContain('*Sudah ada*');
      expect(formatted).toContain('*Belum ada*');

      // Multi-item variant includes ticket IDs in action commands
      const formattedMultiple = formatUncertainOutcomeResponse([
        mockViewModel,
        { ...mockViewModel, ticketId: 203, description: 'Grab Food' },
      ]);
      expect(formattedMultiple).toContain('*Sudah ada #202* atau *Belum ada #202*');
      expect(formattedMultiple).toContain('*Sudah ada #203* atau *Belum ada #203*');

      // No internal state machine / enum leaks
      expect(formatted).not.toContain('UNKNOWN');
      expect(formatted).not.toContain('tutup status lokal');
      expect(formatted).not.toContain('rekonsiliasi draft');
    });

    it('localizes uncertain outcome response to English', () => {
      setActiveLanguage('en');
      const formatted = formatUncertainOutcomeResponse(
        { ...mockViewModel, formattedAmount: 'Rp 76,500' },
        'en'
      );

      expect(formatted).toContain('Cannot confirm whether transaction was recorded');
      expect(formatted).toContain('Do not retry this transaction yet to avoid duplicate records');
      expect(formatted).toContain('will not be retried automatically');
      expect(formatted).toContain('Check Wallet, then reply:');
      expect(formatted).toContain('*Already exists*');
      expect(formatted).toContain('*Not there*');

      expect(formatted).not.toContain('UNKNOWN');
    });
  });

  describe('3. Reconciliation Actions via PendingActionHandler', () => {
    let pendingService: PendingTransactionService;
    let walletMcpClient: MockWalletMcpClient;
    let gateway: MockMessagingGateway;
    let handler: PendingActionHandler;
    let mockEmailRecorded: string | undefined;

    const testAccounts: WalletAccountItem[] = [
      { id: 'acc-1', name: 'BCA Prioritas', currency: 'IDR' },
      { id: 'acc-2', name: 'Jago Utama', currency: 'IDR' },
    ];

    beforeEach(() => {
      setActiveLanguage('id');
      pendingService = new PendingTransactionService();
      walletMcpClient = new MockWalletMcpClient();
      gateway = new MockMessagingGateway();
      mockEmailRecorded = undefined;
      handler = new PendingActionHandler(
        pendingService,
        walletMcpClient as any,
        gateway as any,
        () => ({
          recordProcessedTransaction: (_id?: string, ref?: string) => {
            mockEmailRecorded = ref;
          },
        } as any)
      );
    });

    it('handles "Sudah ada #N": resolves uncertain state without any network call or write', async () => {
      const item = pendingService.addPendingTransaction({
        sourceType: 'WHATSAPP',
        bankDisplayName: 'BCA',
        counterParty: 'Toko Buku Gramedia',
        amount: 150000,
        transactionType: 'EXPENSE',
        matchedAccountId: 'acc-1',
        note: 'Buku Novel',
        recordDate: '2026-09-13',
        referenceNumber: 'REF-BCA-99',
      });
      const ticketId = item.ticketId;

      walletMcpClient.setUnknownFailure(true);
      await handler.handlePendingAction(
        createMockEvent(`ya ${ticketId}`),
        { actionType: 'CONFIRM', targetScope: ticketId },
        Date.now()
      );

      expect(pendingService.hasUncertainTransactions()).toBe(true);
      expect(pendingService.getPendingTransactionState(ticketId)).toBe('UNKNOWN');

      walletMcpClient.calls.length = 0;
      gateway.clear();

      const handled = await handler.handleReconciliationAction(
        createMockEvent(`sudah ada #${ticketId}`),
        { actionType: 'CONFIRM_RECORDED', targetTicketId: ticketId },
        Date.now()
      );

      expect(handled).toBe(true);
      expect(walletMcpClient.calls.length).toBe(0);
      expect(pendingService.hasUncertainTransactions()).toBe(false);
      expect(pendingService.getPendingTransaction(ticketId)).toBeUndefined();
      expect(mockEmailRecorded).toBe('REF-BCA-99');

      expect(gateway.lastMessage).toContain('dianggap sudah tercatat');
      expect(gateway.lastMessage).toContain('Tidak ada transaksi yang akan dikirim ulang');
    });

    it('handles "Belum ada #N": reopens ticket to PENDING without auto-retrying', async () => {
      const item = pendingService.addPendingTransaction({
        sourceType: 'WHATSAPP',
        counterParty: 'Warung Nasi',
        amount: 35000,
        transactionType: 'EXPENSE',
        matchedAccountId: 'acc-2',
        note: 'Makan Siang',
        recordDate: '2026-09-13',
      });
      const ticketId = item.ticketId;

      walletMcpClient.setUnknownFailure(true);
      await handler.handlePendingAction(
        createMockEvent(`ya ${ticketId}`),
        { actionType: 'CONFIRM', targetScope: ticketId },
        Date.now()
      );

      expect(pendingService.hasUncertainTransactions()).toBe(true);

      walletMcpClient.calls.length = 0;
      gateway.clear();

      const handled = await handler.handleReconciliationAction(
        createMockEvent(`belum ada #${ticketId}`),
        { actionType: 'CONFIRM_ABSENT', targetTicketId: ticketId },
        Date.now()
      );

      expect(handled).toBe(true);
      expect(walletMcpClient.calls.length).toBe(0);
      expect(pendingService.hasUncertainTransactions()).toBe(false);
      expect(pendingService.hasPendingTransactions()).toBe(true);

      const pendingItems = pendingService.getAllPendingTransactions();
      expect(pendingItems.length).toBe(1);
      expect(pendingItems[0].ticketId).toBe(ticketId);

      expect(gateway.lastMessage).toContain('Status dikembalikan agar aman dicoba lagi');
      expect(gateway.lastMessage).toContain(`*Ya #${ticketId}*`);
      expect(gateway.lastMessage).toContain(`*Batal #${ticketId}*`);
    });

    it('handles unnumbered "Sudah ada" when exactly one uncertain item exists', async () => {
      const item = pendingService.addPendingTransaction({
        sourceType: 'WHATSAPP',
        counterParty: 'Kopi Kenangan',
        amount: 22000,
        transactionType: 'EXPENSE',
        matchedAccountId: 'acc-1',
        recordDate: '2026-09-13',
      });

      walletMcpClient.setUnknownFailure(true);
      await handler.handlePendingAction(
        createMockEvent(`ya ${item.ticketId}`),
        { actionType: 'CONFIRM', targetScope: item.ticketId },
        Date.now()
      );

      gateway.clear();
      const handled = await handler.handleReconciliationAction(
        createMockEvent('sudah ada'),
        { actionType: 'CONFIRM_RECORDED' },
        Date.now()
      );

      expect(handled).toBe(true);
      expect(pendingService.hasUncertainTransactions()).toBe(false);
      expect(gateway.lastMessage).toContain('dianggap sudah tercatat');
    });

    it('handles unnumbered "Belum ada" when exactly one uncertain item exists', async () => {
      const item = pendingService.addPendingTransaction({
        sourceType: 'WHATSAPP',
        counterParty: 'Bakmi GM',
        amount: 45000,
        transactionType: 'EXPENSE',
        matchedAccountId: 'acc-1',
        recordDate: '2026-09-13',
      });

      walletMcpClient.setUnknownFailure(true);
      await handler.handlePendingAction(
        createMockEvent(`ya ${item.ticketId}`),
        { actionType: 'CONFIRM', targetScope: item.ticketId },
        Date.now()
      );

      gateway.clear();
      const handled = await handler.handleReconciliationAction(
        createMockEvent('belum ada'),
        { actionType: 'CONFIRM_ABSENT' },
        Date.now()
      );

      expect(handled).toBe(true);
      expect(pendingService.hasUncertainTransactions()).toBe(false);
      expect(pendingService.hasPendingTransactions()).toBe(true);
      expect(gateway.lastMessage).toContain('Status dikembalikan agar aman dicoba lagi');
    });

    it('asks for disambiguation when unnumbered command is sent with multiple uncertain items', async () => {
      const item1 = pendingService.addPendingTransaction({
        sourceType: 'WHATSAPP',
        counterParty: 'Item 1',
        amount: 10000,
        transactionType: 'EXPENSE',
        matchedAccountId: 'acc-1',
        recordDate: '2026-09-13',
      });
      const item2 = pendingService.addPendingTransaction({
        sourceType: 'WHATSAPP',
        counterParty: 'Item 2',
        amount: 20000,
        transactionType: 'EXPENSE',
        matchedAccountId: 'acc-2',
        recordDate: '2026-09-13',
      });

      walletMcpClient.setUnknownFailure(true);
      await handler.handlePendingAction(
        createMockEvent(`ya ${item1.ticketId}`),
        { actionType: 'CONFIRM', targetScope: item1.ticketId },
        Date.now()
      );
      await handler.handlePendingAction(
        createMockEvent(`ya ${item2.ticketId}`),
        { actionType: 'CONFIRM', targetScope: item2.ticketId },
        Date.now()
      );

      expect(pendingService.getUncertainTransactions().length).toBe(2);

      gateway.clear();
      const handled = await handler.handleReconciliationAction(
        createMockEvent('sudah ada'),
        { actionType: 'CONFIRM_RECORDED' },
        Date.now()
      );

      expect(handled).toBe(true);
      expect(pendingService.getUncertainTransactions().length).toBe(2);
      expect(gateway.lastMessage).toContain('Ada beberapa transaksi yang perlu diperiksa');
      expect(gateway.lastMessage).toContain(`Sudah ada #${item1.ticketId}`);
      expect(gateway.lastMessage).toContain(`Belum ada #${item1.ticketId}`);
    });

    it('is idempotent: returns clear message when ticket is already resolved or not found', async () => {
      gateway.clear();
      const handled = await handler.handleReconciliationAction(
        createMockEvent('sudah ada #999'),
        { actionType: 'CONFIRM_RECORDED', targetTicketId: 999 },
        Date.now()
      );

      expect(handled).toBe(true);
      expect(gateway.lastMessage).toContain('tidak ditemukan atau sudah selesai diperiksa');
    });

    it('handles unnumbered reconciliation when totalUncertainCount is zero', async () => {
      gateway.clear();
      const handled = await handler.handleReconciliationAction(
        createMockEvent('sudah ada'),
        { actionType: 'CONFIRM_RECORDED' },
        Date.now()
      );

      expect(handled).toBe(true);
      expect(gateway.lastMessage).toContain('Tidak ada transaksi yang perlu diperiksa saat ini');
    });

    it('reconciles uncertain account clarification drafts (both numbered and unnumbered)', async () => {
      const draft = pendingService.addPendingAccountSelectionDraft({
        channel: 'whatsapp',
        chatIdentifier: '+6281234567890',
        senderIdentifier: 'user_123',
        records: [{
          accountId: '',
          amount: -55000,
          currency: 'IDR',
          recordDate: '2026-09-13',
          note: 'Grab Ride',
        }],
        pendingRecordIndex: 0,
        candidateAccounts: testAccounts,
      });

      pendingService.markPendingAccountSelectionDraftUnknown(draft.ticketId);
      expect(pendingService.getUncertainAccountSelectionDrafts().length).toBe(1);

      // 1. Reopen draft as PENDING via "Belum ada #ticketId"
      await handler.handleReconciliationAction(
        createMockEvent(`belum ada #${draft.ticketId}`),
        { actionType: 'CONFIRM_ABSENT', targetTicketId: draft.ticketId },
        Date.now()
      );
      expect(pendingService.getPendingAccountSelectionDraftState(draft.ticketId)).toBe('PENDING');

      // 2. Mark UNKNOWN again and reconcile with "Sudah ada #ticketId"
      pendingService.markPendingAccountSelectionDraftUnknown(draft.ticketId);
      await handler.handleReconciliationAction(
        createMockEvent(`sudah ada #${draft.ticketId}`),
        { actionType: 'CONFIRM_RECORDED', targetTicketId: draft.ticketId },
        Date.now()
      );
      expect(pendingService.getPendingAccountSelectionDraft(draft.ticketId)).toBeUndefined();

      // 3. Test unnumbered draft reconciliation
      const draft2 = pendingService.addPendingAccountSelectionDraft({
        channel: 'whatsapp',
        chatIdentifier: '+6281234567890',
        senderIdentifier: 'user_123',
        records: [{
          accountId: '',
          amount: -25000,
          currency: 'IDR',
          recordDate: '2026-09-13',
          note: 'Snack',
        }],
        pendingRecordIndex: 0,
        candidateAccounts: testAccounts,
      });
      pendingService.markPendingAccountSelectionDraftUnknown(draft2.ticketId);

      await handler.handleReconciliationAction(
        createMockEvent('belum ada'),
        { actionType: 'CONFIRM_ABSENT' },
        Date.now()
      );
      expect(pendingService.getPendingAccountSelectionDraftState(draft2.ticketId)).toBe('PENDING');

      pendingService.markPendingAccountSelectionDraftUnknown(draft2.ticketId);
      await handler.handleReconciliationAction(
        createMockEvent('sudah ada'),
        { actionType: 'CONFIRM_RECORDED' },
        Date.now()
      );
      expect(pendingService.getPendingAccountSelectionDraft(draft2.ticketId)).toBeUndefined();
    });
  });

  describe('4. Queue / Status Commands & View Model', () => {
    let pendingService: PendingTransactionService;

    beforeEach(() => {
      setActiveLanguage('id');
      pendingService = new PendingTransactionService();
    });

    it('builds summary and formats output when ONLY uncertain (NEEDS_CHECK) items exist', () => {
      const item = pendingService.addPendingTransaction({
        sourceType: 'WHATSAPP',
        counterParty: 'Ambarahere',
        amount: 7650,
        transactionType: 'EXPENSE',
        matchedAccountId: 'acc-1',
        accountNameHint: 'Jago Utama',
        currency: 'IDR',
        recordDate: '2026-09-13',
      });
      pendingService.markPendingTransactionUnknown(item.ticketId);

      const summary = buildTransactionAttentionSummary(pendingService);

      expect(summary.totalNeedingAttention).toBe(1);
      expect(summary.needsCheckItems.length).toBe(1);
      expect(summary.waitingConfirmationItems.length).toBe(0);
      expect(summary.waitingAccountItems.length).toBe(0);

      const formatted = formatTransactionAttentionSummary(summary);

      expect(formatted).not.toContain('Tidak ada transaksi yang memerlukan perhatian');
      expect(formatted).toContain('Status Transaksi');
      expect(formatted).toContain('1 transaksi perlu diperiksa');
      expect(formatted).toContain('Ambarahere');
      expect(formatted).toContain('Rp 7.650');
      expect(formatted).toContain('Sudah ada');
      expect(formatted).toContain('Belum ada');
    });

    it('builds summary and formats output when mixed UNKNOWN and PENDING items exist', () => {
      const item1 = pendingService.addPendingTransaction({
        sourceType: 'WHATSAPP',
        counterParty: 'Superindo',
        amount: 85000,
        transactionType: 'EXPENSE',
        matchedAccountId: 'acc-1',
        accountNameHint: 'BCA Prioritas',
        currency: 'IDR',
        recordDate: '2026-09-13',
      });
      pendingService.markPendingTransactionUnknown(item1.ticketId);

      pendingService.addPendingTransaction({
        sourceType: 'EMAIL_AUTO_DETECTED',
        counterParty: 'PLN Token Listrik',
        amount: 200000,
        transactionType: 'EXPENSE',
        matchedAccountId: 'acc-1',
        accountNameHint: 'BCA Prioritas',
        currency: 'IDR',
        recordDate: '2026-09-13',
      });

      const summary = buildTransactionAttentionSummary(pendingService);

      expect(summary.totalNeedingAttention).toBe(2);
      expect(summary.needsCheckItems.length).toBe(1);
      expect(summary.waitingConfirmationItems.length).toBe(1);

      const formatted = formatTransactionAttentionSummary(summary);

      expect(formatted).toContain('1 transaksi perlu diperiksa');
      expect(formatted).toContain('Superindo');
      expect(formatted).toContain('1 transaksi menunggu konfirmasi');
      expect(formatted).toContain('PLN Token Listrik');
    });

    it('formats summary with drafts and multiple waiting items in Indonesian and English', () => {
      // 1. Add transfer pending item
      pendingService.addPendingTransaction({
        sourceType: 'WHATSAPP',
        amount: 500000,
        transactionType: 'TRANSFER',
        matchedAccountId: 'acc-1',
        accountNameHint: 'BCA Prioritas',
        destinationAccountNameHint: 'Jago Utama',
        currency: 'IDR',
        recordDate: '2026-09-13',
      });

      // 2. Add second pending item
      pendingService.addPendingTransaction({
        sourceType: 'WHATSAPP',
        counterParty: 'Indomaret',
        amount: 32000,
        transactionType: 'EXPENSE',
        matchedAccountId: 'acc-1',
        currency: 'IDR',
        recordDate: '2026-09-13',
      });

      // 3. Add account clarification draft
      pendingService.addPendingAccountSelectionDraft({
        channel: 'whatsapp',
        chatIdentifier: '+6281234567890',
        senderIdentifier: 'user_123',
        records: [{
          accountId: '',
          amount: -12000,
          currency: 'IDR',
          recordDate: '2026-09-13',
          note: 'Parkir',
        }],
        pendingRecordIndex: 0,
        candidateAccounts: [{ id: 'acc-1', name: 'BCA' }],
      });

      const summaryId = buildTransactionAttentionSummary(pendingService, 'id');
      expect(summaryId.waitingConfirmationItems.length).toBe(2);
      expect(summaryId.waitingAccountItems.length).toBe(1);

      const formattedId = formatTransactionAttentionSummary(summaryId, 'id');
      expect(formattedId).toContain('menunggu konfirmasi');
      expect(formattedId).toContain('menunggu pilihan akun');
      expect(formattedId).toContain('Balas dengan nomor pilihan akun');

      const summaryEn = buildTransactionAttentionSummary(pendingService, 'en');
      const formattedEn = formatTransactionAttentionSummary(summaryEn, 'en');
      expect(formattedEn).toContain('waiting for confirmation');
      expect(formattedEn).toContain('waiting for account selection');
      expect(formattedEn).toContain('Reply with chosen account option');
    });

    it('shows clear empty message when there are zero attention items', () => {
      const summary = buildTransactionAttentionSummary(pendingService);
      expect(summary.totalNeedingAttention).toBe(0);

      const formatted = formatTransactionAttentionSummary(summary);
      expect(formatted).toContain('Tidak ada transaksi yang memerlukan perhatian saat ini');
    });

    it('localizes status summary to English cleanly', () => {
      setActiveLanguage('en');
      const item = pendingService.addPendingTransaction({
        sourceType: 'WHATSAPP',
        counterParty: 'Coffee Shop',
        amount: 35000,
        transactionType: 'EXPENSE',
        matchedAccountId: 'acc-1',
        currency: 'IDR',
        recordDate: '2026-09-13',
      });
      pendingService.markPendingTransactionUnknown(item.ticketId);

      const summary = buildTransactionAttentionSummary(pendingService, 'en');
      const formatted = formatTransactionAttentionSummary(summary, 'en');

      expect(formatted).toContain('Transaction Status');
      expect(formatted).toContain('1 transaction(s) need check');
      expect(formatted).toContain('Already exists');
      expect(formatted).toContain('Not there');
    });

    it('executes CheckQueueActionHandler seamlessly', async () => {
      const gateway = new MockMessagingGateway();
      const handler = new CheckQueueActionHandler(pendingService, gateway as any);
      await handler.execute({
        action: 'CHECK_QUEUE',
        event: createMockEvent('antrean'),
        routingSource: 'FAST_PATH',
        processingStartTimestamp: Date.now(),
      });

      expect(gateway.lastMessage).toContain('Tidak ada transaksi yang memerlukan perhatian saat ini');
    });

    it('executes FastPathHandler for CHECK_QUEUE', async () => {
      const gateway = new MockMessagingGateway();
      const registry = new FinancialActionRegistry();
      registry.register(new CheckQueueActionHandler(pendingService as any, gateway as any));
      const fastPathHandler = new FastPathHandler(registry);

      const handled = await fastPathHandler.handleFastPath(
        createMockEvent('antrean'),
        'CHECK_QUEUE',
        Date.now()
      );

      expect(handled).toBe(true);
      expect(gateway.lastMessage).toContain('Tidak ada transaksi yang memerlukan perhatian saat ini');
    });
  });

  describe('5. Intent Detection for Fast-Path and Reconciliation', () => {
    it('detects queue / status commands in Indonesian and English', () => {
      expect(detectFastPathAction('antrean')).toBe('CHECK_QUEUE');
      expect(detectFastPathAction('antrian')).toBe('CHECK_QUEUE');
      expect(detectFastPathAction('cek antrean')).toBe('CHECK_QUEUE');
      expect(detectFastPathAction('status antrean')).toBe('CHECK_QUEUE');
      expect(detectFastPathAction('status transaksi')).toBe('CHECK_QUEUE');
      expect(detectFastPathAction('queue')).toBe('CHECK_QUEUE');
      expect(detectFastPathAction('check queue')).toBe('CHECK_QUEUE');
      expect(detectFastPathAction('status')).toBe('CHECK_QUEUE');
    });

    it('detects "Sudah ada" reconciliation action variants', () => {
      expect(detectReconciliationAction('sudah ada')).toEqual({
        actionType: 'CONFIRM_RECORDED',
      });
      expect(detectReconciliationAction('sudah ada #101')).toEqual({
        actionType: 'CONFIRM_RECORDED',
        targetTicketId: 101,
      });
      expect(detectReconciliationAction('sudah ada 101')).toEqual({
        actionType: 'CONFIRM_RECORDED',
        targetTicketId: 101,
      });
      expect(detectReconciliationAction('already exists')).toEqual({
        actionType: 'CONFIRM_RECORDED',
      });
      expect(detectReconciliationAction('already exists #42')).toEqual({
        actionType: 'CONFIRM_RECORDED',
        targetTicketId: 42,
      });
      expect(detectReconciliationAction('confirm recorded 5')).toEqual({
        actionType: 'CONFIRM_RECORDED',
        targetTicketId: 5,
      });
    });

    it('detects "Belum ada" reconciliation action variants', () => {
      expect(detectReconciliationAction('belum ada')).toEqual({
        actionType: 'CONFIRM_ABSENT',
      });
      expect(detectReconciliationAction('belum ada #101')).toEqual({
        actionType: 'CONFIRM_ABSENT',
        targetTicketId: 101,
      });
      expect(detectReconciliationAction('belum ada 101')).toEqual({
        actionType: 'CONFIRM_ABSENT',
        targetTicketId: 101,
      });
      expect(detectReconciliationAction('not there')).toEqual({
        actionType: 'CONFIRM_ABSENT',
      });
      expect(detectReconciliationAction('not there #42')).toEqual({
        actionType: 'CONFIRM_ABSENT',
        targetTicketId: 42,
      });
      expect(detectReconciliationAction('confirm absent 5')).toEqual({
        actionType: 'CONFIRM_ABSENT',
        targetTicketId: 5,
      });
    });

    it('returns null for unrelated text', () => {
      expect(detectReconciliationAction('halo bot')).toBeNull();
      expect(detectReconciliationAction('cek saldo')).toBeNull();
      expect(detectReconciliationAction('ya')).toBeNull();
      expect(detectReconciliationAction('batal')).toBeNull();
    });
  });

  describe('6. Account Clarification Formatter Coverage', () => {
    const mockDraft: PendingAccountSelectionDraft = {
      ticketId: 77,
      channel: 'whatsapp',
      chatIdentifier: '+6281234567890',
      senderIdentifier: 'user_123',
      records: [{
        accountId: '',
        amount: -125000,
        currency: 'IDR',
        recordDate: '2026-09-13',
        note: 'Supermarket Run',
      }],
      pendingRecordIndex: 0,
      candidateAccounts: [
        { id: 'acc-1', name: 'BCA', currency: 'IDR' },
        { id: 'acc-2', name: 'Jago', currency: 'IDR' },
      ],
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 60000),
    };

    it('formats account selection prompts and error variations in Indonesian and English', () => {
      setActiveLanguage('id');
      const promptId = formatAccountSelectionPrompt(mockDraft, [], 'InvalidAccount');
      expect(promptId).toContain('Pilihan akun "InvalidAccount" belum valid');
      expect(promptId).toContain('Pilih Akun Transaksi (#77)');

      setActiveLanguage('en');
      const promptEn = formatAccountSelectionPrompt(mockDraft, [], 'InvalidAccount');
      expect(promptEn).toContain('Account choice "InvalidAccount" is invalid');
      expect(promptEn).toContain('Choose Transaction Account (#77)');
    });

    it('resolves category names and fallback currencies in prompt formatting', () => {
      const draftWithCategory: PendingAccountSelectionDraft = {
        ...mockDraft,
        records: [{
          accountId: '',
          amount: -50000,
          currency: 'IDR',
          recordDate: '2026-09-13',
          categoryId: 'cat-1',
        }],
        candidateAccounts: [
          { id: 'acc-1', name: 'BCA' },
          { id: 'acc-2', name: 'Jago' },
        ],
      };

      const categories = [
        { id: 'cat-1', name: 'Makanan & Minuman' },
        { id: 'cat-2', name: 'Transportasi' },
      ];

      // Exact ID match
      const prompt1 = formatAccountSelectionPrompt(draftWithCategory, categories as any);
      expect(prompt1).toContain('Makanan & Minuman');

      // Numeric index match (e.g. '2' -> categories[1])
      const draftWithNumericCat = {
        ...draftWithCategory,
        records: [{ ...draftWithCategory.records[0], categoryId: '2' }],
      };
      const prompt2 = formatAccountSelectionPrompt(draftWithNumericCat, categories as any);
      expect(prompt2).toContain('Transportasi');

      // Exact name match
      const draftWithNameCat = {
        ...draftWithCategory,
        records: [{ ...draftWithCategory.records[0], categoryId: 'Transportasi' }],
      };
      const prompt3 = formatAccountSelectionPrompt(draftWithNameCat, categories as any);
      expect(prompt3).toContain('Transportasi');

      // Candidate accounts with mixed or missing currencies
      const draftMixedCurrency = {
        ...draftWithCategory,
        records: [{ accountId: '', amount: -50000, recordDate: '2026-09-13' }],
        candidateAccounts: [
          { id: 'acc-1', name: 'BCA', currency: 'IDR' },
          { id: 'acc-2', name: 'USD Account', currency: 'USD' },
        ],
      };
      const prompt4 = formatAccountSelectionPrompt(draftMixedCurrency, categories as any);
      expect(prompt4).toBeDefined();

      // Zero candidate accounts
      const draftNoCandidates = {
        ...draftWithCategory,
        records: [{ accountId: '', amount: -50000, recordDate: '2026-09-13' }],
        candidateAccounts: [],
      };
      const prompt5 = formatAccountSelectionPrompt(draftNoCandidates, categories as any);
      expect(prompt5).toBeDefined();
    });

    it('formats cancellation, processing, retry, unknown, and dismissal messages in ID and EN', () => {
      setActiveLanguage('id');
      expect(formatAccountSelectionCancellation(mockDraft)).toContain('dibatalkan');
      expect(formatAccountSelectionProcessing(mockDraft)).toContain('sedang diproses');
      expect(formatAccountSelectionRetry(mockDraft)).toContain('belum berhasil dicatat');
      const unknownId = formatAccountSelectionUnknownOutcome(mockDraft);
      expect(unknownId).toContain('Belum bisa memastikan transaksi sudah tercatat');
      expect(unknownId).toContain('Sudah ada');
      expect(unknownId).toContain('Belum ada');
      expect(formatAccountSelectionUnknownDismissal(mockDraft)).toContain('ditutup');

      setActiveLanguage('en');
      expect(formatAccountSelectionCancellation(mockDraft)).toContain('cancelled');
      expect(formatAccountSelectionProcessing(mockDraft)).toContain('is being processed');
      expect(formatAccountSelectionRetry(mockDraft)).toContain('was not recorded');
      const unknownEn = formatAccountSelectionUnknownOutcome(mockDraft);
      expect(unknownEn).toContain('Cannot confirm whether transaction was recorded');
      expect(unknownEn).toContain('Already exists');
      expect(unknownEn).toContain('Not there');
      expect(formatAccountSelectionUnknownDismissal(mockDraft)).toContain('status closed');
    });
  });

  describe('7. View Model Builders & Formatters Edge Cases', () => {
    it('builds item view model from clarification draft with WAITING_FOR_ACCOUNT and NEEDS_CHECK', () => {
      const draft: PendingAccountSelectionDraft = {
        ticketId: 88,
        channel: 'whatsapp',
        chatIdentifier: '+6281234567890',
        senderIdentifier: 'user_123',
        records: [{
          accountId: '',
          amount: -45000,
          currency: 'IDR',
          recordDate: '2026-09-13',
          counterParty: 'Gojek',
        }],
        pendingRecordIndex: 0,
        candidateAccounts: [{ id: 'acc-1', name: 'BCA' }],
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 60000),
      };

      const vmAccount = buildItemViewModelFromClarificationDraft(draft, 'WAITING_FOR_ACCOUNT', 'id');
      expect(vmAccount.primaryAction).toBe('SELECT_ACCOUNT');
      expect(vmAccount.secondaryAction).toBe('CANCEL');

      const vmCheck = buildItemViewModelFromClarificationDraft(draft, 'NEEDS_CHECK', 'id');
      expect(vmCheck.primaryAction).toBe('MARK_PRESENT');
      expect(vmCheck.secondaryAction).toBe('MARK_ABSENT');
    });

    it('formats responses when multiple tickets exist or records lack description/account name', () => {
      const ambiguousId = formatReconciliationAmbiguousResponse([
        {
          ticketId: 1,
          status: 'NEEDS_CHECK',
          amount: 10000,
          formattedAmount: 'Rp 10.000',
          description: 'Item 1',
          accountName: 'BCA',
          isTransfer: false,
          createdAt: new Date(),
          primaryAction: 'Sudah ada #1',
          secondaryAction: 'Belum ada #1',
          sourceKind: 'STANDARD',
        },
        {
          ticketId: 2,
          status: 'NEEDS_CHECK',
          amount: 20000,
          formattedAmount: 'Rp 20.000',
          description: 'Item 2',
          accountName: 'Jago',
          isTransfer: false,
          createdAt: new Date(),
          primaryAction: 'Sudah ada #2',
          secondaryAction: 'Belum ada #2',
          sourceKind: 'STANDARD',
        },
      ], 'id');
      expect(ambiguousId).toContain('#1, #2');

      const ambiguousEn = formatReconciliationAmbiguousResponse([], 'en');
      expect(ambiguousEn).toContain('Multiple transactions require checking');

      expect(formatReconciliationRecordedResponse(undefined, 'en')).toContain('already recorded in Wallet');
      expect(formatReconciliationRecordedResponse(42, 'en')).toContain('Transaction #42 is confirmed as already recorded in Wallet');
      expect(formatReconciliationAbsentResponse(undefined, 'en')).toContain('not recorded in Wallet');
      expect(formatReconciliationAbsentResponse(42, 'en')).toContain('Transaction #42 is not recorded in Wallet');
      expect(formatReconciliationNotFoundResponse(undefined, 'en')).toContain('no transactions requiring verification');
      expect(formatReconciliationNotFoundResponse(42, 'en')).toContain('Transaction #42 was not found');
    });
  });

  describe('8. Dictionary Direct Coverage for Locales', () => {
    it('covers all custom functions in id and en dictionary', () => {
      const idDict = indonesianDictionary;
      const enDict = englishDictionary;

      // Status headers
      expect(idDict.status.waitingAccountHeader(3)).toContain('3');
      expect(enDict.status.waitingAccountHeader(3)).toContain('3');
      expect(idDict.status.waitingConfirmationHeader(2)).toContain('2');
      expect(enDict.status.waitingConfirmationHeader(2)).toContain('2');
      expect(idDict.status.needsCheckHeader(1)).toContain('1');
      expect(enDict.status.needsCheckHeader(1)).toContain('1');

      // Uncertain prompt multiple
      expect(idDict.uncertain.actionPromptMultiple([1, 2])).toContain('#1');
      expect(enDict.uncertain.actionPromptMultiple([1, 2])).toContain('#1');

      // Reconciliation
      expect(idDict.reconciliation.recordedWithTicket(5)).toContain('#5');
      expect(enDict.reconciliation.recordedWithTicket(5)).toContain('#5');
      expect(idDict.reconciliation.recordedSingle).toBeDefined();
      expect(enDict.reconciliation.recordedSingle).toBeDefined();
      expect(idDict.reconciliation.absentWithTicket(5)).toContain('#5');
      expect(enDict.reconciliation.absentWithTicket(5)).toContain('#5');
      expect(idDict.reconciliation.absentSingle).toBeDefined();
      expect(enDict.reconciliation.absentSingle).toBeDefined();
      expect(idDict.reconciliation.notFoundWithTicket(5)).toContain('#5');
      expect(enDict.reconciliation.notFoundWithTicket(5)).toContain('#5');
      expect(idDict.reconciliation.notFoundNone).toBeDefined();
      expect(enDict.reconciliation.notFoundNone).toBeDefined();
      expect(idDict.reconciliation.ambiguous([1, 2])).toContain('#1');
      expect(enDict.reconciliation.ambiguous([1, 2])).toContain('#1');

      // Email notifications: transfer, income
      const transferNotifId = idDict.emailPending.formatNotification({
        ticketId: 10,
        typeIcon: '🔄',
        typeLabel: 'Transfer Keluar',
        formattedAmount: 'Rp 100.000',
        formattedTime: '13 Sep 2026',
        accountNameHint: 'BCA',
        destinationAccountNameHint: 'Jago',
        totalPendingCount: 1,
      });
      expect(transferNotifId).toContain('Transfer Baru');

      const transferNotifEn = enDict.emailPending.formatNotification({
        ticketId: 10,
        typeIcon: '🔄',
        typeLabel: 'Transfer Out',
        formattedAmount: '$100.00',
        formattedTime: 'Sep 13, 2026',
        accountNameHint: 'Chase',
        destinationAccountNameHint: 'Savings',
        totalPendingCount: 1,
      });
      expect(transferNotifEn).toContain('New Transfer');
    });

    it('covers non-transfer and multiple pending variations in id and en', () => {
      const idDict = indonesianDictionary;
      const enDict = englishDictionary;

      // Non-transfer single
      const nonTransferSingleId = idDict.emailPending.formatNotification({
        ticketId: 1,
        typeIcon: '📩',
        typeLabel: 'Pembayaran',
        formattedAmount: 'Rp 50.000',
        formattedTime: '13 Sep 2026',
        counterParty: 'Indomaret',
        matchedCategoryName: 'Belanja',
        accountNameHint: 'BCA',
        totalPendingCount: 1,
      });
      expect(nonTransferSingleId).toContain('Pembayaran Baru');
      expect(nonTransferSingleId).toContain('Akun: BCA');
      expect(nonTransferSingleId).toContain('Kategori: Belanja');
      expect(nonTransferSingleId).toContain('Balas *Ya* atau *Catat*');

      const nonTransferSingleEn = enDict.emailPending.formatNotification({
        ticketId: 1,
        typeIcon: '📩',
        typeLabel: 'Payment',
        formattedAmount: '$50.00',
        formattedTime: 'Sep 13, 2026',
        counterParty: 'Walmart',
        matchedCategoryName: 'Shopping',
        accountNameHint: 'Checking',
        totalPendingCount: 1,
      });
      expect(nonTransferSingleEn).toContain('New Payment');
      expect(nonTransferSingleEn).toContain('Account: Checking');
      expect(nonTransferSingleEn).toContain('Category: Shopping');
      expect(nonTransferSingleEn).toContain('Reply *Yes* or *Record*');

      // Non-transfer multiple
      const nonTransferMultiId = idDict.emailPending.formatNotification({
        ticketId: 2,
        typeIcon: '📩',
        typeLabel: 'Pembayaran',
        formattedAmount: 'Rp 75.000',
        formattedTime: '13 Sep 2026',
        bankDisplayName: 'BCA Prioritas',
        totalPendingCount: 3,
      });
      expect(nonTransferMultiId).toContain('(#2)');
      expect(nonTransferMultiId).toContain('Ada 2 transaksi lain yang juga menunggu konfirmasi');

      const nonTransferMultiEn = enDict.emailPending.formatNotification({
        ticketId: 2,
        typeIcon: '📩',
        typeLabel: 'Payment',
        formattedAmount: '$75.00',
        formattedTime: 'Sep 13, 2026',
        bankDisplayName: 'Chase Bank',
        totalPendingCount: 3,
      });
      expect(nonTransferMultiEn).toContain('(#2)');
      expect(nonTransferMultiEn).toContain('There is 2 other transaction waiting for confirmation');

      // Transfer multiple
      const transferMultiId = idDict.emailPending.formatNotification({
        ticketId: 3,
        typeIcon: '🔄',
        typeLabel: 'Transfer',
        formattedAmount: 'Rp 100.000',
        formattedTime: '13 Sep 2026',
        totalPendingCount: 2,
      });
      expect(transferMultiId).toContain('(#3)');
      expect(transferMultiId).toContain('Akun ➔ Tujuan');

      const transferMultiEn = enDict.emailPending.formatNotification({
        ticketId: 3,
        typeIcon: '🔄',
        typeLabel: 'Transfer',
        formattedAmount: '$100.00',
        formattedTime: 'Sep 13, 2026',
        totalPendingCount: 2,
      });
      expect(transferMultiEn).toContain('(#3)');
      expect(transferMultiEn).toContain('Account ➔ Destination');
    });

    it('covers singleSuccess in id and en dictionary for transfer and expense', () => {
      const idDict = indonesianDictionary;
      const enDict = englishDictionary;

      const transferId = idDict.confirmation.singleSuccess({
        ticketId: 10,
        isTransfer: true,
        formattedAmount: 'Rp 250.000',
        accountNameHint: 'BCA',
        destinationAccountNameHint: 'Jago',
        formattedTime: '13 Sep 2026',
      });
      expect(transferId).toContain('Transfer Dicatat ke Wallet');
      expect(transferId).toContain('BCA ➔ Jago');

      const transferEn = enDict.confirmation.singleSuccess({
        ticketId: 10,
        isTransfer: true,
        formattedAmount: '$250.00',
        accountNameHint: 'Checking',
        destinationAccountNameHint: 'Savings',
        formattedTime: 'Sep 13, 2026',
      });
      expect(transferEn).toContain('Transfer Recorded to Wallet');
      expect(transferEn).toContain('Checking ➔ Savings');

      const expenseId = idDict.confirmation.singleSuccess({
        ticketId: 11,
        isTransfer: false,
        formattedAmount: 'Rp 50.000',
        accountNameHint: 'BCA',
        formattedTime: '13 Sep 2026',
        merchantOrNote: 'Gojek',
      });
      expect(expenseId).toContain('Transaksi Dicatat ke Wallet');
      expect(expenseId).toContain('Gojek');

      const expenseEn = enDict.confirmation.singleSuccess({
        ticketId: 11,
        isTransfer: false,
        formattedAmount: '$50.00',
        accountNameHint: 'Checking',
        formattedTime: 'Sep 13, 2026',
        merchantOrNote: 'Uber',
      });
      expect(expenseEn).toContain('Transaction Recorded to Wallet');
      expect(expenseEn).toContain('Uber');
    });
  });

  describe('9. Mixed Outcomes & Cancellation Scenarios in PendingActionHandler', () => {
    let pendingService: PendingTransactionService;
    let mockClient: MockWalletMcpClient;
    let mockGateway: MockMessagingGateway;
    let handler: PendingActionHandler;

    beforeEach(() => {
      setActiveLanguage('id');
      pendingService = new PendingTransactionService();
      mockClient = new MockWalletMcpClient();
      mockGateway = new MockMessagingGateway();
      handler = new PendingActionHandler(
        pendingService,
        mockClient as any,
        mockGateway as any,
        () => undefined
      );
    });

    it('handles single item and bulk confirmation when all items succeed', async () => {
      const item1 = pendingService.addPendingTransaction({
        sourceType: 'WHATSAPP',
        counterParty: 'Item 1 Only',
        amount: 10000,
        transactionType: 'EXPENSE',
        matchedAccountId: 'acc-1',
        currency: 'IDR',
        recordDate: '2026-09-13',
      });

      await handler.handlePendingAction(
        createMockEvent(`ya #${item1.ticketId}`),
        { actionType: 'CONFIRM', targetScope: item1.ticketId },
        Date.now()
      );

      expect(mockGateway.lastMessage).toContain('Transaksi Dicatat ke Wallet');

      // Bulk success
      const item2 = pendingService.addPendingTransaction({
        sourceType: 'WHATSAPP',
        counterParty: 'Item Bulk 1',
        amount: 15000,
        transactionType: 'EXPENSE',
        matchedAccountId: 'acc-1',
        currency: 'IDR',
        recordDate: '2026-09-13',
      });
      const item3 = pendingService.addPendingTransaction({
        sourceType: 'WHATSAPP',
        counterParty: 'Item Bulk 2',
        amount: 25000,
        transactionType: 'EXPENSE',
        matchedAccountId: 'acc-1',
        currency: 'IDR',
        recordDate: '2026-09-13',
      });

      await handler.handlePendingAction(
        createMockEvent('ya semua'),
        { actionType: 'CONFIRM', targetScope: 'ALL' },
        Date.now()
      );

      expect(mockGateway.lastMessage).toContain('2 Transaksi Berhasil Dicatat ke Wallet');
    });

    it('handles confirmation of TRANSFER transaction with one native paired record', async () => {
      const transferItem = pendingService.addPendingTransaction({
        sourceType: 'WHATSAPP',
        amount: 200000,
        transactionType: 'TRANSFER',
        matchedAccountId: 'acc-1',
        matchedDestinationAccountId: 'acc-2',
        accountNameHint: 'BCA Prioritas',
        destinationAccountNameHint: 'Jago Utama',
        currency: 'IDR',
        recordDate: '2026-09-13',
      });

      await handler.handlePendingAction(
        createMockEvent(`ya #${transferItem.ticketId}`),
        { actionType: 'CONFIRM', targetScope: transferItem.ticketId },
        Date.now()
      );

      expect(mockClient.calls.length).toBe(1);
      expect(mockClient.calls[0][0].transfer).toEqual({
        pairingMode: 'new',
        accountId: 'acc-2',
      });
      expect(mockGateway.lastMessage).toContain('Transfer Dicatat ke Wallet');
      expect(mockGateway.lastMessage).toContain('BCA Prioritas ➔ Jago Utama');
    });

    it('handles mixed outcomes in batch confirmation: 1 success, 1 unknown, 1 definitive failure', async () => {
      const item1 = pendingService.addPendingTransaction({
        sourceType: 'WHATSAPP',
        counterParty: 'Item 1 Success',
        amount: 10000,
        transactionType: 'EXPENSE',
        matchedAccountId: 'acc-1',
        currency: 'IDR',
        recordDate: '2026-09-13',
        note: 'item-1',
      });

      const item2 = pendingService.addPendingTransaction({
        sourceType: 'WHATSAPP',
        counterParty: 'Item 2 Unknown',
        amount: 20000,
        transactionType: 'EXPENSE',
        matchedAccountId: 'acc-1',
        currency: 'IDR',
        recordDate: '2026-09-13',
        note: 'item-2',
      });

      const item3 = pendingService.addPendingTransaction({
        sourceType: 'WHATSAPP',
        counterParty: 'Item 3 Failed',
        amount: 30000,
        transactionType: 'EXPENSE',
        matchedAccountId: 'acc-1',
        currency: 'IDR',
        recordDate: '2026-09-13',
        note: 'item-3',
      });

      mockClient.setCustomDispatchHandler(async records => {
        const note = records[0]?.note;
        if (note === 'item-1') {
          return {
            summary: { total: 1, succeeded: 1, failed: 0 },
            results: [{ id: 'rec-1', success: true }],
          };
        }
        if (note === 'item-2') {
          throw new WalletMcpRequestError('Network timeout', 'UNKNOWN');
        }
        if (note === 'item-3') {
          throw new WalletMcpRequestError('Definitive error', 'DEFINITIVE_FAILURE');
        }
        return {
          summary: { total: 1, succeeded: 1, failed: 0 },
          results: [{ id: 'rec-def', success: true }],
        };
      });

      await handler.handlePendingAction(
        createMockEvent('ya semua'),
        { actionType: 'CONFIRM', targetScope: 'ALL' },
        Date.now()
      );

      const message = mockGateway.lastMessage || '';
      expect(message).toContain('1/3 transaksi berhasil dicatat ke Wallet');
      expect(message).toContain(`Gagal mencatat tiket #${item3.ticketId}`);
      expect(message).toContain(`"ya #${item3.ticketId}"`);
      expect(message).toContain('Belum bisa memastikan transaksi sudah tercatat');
      expect(message).toContain(`Item 2 Unknown (#${item2.ticketId})`);
    });

    it('handles cancellation of ALL pending transactions', async () => {
      pendingService.addPendingTransaction({
        sourceType: 'WHATSAPP',
        counterParty: 'Item A',
        amount: 10000,
        transactionType: 'EXPENSE',
        matchedAccountId: 'acc-1',
        currency: 'IDR',
        recordDate: '2026-09-13',
      });
      pendingService.addPendingTransaction({
        sourceType: 'WHATSAPP',
        counterParty: 'Item B',
        amount: 20000,
        transactionType: 'EXPENSE',
        matchedAccountId: 'acc-1',
        currency: 'IDR',
        recordDate: '2026-09-13',
      });

      await handler.handlePendingAction(
        createMockEvent('batal semua'),
        { actionType: 'REJECT', targetScope: 'ALL' },
        Date.now()
      );

      expect(mockGateway.lastMessage).toContain('Dibatalkan');
      expect(pendingService.hasPendingTransactions()).toBe(false);
    });

    it('handles cancellation of a specific ticket', async () => {
      const item = pendingService.addPendingTransaction({
        sourceType: 'WHATSAPP',
        counterParty: 'Item Single',
        amount: 15000,
        transactionType: 'EXPENSE',
        matchedAccountId: 'acc-1',
        currency: 'IDR',
        recordDate: '2026-09-13',
      });

      await handler.handlePendingAction(
        createMockEvent(`batal #${item.ticketId}`),
        { actionType: 'REJECT', targetScope: item.ticketId },
        Date.now()
      );

      expect(mockGateway.lastMessage).toContain('Dibatalkan');
      expect(pendingService.hasPendingTransactions()).toBe(false);
    });

    it('handles cancellation of latest pending transaction when no target is specified', async () => {
      pendingService.addPendingTransaction({
        sourceType: 'WHATSAPP',
        counterParty: 'Item Latest',
        amount: 25000,
        transactionType: 'EXPENSE',
        matchedAccountId: 'acc-1',
        currency: 'IDR',
        recordDate: '2026-09-13',
      });

      await handler.handlePendingAction(
        createMockEvent('batal'),
        { actionType: 'REJECT' },
        Date.now()
      );

      expect(mockGateway.lastMessage).toContain('Dibatalkan');
      expect(pendingService.hasPendingTransactions()).toBe(false);
    });

    it('returns warning message when canceling non-existent ticket', async () => {
      await handler.handlePendingAction(
        createMockEvent('batal #999'),
        { actionType: 'REJECT', targetScope: 999 },
        Date.now()
      );

      expect(mockGateway.lastMessage).toContain('Tiket transaksi tidak ditemukan atau sedang diproses.');
    });
  });

  describe('10. UserMessageHandler Reconciliation Command Routing', () => {
    it('intercepts reconciliation commands and routes to PendingActionHandler', async () => {
      const mockPendingActionHandler = {
        handleReconciliationAction: vi.fn().mockResolvedValue(true),
      };
      const userMessageHandler = createTestUserMessageHandler({
        messagingGateway: new MockMessagingGateway() as any,
        pendingTransactionManager: new PendingTransactionService() as any,
        pendingActionHandler: mockPendingActionHandler as any,
        financialActionRegistry: { execute: vi.fn() } as any,
        accountClarificationHandler: { handlePendingAccountSelectionReply: vi.fn().mockResolvedValue(false) } as any,
      });

      const event = createMockEvent('sudah ada #123');
      await userMessageHandler.handleIncomingUserMessage(event);

      expect(mockPendingActionHandler.handleReconciliationAction).toHaveBeenCalledTimes(1);
      expect(mockPendingActionHandler.handleReconciliationAction).toHaveBeenCalledWith(
        event,
        { actionType: 'CONFIRM_RECORDED', targetTicketId: 123 },
        expect.any(Number)
      );
    });

    it('intercepts unnumbered "belum ada" and routes to PendingActionHandler', async () => {
      const mockPendingActionHandler = {
        handleReconciliationAction: vi.fn().mockResolvedValue(true),
      };
      const userMessageHandler = createTestUserMessageHandler({
        messagingGateway: new MockMessagingGateway() as any,
        pendingTransactionManager: new PendingTransactionService() as any,
        pendingActionHandler: mockPendingActionHandler as any,
        financialActionRegistry: { execute: vi.fn() } as any,
        accountClarificationHandler: { handlePendingAccountSelectionReply: vi.fn().mockResolvedValue(false) } as any,
      });

      const event = createMockEvent('belum ada');
      await userMessageHandler.handleIncomingUserMessage(event);

      expect(mockPendingActionHandler.handleReconciliationAction).toHaveBeenCalledWith(
        event,
        { actionType: 'CONFIRM_ABSENT' },
        expect.any(Number)
      );
    });
  });

  describe('11. PendingTransactionService Direct State & Uncertain Queries', () => {
    it('reopens unknown transaction as pending', () => {
      const service = new PendingTransactionService();
      const item = service.addPendingTransaction({
        sourceType: 'WHATSAPP',
        amount: 50000,
        transactionType: 'EXPENSE',
        matchedAccountId: 'acc-1',
        currency: 'IDR',
        recordDate: '2026-09-13',
      });

      // When state is PENDING, reopening should return false
      expect(service.reopenUnknownTransactionAsPending(item.ticketId)).toBe(false);

      // Mark as UNKNOWN
      service.markPendingTransactionUnknown(item.ticketId);
      expect(service.getPendingTransactionState(item.ticketId)).toBe('UNKNOWN');
      expect(service.hasUncertainTransactions()).toBe(true);
      expect(service.getUncertainTransactions().length).toBe(1);

      // Reopen as PENDING
      expect(service.reopenUnknownTransactionAsPending(item.ticketId)).toBe(true);
      expect(service.getPendingTransactionState(item.ticketId)).toBe('PENDING');
    });

    it('reopens unknown account selection draft as pending', () => {
      const service = new PendingTransactionService();
      const draft = service.addPendingAccountSelectionDraft({
        channel: 'whatsapp',
        chatIdentifier: '+6281234567890',
        senderIdentifier: 'user_123',
        records: [{
          accountId: '',
          amount: -15000,
          currency: 'IDR',
          recordDate: '2026-09-13',
        }],
        pendingRecordIndex: 0,
        candidateAccounts: [{ id: 'acc-1', name: 'BCA' }],
      });

      // When state is PENDING, reopening should return false
      expect(service.reopenUnknownTransactionAsPending(draft.ticketId)).toBe(false);

      // Mark as UNKNOWN
      service.markPendingAccountSelectionDraftUnknown(draft.ticketId);
      expect(service.getPendingAccountSelectionDraftState(draft.ticketId)).toBe('UNKNOWN');
      expect(service.hasUncertainTransactions()).toBe(true);
      expect(service.getUncertainAccountSelectionDrafts().length).toBe(1);

      // Reopen as PENDING
      expect(service.reopenUnknownTransactionAsPending(draft.ticketId)).toBe(true);
      expect(service.getPendingAccountSelectionDraftState(draft.ticketId)).toBe('PENDING');
    });

    it('returns false when reopening non-existent ticketId', () => {
      const service = new PendingTransactionService();
      expect(service.reopenUnknownTransactionAsPending(999)).toBe(false);
      expect(service.hasUncertainTransactions()).toBe(false);
      expect(service.getUncertainTransactions()).toEqual([]);
      expect(service.getUncertainAccountSelectionDrafts()).toEqual([]);
    });
  });

  describe('12. Comprehensive Intent Detection Regexes', () => {
    it('detects short and alternative forms of reconciliation action', () => {
      expect(detectReconciliationAction('sudah 5')).toEqual({
        actionType: 'CONFIRM_RECORDED',
        targetTicketId: 5,
      });
      expect(detectReconciliationAction('ada #5')).toEqual({
        actionType: 'CONFIRM_RECORDED',
        targetTicketId: 5,
      });
      expect(detectReconciliationAction('exists 5')).toEqual({
        actionType: 'CONFIRM_RECORDED',
        targetTicketId: 5,
      });
      expect(detectReconciliationAction('belum #7')).toEqual({
        actionType: 'CONFIRM_ABSENT',
        targetTicketId: 7,
      });
      expect(detectReconciliationAction('sudah masuk')).toEqual({
        actionType: 'CONFIRM_RECORDED',
      });
      expect(detectReconciliationAction('already recorded')).toEqual({
        actionType: 'CONFIRM_RECORDED',
      });
      expect(detectReconciliationAction('already there')).toEqual({
        actionType: 'CONFIRM_RECORDED',
      });
      expect(detectReconciliationAction('already in wallet')).toEqual({
        actionType: 'CONFIRM_RECORDED',
      });
      expect(detectReconciliationAction('sudah')).toEqual({
        actionType: 'CONFIRM_RECORDED',
      });
      expect(detectReconciliationAction('ada')).toEqual({
        actionType: 'CONFIRM_RECORDED',
      });

      expect(detectReconciliationAction('belum masuk')).toEqual({
        actionType: 'CONFIRM_ABSENT',
      });
      expect(detectReconciliationAction('tidak ada')).toEqual({
        actionType: 'CONFIRM_ABSENT',
      });
      expect(detectReconciliationAction('ga ada')).toEqual({
        actionType: 'CONFIRM_ABSENT',
      });
      expect(detectReconciliationAction('gak ada')).toEqual({
        actionType: 'CONFIRM_ABSENT',
      });
      expect(detectReconciliationAction('not yet')).toEqual({
        actionType: 'CONFIRM_ABSENT',
      });
      expect(detectReconciliationAction('not recorded')).toEqual({
        actionType: 'CONFIRM_ABSENT',
      });
      expect(detectReconciliationAction('not in wallet')).toEqual({
        actionType: 'CONFIRM_ABSENT',
      });
      expect(detectReconciliationAction('missing')).toEqual({
        actionType: 'CONFIRM_ABSENT',
      });
      expect(detectReconciliationAction('not found')).toEqual({
        actionType: 'CONFIRM_ABSENT',
      });
      expect(detectReconciliationAction('belum')).toEqual({
        actionType: 'CONFIRM_ABSENT',
      });

      expect(detectReconciliationAction(null as any)).toBeNull();
      expect(detectReconciliationAction(undefined as any)).toBeNull();
      expect(detectReconciliationAction('')).toBeNull();
    });

    it('detects queue patterns in fast-path intent detector', () => {
      expect(detectFastPathAction('lihat antrean')).toBe('CHECK_QUEUE');
      expect(detectFastPathAction('view queue')).toBe('CHECK_QUEUE');
      expect(detectFastPathAction('pending transaksi')).toBe('CHECK_QUEUE');
      expect(detectFastPathAction('cek status antrian')).toBe('CHECK_QUEUE');
      expect(detectFastPathAction('status antrian')).toBe('CHECK_QUEUE');
      expect(detectFastPathAction('lihat status transaksi')).toBe('CHECK_QUEUE');
    });
  });

  describe('13. Reconciliation Action Edge Cases in PendingActionHandler', () => {
    let pendingService: PendingTransactionService;
    let mockClient: MockWalletMcpClient;
    let mockGateway: MockMessagingGateway;
    let mockEmailListener: { recordProcessedTransaction: ReturnType<typeof vi.fn> };
    let handler: PendingActionHandler;

    beforeEach(() => {
      setActiveLanguage('id');
      pendingService = new PendingTransactionService();
      mockClient = new MockWalletMcpClient();
      mockGateway = new MockMessagingGateway();
      mockEmailListener = {
        recordProcessedTransaction: vi.fn(),
      };
      handler = new PendingActionHandler(
        pendingService,
        mockClient as any,
        mockGateway as any,
        () => mockEmailListener as any
      );
    });

    it('handles reconciliation of non-existent ticket number', async () => {
      await handler.handleReconciliationAction(
        createMockEvent('sudah ada #999'),
        { actionType: 'CONFIRM_RECORDED', targetTicketId: 999 },
        Date.now()
      );

      expect(mockGateway.lastMessage).toContain('Transaksi #999 tidak ditemukan atau sudah selesai diperiksa');
    });

    it('handles unnumbered reconciliation when zero transactions are uncertain', async () => {
      await handler.handleReconciliationAction(
        createMockEvent('sudah ada'),
        { actionType: 'CONFIRM_RECORDED' },
        Date.now()
      );

      expect(mockGateway.lastMessage).toContain('Tidak ada transaksi yang perlu diperiksa saat ini');
    });

    it('notifies active email listener when reconciling uncertain transaction as recorded', async () => {
      const item = pendingService.addPendingTransaction({
        sourceType: 'EMAIL_AUTO_DETECTED',
        amount: 80000,
        transactionType: 'EXPENSE',
        matchedAccountId: 'acc-1',
        currency: 'IDR',
        recordDate: '2026-09-13',
        referenceNumber: 'REF-12345',
      });
      pendingService.markPendingTransactionUnknown(item.ticketId);

      await handler.handleReconciliationAction(
        createMockEvent(`sudah ada #${item.ticketId}`),
        { actionType: 'CONFIRM_RECORDED', targetTicketId: item.ticketId },
        Date.now()
      );

      expect(mockEmailListener.recordProcessedTransaction).toHaveBeenCalledWith(
        undefined,
        'REF-12345'
      );
      expect(mockGateway.lastMessage).toContain(`transaksi #${item.ticketId} dianggap sudah tercatat`);
    });

    it('notifies active email listener on unnumbered single reconciliation', async () => {
      const item = pendingService.addPendingTransaction({
        sourceType: 'EMAIL_AUTO_DETECTED',
        amount: 40000,
        transactionType: 'EXPENSE',
        matchedAccountId: 'acc-1',
        currency: 'IDR',
        recordDate: '2026-09-13',
        referenceNumber: 'REF-SINGLE',
      });
      pendingService.markPendingTransactionUnknown(item.ticketId);

      await handler.handleReconciliationAction(
        createMockEvent('sudah ada'),
        { actionType: 'CONFIRM_RECORDED' },
        Date.now()
      );

      expect(mockEmailListener.recordProcessedTransaction).toHaveBeenCalledWith(
        undefined,
        'REF-SINGLE'
      );
      expect(mockGateway.lastMessage).toContain('transaksi dianggap sudah tercatat');
    });
  });
});
