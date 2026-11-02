import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ModifyRecordHandler } from '../src/core/handlers/modifyRecordHandler.js';
import { TransactionMessageStore } from '../src/wallet/records/transactionMessageStore.js';
import type { WalletCacheService, WalletMcpClientService, WalletCategoryItem, WalletAccountItem } from '../src/wallet/index.js';
import type { MessagingGatewayService, IncomingUserMessageEvent } from '../src/gateway/index.js';

describe('ModifyRecordHandler', () => {
  let mockClient: WalletMcpClientService;
  let mockCache: WalletCacheService;
  let mockGateway: MessagingGatewayService;
  let store: TransactionMessageStore;
  let handler: ModifyRecordHandler;

  const sampleAccounts: WalletAccountItem[] = [
    { id: 'acc-bca', name: 'Jago Expense', balance: 500000, currency: 'IDR' },
    { id: 'acc-mandiri', name: 'Mandiri Checking', balance: 1000000, currency: 'IDR' },
    { id: 'acc-sync', name: 'BCA Bank Sync', balance: 2000000, currency: 'IDR', isBankSynced: true },
    { id: 'acc-usd', name: 'USD Savings', balance: 100, currency: 'USD' },
  ];

  const sampleCategories: WalletCategoryItem[] = [
    { id: 'cat-food', name: 'Makanan & Minuman', group: { id: 'food', name: 'Food' }, isAssignable: true },
    { id: 'cat-transport', name: 'Transportasi', group: { id: 'transport', name: 'Transport' }, isAssignable: true },
    { id: 'cat-uncat', name: 'Uncategorized', group: { id: 'system_categories', name: 'System' }, isAssignable: false },
  ];

  beforeEach(() => {
    mockClient = {
      patchRecords: vi.fn(async () => ({
        summary: { total: 1, succeeded: 1 },
        results: [{ id: 'rec-101', inputIndex: 0, success: true }],
      })),
      createLabel: vi.fn(async (name: string) => ({
        id: `lbl-${name.toLowerCase()}`,
        name,
      })),
    } as unknown as WalletMcpClientService;

    mockCache = {
      getAccounts: vi.fn(() => sampleAccounts),
      getCategories: vi.fn(() => sampleCategories),
      findLabelByName: vi.fn((nameHint: string) => {
        if (nameHint.toLowerCase() === 'jajan') {
          return { id: 'lbl-jajan', name: 'jajan' };
        }
        return undefined;
      }),
      isLabelsLoaded: vi.fn(() => true),
      addLabelToCache: vi.fn(),
    } as unknown as WalletCacheService;

    mockGateway = {
      sendMessage: vi.fn(async () => ({ messageId: 'reply-1' })),
    } as unknown as MessagingGatewayService;

    store = new TransactionMessageStore();

    handler = new ModifyRecordHandler(
      mockClient,
      mockCache,
      mockGateway,
      store
    );
  });

  it('ignores non-reply messages or messages without text', async () => {
    const event: IncomingUserMessageEvent = {
      channel: 'telegram',
      senderIdentifier: 'user-1',
      chatIdentifier: 'chat-1',
      messageType: 'text',
      textPayload: 'c: Makan',
    };

    const handled = await handler.handleModifyRecordReply(event, Date.now());
    expect(handled).toBe(false);
    expect(mockClient.patchRecords).not.toHaveBeenCalled();
  });

  it('ignores replies that do not match edit command patterns', async () => {
    const event: IncomingUserMessageEvent = {
      channel: 'telegram',
      senderIdentifier: 'user-1',
      chatIdentifier: 'chat-1',
      messageType: 'text',
      textPayload: 'terima kasih bot',
      replyToMessageId: 'bot-msg-1',
    };

    const handled = await handler.handleModifyRecordReply(event, Date.now());
    expect(handled).toBe(false);
    expect(mockClient.patchRecords).not.toHaveBeenCalled();
  });

  it('successfully patches a recorded transaction on reply with auto-capitalized title and formatted receipt response', async () => {
    store.recordMessageMapping('bot-msg-1', {
      recordId: 'rec-101',
      accountId: 'acc-bca',
      note: 'Tahu Goreng',
      categoryId: 'cat-food',
      amount: -50000,
      recordDate: '2026-11-01T16:49:00.000Z',
    });

    const event: IncomingUserMessageEvent = {
      channel: 'telegram',
      senderIdentifier: 'user-1',
      chatIdentifier: 'chat-1',
      messageType: 'text',
      textPayload: 'n: tahu risol',
      replyToMessageId: 'bot-msg-1',
    };

    const handled = await handler.handleModifyRecordReply(event, Date.now());
    expect(handled).toBe(true);

    // Verifies Smart Title Casing auto-capitalization: 'tahu risol' -> 'Tahu Risol'
    expect(mockClient.patchRecords).toHaveBeenCalledWith([
      {
        id: 'rec-101',
        note: 'Tahu Risol',
      },
    ]);

    expect(mockGateway.sendMessage).toHaveBeenCalledTimes(1);
    const sentMessage = (mockGateway.sendMessage as any).mock.calls[0][2];
    
    // Verifies receipt card format requested by user
    expect(sentMessage).toContain('✅ Transaksi berhasil diperbarui:');
    expect(sentMessage).toContain('Tahu Risol');
    expect(sentMessage).toContain('💸 Rp 50.000  •  Jago Expense');
    expect(sentMessage).toContain('🏷️ Makanan & Minuman');
    // No tags were present, so no 🔖 line
    expect(sentMessage).not.toContain('🔖');
  });

  it('displays 🔖 tags line if tags are present or edited, and hides 🔖 if no tags', async () => {
    store.recordMessageMapping('bot-msg-tags', {
      recordId: 'rec-102',
      accountId: 'acc-bca',
      note: 'Kopi Susu',
      categoryId: 'cat-food',
      amount: -25000,
    });

    const event: IncomingUserMessageEvent = {
      channel: 'telegram',
      senderIdentifier: 'user-1',
      chatIdentifier: 'chat-1',
      messageType: 'text',
      textPayload: 't: #jajan, #kopi',
      replyToMessageId: 'bot-msg-tags',
    };

    const handled = await handler.handleModifyRecordReply(event, Date.now());
    expect(handled).toBe(true);

    const sentMessage = (mockGateway.sendMessage as any).mock.calls[0][2];
    expect(sentMessage).toContain('✅ Transaksi berhasil diperbarui:');
    expect(sentMessage).toContain('🔖 #jajan #kopi');
  });

  it('supports explicit prefix `e` on reply', async () => {
    store.recordMessageMapping('bot-msg-2', {
      recordId: 'rec-202',
      accountId: 'acc-bca',
    });

    const event: IncomingUserMessageEvent = {
      channel: 'telegram',
      senderIdentifier: 'user-1',
      chatIdentifier: 'chat-1',
      messageType: 'text',
      textPayload: 'e c: Transportasi n: bensin motor',
      replyToMessageId: 'bot-msg-2',
    };

    const handled = await handler.handleModifyRecordReply(event, Date.now());
    expect(handled).toBe(true);

    expect(mockClient.patchRecords).toHaveBeenCalledWith([
      {
        id: 'rec-202',
        categoryId: 'cat-transport',
        note: 'Bensin Motor',
      },
    ]);
  });

  it('preserves negative sign for expenses when amount is edited without explicit plus sign', async () => {
    store.recordMessageMapping('bot-msg-exp', {
      recordId: 'rec-exp-1',
      accountId: 'acc-bca',
      amount: -50000,
    });

    const event: IncomingUserMessageEvent = {
      channel: 'telegram',
      senderIdentifier: 'user-1',
      chatIdentifier: 'chat-1',
      messageType: 'text',
      textPayload: 'a: 35000',
      replyToMessageId: 'bot-msg-exp',
    };

    const handled = await handler.handleModifyRecordReply(event, Date.now());
    expect(handled).toBe(true);

    expect(mockClient.patchRecords).toHaveBeenCalledWith([
      {
        id: 'rec-exp-1',
        amount: -35000,
      },
    ]);
  });

  it('allows explicit positive sign on existing expense to convert it to income', async () => {
    store.recordMessageMapping('bot-msg-exp2', {
      recordId: 'rec-exp-2',
      accountId: 'acc-bca',
      amount: -50000,
    });

    const event: IncomingUserMessageEvent = {
      channel: 'telegram',
      senderIdentifier: 'user-1',
      chatIdentifier: 'chat-1',
      messageType: 'text',
      textPayload: 'a: +75000',
      replyToMessageId: 'bot-msg-exp2',
    };

    const handled = await handler.handleModifyRecordReply(event, Date.now());
    expect(handled).toBe(true);

    expect(mockClient.patchRecords).toHaveBeenCalledWith([
      {
        id: 'rec-exp-2',
        amount: 75000,
      },
    ]);
  });

  it('rejects zero amount update with human warning', async () => {
    store.recordMessageMapping('bot-msg-zero', {
      recordId: 'rec-zero',
      accountId: 'acc-bca',
      amount: -50000,
    });

    const event: IncomingUserMessageEvent = {
      channel: 'telegram',
      senderIdentifier: 'user-1',
      chatIdentifier: 'chat-1',
      messageType: 'text',
      textPayload: 'a: 0',
      replyToMessageId: 'bot-msg-zero',
    };

    const handled = await handler.handleModifyRecordReply(event, Date.now());
    expect(handled).toBe(true);
    expect(mockClient.patchRecords).not.toHaveBeenCalled();

    const sentMessage = (mockGateway.sendMessage as any).mock.calls[0][2];
    expect(sentMessage).toContain('Nominal transaksi tidak boleh bernilai 0');
  });

  it('supports chained edits by recording the new confirmation message ID', async () => {
    store.recordMessageMapping('initial-bot-msg', {
      recordId: 'rec-chain-1',
      accountId: 'acc-bca',
      amount: -20000,
    });

    (mockGateway.sendMessage as any).mockResolvedValueOnce({ messageId: 'confirmation-msg-1' });

    // 1st Edit
    const event1: IncomingUserMessageEvent = {
      channel: 'telegram',
      senderIdentifier: 'user-1',
      chatIdentifier: 'chat-1',
      messageType: 'text',
      textPayload: 'c: Transportasi',
      replyToMessageId: 'initial-bot-msg',
    };
    await handler.handleModifyRecordReply(event1, Date.now());

    // 2nd Edit: user replies to confirmation-msg-1
    const chainedMapping = store.getMessageMapping('confirmation-msg-1');
    expect(chainedMapping).toBeDefined();
    expect(chainedMapping?.recordId).toBe('rec-chain-1');
    expect(chainedMapping?.categoryName).toBe('Transportasi');

    const event2: IncomingUserMessageEvent = {
      channel: 'telegram',
      senderIdentifier: 'user-1',
      chatIdentifier: 'chat-1',
      messageType: 'text',
      textPayload: 'n: bensin shell',
      replyToMessageId: 'confirmation-msg-1',
    };
    const handled2 = await handler.handleModifyRecordReply(event2, Date.now());
    expect(handled2).toBe(true);
    expect(mockClient.patchRecords).toHaveBeenCalledWith([
      {
        id: 'rec-chain-1',
        note: 'Bensin Shell',
      },
    ]);
  });

  it('sends not-found error if reply references an unknown or expired message ID', async () => {
    const event: IncomingUserMessageEvent = {
      channel: 'telegram',
      senderIdentifier: 'user-1',
      chatIdentifier: 'chat-1',
      messageType: 'text',
      textPayload: 'c: Makanan',
      replyToMessageId: 'unknown-msg-id',
    };

    const handled = await handler.handleModifyRecordReply(event, Date.now());
    expect(handled).toBe(true);
    expect(mockClient.patchRecords).not.toHaveBeenCalled();

    const sentMessage = (mockGateway.sendMessage as any).mock.calls[0][2];
    expect(sentMessage).toContain('tidak ditemukan atau pesan yang dibalas sudah kedaluwarsa');
  });

  it('rejects unassignable or non-existent categories', async () => {
    store.recordMessageMapping('bot-msg-3', {
      recordId: 'rec-303',
      accountId: 'acc-bca',
    });

    const event: IncomingUserMessageEvent = {
      channel: 'telegram',
      senderIdentifier: 'user-1',
      chatIdentifier: 'chat-1',
      messageType: 'text',
      textPayload: 'c: KategoriGaib',
      replyToMessageId: 'bot-msg-3',
    };

    const handled = await handler.handleModifyRecordReply(event, Date.now());
    expect(handled).toBe(true);
    expect(mockClient.patchRecords).not.toHaveBeenCalled();

    const sentMessage = (mockGateway.sendMessage as any).mock.calls[0][2];
    expect(sentMessage).toContain('tidak ditemukan atau tidak dapat digunakan');
  });

  it('handles MCP patch failure and informs user', async () => {
    store.recordMessageMapping('bot-msg-4', {
      recordId: 'rec-404',
      accountId: 'acc-bca',
    });

    (mockClient.patchRecords as any).mockRejectedValueOnce(new Error('records.update scope missing'));

    const event: IncomingUserMessageEvent = {
      channel: 'telegram',
      senderIdentifier: 'user-1',
      chatIdentifier: 'chat-1',
      messageType: 'text',
      textPayload: 'n: Catatan baru',
      replyToMessageId: 'bot-msg-4',
    };

    const handled = await handler.handleModifyRecordReply(event, Date.now());
    expect(handled).toBe(true);

    const sentMessage = (mockGateway.sendMessage as any).mock.calls[0][2];
    expect(sentMessage).toContain('Gagal memperbarui transaksi');
    expect(sentMessage).toContain('records.update scope missing');
  });

  describe('Account Moving Capabilities (Issue #261)', () => {
    it('successfully moves a record to another account sharing the same currency', async () => {
      store.recordMessageMapping('msg-move-1', {
        recordId: 'rec-move-1',
        accountId: 'acc-bca',
        accountName: 'Jago Expense',
        currency: 'IDR',
        note: 'Belanja Supermarket',
        amount: -150000,
      });

      const event: IncomingUserMessageEvent = {
        channel: 'telegram',
        senderIdentifier: 'user-1',
        chatIdentifier: 'chat-1',
        messageType: 'text',
        textPayload: 'rek: Mandiri Checking',
        replyToMessageId: 'msg-move-1',
      };

      const handled = await handler.handleModifyRecordReply(event, Date.now());
      expect(handled).toBe(true);

      expect(mockClient.patchRecords).toHaveBeenCalledWith([
        {
          id: 'rec-move-1',
          accountId: 'acc-mandiri',
        },
      ]);

      const sentMessage = (mockGateway.sendMessage as any).mock.calls[0][2];
      expect(sentMessage).toContain('✅ Transaksi berhasil diperbarui:');
      expect(sentMessage).toContain('🏦 Akun dipindahkan dari: Jago Expense ➔ Mandiri Checking');

      const updated = store.getMessageMapping('msg-move-1');
      expect(updated?.accountId).toBe('acc-mandiri');
      expect(updated?.accountName).toBe('Mandiri Checking');
    });

    it('rejects moving when source account is bank-synced', async () => {
      store.recordMessageMapping('msg-sync-src', {
        recordId: 'rec-sync-1',
        accountId: 'acc-sync',
        accountName: 'BCA Bank Sync',
        currency: 'IDR',
      });

      const event: IncomingUserMessageEvent = {
        channel: 'telegram',
        senderIdentifier: 'user-1',
        chatIdentifier: 'chat-1',
        messageType: 'text',
        textPayload: 'rek: Mandiri Checking',
        replyToMessageId: 'msg-sync-src',
      };

      const handled = await handler.handleModifyRecordReply(event, Date.now());
      expect(handled).toBe(true);
      expect(mockClient.patchRecords).not.toHaveBeenCalled();

      const sentMessage = (mockGateway.sendMessage as any).mock.calls[0][2];
      expect(sentMessage).toContain('Transaksi pada akun bank-sync (BCA Bank Sync) tidak dapat dipindahkan');
    });

    it('rejects moving when target account is bank-synced', async () => {
      store.recordMessageMapping('msg-sync-dest', {
        recordId: 'rec-dest-1',
        accountId: 'acc-bca',
        accountName: 'Jago Expense',
        currency: 'IDR',
      });

      const event: IncomingUserMessageEvent = {
        channel: 'telegram',
        senderIdentifier: 'user-1',
        chatIdentifier: 'chat-1',
        messageType: 'text',
        textPayload: 'rek: BCA Bank Sync',
        replyToMessageId: 'msg-sync-dest',
      };

      const handled = await handler.handleModifyRecordReply(event, Date.now());
      expect(handled).toBe(true);
      expect(mockClient.patchRecords).not.toHaveBeenCalled();

      const sentMessage = (mockGateway.sendMessage as any).mock.calls[0][2];
      expect(sentMessage).toContain('Tidak dapat memindahkan transaksi ke akun bank-sync (BCA Bank Sync)');
    });

    it('rejects moving when currencies do not match', async () => {
      store.recordMessageMapping('msg-curr-diff', {
        recordId: 'rec-curr-1',
        accountId: 'acc-bca',
        accountName: 'Jago Expense',
        currency: 'IDR',
      });

      const event: IncomingUserMessageEvent = {
        channel: 'telegram',
        senderIdentifier: 'user-1',
        chatIdentifier: 'chat-1',
        messageType: 'text',
        textPayload: 'rek: USD Savings',
        replyToMessageId: 'msg-curr-diff',
      };

      const handled = await handler.handleModifyRecordReply(event, Date.now());
      expect(handled).toBe(true);
      expect(mockClient.patchRecords).not.toHaveBeenCalled();

      const sentMessage = (mockGateway.sendMessage as any).mock.calls[0][2];
      expect(sentMessage).toContain('Mata uang Jago Expense (IDR) berbeda dengan USD Savings (USD)');
    });

    it('rejects moving when target account is not found', async () => {
      store.recordMessageMapping('msg-acc-not-found', {
        recordId: 'rec-nf-1',
        accountId: 'acc-bca',
        accountName: 'Jago Expense',
        currency: 'IDR',
      });

      const event: IncomingUserMessageEvent = {
        channel: 'telegram',
        senderIdentifier: 'user-1',
        chatIdentifier: 'chat-1',
        messageType: 'text',
        textPayload: 'rek: AkunGaib',
        replyToMessageId: 'msg-acc-not-found',
      };

      const handled = await handler.handleModifyRecordReply(event, Date.now());
      expect(handled).toBe(true);
      expect(mockClient.patchRecords).not.toHaveBeenCalled();

      const sentMessage = (mockGateway.sendMessage as any).mock.calls[0][2];
      expect(sentMessage).toContain('Akun "AkunGaib" tidak ditemukan.');
    });

    it('rejects moving when target account hint is ambiguous', async () => {
      // Add a second Jago account to trigger ambiguity
      (mockCache.getAccounts as any).mockReturnValue([
        ...sampleAccounts,
        { id: 'acc-jago-2', name: 'Jago Savings', balance: 1000000, currency: 'IDR' },
      ]);

      store.recordMessageMapping('msg-acc-ambig', {
        recordId: 'rec-ambig-1',
        accountId: 'acc-mandiri',
        accountName: 'Mandiri Checking',
        currency: 'IDR',
      });

      const event: IncomingUserMessageEvent = {
        channel: 'telegram',
        senderIdentifier: 'user-1',
        chatIdentifier: 'chat-1',
        messageType: 'text',
        textPayload: 'rek: Jago',
        replyToMessageId: 'msg-acc-ambig',
      };

      const handled = await handler.handleModifyRecordReply(event, Date.now());
      expect(handled).toBe(true);
      expect(mockClient.patchRecords).not.toHaveBeenCalled();

      const sentMessage = (mockGateway.sendMessage as any).mock.calls[0][2];
      expect(sentMessage).toContain('Akun "Jago" ambigu: cocok dengan');
    });

    it('handles same-account move without redundant accountId in patch payload', async () => {
      store.recordMessageMapping('msg-same-acc', {
        recordId: 'rec-same-1',
        accountId: 'acc-bca',
        accountName: 'Jago Expense',
        currency: 'IDR',
        note: 'Old Note',
      });

      const event: IncomingUserMessageEvent = {
        channel: 'telegram',
        senderIdentifier: 'user-1',
        chatIdentifier: 'chat-1',
        messageType: 'text',
        textPayload: 'rek: Jago Expense n: New Note',
        replyToMessageId: 'msg-same-acc',
      };

      const handled = await handler.handleModifyRecordReply(event, Date.now());
      expect(handled).toBe(true);

      expect(mockClient.patchRecords).toHaveBeenCalledWith([
        {
          id: 'rec-same-1',
          note: 'New Note',
        },
      ]);
    });
  });

  describe('Field Clearing and Transfer Unlinking ($clear)', () => {
    it('clears note and tags via $clear and updates message store', async () => {
      store.recordMessageMapping('msg-clear-1', {
        recordId: 'rec-clear-1',
        accountId: 'acc-bca',
        note: 'Existing Note',
        labels: ['existing-tag'],
      });

      const event: IncomingUserMessageEvent = {
        channel: 'telegram',
        senderIdentifier: 'user-1',
        chatIdentifier: 'chat-1',
        messageType: 'text',
        textPayload: 'n: - t: -',
        replyToMessageId: 'msg-clear-1',
      };

      const handled = await handler.handleModifyRecordReply(event, Date.now());
      expect(handled).toBe(true);

      expect(mockClient.patchRecords).toHaveBeenCalledWith([
        {
          id: 'rec-clear-1',
          $clear: ['note', 'labelIds'],
        },
      ]);

      const sentMessage = (mockGateway.sendMessage as any).mock.calls[0][2];
      expect(sentMessage).toContain('🧹 Bidang dibersihkan: Catatan, Tag / Label');

      const updated = store.getMessageMapping('msg-clear-1');
      expect(updated?.note).toBeUndefined();
      expect(updated?.labels).toEqual([]);
    });

    it('unlinks transfer via $clear: ["transfer"] on natural command and unsets partnerRecordId', async () => {
      store.recordMessageMapping('msg-tf-1', {
        recordId: 'rec-tf-1',
        accountId: 'acc-bca',
        categoryId: 'cat-transfer-id',
        categoryName: 'Transfer',
        isTransfer: true,
        partnerRecordId: 'rec-tf-partner-999',
      });

      const event: IncomingUserMessageEvent = {
        channel: 'telegram',
        senderIdentifier: 'user-1',
        chatIdentifier: 'chat-1',
        messageType: 'text',
        textPayload: 'unlink transfer',
        replyToMessageId: 'msg-tf-1',
      };

      const handled = await handler.handleModifyRecordReply(event, Date.now());
      expect(handled).toBe(true);

      expect(mockClient.patchRecords).toHaveBeenCalledWith([
        {
          id: 'rec-tf-1',
          $clear: ['transfer'],
        },
      ]);

      const sentMessage = (mockGateway.sendMessage as any).mock.calls[0][2];
      expect(sentMessage).toContain('🧹 Bidang dibersihkan: Status Transfer');
      expect(sentMessage).toContain('🏷️ Umum');

      const updated = store.getMessageMapping('msg-tf-1');
      expect(updated?.isTransfer).toBe(false);
      expect(updated?.partnerRecordId).toBeUndefined();
    });
  });
});
