import { describe, it, expect, beforeEach } from 'vitest';
import { setActiveLanguage } from '../src/i18n/index.js';
import {
  formatPendingEmailTransactionNotification,
} from '../src/utils/humanResponseFormatter.js';
import {
  formatUncertainOutcomeResponse,
  formatTransactionAttentionSummary,
} from '../src/utils/transactionStatusFormatter.js';
import {
  buildTransactionAttentionSummary,
} from '../src/services/transactionStatusViewModel.js';
import {
  PendingTransactionService,
  PendingTransactionItem,
} from '../src/services/pendingTransactionService.js';
import { PendingActionHandler } from '../src/handlers/pendingActionHandler.js';
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

class MockWalletMcpClient {
  public readonly calls: CreateRecordInputPayload[][] = [];
  private shouldFailWithUnknown = false;

  setUnknownFailure(fail: boolean): void {
    this.shouldFailWithUnknown = fail;
  }

  async createRecords(records: CreateRecordInputPayload[]): Promise<WalletCreateRecordsResponse> {
    this.calls.push(records.map(record => ({ ...record })));
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
    userId: 'user_123',
    messageContent,
    timestamp: new Date(),
    messageId: `msg-${Date.now()}-${Math.random()}`,
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

    const testAccounts: WalletAccountItem[] = [
      { id: 'acc-1', name: 'BCA Prioritas', currency: 'IDR' },
      { id: 'acc-2', name: 'Jago Utama', currency: 'IDR' },
    ];

    beforeEach(() => {
      setActiveLanguage('id');
      pendingService = new PendingTransactionService();
      walletMcpClient = new MockWalletMcpClient();
      gateway = new MockMessagingGateway();
      handler = new PendingActionHandler(
        pendingService,
        walletMcpClient as any,
        gateway as any,
        () => null
      );
    });

    it('handles "Sudah ada #N": resolves uncertain state without any network call or write', async () => {
      // 1. Add pending transaction
      const item = pendingService.addPendingTransaction({
        sourceType: 'WHATSAPP',
        bankDisplayName: 'BCA',
        counterParty: 'Toko Buku Gramedia',
        amount: 150000,
        transactionType: 'EXPENSE',
        matchedAccountId: 'acc-1',
        note: 'Buku Novel',
        recordDate: '2026-09-13',
      });
      const ticketId = item.ticketId;

      // 2. Dispatch write with UNKNOWN failure
      walletMcpClient.setUnknownFailure(true);
      await handler.handlePendingAction(
        createMockEvent(`ya ${ticketId}`),
        { actionType: 'CONFIRM', targetScope: ticketId },
        Date.now()
      );

      // Verify item transitioned to UNKNOWN
      expect(pendingService.hasUncertainTransactions()).toBe(true);
      expect(pendingService.getPendingTransactionState(ticketId)).toBe('UNKNOWN');

      // 3. User verifies in Wallet and replies "Sudah ada #ticketId"
      walletMcpClient.calls.length = 0; // reset call counter
      gateway.clear();

      const handled = await handler.handleReconciliationAction(
        createMockEvent(`sudah ada #${ticketId}`),
        { actionType: 'CONFIRM_RECORDED', targetTicketId: ticketId },
        Date.now()
      );

      expect(handled).toBe(true);
      // Verify no Wallet MCP call was made!
      expect(walletMcpClient.calls.length).toBe(0);

      // Verify state is completely resolved
      expect(pendingService.hasUncertainTransactions()).toBe(false);
      expect(pendingService.getPendingTransaction(ticketId)).toBeUndefined();

      // Verify user response confirms local resolution
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

      // Trigger UNKNOWN failure
      walletMcpClient.setUnknownFailure(true);
      await handler.handlePendingAction(
        createMockEvent(`ya ${ticketId}`),
        { actionType: 'CONFIRM', targetScope: ticketId },
        Date.now()
      );

      expect(pendingService.hasUncertainTransactions()).toBe(true);

      // User confirms transaction is absent: "Belum ada #ticketId"
      walletMcpClient.calls.length = 0;
      gateway.clear();

      const handled = await handler.handleReconciliationAction(
        createMockEvent(`belum ada #${ticketId}`),
        { actionType: 'CONFIRM_ABSENT', targetTicketId: ticketId },
        Date.now()
      );

      expect(handled).toBe(true);
      // Critical invariant: NEVER auto-retry immediately!
      expect(walletMcpClient.calls.length).toBe(0);

      // Ticket must now be in PENDING, not UNKNOWN
      expect(pendingService.hasUncertainTransactions()).toBe(false);
      expect(pendingService.hasPendingTransactions()).toBe(true);

      const pendingItems = pendingService.getAllPendingTransactions();
      expect(pendingItems.length).toBe(1);
      expect(pendingItems[0].ticketId).toBe(ticketId);

      // Message tells user it is ready to be recorded and gives next command
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
      // User simply types "sudah ada" without number
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
      // No item was removed
      expect(pendingService.getUncertainTransactions().length).toBe(2);
      // Response prompts for specific ticket
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
  });

  describe('4. Queue / Status Commands & View Model', () => {
    let pendingService: PendingTransactionService;

    beforeEach(() => {
      setActiveLanguage('id');
      pendingService = new PendingTransactionService();
    });

    it('builds summary and formats output when ONLY uncertain (NEEDS_CHECK) items exist', () => {
      // Add and transition one item to UNKNOWN
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

      // Must NOT show misleading "Tidak ada transaksi yang memerlukan perhatian"
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
});
