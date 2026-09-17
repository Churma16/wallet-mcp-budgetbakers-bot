import { describe, expect, it, vi } from 'vitest';
import { UserMessageHandler } from '../src/handlers/userMessageHandler.js';
import { detectFastPathAction } from '../src/utils/fastPathIntentDetector.js';
import {
  normalizeTransactionHistoryFilters,
  matchDynamicCategoryGroup,
  extractDynamicCategoryGroups,
} from '../src/utils/transactionHistoryFilterNormalizer.js';
import { validateSemanticHistoryQueryOptions } from '../src/services/ai/semanticToolBoundary.js';
import { WalletAccountItem, WalletCategoryItem, WalletRecordItem } from '../src/types/walletTypes.js';
import { WalletMcpClientService } from '../src/services/walletMcpService.js';
import { TransactionHistoryService } from '../src/services/transactionHistoryService.js';
import { getDictionary } from '../src/i18n/index.js';

const MOCK_ACCOUNTS: WalletAccountItem[] = [
  { id: 'acc-bca', name: 'BCA' },
  { id: 'acc-mandiri', name: 'Mandiri Debit Card' },
  { id: 'acc-jago', name: 'Jago' },
];

const COMPREHENSIVE_CATEGORIES: WalletCategoryItem[] = [
  // Food group
  { id: 'cat-food-main', name: 'Makanan & Minuman', group: 'food_and_drinks' },
  { id: 'cat-hangout', name: 'Makan Hangout', group: 'food_and_drinks' },
  { id: 'cat-nafsu', name: 'Makan Nafsu', group: 'food_and_drinks' },
  { id: 'cat-pokok', name: 'Makan Pokok', group: 'food_and_drinks' },

  // Internet / connectivity group
  { id: 'cat-internet', name: 'Internet & Wifi', group: 'communication_pc' },
  { id: 'cat-pulsa', name: 'Pulsa & Paket Data', group: 'communication_pc' },

  // Digital / software / subscriptions
  { id: 'cat-software', name: 'Software & Apps', group: 'communication_pc' },
  { id: 'cat-digital-services', name: 'Digital Services', group: 'communication_pc' },
  { id: 'cat-subscription', name: 'Books, audio, subscription', group: 'life_entertainment' },

  // Transport
  { id: 'cat-transport-main', name: 'Transportasi', group: 'transportation' },
  { id: 'cat-ridehail', name: 'Ojek Online', group: 'transportation' },

  // Shopping & Electronics
  { id: 'cat-shopping', name: 'Belanja Bulanan', group: 'shopping' },
  { id: 'cat-electronics', name: 'Barang Elektronik', group: 'shopping' },
  { id: 'cat-groceries', name: 'Groceries', group: 'food_and_drinks' },

  // Housing & Health
  { id: 'cat-housing', name: 'Kebutuhan Rumah', group: 'housing' },
  { id: 'cat-health', name: 'Kesehatan & Obat', group: 'life_entertainment' },
];

const ISSUE_173_CATEGORIES: WalletCategoryItem[] = [
  { id: 'c-1', name: 'Makan Nafsu', group: 'food_and_drinks' },
  { id: 'c-2', name: 'Food & Drinks', group: 'food_and_drinks' },
  { id: 'c-3', name: 'Other' },
  { id: 'c-4', name: 'Makan Hangout', group: 'food_and_drinks' },
  { id: 'c-5', name: 'Software, apps, games', group: 'communication_pc' },
  { id: 'c-6', name: 'Transport', group: 'transportation' },
  { id: 'c-7', name: 'Internet', group: 'communication_pc' },
  { id: 'c-8', name: 'Pengeluaran Digital', group: 'communication_pc' },
];

function createRegressionHandler(aiProvider: any, fastPathHandled = false, categories: WalletCategoryItem[] = COMPREHENSIVE_CATEGORIES, accounts: WalletAccountItem[] = MOCK_ACCOUNTS) {
  const gateway = { sendTypingPresence: vi.fn(), clearTypingPresence: vi.fn(), sendMessage: vi.fn() };
  const registry = { hasHandler: vi.fn().mockReturnValue(true), execute: vi.fn() };
  const fastPath = { handleFastPath: vi.fn().mockResolvedValue(fastPathHandled) };
  const handler = new UserMessageHandler(
    gateway as any,
    { hasPendingTransactions: vi.fn().mockReturnValue(false) } as any,
    {} as any,
    fastPath as any,
    aiProvider,
    { getAccounts: vi.fn().mockReturnValue(accounts), getCategories: vi.fn().mockReturnValue(categories) } as any,
    {} as any,
    {} as any,
    {} as any,
    registry as any,
    { handlePendingAccountSelectionReply: vi.fn().mockResolvedValue(false) } as any
  );
  return { handler, gateway, registry, fastPath };
}

function textEvent(text: string) {
  return { channel: 'whatsapp', chatIdentifier: 'chat-reg', senderIdentifier: 'user-reg', messageType: 'text', textPayload: text } as any;
}

describe('Issue #160 comment checklist regression corpus', () => {
  describe('Food / dining corpus', () => {
    it.each([
      ['History makan semua'],
      ['History makan all'],
      ['Riwayat makan semua'],
      ['Riwayat semua makan'],
      ['Semua riwayat makan bulan ini'],
      ['Riwayat semua pengeluaran makanan'],
    ])('resolves broad food phrase "%s" to a category group without dropping group scope', (input) => {
      const fastPathResult = detectFastPathAction(input);
      expect(fastPathResult).not.toBeNull();
      expect(fastPathResult!.type).toBe('TRANSACTION_HISTORY');

      const historyAction = fastPathResult as { type: 'TRANSACTION_HISTORY'; options: any };
      const normalized = normalizeTransactionHistoryFilters(historyAction.options, MOCK_ACCOUNTS, COMPREHENSIVE_CATEGORIES);

      expect(normalized.isValid).toBe(true);
      expect(normalized.upstreamCategoryGroup).toBe('food_and_drinks');
      expect(normalized.upstreamCategoryId).toBeDefined();
      expect(normalized.upstreamCategoryId!.length).toBeGreaterThan(1);
    });

    it.each([
      ['History Makan Hangout', 'cat-hangout', 'Makan Hangout'],
      ['History Makan Nafsu', 'cat-nafsu', 'Makan Nafsu'],
      ['History Makan Pokok', 'cat-pokok', 'Makan Pokok'],
    ])('keeps exact category name "%s" as a single-category filter', (input, expectedId, _expectedName) => {
      const fastPathResult = detectFastPathAction(input);
      expect(fastPathResult).not.toBeNull();
      expect(fastPathResult!.type).toBe('TRANSACTION_HISTORY');

      const historyAction = fastPathResult as { type: 'TRANSACTION_HISTORY'; options: any };
      const normalized = normalizeTransactionHistoryFilters(historyAction.options, MOCK_ACCOUNTS, COMPREHENSIVE_CATEGORIES);

      expect(normalized.isValid).toBe(true);
      expect(normalized.upstreamCategoryId).toEqual([expectedId]);
      expect(normalized.upstreamCategoryGroup).toBeUndefined();
      expect(normalized.appliedFilters.searchQuery).toBeUndefined();
    });

    it.each([
      ['History makan hangry', 'hangry'],
      ['Riwayat makan ayam hangry', 'ayam hangry'],
      ['Riwayat makan di hangry', 'hangry'],
      ['Riwayat pesen makan di grab', 'grab'],
      ['Riwayat grab food', 'grab'],
      ['Riwayat makanan dari grab', 'grab'],
    ])('routes merchant/item phrase "%s" to cross-category description search without categoryGroup', async (input, expectedSearch) => {
      const processTextMessage = vi.fn().mockResolvedValue({
        action: 'TRANSACTION_HISTORY',
        queryOptions: { searchQuery: expectedSearch },
      });
      const harness = createRegressionHandler(
        { providerName: 'mock', processTextMessage, processImageMessage: vi.fn() },
        false
      );

      await harness.handler.handleIncomingUserMessage(textEvent(input));

      expect(harness.registry.execute).toHaveBeenCalledWith(expect.objectContaining({
        action: 'TRANSACTION_HISTORY',
        queryOptions: expect.objectContaining({
          searchQuery: expectedSearch,
        }),
      }));
      const executeCall = harness.registry.execute.mock.calls[0][0];
      expect(executeCall.queryOptions.categoryId).toBeUndefined();
      expect(executeCall.queryOptions.categoryGroup).toBeUndefined();
    });

    it('correctly extracts account, recordType, datePeriod, and category for "Riwayat makan jago expense bulan ini"', () => {
      const fastPathResult = detectFastPathAction('Riwayat makan jago expense bulan ini');
      expect(fastPathResult).not.toBeNull();
      expect(fastPathResult!.type).toBe('TRANSACTION_HISTORY');

      const historyAction = fastPathResult as { type: 'TRANSACTION_HISTORY'; options: any };
      expect(historyAction.options.accountName).toBe('jago');
      expect(historyAction.options.recordType).toBe('expense');
      expect(historyAction.options.datePeriod).toBe('this_month');
    });
  });

  describe('Internet / connectivity corpus', () => {
    it.each([
      ['Riwayat bayar wifi', 'cat-internet'],
      ['History bayar wifi', 'cat-internet'],
      ['Riwayat wifi', 'cat-internet'],
      ['Riwayat internet', 'cat-internet'],
      ['Riwayat isi paket data', 'cat-pulsa'],
      ['Riwayat langganan internet', 'cat-internet'],
    ])('prefers category intent for spending domain phrase "%s"', async (input, expectedCategoryId) => {
      const processTextMessage = vi.fn().mockResolvedValue({
        action: 'TRANSACTION_HISTORY',
        queryOptions: { categoryId: expectedCategoryId },
      });
      const harness = createRegressionHandler(
        { providerName: 'mock', processTextMessage, processImageMessage: vi.fn() },
        false
      );

      await harness.handler.handleIncomingUserMessage(textEvent(input));

      expect(harness.registry.execute).toHaveBeenCalledWith(expect.objectContaining({
        action: 'TRANSACTION_HISTORY',
        queryOptions: expect.objectContaining({
          categoryId: expectedCategoryId,
        }),
      }));
    });

    it.each([
      ['Riwayat cari wifi', 'wifi'],
      ['History search wifi', 'wifi'],
    ])('preserves explicit search marker "%s" as pure searchQuery', (input, expectedQuery) => {
      const fastPathResult = detectFastPathAction(input);
      expect(fastPathResult).not.toBeNull();
      expect(fastPathResult!.type).toBe('TRANSACTION_HISTORY');

      const historyAction = fastPathResult as { type: 'TRANSACTION_HISTORY'; options: any };
      expect(historyAction.options.searchQuery).toBe(expectedQuery);
      expect(historyAction.options.categoryName).toBeUndefined();

      const normalized = normalizeTransactionHistoryFilters(historyAction.options, MOCK_ACCOUNTS, COMPREHENSIVE_CATEGORIES);
      expect(normalized.isValid).toBe(true);
      expect(normalized.upstreamSearchQuery).toBe(expectedQuery);
      expect(normalized.upstreamCategoryId).toBeUndefined();
    });
  });

  describe('Digital / software / AI subscriptions corpus', () => {
    it('does not resolve "Riwayat Langganan ai" solely to a generic subscription category without AI signal', async () => {
      // The resolver composes communication/software with AI search or asks for clarification
      const processTextMessage = vi.fn().mockResolvedValue({
        action: 'TRANSACTION_HISTORY',
        queryOptions: { categoryGroup: 'communication_pc', searchQuery: 'ai' },
      });
      const harness = createRegressionHandler(
        { providerName: 'mock', processTextMessage, processImageMessage: vi.fn() },
        false
      );

      await harness.handler.handleIncomingUserMessage(textEvent('Riwayat Langganan ai'));

      expect(harness.registry.execute).toHaveBeenCalledWith(expect.objectContaining({
        action: 'TRANSACTION_HISTORY',
        queryOptions: expect.objectContaining({
          categoryGroup: 'communication_pc',
          searchQuery: 'ai',
        }),
      }));
    });

    it('asks for clarification if multi-signal "Riwayat Langganan ai" is ambiguous across subscription domains', async () => {
      const clarificationText = 'Apakah Anda mencari langganan aplikasi/AI atau langganan media/buku?';
      const processTextMessage = vi.fn().mockResolvedValue({
        action: 'GENERAL_REPLY',
        explanation: clarificationText,
      });
      const harness = createRegressionHandler(
        { providerName: 'mock', processTextMessage, processImageMessage: vi.fn() },
        false
      );

      await harness.handler.handleIncomingUserMessage(textEvent('Riwayat Langganan ai'));

      expect(harness.registry.execute).not.toHaveBeenCalled();
      expect(harness.gateway.sendMessage).toHaveBeenCalledWith(
        'whatsapp',
        'chat-reg',
        clarificationText
      );
    });

    it.each([
      ['Riwayat Gemini Pro', 'Gemini Pro'],
      ['Riwayat Deepseek', 'Deepseek'],
      ['Riwayat Zytro API', 'Zytro API'],
    ])('preserves specific provider/tool name in "%s" as searchQuery', async (input, expectedSearch) => {
      const processTextMessage = vi.fn().mockResolvedValue({
        action: 'TRANSACTION_HISTORY',
        queryOptions: { searchQuery: expectedSearch },
      });
      const harness = createRegressionHandler(
        { providerName: 'mock', processTextMessage, processImageMessage: vi.fn() },
        false
      );

      await harness.handler.handleIncomingUserMessage(textEvent(input));

      expect(harness.registry.execute).toHaveBeenCalledWith(expect.objectContaining({
        action: 'TRANSACTION_HISTORY',
        queryOptions: expect.objectContaining({
          searchQuery: expectedSearch,
        }),
      }));
    });

    it.each([
      ['Riwayat beli token API', 'token API'],
      ['Riwayat API provider', 'API provider'],
      ['Riwayat tools ai', 'tools ai'],
      ['Riwayat layanan AI', 'layanan AI'],
    ])('composes or searches for AI/API service term in "%s"', async (input, expectedSearch) => {
      const processTextMessage = vi.fn().mockResolvedValue({
        action: 'TRANSACTION_HISTORY',
        queryOptions: { categoryGroup: 'communication_pc', searchQuery: expectedSearch },
      });
      const harness = createRegressionHandler(
        { providerName: 'mock', processTextMessage, processImageMessage: vi.fn() },
        false
      );

      await harness.handler.handleIncomingUserMessage(textEvent(input));

      expect(harness.registry.execute).toHaveBeenCalledWith(expect.objectContaining({
        action: 'TRANSACTION_HISTORY',
        queryOptions: expect.objectContaining({
          searchQuery: expectedSearch,
        }),
      }));
    });
  });

  describe('Hosting / VPS / infrastructure corpus', () => {
    it.each([
      ['Riwayat beli vps', 'vps'],
      ['History vps', 'vps'],
      ['Riwayat VPS Rumahweb', 'VPS Rumahweb'],
      ['Riwayat hosting', 'hosting'],
      ['Riwayat domain', 'domain'],
      ['Riwayat server', 'server'],
      ['Riwayat infrastruktur', 'infrastruktur'],
    ])('finds hosting/infra records with searchQuery for "%s"', async (input, expectedSearch) => {
      const processTextMessage = vi.fn().mockResolvedValue({
        action: 'TRANSACTION_HISTORY',
        queryOptions: { searchQuery: expectedSearch },
      });
      const harness = createRegressionHandler(
        { providerName: 'mock', processTextMessage, processImageMessage: vi.fn() },
        false
      );

      await harness.handler.handleIncomingUserMessage(textEvent(input));

      expect(harness.registry.execute).toHaveBeenCalledWith(expect.objectContaining({
        action: 'TRANSACTION_HISTORY',
        queryOptions: expect.objectContaining({
          searchQuery: expectedSearch,
        }),
      }));
    });

    it('preserves explicit search marker for "Riwayat cari vps"', () => {
      const fastPathResult = detectFastPathAction('Riwayat cari vps');
      expect(fastPathResult).not.toBeNull();
      expect(fastPathResult!.type).toBe('TRANSACTION_HISTORY');

      const historyAction = fastPathResult as { type: 'TRANSACTION_HISTORY'; options: any };
      expect(historyAction.options.searchQuery).toBe('vps');
    });

    it('composes category and search for "Riwayat digital vps"', async () => {
      const processTextMessage = vi.fn().mockResolvedValue({
        action: 'TRANSACTION_HISTORY',
        queryOptions: { categoryGroup: 'communication_pc', searchQuery: 'vps' },
      });
      const harness = createRegressionHandler(
        { providerName: 'mock', processTextMessage, processImageMessage: vi.fn() },
        false
      );

      await harness.handler.handleIncomingUserMessage(textEvent('Riwayat digital vps'));

      expect(harness.registry.execute).toHaveBeenCalledWith(expect.objectContaining({
        action: 'TRANSACTION_HISTORY',
        queryOptions: expect.objectContaining({
          categoryGroup: 'communication_pc',
          searchQuery: 'vps',
        }),
      }));
    });
  });

  describe('Transport / ride-hailing corpus', () => {
    it.each([
      ['Riwayat transport semua'],
      ['History transport all'],
    ])('resolves broad transport phrase "%s" to transport category group', (input) => {
      const fastPathResult = detectFastPathAction(input);
      expect(fastPathResult).not.toBeNull();

      const historyAction = fastPathResult as { type: 'TRANSACTION_HISTORY'; options: any };
      const normalized = normalizeTransactionHistoryFilters(historyAction.options, MOCK_ACCOUNTS, COMPREHENSIVE_CATEGORIES);

      expect(normalized.isValid).toBe(true);
      expect(normalized.upstreamCategoryGroup).toBe('transportation');
    });

    it.each([
      ['Riwayat grab bike', 'grab bike'],
      ['Riwayat gojek', 'gojek'],
      ['Riwayat ojek', 'ojek'],
      ['Riwayat ojol', 'ojol'],
      ['Riwayat perjalanan grab', 'grab'],
    ])('composes transport category and provider search for "%s"', async (input, expectedSearch) => {
      const processTextMessage = vi.fn().mockResolvedValue({
        action: 'TRANSACTION_HISTORY',
        queryOptions: { categoryGroup: 'transportation', searchQuery: expectedSearch },
      });
      const harness = createRegressionHandler(
        { providerName: 'mock', processTextMessage, processImageMessage: vi.fn() },
        false
      );

      await harness.handler.handleIncomingUserMessage(textEvent(input));

      expect(harness.registry.execute).toHaveBeenCalledWith(expect.objectContaining({
        action: 'TRANSACTION_HISTORY',
        queryOptions: expect.objectContaining({
          categoryGroup: 'transportation',
          searchQuery: expectedSearch,
        }),
      }));
    });

    it('correctly parses account and category for "Riwayat transport dari Mandiri Debit Card"', () => {
      const fastPathResult = detectFastPathAction('Riwayat transport dari Mandiri Debit Card');
      expect(fastPathResult).not.toBeNull();

      const historyAction = fastPathResult as { type: 'TRANSACTION_HISTORY'; options: any };
      expect(historyAction.options.accountName).toBe('mandiri debit card');
      expect(historyAction.options.categoryName).toBe('transport');

      const normalized = normalizeTransactionHistoryFilters(historyAction.options, MOCK_ACCOUNTS, COMPREHENSIVE_CATEGORIES);
      expect(normalized.isValid).toBe(true);
      expect(normalized.upstreamAccountId).toBe('acc-mandiri');
    });
  });

  describe('Shopping / necessities / health corpus', () => {
    it.each([
      ['Riwayat beli obat', 'cat-health'],
      ['History medicine purchases', 'cat-health'],
      ['Riwayat health expenses', 'cat-health'],
      ['Riwayat kebutuhan rumah', 'cat-housing'],
      ['Riwayat belanja bulanan', 'cat-shopping'],
      ['Riwayat groceries', 'cat-groceries'],
      ['Riwayat beli barang elektronik', 'cat-electronics'],
      ['Riwayat elektronik', 'cat-electronics'],
    ])('maps unambiguous category intent "%s" to appropriate category', async (input, expectedCategoryId) => {
      const processTextMessage = vi.fn().mockResolvedValue({
        action: 'TRANSACTION_HISTORY',
        queryOptions: { categoryId: expectedCategoryId },
      });
      const harness = createRegressionHandler(
        { providerName: 'mock', processTextMessage, processImageMessage: vi.fn() },
        false
      );

      await harness.handler.handleIncomingUserMessage(textEvent(input));

      expect(harness.registry.execute).toHaveBeenCalledWith(expect.objectContaining({
        action: 'TRANSACTION_HISTORY',
        queryOptions: expect.objectContaining({
          categoryId: expectedCategoryId,
        }),
      }));
    });

    it('preserves charger item term in "Riwayat cari charger" as explicit fast-path searchQuery', () => {
      const fastPathResult = detectFastPathAction('Riwayat cari charger');
      expect(fastPathResult).not.toBeNull();
      const historyAction = fastPathResult as { type: 'TRANSACTION_HISTORY'; options: any };
      expect(historyAction.options.searchQuery).toBe('charger');
    });

    it('defers "Riwayat charger" to semantic search resolution since charger is not a category', async () => {
      const processTextMessage = vi.fn().mockResolvedValue({
        action: 'TRANSACTION_HISTORY',
        queryOptions: { searchQuery: 'charger' },
      });
      const harness = createRegressionHandler(
        { providerName: 'mock', processTextMessage, processImageMessage: vi.fn() },
        false
      );

      await harness.handler.handleIncomingUserMessage(textEvent('Riwayat charger'));

      expect(harness.registry.execute).toHaveBeenCalledWith(expect.objectContaining({
        action: 'TRANSACTION_HISTORY',
        queryOptions: expect.objectContaining({
          searchQuery: 'charger',
        }),
      }));
    });
  });

  describe('Transaction-entry collision guards', () => {
    it.each([
      ['makan 25k'],
      ['beli obat 50k'],
      ['bayar wifi 300k'],
      ['beli charger 200k'],
      ['bayar vps 100k'],
      ['langganan ai 15000'],
      ['pesen makan di grab 60000'],
    ])('strictly rejects transaction-entry message "%s" from fast-path history', (input) => {
      const fastPathResult = detectFastPathAction(input);
      expect(fastPathResult).toBeNull();
    });
  });

  describe('Category explanation invariant', () => {
    it('ensures a chosen single category explains the whole phrase, not only one token', () => {
      // Category "Makan" should NOT match "makan ayam hangry" as a single-category filter
      const categories: WalletCategoryItem[] = [{ id: 'cat-makan', name: 'Makan' }];
      const normalized = normalizeTransactionHistoryFilters(
        { categoryName: 'makan ayam hangry' },
        MOCK_ACCOUNTS,
        categories
      );

      expect(normalized.isValid).toBe(false);
      expect(normalized.upstreamCategoryId).toBeUndefined();
      expect(normalized.unresolvedFilters).toContainEqual(
        expect.objectContaining({
          filterKey: 'category',
          rawValue: 'makan ayam hangry',
          reason: 'NOT_FOUND',
        })
      );
    });

    it('ensures an exact category name explains the whole phrase and succeeds', () => {
      const categories: WalletCategoryItem[] = [{ id: 'cat-makan-hangout', name: 'Makan Hangout' }];
      const normalized = normalizeTransactionHistoryFilters(
        { categoryName: 'makan hangout' },
        MOCK_ACCOUNTS,
        categories
      );

      expect(normalized.isValid).toBe(true);
      expect(normalized.upstreamCategoryId).toEqual(['cat-makan-hangout']);
      expect(normalized.unresolvedFilters).toHaveLength(0);
    });
  });

  describe('Issue #173 synthetic fixture & description search acceptance', () => {
    const ISSUE_173_FIXTURE_RECORDS: any[] = [
      { id: 'rec-A', recordType: 'expense', amount: -50000, note: 'Hangry dinner', category: { id: 'c-1', name: 'Makan Nafsu' }, recordDate: '2026-09-16T12:00:00Z' },
      { id: 'rec-B', recordType: 'expense', amount: -40000, note: 'Hangry lunch', category: { id: 'c-2', name: 'Food & Drinks' }, recordDate: '2026-09-16T11:00:00Z' },
      { id: 'rec-C', recordType: 'expense', amount: -45000, note: 'Hangry reimbursement', category: { id: 'c-3', name: 'Other' }, recordDate: '2026-09-16T10:00:00Z' },
      { id: 'rec-D', recordType: 'expense', amount: -60000, note: 'Hokben dinner', category: { id: 'c-4', name: 'Makan Hangout' }, recordDate: '2026-09-16T09:00:00Z' },
      { id: 'rec-E', recordType: 'expense', amount: -150000, note: 'AI provider API', category: { id: 'c-5', name: 'Software, apps, games' }, recordDate: '2026-09-16T08:00:00Z' },
      { id: 'rec-F', recordType: 'expense', amount: -25000, note: 'Trip to Sarana Jaya', category: { id: 'c-6', name: 'Transport' }, recordDate: '2026-09-16T07:00:00Z' },
      { id: 'rec-G', recordType: 'expense', amount: -100000, note: '10 GB data package', category: { id: 'c-7', name: 'Internet' }, recordDate: '2026-09-16T06:00:00Z' },
      { id: 'rec-H', recordType: 'expense', amount: -120000, note: 'VPS hosting', category: { id: 'c-8', name: 'Pengeluaran Digital' }, recordDate: '2026-09-16T05:00:00Z' },
      { id: 'rec-I', recordType: 'income', amount: 50000, note: 'AI provider refund', category: { id: 'c-5', name: 'Software, apps, games' }, recordDate: '2026-09-16T04:00:00Z' },
      { id: 'rec-J', recordType: 'income', amount: 35000, note: 'Hangry refund', category: { id: 'c-3', name: 'Other' }, recordDate: '2026-09-16T03:00:00Z' },
    ];

    function createFixtureHistoryService() {
      const client = new WalletMcpClientService('https://mcp.wallet.budgetbakers.com', 'mock-token');
      client.callMcpTool = vi.fn().mockImplementation(async <T>(_toolName: string, args: Record<string, unknown> = {}): Promise<T> => {
        let filtered = [...ISSUE_173_FIXTURE_RECORDS];
        if (args.recordType) {
          filtered = filtered.filter(r => r.recordType === args.recordType);
        }
        if (args.categoryId && Array.isArray(args.categoryId)) {
          filtered = filtered.filter(r => (args.categoryId as string[]).includes(r.category.id));
        }
        return { records: filtered, total: filtered.length } as T;
      });
      const cacheService = {
        getAccounts: () => MOCK_ACCOUNTS,
        getCategories: () => ISSUE_173_CATEGORIES,
      } as any;
      return { client, historyService: new TransactionHistoryService(client, cacheService) };
    }

    it('riwayat makan hangry: returns A, B, C, J and never D across categories and types', async () => {
      const { historyService, client } = createFixtureHistoryService();
      const result = await historyService.getTransactionHistory({
        searchQuery: 'hangry',
        sort: 'newest',
      });

      const returnedIds = result.records.map(r => r.id);
      expect(returnedIds).toEqual(['rec-A', 'rec-B', 'rec-C', 'rec-J']);
      expect(returnedIds).not.toContain('rec-D');

      const lastCall = (client.callMcpTool as any).mock.calls[0][1];
      expect(lastCall.categoryId).toBeUndefined();
      expect(lastCall.categoryGroup).toBeUndefined();
    });

    it('riwayat beli ai: returns E and never F (incidental Jaya) or I (income refund)', async () => {
      const { historyService } = createFixtureHistoryService();
      const result = await historyService.getTransactionHistory({
        searchQuery: 'ai',
        recordType: 'expense',
        sort: 'newest',
      });

      const returnedIds = result.records.map(r => r.id);
      expect(returnedIds).toEqual(['rec-E']);
      expect(returnedIds).not.toContain('rec-F');
      expect(returnedIds).not.toContain('rec-I');
    });

    it('riwayat beli wifi / riwayat langganan wifi: returns no matches and never G (Internet package)', async () => {
      const { historyService } = createFixtureHistoryService();
      const result = await historyService.getTransactionHistory({
        searchQuery: 'wifi',
        recordType: 'expense',
        sort: 'newest',
      });

      expect(result.records).toHaveLength(0);
      expect(result.records.map(r => r.id)).not.toContain('rec-G');
    });

    it('riwayat beli vps: returns H and never G or income refund', async () => {
      const { historyService } = createFixtureHistoryService();
      const result = await historyService.getTransactionHistory({
        searchQuery: 'vps',
        recordType: 'expense',
        sort: 'newest',
      });

      const returnedIds = result.records.map(r => r.id);
      expect(returnedIds).toEqual(['rec-H']);
      expect(returnedIds).not.toContain('rec-G');
    });

    it('preserves multi-page pagination for cross-category note search without losing filter', async () => {
      const multiPageRecords = Array.from({ length: 15 }, (_, index) => ({
        id: `rec-hangry-${index + 1}`,
        recordType: 'expense',
        amount: -25000,
        note: `Hangry meal #${index + 1}`,
        category: { id: index % 2 === 0 ? 'c-1' : 'c-3', name: index % 2 === 0 ? 'Makan Nafsu' : 'Other' },
        recordDate: new Date(Date.now() - index * 60000).toISOString(),
      }));

      const client = new WalletMcpClientService('https://mcp.wallet.budgetbakers.com', 'mock-token');
      client.callMcpTool = vi.fn().mockImplementation(async <T>(_toolName: string, args: Record<string, unknown> = {}): Promise<T> => {
        const offset = (args.offset as number) || 0;
        const limit = (args.limit as number) || 10;
        const pageItems = multiPageRecords.slice(offset, offset + limit);
        return { records: pageItems, total: multiPageRecords.length } as T;
      });
      const historyService = new TransactionHistoryService(client, {
        getAccounts: () => MOCK_ACCOUNTS,
        getCategories: () => ISSUE_173_CATEGORIES,
      } as any);

      const page1 = await historyService.getTransactionHistory({
        searchQuery: 'hangry',
        page: 1,
        limit: 10,
      });
      expect(page1.records).toHaveLength(10);
      expect(page1.hasMore).toBe(true);

      const page2 = await historyService.getTransactionHistory({
        searchQuery: 'hangry',
        page: 2,
        limit: 10,
      });
      expect(page2.records).toHaveLength(5);
      expect(page2.records[0].id).toBe('rec-hangry-11');
      expect(page2.hasMore).toBe(false);
    });
  });

  describe('Unexecuted deferred history fail-closed guards', () => {
    it('fails closed and sends clarification/error text without leaking result-like AI explanation', async () => {
      const processTextMessage = vi.fn().mockResolvedValue({
        action: 'TRANSACTION_HISTORY',
        explanation: 'Menampilkan riwayat transaksi pengeluaran untuk pembelian wifi.',
        queryOptions: {},
      });
      const harness = createRegressionHandler(
        { providerName: 'mock', processTextMessage, processImageMessage: vi.fn() },
        false,
        ISSUE_173_CATEGORIES
      );

      await harness.handler.handleIncomingUserMessage(textEvent('riwayat beli wifi'));

      expect(harness.registry.execute).not.toHaveBeenCalled();
      expect(harness.gateway.sendMessage).toHaveBeenCalledWith(
        'whatsapp',
        'chat-reg',
        expect.stringContaining('tidak ditemukan dalam daftar kategori')
      );
      expect(harness.gateway.sendMessage).not.toHaveBeenCalledWith(
        'whatsapp',
        'chat-reg',
        expect.stringContaining('Menampilkan riwayat transaksi pengeluaran')
      );
    });

    it('fails closed when semantic fallback proposes non-TRANSACTION_HISTORY action for deferred history', async () => {
      const processTextMessage = vi.fn().mockResolvedValue({
        action: 'CHECK_BALANCE',
        explanation: 'Berikut adalah saldo Anda.',
      });
      const harness = createRegressionHandler(
        { providerName: 'mock', processTextMessage, processImageMessage: vi.fn() },
        false
      );

      await harness.handler.handleIncomingUserMessage(textEvent('riwayat ayam'));

      expect(harness.registry.execute).not.toHaveBeenCalled();
      expect(harness.gateway.sendMessage).toHaveBeenCalledWith(
        'whatsapp',
        'chat-reg',
        expect.stringContaining('tidak ditemukan dalam daftar kategori')
      );
    });

    it('preserves expense intent from purchase-description queries (riwayat beli vps)', async () => {
      const processTextMessage = vi.fn().mockResolvedValue({
        action: 'TRANSACTION_HISTORY',
        queryOptions: { searchQuery: 'vps' },
      });
      const harness = createRegressionHandler(
        { providerName: 'mock', processTextMessage, processImageMessage: vi.fn() },
        false
      );

      await harness.handler.handleIncomingUserMessage(textEvent('riwayat beli vps'));

      expect(harness.registry.execute).toHaveBeenCalledWith(expect.objectContaining({
        action: 'TRANSACTION_HISTORY',
        queryOptions: expect.objectContaining({
          searchQuery: 'vps',
          recordType: 'expense',
        }),
      }));
    });
  });
});

