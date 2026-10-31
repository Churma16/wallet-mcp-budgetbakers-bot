import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { CategoryContextService } from '../src/brain/category/categoryContext.js';
import { UserMessageHandler } from '../src/core/dispatcher.js';
import { PendingTransactionService } from '../src/core/pending.js';
import { WalletMcpRequestError } from '../src/wallet/index.js';
import { IncomingUserMessageEvent } from '../src/gateway/index.js';
import { CreateRecordInputPayload, WalletAccountItem, WalletCategoryItem } from '../src/types/walletTypes.js';
import { setActiveLanguage } from '../src/i18n/index.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

class MockMessagingGateway {
  public readonly messages: Array<{ channel: string; chatId: string; content: string }> = [];

  async sendTypingPresence(): Promise<void> {}
  async clearTypingPresence(): Promise<void> {}

  async sendMessage(channel: string, chatId: string, content: string): Promise<void> {
    this.messages.push({ channel, chatId, content });
  }
}

class MockWalletMcpClient {
  public readonly calls: CreateRecordInputPayload[][] = [];
  private nextFailure: Error | null = null;

  failNextDefinitively(message: string = 'definitive MCP failure'): void {
    this.nextFailure = new WalletMcpRequestError(message, 'DEFINITIVE_FAILURE');
  }

  async createRecords(records: CreateRecordInputPayload[]): Promise<Record<string, unknown>> {
    this.calls.push(records.map(record => ({ ...record })));
    const configuredFailure = this.nextFailure;
    this.nextFailure = null;
    if (configuredFailure) {
      throw configuredFailure;
    }
    return {};
  }

  async fetchBudgets(): Promise<never[]> {
    return [];
  }
}

class MockWalletCacheService {
  constructor(
    private readonly accounts: WalletAccountItem[],
    private readonly categories: WalletCategoryItem[]
  ) {}

  getAccounts(): WalletAccountItem[] {
    return this.accounts;
  }

  getCategories(): WalletCategoryItem[] {
    return this.categories;
  }

  async refreshAccounts(): Promise<WalletAccountItem[]> {
    return this.accounts;
  }
}

class MockFinancialAiProvider {
  public readonly providerName = 'mock';
  public textCalls = 0;

  constructor(private readonly intent: Record<string, unknown>) {}

  async processTextMessage(): Promise<Record<string, unknown>> {
    this.textCalls++;
    return this.intent;
  }

  async processImageMessage(): Promise<Record<string, unknown>> {
    return this.intent;
  }
}

class MockPendingActionHandler {
  async handlePendingAction(): Promise<boolean> {
    return false;
  }
}

class MockFastPathHandler {
  async handleFastPath(): Promise<boolean> {
    return false;
  }
}

const mockAccounts: WalletAccountItem[] = [
  { id: 'acc-bca', name: 'BCA', currency: 'IDR' },
  { id: 'acc-cash', name: 'Cash', currency: 'IDR' },
];

const mockCategories: WalletCategoryItem[] = [
  { id: 'cat-kesehatan', name: 'Kesehatan & Medis' },
  { id: 'cat-makanan', name: 'Makanan & Minuman' },
  { id: 'cat-belanja', name: 'Belanja' },
];

function createEvent(textPayload: string): IncomingUserMessageEvent {
  return {
    channel: 'whatsapp',
    senderIdentifier: '+628123456789',
    chatIdentifier: '+628123456789',
    messageType: 'text',
    textPayload,
  };
}

describe('Category Clarification and Auto Mode', () => {
  let pendingManager: PendingTransactionService;
  let gateway: MockMessagingGateway;
  let mcpClient: MockWalletMcpClient;
  let cache: MockWalletCacheService;

  beforeEach(() => {
    setActiveLanguage('id');
    pendingManager = new PendingTransactionService();
    gateway = new MockMessagingGateway();
    mcpClient = new MockWalletMcpClient();
    cache = new MockWalletCacheService(mockAccounts, mockCategories);
  });

  afterEach(() => {
    setActiveLanguage('id');
  });

  it('Suite 1: Unrecognized category creates clarification draft in ask mode and numeric choice finalizes it', async () => {
    const aiProvider = new MockFinancialAiProvider({
      action: 'CREATE_RECORD',
      records: [
        {
          accountId: 'acc-bca',
          amount: -50000,
          recordDate: '2026-09-10T12:00:00+07:00',
          categoryHint: 'obat',
          note: 'Beli paracetamol',
        },
      ],
    });

    const handler = new UserMessageHandler(
      gateway as any,
      pendingManager,
      new MockPendingActionHandler() as any,
      new MockFastPathHandler() as any,
      aiProvider as any,
      cache as any,
      mcpClient as any,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'ask'
    );

    await handler.handleIncomingUserMessage(createEvent('Beli paracetamol 50rb cat:obat'));

    expect(mcpClient.calls.length).toBe(0);
    expect(gateway.messages.length).toBe(1);
    expect(gateway.messages[0].content).toContain('obat');
    expect(gateway.messages[0].content).toContain('1. Kesehatan & Medis');

    const draft = pendingManager.getLatestPendingCategorySelectionDraft('whatsapp', '+628123456789', '+628123456789');
    expect(draft).toBeDefined();
    expect(draft?.categoryHint).toBe('obat');

    // User replies with choice 1
    await handler.handleIncomingUserMessage(createEvent('1'));

    expect(mcpClient.calls.length).toBe(1);
    expect(mcpClient.calls[0][0].categoryId).toBe('cat-kesehatan');
    expect(mcpClient.calls[0][0].amount).toBe(-50000);

    const afterDraft = pendingManager.getLatestPendingCategorySelectionDraft('whatsapp', '+628123456789', '+628123456789');
    expect(afterDraft).toBeUndefined();
  });

  it('Suite 2: Replying with category name finalizes the draft', async () => {
    const aiProvider = new MockFinancialAiProvider({
      action: 'CREATE_RECORD',
      records: [
        {
          accountId: 'acc-bca',
          amount: -35000,
          recordDate: '2026-09-10T12:00:00+07:00',
          categoryHint: 'vitamin',
          note: 'Beli vitamin C',
        },
      ],
    });

    const handler = new UserMessageHandler(
      gateway as any,
      pendingManager,
      new MockPendingActionHandler() as any,
      new MockFastPathHandler() as any,
      aiProvider as any,
      cache as any,
      mcpClient as any,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'ask'
    );

    await handler.handleIncomingUserMessage(createEvent('Beli vitamin C 35rb cat:vitamin'));
    expect(gateway.messages.length).toBe(1);

    // User replies with the category name directly
    await handler.handleIncomingUserMessage(createEvent('Kesehatan & Medis'));

    expect(mcpClient.calls.length).toBe(1);
    expect(mcpClient.calls[0][0].categoryId).toBe('cat-kesehatan');
  });

  it('Suite 3: Invalid selection keeps the draft pending and delivers retry prompt', async () => {
    const aiProvider = new MockFinancialAiProvider({
      action: 'CREATE_RECORD',
      records: [
        {
          accountId: 'acc-bca',
          amount: -25000,
          recordDate: '2026-09-10T12:00:00+07:00',
          categoryHint: 'antiseptik',
          note: 'Betadine',
        },
      ],
    });

    const handler = new UserMessageHandler(
      gateway as any,
      pendingManager,
      new MockPendingActionHandler() as any,
      new MockFastPathHandler() as any,
      aiProvider as any,
      cache as any,
      mcpClient as any,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'ask'
    );

    await handler.handleIncomingUserMessage(createEvent('Betadine 25rb cat:antiseptik'));
    expect(gateway.messages.length).toBe(1);

    // User replies with invalid number
    await handler.handleIncomingUserMessage(createEvent('99'));

    expect(mcpClient.calls.length).toBe(0);
    expect(gateway.messages.length).toBe(2);
    expect(gateway.messages[1].content).toContain('tidak valid');

    const draft = pendingManager.getLatestPendingCategorySelectionDraft('whatsapp', '+628123456789', '+628123456789');
    expect(draft).toBeDefined();
  });

  it('Suite 4: Cancellation discards the draft without writing to Wallet', async () => {
    const aiProvider = new MockFinancialAiProvider({
      action: 'CREATE_RECORD',
      records: [
        {
          accountId: 'acc-bca',
          amount: -15000,
          recordDate: '2026-09-10T12:00:00+07:00',
          categoryHint: 'perban',
          note: 'Kasa perban',
        },
      ],
    });

    const handler = new UserMessageHandler(
      gateway as any,
      pendingManager,
      new MockPendingActionHandler() as any,
      new MockFastPathHandler() as any,
      aiProvider as any,
      cache as any,
      mcpClient as any,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'ask'
    );

    await handler.handleIncomingUserMessage(createEvent('Kasa perban 15rb cat:perban'));
    expect(gateway.messages.length).toBe(1);

    // User replies with 'batal'
    await handler.handleIncomingUserMessage(createEvent('batal'));

    expect(mcpClient.calls.length).toBe(0);
    expect(gateway.messages.length).toBe(2);
    expect(gateway.messages[1].content).toContain('dibatalkan');

    const draft = pendingManager.getLatestPendingCategorySelectionDraft('whatsapp', '+628123456789', '+628123456789');
    expect(draft).toBeUndefined();
  });

  it('Suite 5: Auto mode automatically matches and creates record without prompt', async () => {
    const aiProvider = new MockFinancialAiProvider({
      action: 'CREATE_RECORD',
      records: [
        {
          accountId: 'acc-bca',
          amount: -75000,
          recordDate: '2026-09-10T12:00:00+07:00',
          categoryHint: 'obat',
          note: 'Beli obat flu',
        },
      ],
    });

    const handler = new UserMessageHandler(
      gateway as any,
      pendingManager,
      new MockPendingActionHandler() as any,
      new MockFastPathHandler() as any,
      aiProvider as any,
      cache as any,
      mcpClient as any,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'auto'
    );

    await handler.handleIncomingUserMessage(createEvent('Beli obat flu 75rb cat:obat'));

    // In auto mode, record should be immediately dispatched to MCP with the best category!
    expect(mcpClient.calls.length).toBe(1);
    expect(mcpClient.calls[0][0].categoryId).toBe('cat-kesehatan');
    expect(mcpClient.calls[0][0].amount).toBe(-75000);

    // No clarification prompt was sent to the user
    expect(gateway.messages.length).toBe(1);
    expect(gateway.messages[0].content).not.toContain('Pilih kategori yang sesuai');

    const draft = pendingManager.getLatestPendingCategorySelectionDraft('whatsapp', '+628123456789', '+628123456789');
    expect(draft).toBeUndefined();
  });

  it('Suite 6: Definitive MCP failure keeps draft retryable', async () => {
    const aiProvider = new MockFinancialAiProvider({
      action: 'CREATE_RECORD',
      records: [
        {
          accountId: 'acc-bca',
          amount: -50000,
          recordDate: '2026-09-10T12:00:00+07:00',
          categoryHint: 'obat',
          note: 'Beli obat',
        },
      ],
    });

    const handler = new UserMessageHandler(
      gateway as any,
      pendingManager,
      new MockPendingActionHandler() as any,
      new MockFastPathHandler() as any,
      aiProvider as any,
      cache as any,
      mcpClient as any,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'ask'
    );

    await handler.handleIncomingUserMessage(createEvent('Beli obat 50rb cat:obat'));
    expect(gateway.messages.length).toBe(1);

    // Force MCP client failure
    mcpClient.failNextDefinitively('Wallet MCP database error');

    await handler.handleIncomingUserMessage(createEvent('1'));

    // Should inform the user of failure while preserving the draft
    expect(gateway.messages.length).toBe(2);
    expect(gateway.messages[1].content).toContain('Gagal');

    const draft = pendingManager.getLatestPendingCategorySelectionDraft('whatsapp', '+628123456789', '+628123456789');
    expect(draft).toBeDefined();

    // Retrying choice 1 now succeeds
    await handler.handleIncomingUserMessage(createEvent('1'));
    expect(mcpClient.calls.length).toBe(2);
  });
  it('Suite 7: Flexible numeric replies like #1 and 1. finalize the draft', async () => {
    const aiProvider = new MockFinancialAiProvider({
      action: 'CREATE_RECORD',
      records: [
        {
          accountId: 'acc-bca',
          amount: -50000,
          recordDate: '2026-09-10T12:00:00+07:00',
          categoryHint: 'obat',
          note: 'Beli obat',
        },
      ],
    });

    const handler = new UserMessageHandler(
      gateway as any,
      pendingManager,
      new MockPendingActionHandler() as any,
      new MockFastPathHandler() as any,
      aiProvider as any,
      cache as any,
      mcpClient as any,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'ask'
    );

    await handler.handleIncomingUserMessage(createEvent('Beli obat 50rb cat:obat'));
    expect(gateway.messages.length).toBe(1);

    // User replies with '#1'
    await handler.handleIncomingUserMessage(createEvent('#1'));
    expect(mcpClient.calls.length).toBe(1);
    expect(mcpClient.calls[0][0].categoryId).toBe('cat-kesehatan');
  });

  it('Suite 8: Reply routing prioritizes newer category draft over older account draft', async () => {
    const accountProvider = new MockFinancialAiProvider({
      action: 'CREATE_RECORD',
      records: [
        {
          amount: -20000,
          recordDate: '2026-09-10T12:00:00+07:00',
          categoryId: 'cat-makanan',
          note: 'Makan',
        },
      ],
    });

    const handler = new UserMessageHandler(
      gateway as any,
      pendingManager,
      new MockPendingActionHandler() as any,
      new MockFastPathHandler() as any,
      accountProvider as any,
      cache as any,
      mcpClient as any,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'ask'
    );

    // 1. First transaction creates an account clarification draft (#1)
    await handler.handleIncomingUserMessage(createEvent('Makan 20rb'));
    const accountDraft = pendingManager.getLatestPendingAccountSelectionDraft('whatsapp', '+628123456789', '+628123456789');
    expect(accountDraft).toBeDefined();

    // 2. Second transaction creates a category clarification draft (#2)
    const categoryDraft = pendingManager.addPendingCategorySelectionDraft({
      sourceType: 'USER',
      channel: 'whatsapp',
      senderIdentifier: '+628123456789',
      chatIdentifier: '+628123456789',
      records: [
        {
          accountId: 'acc-bca',
          amount: -50000,
          recordDate: '2026-09-10T12:00:00+07:00',
          categoryHint: 'obat',
          note: 'Beli obat',
        },
      ],
      pendingRecordIndex: 0,
      categoryHint: 'obat',
      candidateCategories: [{ id: 'cat-kesehatan', name: 'Kesehatan & Medis' }],
    });
    expect(categoryDraft.ticketId).toBeGreaterThan(accountDraft!.ticketId);

    // 3. User replies '1' - it must resolve the NEWER category draft, not hijack the account draft!
    await handler.handleIncomingUserMessage(createEvent('1'));

    expect(mcpClient.calls.length).toBe(1);
    expect(mcpClient.calls[0][0].categoryId).toBe('cat-kesehatan');
    expect(mcpClient.calls[0][0].accountId).toBe('acc-bca');
  });

  it('Suite 9: Mixed unresolved entity batch fails validation safely without silently dropping records', async () => {
    const mixedProvider = new MockFinancialAiProvider({
      action: 'CREATE_RECORD',
      records: [
        {
          // Missing account
          amount: -20000,
          recordDate: '2026-09-10T12:00:00+07:00',
          categoryId: 'cat-makanan',
          note: 'Makan',
        },
        {
          // Unresolved category
          accountId: 'acc-bca',
          amount: -50000,
          recordDate: '2026-09-10T12:00:00+07:00',
          categoryHint: 'obat',
          note: 'Beli obat',
        },
      ],
    });

    const handler = new UserMessageHandler(
      gateway as any,
      pendingManager,
      new MockPendingActionHandler() as any,
      new MockFastPathHandler() as any,
      mixedProvider as any,
      cache as any,
      mcpClient as any,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'ask'
    );

    await handler.handleIncomingUserMessage(createEvent('Makan 20rb dan Beli obat 50rb'));

    // Because entities are mixed, it should reject safely instead of dropping record 0
    expect(mcpClient.calls.length).toBe(0);
    expect(gateway.messages.length).toBe(1);
    expect(gateway.messages[0].content).toContain('tidak ditemukan');
  });

  it('Suite 10: Dynamic categoryResolutionMode from CategoryContextService and env override', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'category-context-override-'));
    const configPath = path.join(tempDir, 'category-context.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        version: '1.0',
        settings: { categoryResolutionMode: 'auto' },
      }),
      'utf8'
    );

    const contextService = new CategoryContextService(configPath);

    const aiProvider = new MockFinancialAiProvider({
      action: 'CREATE_RECORD',
      records: [
        {
          accountId: 'acc-bca',
          amount: -30000,
          recordDate: '2026-09-10T12:00:00+07:00',
          categoryHint: 'obat',
          note: 'Paracetamol',
        },
      ],
    });

    try {
      delete process.env.CATEGORY_RESOLUTION_MODE;

      // 1. When categoryResolutionMode is not explicitly passed to UserMessageHandler,
      // it delegates resolution to CategoryContextService which resolves 'auto' from settings JSON
      const handlerWithService = new UserMessageHandler(
        gateway as any,
        pendingManager,
        new MockPendingActionHandler() as any,
        new MockFastPathHandler() as any,
        aiProvider as any,
        cache as any,
        mcpClient as any,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        contextService
      );

      await handlerWithService.handleIncomingUserMessage(createEvent('Paracetamol 30rb cat:obat'));
      expect(mcpClient.calls.length).toBe(1);
      expect(mcpClient.calls[0][0].categoryId).toBe('cat-kesehatan');

      // 2. Env override takes priority: if CATEGORY_RESOLUTION_MODE='ask', it overrides JSON 'auto'
      process.env.CATEGORY_RESOLUTION_MODE = 'ask';
      mcpClient.calls = [];
      gateway.messages = [];

      await handlerWithService.handleIncomingUserMessage(createEvent('Amoxicillin 25rb cat:obat'));
      // Should now prompt instead of auto-matching
      expect(mcpClient.calls.length).toBe(0);
      expect(gateway.messages.length).toBe(1);
      expect(gateway.messages[0].content).toContain('Pilih kategori yang sesuai');
    } finally {
      delete process.env.CATEGORY_RESOLUTION_MODE;
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});