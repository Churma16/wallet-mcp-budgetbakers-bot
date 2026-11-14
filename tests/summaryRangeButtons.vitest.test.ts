import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createTelegramSummaryRangeKeyboard,
  SummaryRangeKey,
} from '../src/gateway/telegramMenu.js';
import {
  handleSummaryRangeCallback,
  SUMMARY_RANGE_TO_PERIOD,
} from '../src/core/summary/summaryRangeHandler.js';
import { calculateRelativeDateRange } from '../src/wallet/history/historyDateResolver.js';
import { extractHistoryQueryOptionsFromTokens } from '../src/brain/fastpath/fastPathTokens.js';
import { detectFastPathAction } from '../src/brain/index.js';
import { formatTransactionSummaryMessage } from '../src/wallet/formatters/transactionSummaryFormatter.js';
import { FinancialActionExecutor } from '../src/core/executor.js';
import { TelegramMessagingAdapter } from '../src/gateway/telegram.js';
import type { TransactionSummaryResult } from '../src/wallet/types.js';

describe('Transaction Summary Time Range Buttons & Top 5 Expenses', () => {
  describe('createTelegramSummaryRangeKeyboard', () => {
    it('creates a 2x2 inline keyboard with "1m" highlighted by default in Indonesian', () => {
      const keyboard = createTelegramSummaryRangeKeyboard('1m', 'id');
      const rows = keyboard.inline_keyboard;

      expect(rows.length).toBe(2);
      expect(rows[0].length).toBe(2);
      expect(rows[1].length).toBe(2);

      // Row 1: 1 Minggu | • 1 Bulan •
      expect(rows[0][0].text).toBe('1 Minggu');
      expect(rows[0][0].callback_data).toBe('sum:range:1w');
      expect(rows[0][1].text).toBe('• 1 Bulan •');
      expect(rows[0][1].callback_data).toBe('sum:range:1m');

      // Row 2: 6 Bulan | 1 Tahun
      expect(rows[1][0].text).toBe('6 Bulan');
      expect(rows[1][0].callback_data).toBe('sum:range:6m');
      expect(rows[1][1].text).toBe('1 Tahun');
      expect(rows[1][1].callback_data).toBe('sum:range:1y');
    });

    it('highlights other active ranges correctly in Indonesian', () => {
      const kb1w = createTelegramSummaryRangeKeyboard('1w', 'id');
      expect(kb1w.inline_keyboard[0][0].text).toBe('• 1 Minggu •');
      expect(kb1w.inline_keyboard[0][1].text).toBe('1 Bulan');

      const kb6m = createTelegramSummaryRangeKeyboard('6m', 'id');
      expect(kb6m.inline_keyboard[1][0].text).toBe('• 6 Bulan •');
      expect(kb6m.inline_keyboard[1][1].text).toBe('1 Tahun');

      const kb1y = createTelegramSummaryRangeKeyboard('1y', 'id');
      expect(kb1y.inline_keyboard[1][0].text).toBe('6 Bulan');
      expect(kb1y.inline_keyboard[1][1].text).toBe('• 1 Tahun •');
    });

    it('creates 2x2 inline keyboard in English when requested', () => {
      const keyboard = createTelegramSummaryRangeKeyboard('6m', 'en');
      const rows = keyboard.inline_keyboard;

      expect(rows[0][0].text).toBe('1 Week');
      expect(rows[0][1].text).toBe('1 Month');
      expect(rows[1][0].text).toBe('• 6 Months •');
      expect(rows[1][1].text).toBe('1 Year');
    });
  });

  describe('handleSummaryRangeCallback', () => {
    it('returns null if summaryService is not provided or prefix does not match', async () => {
      expect(await handleSummaryRangeCallback('sum:range:1w', undefined)).toBeNull();
      const mockService: any = { getTransactionSummary: vi.fn() };
      expect(await handleSummaryRangeCallback('unknown:data', mockService)).toBeNull();
      expect(await handleSummaryRangeCallback('sum:range:unknown', mockService)).toBeNull();
    });

    it('fetches summary with mapped period and category grouping for 1w, 1m, 6m, 1y', async () => {
      const mockSummaryResult: TransactionSummaryResult = {
        transactionCount: 5,
        excludedTransferCount: 2,
        totals: [{ currency: 'IDR', income: 1000000, expense: 500000, net: 500000, transactionCount: 5 }],
        breakdown: [
          { name: 'Food', totals: [{ currency: 'IDR', income: 0, expense: 300000, net: -300000, transactionCount: 3 }] },
          { name: 'Transport', totals: [{ currency: 'IDR', income: 0, expense: 200000, net: -200000, transactionCount: 2 }] },
        ],
        groupBy: 'category',
        isMultiCurrency: false,
        isComplete: true,
      };

      const mockService: any = {
        getTransactionSummary: vi.fn().mockResolvedValue(mockSummaryResult),
      };

      const keys: SummaryRangeKey[] = ['1w', '1m', '6m', '1y'];
      for (const key of keys) {
        const result = await handleSummaryRangeCallback(`sum:range:${key}`, mockService, 'id');
        expect(result).not.toBeNull();
        expect(result!.rangeKey).toBe(key);
        expect(result!.replyMarkup.inline_keyboard.length).toBe(2);
        expect(result!.text).toContain('Ringkasan Transaksi');
        expect(mockService.getTransactionSummary).toHaveBeenCalledWith(
          {
            datePeriod: SUMMARY_RANGE_TO_PERIOD[key],
            groupBy: 'category',
          },
          expect.any(Date)
        );
      }
    });
  });

  describe('calculateRelativeDateRange for last_6_months', () => {
    it('calculates the exact 6-month boundary with UTC timezone', () => {
      const referenceDate = new Date('2026-09-15T12:00:00Z');
      const result = calculateRelativeDateRange('last_6_months', referenceDate, 'UTC');

      expect(result.to).toBe('2026-09-15');
      expect(result.from).toBe('2026-03-15');
      expect(result.label).toBe('6 Bulan Terakhir');
      expect(result.selector).toBe('6 bulan terakhir');
    });

    it('handles month boundary clipping correctly when 6 months prior has fewer days', () => {
      // 2026-08-31 minus 6 months -> February 2026 has 28 days
      const referenceDate = new Date('2026-08-31T12:00:00Z');
      const result = calculateRelativeDateRange('last_6_months', referenceDate, 'UTC');

      expect(result.to).toBe('2026-08-31');
      expect(result.from).toBe('2026-02-28');
    });
  });

  describe('fastPathTokens for last_6_months', () => {
    it('extracts last_6_months from natural language phrases in Indonesian and English', () => {
      const idResult = extractHistoryQueryOptionsFromTokens('6 bulan terakhir');
      expect(idResult?.datePeriod).toBe('last_6_months');

      const idShortResult = extractHistoryQueryOptionsFromTokens('6 bulan');
      expect(idShortResult?.datePeriod).toBe('last_6_months');

      const enResult = extractHistoryQueryOptionsFromTokens('last 6 months');
      expect(enResult?.datePeriod).toBe('last_6_months');
    });

    it('detects fastpath /rekap 6 bulan terakhir and summary last 6 months', () => {
      const fastPathId = detectFastPathAction('/rekap 6 bulan terakhir');
      expect(fastPathId).not.toBeNull();
      expect(fastPathId?.type).toBe('TRANSACTION_SUMMARY');
      expect((fastPathId as any).options?.datePeriod).toBe('last_6_months');

      const fastPathEn = detectFastPathAction('summary last 6 months');
      expect(fastPathEn).not.toBeNull();
      expect(fastPathEn?.type).toBe('TRANSACTION_SUMMARY');
      expect((fastPathEn as any).options?.datePeriod).toBe('last_6_months');
    });
  });

  describe('formatTransactionSummaryMessage Top 5 expenses & no transfer notice', () => {
    it('formats top 5 expenses and omits transfer exclusion notice', () => {
      const summaryResult: TransactionSummaryResult = {
        transactionCount: 20,
        excludedTransferCount: 424,
        totals: [{ currency: 'IDR', income: 10000000, expense: 8000000, net: 2000000, transactionCount: 20 }],
        breakdown: [
          { name: 'Belanja', totals: [{ currency: 'IDR', income: 0, expense: 3000000, net: -3000000, transactionCount: 6 }] },
          { name: 'Makan', totals: [{ currency: 'IDR', income: 0, expense: 2000000, net: -2000000, transactionCount: 5 }] },
          { name: 'Transport', totals: [{ currency: 'IDR', income: 0, expense: 1500000, net: -1500000, transactionCount: 4 }] },
          { name: 'Tagihan', totals: [{ currency: 'IDR', income: 0, expense: 800000, net: -800000, transactionCount: 2 }] },
          { name: 'Hiburan', totals: [{ currency: 'IDR', income: 0, expense: 500000, net: -500000, transactionCount: 2 }] },
          { name: 'Kesehatan', totals: [{ currency: 'IDR', income: 0, expense: 200000, net: -200000, transactionCount: 1 }] },
        ],
        groupBy: 'category',
        isMultiCurrency: false,
        isComplete: true,
      };

      const formatted = formatTransactionSummaryMessage(summaryResult, 'id');

      // Header and totals
      expect(formatted).toContain('📊 *Ringkasan Transaksi*');
      expect(formatted).toContain('💰 Pemasukan: *Rp 10.000.000*');
      expect(formatted).toContain('💸 Pengeluaran: *Rp 8.000.000*');
      expect(formatted).toContain('🧮 Net: *+Rp 2.000.000*');

      // Top 5 breakdown
      expect(formatted).toContain('*Top Pengeluaran:*');
      expect(formatted).toContain('1. Belanja: *Rp 3.000.000*');
      expect(formatted).toContain('2. Makan: *Rp 2.000.000*');
      expect(formatted).toContain('3. Transport: *Rp 1.500.000*');
      expect(formatted).toContain('4. Tagihan: *Rp 800.000*');
      expect(formatted).toContain('5. Hiburan: *Rp 500.000*');
      // 6th item must be excluded
      expect(formatted).not.toContain('Kesehatan');

      // Crucial: Transfer exclusion line must NOT be present
      expect(formatted).not.toContain('Mengabaikan');
      expect(formatted).not.toContain('Excluded');
      expect(formatted).not.toContain('transaksi transfer');
    });
  });

  describe('FinancialActionExecutor executeTransactionSummary defaults', () => {
    it('defaults to this_month and category when no date or groupBy options are specified', async () => {
      const mockSummaryService: any = {
        getTransactionSummary: vi.fn().mockResolvedValue({
          transactionCount: 3,
          excludedTransferCount: 0,
          totals: [{ currency: 'IDR', income: 500000, expense: 200000, net: 300000, transactionCount: 3 }],
          breakdown: [
            { name: 'Food', totals: [{ currency: 'IDR', income: 0, expense: 200000, net: -200000, transactionCount: 3 }] },
          ],
          groupBy: 'category',
          isMultiCurrency: false,
          isComplete: true,
        }),
      };

      const mockGateway: any = {
        sendMessage: vi.fn().mockResolvedValue({ messageId: 'msg-1' }),
      };

      const executor = new FinancialActionExecutor(
        {} as any,
        {} as any,
        mockGateway,
        {} as any,
        mockSummaryService
      );

      await executor.executeTransactionSummary({
        channel: 'telegram',
        chatIdentifier: 'chat-123',
        senderIdentifier: 'user-123',
        messageType: 'text',
        textPayload: '/rekap',
      });

      // Verify defaults
      expect(mockSummaryService.getTransactionSummary).toHaveBeenCalledWith(
        {
          datePeriod: 'this_month',
          groupBy: 'category',
        },
        expect.any(Date)
      );

      // Verify Telegram keyboard attached with 1m active
      expect(mockGateway.sendMessage).toHaveBeenCalledWith(
        'telegram',
        'chat-123',
        expect.stringContaining('Ringkasan Transaksi'),
        expect.objectContaining({
          replyMarkup: expect.objectContaining({
            inline_keyboard: expect.any(Array),
          }),
        })
      );

      const sentReplyMarkup = mockGateway.sendMessage.mock.calls[0][3].replyMarkup;
      expect(sentReplyMarkup.inline_keyboard[0][1].text).toBe('• 1 Bulan •');
    });
  });

  describe('TelegramMessagingAdapter callback_query integration', () => {
    it('handles sum:range: callback by editing message in-place and answering callback', async () => {
      const mockSummaryService: any = {
        getTransactionSummary: vi.fn().mockResolvedValue({
          transactionCount: 2,
          excludedTransferCount: 0,
          totals: [{ currency: 'IDR', income: 2000000, expense: 1000000, net: 1000000, transactionCount: 2 }],
          breakdown: [
            { name: 'Shopping', totals: [{ currency: 'IDR', income: 0, expense: 1000000, net: -1000000, transactionCount: 2 }] },
          ],
          groupBy: 'category',
          isMultiCurrency: false,
          isComplete: true,
        }),
      };

      const adapter = new TelegramMessagingAdapter('dummy-token', '123456789', vi.fn(), {
        transactionSummaryService: mockSummaryService,
      });

      const handlers: Record<string, (ctx: any) => Promise<void>> = {};
      const mockBot: any = {
        use: vi.fn(),
        on: vi.fn((event: string, handler: any) => {
          handlers[event] = handler;
        }),
        catch: vi.fn(),
      };

      adapter.setupBotHandlers(mockBot);
      expect(handlers['callback_query:data']).toBeDefined();

      const mockEditMessageText = vi.fn().mockResolvedValue({});
      const mockAnswerCallbackQuery = vi.fn().mockResolvedValue({});

      const mockContext = {
        callbackQuery: {
          data: 'sum:range:1w',
        },
        editMessageText: mockEditMessageText,
        answerCallbackQuery: mockAnswerCallbackQuery,
      };

      await handlers['callback_query:data'](mockContext);

      expect(mockAnswerCallbackQuery).toHaveBeenCalled();
      expect(mockSummaryService.getTransactionSummary).toHaveBeenCalledWith(
        {
          datePeriod: 'this_week',
          groupBy: 'category',
        },
        expect.any(Date)
      );
      expect(mockEditMessageText).toHaveBeenCalledWith(
        expect.stringContaining('Ringkasan Transaksi'),
        expect.objectContaining({
          parse_mode: 'HTML',
          reply_markup: expect.objectContaining({
            inline_keyboard: expect.any(Array),
          }),
        })
      );

      const editedMarkup = mockEditMessageText.mock.calls[0][1].reply_markup;
      expect(editedMarkup.inline_keyboard[0][0].text).toBe('• 1 Minggu •');
    });
  });
});
