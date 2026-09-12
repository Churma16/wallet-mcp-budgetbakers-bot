import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  FinancialActionRegistry,
  UnknownFinancialActionError,
  CheckBalanceActionHandler,
  CheckBudgetActionHandler,
  HelpMenuActionHandler,
  TransactionHistoryActionHandler,
  TransactionSummaryActionHandler,
  CreateRecordActionHandler,
  createDefaultFinancialActionRegistry,
  FinancialActionHandler,
  CheckBalanceActionContext,
} from '../src/actions/index.js';
import { FinancialActionExecutor } from '../src/services/financialActionExecutor.js';
import { FastPathHandler } from '../src/handlers/fastPathHandler.js';
import { UserMessageHandler } from '../src/handlers/userMessageHandler.js';
import { IncomingUserMessageEvent } from '../src/services/messaging/index.js';
import { WalletAccountItem, WalletCategoryItem, WalletBudgetProgressItem } from '../src/types/walletTypes.js';
import { setActiveLanguage } from '../src/i18n/index.js';

function createMockIncomingEvent(textPayload: string): IncomingUserMessageEvent {
  return {
    channel: 'whatsapp',
    senderIdentifier: 'user-phone-12345',
    chatIdentifier: '12345@s.whatsapp.net',
    messageType: 'text',
    textPayload,
    rawMessageTimestamp: new Date('2026-09-13T00:00:00.000Z'),
  };
}

describe('FinancialActionRegistry & Action Handlers (Issue #116)', () => {
  beforeEach(() => {
    setActiveLanguage('id');
  });

  describe('Registration & Retrieval Lifecycle', () => {
    it('registers, retrieves, and checks existence of action handlers', () => {
      const registry = new FinancialActionRegistry();

      const mockBalanceHandler: FinancialActionHandler<'CHECK_BALANCE'> = {
        action: 'CHECK_BALANCE',
        execute: vi.fn(),
      };

      expect(registry.hasHandler('CHECK_BALANCE')).toBe(false);
      expect(registry.getHandler('CHECK_BALANCE')).toBeUndefined();
      expect(registry.getAllRegisteredActions()).toEqual([]);

      registry.register(mockBalanceHandler);

      expect(registry.hasHandler('CHECK_BALANCE')).toBe(true);
      expect(registry.getHandler('CHECK_BALANCE')).toBe(mockBalanceHandler);
      expect(registry.getAllRegisteredActions()).toEqual(['CHECK_BALANCE']);
    });

    it('warns when overwriting an existing action handler and keeps the latest registration', () => {
      const registry = new FinancialActionRegistry();

      const firstHandler: FinancialActionHandler<'CHECK_BALANCE'> = {
        action: 'CHECK_BALANCE',
        execute: vi.fn(),
      };
      const secondHandler: FinancialActionHandler<'CHECK_BALANCE'> = {
        action: 'CHECK_BALANCE',
        execute: vi.fn(),
      };

      registry.register(firstHandler);
      registry.register(secondHandler);

      expect(registry.getHandler('CHECK_BALANCE')).toBe(secondHandler);
      expect(registry.getAllRegisteredActions()).toEqual(['CHECK_BALANCE']);
    });
  });

  describe('Unknown / Unregistered Action Dispatching & Safe Failure', () => {
    it('throws UnknownFinancialActionError when execute is invoked for an unregistered action', async () => {
      const registry = new FinancialActionRegistry();
      const mockEvent = createMockIncomingEvent('cek saldo');

      await expect(
        registry.execute({
          action: 'UNKNOWN_ACTION' as any,
          event: mockEvent,
        })
      ).rejects.toThrow(UnknownFinancialActionError);

      await expect(
        registry.execute({
          action: 'UNKNOWN_ACTION' as any,
          event: mockEvent,
        })
      ).rejects.toThrow('No financial action handler registered for action: UNKNOWN_ACTION');
    });

    it('tryExecute returns false without throwing for an unregistered action', async () => {
      const registry = new FinancialActionRegistry();
      const mockEvent = createMockIncomingEvent('halo');

      const handled = await registry.tryExecute({
        action: 'UNKNOWN_ACTION' as any,
        event: mockEvent,
      });

      expect(handled).toBe(false);
    });

    it('tryExecute returns true and executes handler for a registered action', async () => {
      const registry = new FinancialActionRegistry();
      const mockExecute = vi.fn().mockResolvedValue(undefined);
      const mockHandler: FinancialActionHandler<'HELP_MENU'> = {
        action: 'HELP_MENU',
        execute: mockExecute,
      };
      registry.register(mockHandler);

      const mockEvent = createMockIncomingEvent('bantuan');
      const handled = await registry.tryExecute({
        action: 'HELP_MENU',
        event: mockEvent,
      });

      expect(handled).toBe(true);
      expect(mockExecute).toHaveBeenCalledTimes(1);
    });
  });

  describe('ReadActionHandlers Execution Delegation', () => {
    let mockExecutor: {
      executeCheckBalance: ReturnType<typeof vi.fn>;
      executeCheckBudget: ReturnType<typeof vi.fn>;
      executeHelpMenu: ReturnType<typeof vi.fn>;
      executeTransactionHistory: ReturnType<typeof vi.fn>;
      executeTransactionSummary: ReturnType<typeof vi.fn>;
    };

    beforeEach(() => {
      mockExecutor = {
        executeCheckBalance: vi.fn().mockResolvedValue(undefined),
        executeCheckBudget: vi.fn().mockResolvedValue(undefined),
        executeHelpMenu: vi.fn().mockResolvedValue(undefined),
        executeTransactionHistory: vi.fn().mockResolvedValue(undefined),
        executeTransactionSummary: vi.fn().mockResolvedValue(undefined),
      };
    });

    it('CheckBalanceActionHandler delegates to FinancialActionExecutor.executeCheckBalance', async () => {
      const handler = new CheckBalanceActionHandler(mockExecutor as unknown as FinancialActionExecutor);
      const mockEvent = createMockIncomingEvent('saldo');

      await handler.execute({
        action: 'CHECK_BALANCE',
        event: mockEvent,
        processingStartTimestamp: 1726000000000,
        routingSource: 'fast-path',
      });

      expect(mockExecutor.executeCheckBalance).toHaveBeenCalledWith(mockEvent, {
        processingStartTimestamp: 1726000000000,
        routingSource: 'fast-path',
      });
    });

    it('CheckBudgetActionHandler delegates to FinancialActionExecutor.executeCheckBudget', async () => {
      const handler = new CheckBudgetActionHandler(mockExecutor as unknown as FinancialActionExecutor);
      const mockEvent = createMockIncomingEvent('budget');

      await handler.execute({
        action: 'CHECK_BUDGET',
        event: mockEvent,
        processingStartTimestamp: 1726000000000,
        routingSource: 'ai',
      });

      expect(mockExecutor.executeCheckBudget).toHaveBeenCalledWith(mockEvent, {
        processingStartTimestamp: 1726000000000,
        routingSource: 'ai',
      });
    });

    it('HelpMenuActionHandler delegates to FinancialActionExecutor.executeHelpMenu', async () => {
      const handler = new HelpMenuActionHandler(mockExecutor as unknown as FinancialActionExecutor);
      const mockEvent = createMockIncomingEvent('help');

      await handler.execute({
        action: 'HELP_MENU',
        event: mockEvent,
        processingStartTimestamp: 1726000000000,
        routingSource: 'fast-path',
      });

      expect(mockExecutor.executeHelpMenu).toHaveBeenCalledWith(mockEvent, {
        processingStartTimestamp: 1726000000000,
        routingSource: 'fast-path',
      });
    });

    it('TransactionHistoryActionHandler delegates with query options', async () => {
      const handler = new TransactionHistoryActionHandler(mockExecutor as unknown as FinancialActionExecutor);
      const mockEvent = createMockIncomingEvent('riwayat');
      const queryOptions = { limit: 5, page: 1, sort: 'asc' as const };

      await handler.execute({
        action: 'TRANSACTION_HISTORY',
        event: mockEvent,
        queryOptions,
        processingStartTimestamp: 1726000000000,
        routingSource: 'fast-path',
      });

      expect(mockExecutor.executeTransactionHistory).toHaveBeenCalledWith(mockEvent, queryOptions, {
        processingStartTimestamp: 1726000000000,
        routingSource: 'fast-path',
      });
    });

    it('TransactionSummaryActionHandler delegates with summary options', async () => {
      const handler = new TransactionSummaryActionHandler(mockExecutor as unknown as FinancialActionExecutor);
      const mockEvent = createMockIncomingEvent('rekap bulan ini');
      const summaryOptions = { period: 'monthly' as const, groupBy: 'category' as const };

      await handler.execute({
        action: 'TRANSACTION_SUMMARY',
        event: mockEvent,
        summaryOptions,
        processingStartTimestamp: 1726000000000,
        routingSource: 'fast-path',
      });

      expect(mockExecutor.executeTransactionSummary).toHaveBeenCalledWith(mockEvent, summaryOptions, {
        processingStartTimestamp: 1726000000000,
        routingSource: 'fast-path',
      });
    });
  });

  describe('CreateRecordActionHandler Workflow & Encapsulation', () => {
    let mockWalletMcpClient: { createRecords: ReturnType<typeof vi.fn> };
    let mockWalletCacheService: { getAccounts: ReturnType<typeof vi.fn>; getCategories: ReturnType<typeof vi.fn> };
    let mockMessagingGateway: { sendMessage: ReturnType<typeof vi.fn> };
    let mockRecordPreparationService: { prepareRecordsForDispatch: ReturnType<typeof vi.fn> };
    let mockAccountClarificationHandler: { createPendingAccountSelectionDraft: ReturnType<typeof vi.fn> };

    const sampleAccounts: WalletAccountItem[] = [
      { id: 'acc-1', name: 'BCA', balance: 1000000, currency: 'IDR' },
      { id: 'acc-2', name: 'Mandiri', balance: 2000000, currency: 'IDR' },
    ];
    const sampleCategories: WalletCategoryItem[] = [
      { id: 'cat-1', name: 'Makanan', type: 'EXPENSE' },
    ];

    beforeEach(() => {
      mockWalletMcpClient = { createRecords: vi.fn().mockResolvedValue(undefined) };
      mockWalletCacheService = {
        getAccounts: vi.fn(() => sampleAccounts),
        getCategories: vi.fn(() => sampleCategories),
      };
      mockMessagingGateway = { sendMessage: vi.fn().mockResolvedValue(undefined) };
      mockRecordPreparationService = { prepareRecordsForDispatch: vi.fn().mockResolvedValue(undefined) };
      mockAccountClarificationHandler = { createPendingAccountSelectionDraft: vi.fn().mockResolvedValue(false) };
    });

    it('handles empty records safely by sending a fallback error notice', async () => {
      const handler = new CreateRecordActionHandler(
        mockWalletMcpClient as any,
        mockWalletCacheService as any,
        mockMessagingGateway as any,
        mockRecordPreparationService as any,
        mockAccountClarificationHandler as any
      );

      const event = createMockIncomingEvent('beli bakso');
      await handler.execute({
        action: 'CREATE_RECORD',
        event,
        records: [],
      });

      expect(mockMessagingGateway.sendMessage).toHaveBeenCalledTimes(1);
      expect(mockWalletMcpClient.createRecords).not.toHaveBeenCalled();
    });

    it('successfully validates, prepares, creates records, and sends formatted confirmation', async () => {
      const handler = new CreateRecordActionHandler(
        mockWalletMcpClient as any,
        mockWalletCacheService as any,
        mockMessagingGateway as any,
        mockRecordPreparationService as any,
        mockAccountClarificationHandler as any
      );

      const event = createMockIncomingEvent('makan siang 25000 bca');
      await handler.execute({
        action: 'CREATE_RECORD',
        event,
        records: [
          {
            accountId: 'acc-1',
            categoryId: 'cat-1',
            amount: 25000,
            recordDate: new Date().toISOString(),
            note: 'makan siang',
          },
        ],
        processingStartTimestamp: Date.now(),
        routingSource: 'ai',
      });

      expect(mockRecordPreparationService.prepareRecordsForDispatch).toHaveBeenCalledTimes(1);
      expect(mockWalletMcpClient.createRecords).toHaveBeenCalledTimes(1);
      expect(mockMessagingGateway.sendMessage).toHaveBeenCalledTimes(1);

      const sentMessage = mockMessagingGateway.sendMessage.mock.calls[0][2];
      expect(typeof sentMessage).toBe('string');
      expect(sentMessage.length).toBeGreaterThan(0);
    });

    it('creates pending account clarification draft when account resolution is ambiguous', async () => {
      mockAccountClarificationHandler.createPendingAccountSelectionDraft.mockResolvedValue(true);

      const handler = new CreateRecordActionHandler(
        mockWalletMcpClient as any,
        mockWalletCacheService as any,
        mockMessagingGateway as any,
        mockRecordPreparationService as any,
        mockAccountClarificationHandler as any
      );

      const event = createMockIncomingEvent('kopi 30000 bank');
      await handler.execute({
        action: 'CREATE_RECORD',
        event,
        records: [
          {
            accountId: 'bank',
            amount: 30000,
            recordDate: new Date().toISOString(),
            note: 'kopi',
          },
        ],
      });

      expect(mockAccountClarificationHandler.createPendingAccountSelectionDraft).toHaveBeenCalledTimes(1);
      expect(mockWalletMcpClient.createRecords).not.toHaveBeenCalled();
      expect(mockMessagingGateway.sendMessage).not.toHaveBeenCalled();
    });

    it('sends validation rejection notice when record validation fails', async () => {
      const handler = new CreateRecordActionHandler(
        mockWalletMcpClient as any,
        mockWalletCacheService as any,
        mockMessagingGateway as any,
        mockRecordPreparationService as any,
        mockAccountClarificationHandler as any
      );

      const event = createMockIncomingEvent('invalid record');
      await handler.execute({
        action: 'CREATE_RECORD',
        event,
        records: [
          {
            accountId: 'non-existent-account-id',
            amount: -500, // Invalid negative amount
            recordDate: 'invalid-date',
            note: '',
          },
        ],
      });

      expect(mockMessagingGateway.sendMessage).toHaveBeenCalledTimes(1);
      expect(mockWalletMcpClient.createRecords).not.toHaveBeenCalled();
    });

    it('attaches hashtags from raw user message if record has no labels', async () => {
      const handler = new CreateRecordActionHandler(
        mockWalletMcpClient as any,
        mockWalletCacheService as any,
        mockMessagingGateway as any,
        mockRecordPreparationService as any,
        mockAccountClarificationHandler as any
      );

      const event = createMockIncomingEvent('makan sate 40000 bca #kuliner #dinner');
      const recordsToCreate = [
        {
          accountId: 'acc-1',
          categoryId: 'cat-1',
          amount: 40000,
          recordDate: new Date().toISOString(),
          note: 'makan sate',
          labels: [] as string[],
        },
      ];

      await handler.execute({
        action: 'CREATE_RECORD',
        event,
        records: recordsToCreate,
      });

      expect(mockRecordPreparationService.prepareRecordsForDispatch).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            labels: expect.arrayContaining(['kuliner', 'dinner']),
          }),
        ])
      );
      expect(mockWalletMcpClient.createRecords).toHaveBeenCalledTimes(1);
    });
  });

  describe('Default FinancialActionRegistry Factory', () => {
    it('creates a registry populated with all 6 core financial action handlers', () => {
      const mockExecutor = {} as FinancialActionExecutor;
      const mockClient = {} as any;
      const mockCache = {} as any;
      const mockGateway = {} as any;
      const mockRecordPrep = {} as any;
      const mockClarification = {} as any;

      const registry = createDefaultFinancialActionRegistry({
        financialActionExecutor: mockExecutor,
        walletMcpClient: mockClient,
        walletCacheService: mockCache,
        messagingGateway: mockGateway,
        recordPreparationService: mockRecordPrep,
        accountClarificationHandler: mockClarification,
      });

      const registeredActions = registry.getAllRegisteredActions();
      expect(registeredActions).toContain('CHECK_BALANCE');
      expect(registeredActions).toContain('CHECK_BUDGET');
      expect(registeredActions).toContain('HELP_MENU');
      expect(registeredActions).toContain('TRANSACTION_HISTORY');
      expect(registeredActions).toContain('TRANSACTION_SUMMARY');
      expect(registeredActions).toContain('CREATE_RECORD');
      expect(registeredActions.length).toBe(6);
    });
  });

  describe('Fast-Path and AI-Path Routing Convergence to Shared Registry', () => {
    it('converges FastPathHandler and UserMessageHandler on the same registered execution handlers', async () => {
      const registry = new FinancialActionRegistry();
      const executedActions: string[] = [];

      const balanceHandler: FinancialActionHandler<'CHECK_BALANCE'> = {
        action: 'CHECK_BALANCE',
        execute: async () => {
          executedActions.push('CHECK_BALANCE');
        },
      };

      const budgetHandler: FinancialActionHandler<'CHECK_BUDGET'> = {
        action: 'CHECK_BUDGET',
        execute: async () => {
          executedActions.push('CHECK_BUDGET');
        },
      };

      const createRecordHandler: FinancialActionHandler<'CREATE_RECORD'> = {
        action: 'CREATE_RECORD',
        execute: async () => {
          executedActions.push('CREATE_RECORD');
        },
      };

      registry.register(balanceHandler);
      registry.register(budgetHandler);
      registry.register(createRecordHandler);

      const mockGateway = {
        sendMessage: vi.fn(),
        sendTypingPresence: vi.fn(),
        clearTypingPresence: vi.fn(),
      };

      const fastPathHandler = new FastPathHandler(
        {} as any,
        {} as any,
        mockGateway as any,
        undefined,
        undefined,
        undefined,
        registry
      );

      const mockAiProvider = {
        providerName: 'mock-ai',
        processTextMessage: vi.fn(),
      };

      const userMessageHandler = new UserMessageHandler(
        mockGateway as any,
        { hasPendingTransactions: () => false } as any,
        {} as any,
        fastPathHandler,
        mockAiProvider as any,
        { getAccounts: () => [], getCategories: () => [] } as any,
        {} as any,
        undefined,
        undefined,
        registry
      );

      // Fast-path execution for balance
      const fastPathBalanceEvent = createMockIncomingEvent('saldo');
      const fastPathHandled = await fastPathHandler.handleFastPath(
        fastPathBalanceEvent,
        'CHECK_BALANCE',
        Date.now()
      );
      expect(fastPathHandled).toBe(true);
      expect(executedActions).toEqual(['CHECK_BALANCE']);

      // AI-routed execution for balance
      executedActions.length = 0;
      mockAiProvider.processTextMessage.mockResolvedValueOnce({
        action: 'CHECK_BALANCE',
        explanation: 'AI wants to check balance',
      });
      const aiBalanceEvent = createMockIncomingEvent('tolong periksa saldo saya');
      await userMessageHandler.handleIncomingUserMessage(aiBalanceEvent);
      expect(executedActions).toEqual(['CHECK_BALANCE']);

      // Fast-path execution for budget
      executedActions.length = 0;
      const fastPathBudgetEvent = createMockIncomingEvent('budget');
      const fastPathBudgetHandled = await fastPathHandler.handleFastPath(
        fastPathBudgetEvent,
        'CHECK_BUDGET',
        Date.now()
      );
      expect(fastPathBudgetHandled).toBe(true);
      expect(executedActions).toEqual(['CHECK_BUDGET']);

      // AI-routed execution for budget
      executedActions.length = 0;
      mockAiProvider.processTextMessage.mockResolvedValueOnce({
        action: 'CHECK_BUDGET',
        explanation: 'AI wants to check budget',
      });
      const aiBudgetEvent = createMockIncomingEvent('cek anggaran bulan ini');
      await userMessageHandler.handleIncomingUserMessage(aiBudgetEvent);
      expect(executedActions).toEqual(['CHECK_BUDGET']);

      // AI-routed execution for record creation
      executedActions.length = 0;
      mockAiProvider.processTextMessage.mockResolvedValueOnce({
        action: 'CREATE_RECORD',
        records: [{ accountId: 'acc-1', amount: 10000, recordDate: new Date().toISOString(), note: 'snack' }],
      });
      const aiRecordEvent = createMockIncomingEvent('beli snack 10000');
      await userMessageHandler.handleIncomingUserMessage(aiRecordEvent);
      expect(executedActions).toEqual(['CREATE_RECORD']);
    });
  });

  describe('Incomplete Text CREATE_RECORD Intent Fallback Regression', () => {
    it('preserves explanation fallback when text AI returns CREATE_RECORD with records: [] without invoking registry handler or wallet write', async () => {
      const registry = new FinancialActionRegistry();
      const mockCreateRecordHandler = {
        action: 'CREATE_RECORD' as const,
        execute: vi.fn(),
      };
      registry.register(mockCreateRecordHandler);

      const mockGateway = {
        sendMessage: vi.fn().mockResolvedValue(undefined),
        sendTypingPresence: vi.fn().mockResolvedValue(undefined),
        clearTypingPresence: vi.fn().mockResolvedValue(undefined),
      };

      const mockAiProvider = {
        providerName: 'mock-ai',
        processTextMessage: vi.fn().mockResolvedValue({
          action: 'CREATE_RECORD',
          records: [],
          explanation: 'Saya belum punya cukup detail untuk mencatat transaksi ini. Tolong sebutkan nominalnya.',
        }),
      };

      const mockWalletMcpClient = {
        createRecords: vi.fn(),
      };

      const userMessageHandler = new UserMessageHandler(
        mockGateway as any,
        { hasPendingTransactions: () => false } as any,
        {} as any,
        { handleFastPath: vi.fn().mockResolvedValue(false) } as any,
        mockAiProvider as any,
        { getAccounts: () => [], getCategories: () => [] } as any,
        mockWalletMcpClient as any,
        undefined,
        undefined,
        registry
      );

      const textEvent = createMockIncomingEvent('beli makan tapi belum ada nominal');
      await userMessageHandler.handleIncomingUserMessage(textEvent);

      expect(mockCreateRecordHandler.execute).not.toHaveBeenCalled();
      expect(mockWalletMcpClient.createRecords).not.toHaveBeenCalled();
      expect(mockGateway.sendMessage).toHaveBeenCalledWith(
        textEvent.channel,
        textEvent.chatIdentifier,
        'Saya belum punya cukup detail untuk mencatat transaksi ini. Tolong sebutkan nominalnya.'
      );
      expect(mockGateway.sendMessage).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.stringMatching(/struk|receipt/i)
      );
    });

    it('preserves explanation fallback when text AI returns CREATE_RECORD with records: undefined', async () => {
      const registry = new FinancialActionRegistry();
      const mockCreateRecordHandler = {
        action: 'CREATE_RECORD' as const,
        execute: vi.fn(),
      };
      registry.register(mockCreateRecordHandler);

      const mockGateway = {
        sendMessage: vi.fn().mockResolvedValue(undefined),
        sendTypingPresence: vi.fn().mockResolvedValue(undefined),
        clearTypingPresence: vi.fn().mockResolvedValue(undefined),
      };

      const mockAiProvider = {
        providerName: 'mock-ai',
        processTextMessage: vi.fn().mockResolvedValue({
          action: 'CREATE_RECORD',
          records: undefined,
          explanation: 'Mohon sebutkan nama akun dan kategori.',
        }),
      };

      const mockWalletMcpClient = {
        createRecords: vi.fn(),
      };

      const userMessageHandler = new UserMessageHandler(
        mockGateway as any,
        { hasPendingTransactions: () => false } as any,
        {} as any,
        { handleFastPath: vi.fn().mockResolvedValue(false) } as any,
        mockAiProvider as any,
        { getAccounts: () => [], getCategories: () => [] } as any,
        mockWalletMcpClient as any,
        undefined,
        undefined,
        registry
      );

      const textEvent = createMockIncomingEvent('catat pengeluaran');
      await userMessageHandler.handleIncomingUserMessage(textEvent);

      expect(mockCreateRecordHandler.execute).not.toHaveBeenCalled();
      expect(mockWalletMcpClient.createRecords).not.toHaveBeenCalled();
      expect(mockGateway.sendMessage).toHaveBeenCalledWith(
        textEvent.channel,
        textEvent.chatIdentifier,
        'Mohon sebutkan nama akun dan kategori.'
      );
    });

    it('falls back to welcome guidance when text AI returns CREATE_RECORD with empty records and no explanation', async () => {
      const registry = new FinancialActionRegistry();
      const mockCreateRecordHandler = {
        action: 'CREATE_RECORD' as const,
        execute: vi.fn(),
      };
      registry.register(mockCreateRecordHandler);

      const mockGateway = {
        sendMessage: vi.fn().mockResolvedValue(undefined),
        sendTypingPresence: vi.fn().mockResolvedValue(undefined),
        clearTypingPresence: vi.fn().mockResolvedValue(undefined),
      };

      const mockAiProvider = {
        providerName: 'mock-ai',
        processTextMessage: vi.fn().mockResolvedValue({
          action: 'CREATE_RECORD',
          records: [],
        }),
      };

      const userMessageHandler = new UserMessageHandler(
        mockGateway as any,
        { hasPendingTransactions: () => false } as any,
        {} as any,
        { handleFastPath: vi.fn().mockResolvedValue(false) } as any,
        mockAiProvider as any,
        { getAccounts: () => [], getCategories: () => [] } as any,
        {} as any,
        undefined,
        undefined,
        registry
      );

      const textEvent = createMockIncomingEvent('halo');
      await userMessageHandler.handleIncomingUserMessage(textEvent);

      expect(mockCreateRecordHandler.execute).not.toHaveBeenCalled();
      expect(mockGateway.sendMessage).toHaveBeenCalledWith(
        textEvent.channel,
        textEvent.chatIdentifier,
        expect.stringContaining('Halo!')
      );
    });

    it('preserves receipt extraction failure path when image message returns CREATE_RECORD with 0 records', async () => {
      const registry = new FinancialActionRegistry();
      const mockCreateRecordHandler = {
        action: 'CREATE_RECORD' as const,
        execute: vi.fn(),
      };
      registry.register(mockCreateRecordHandler);

      const mockGateway = {
        sendMessage: vi.fn().mockResolvedValue(undefined),
        sendTypingPresence: vi.fn().mockResolvedValue(undefined),
        clearTypingPresence: vi.fn().mockResolvedValue(undefined),
      };

      const mockAiProvider = {
        providerName: 'mock-ai',
        processImageMessage: vi.fn().mockResolvedValue({
          action: 'CREATE_RECORD',
          records: [],
        }),
      };

      const userMessageHandler = new UserMessageHandler(
        mockGateway as any,
        { hasPendingTransactions: () => false } as any,
        {} as any,
        { handleFastPath: vi.fn().mockResolvedValue(false) } as any,
        mockAiProvider as any,
        { getAccounts: () => [], getCategories: () => [] } as any,
        {} as any,
        undefined,
        undefined,
        registry
      );

      const imageEvent: IncomingUserMessageEvent = {
        channel: 'whatsapp',
        senderIdentifier: 'user-phone-12345',
        chatIdentifier: '12345@s.whatsapp.net',
        messageType: 'image',
        imageBuffer: Buffer.from('fake-image-bytes'),
        imageMimeType: 'image/jpeg',
      };

      await userMessageHandler.handleIncomingUserMessage(imageEvent);

      expect(mockCreateRecordHandler.execute).not.toHaveBeenCalled();
      expect(mockGateway.sendMessage).toHaveBeenCalledWith(
        imageEvent.channel,
        imageEvent.chatIdentifier,
        expect.stringMatching(/foto struk/i)
      );
    });
  });
});
