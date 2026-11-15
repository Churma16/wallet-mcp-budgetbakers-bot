import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createTelegramBudgetInlineKeyboard,
  BudgetPeriodFilter,
  BudgetViewMode,
} from '../src/gateway/telegramMenu.js';
import { handleBudgetCallback } from '../src/core/budget/budgetCallbackHandler.js';
import type { WalletBudgetItem } from '../src/wallet/types.js';
import type { WalletMcpClientService } from '../src/wallet/index.js';
import { setActiveLanguage } from '../src/i18n/index.js';

describe('Budget Interactive Callback Handler & Keyboard', () => {
  const referenceDate = new Date('2026-09-15T12:00:00.000Z');

  const mockBudgets: WalletBudgetItem[] = [
    {
      id: 'b-1',
      name: 'Makan & Minum',
      limitAmount: 700000,
      spentAmount: 81400,
      remainingAmount: 618600,
      periodType: 'WEEK',
      period: '2026-W37',
    },
    {
      id: 'b-2',
      name: 'Sewa Apartemen',
      limitAmount: 3000000,
      spentAmount: 3000000,
      remainingAmount: 0,
      periodType: 'MONTH',
      period: '2026-M09',
    },
  ];

  const mockClient = {
    fetchBudgets: vi.fn().mockResolvedValue(mockBudgets),
  } as unknown as WalletMcpClientService;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(referenceDate);
    setActiveLanguage('id');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('createTelegramBudgetInlineKeyboard', () => {
    it('creates keyboard with period buttons and detail toggle in 3 rows', () => {
      const keyboard = createTelegramBudgetInlineKeyboard('compact', 'all', 'id');
      const rows = keyboard.inline_keyboard;

      expect(rows.length).toBe(3);

      // Row 1: • Semua •
      expect(rows[0].length).toBe(1);
      expect(rows[0][0].text).toBe('• Semua •');
      expect(rows[0][0].callback_data).toBe('bgt:r:all');

      // Row 2: 1 Minggu | 1 Bulan | 1 Tahun (3 buttons)
      expect(rows[1].length).toBe(3);
      expect(rows[1][0].text).toBe('1 Minggu');
      expect(rows[1][0].callback_data).toBe('bgt:r:1w');

      expect(rows[1][1].text).toBe('1 Bulan');
      expect(rows[1][1].callback_data).toBe('bgt:r:1m');

      expect(rows[1][2].text).toBe('1 Tahun');
      expect(rows[1][2].callback_data).toBe('bgt:r:1y');

      // Row 3: 🔍 Mode Detail toggle
      expect(rows[2].length).toBe(1);
      expect(rows[2][0].text).toBe('🔍 Mode Detail');
      expect(rows[2][0].callback_data).toBe('bgt:d:all');
    });

    it('creates keyboard with detail mode active, showing compact toggle and preserving period', () => {
      const keyboard = createTelegramBudgetInlineKeyboard('detail', '1m', 'id');
      const rows = keyboard.inline_keyboard;

      // Row 1: Semua
      expect(rows[0][0].text).toBe('Semua');
      expect(rows[0][0].callback_data).toBe('bgt:d:all');

      // Row 2 highlights 1 Bulan and preserves 'd' mode
      expect(rows[1][1].text).toBe('• 1 Bulan •');
      expect(rows[1][1].callback_data).toBe('bgt:d:1m');

      // Row 3 shows compact toggle
      expect(rows[2][0].text).toBe('📱 Mode Ringkas');
      expect(rows[2][0].callback_data).toBe('bgt:r:1m');
    });

    it('renders localized button labels in English', () => {
      const keyboard = createTelegramBudgetInlineKeyboard('compact', '1w', 'en');
      const rows = keyboard.inline_keyboard;

      expect(rows[0][0].text).toBe('All');
      expect(rows[1][0].text).toBe('• 1 Week •');
      expect(rows[2][0].text).toBe('🔍 Detail View');
    });
  });

  describe('handleBudgetCallback', () => {
    it('returns null for invalid prefix or invalid format', async () => {
      expect(await handleBudgetCallback('unknown:data', mockClient)).toBeNull();
      expect(await handleBudgetCallback('bgt:unknown', mockClient)).toBeNull();
      expect(await handleBudgetCallback('bgt:x:all', mockClient)).toBeNull();
      expect(await handleBudgetCallback('bgt:r:invalid_period', mockClient)).toBeNull();
      expect(await handleBudgetCallback('bgt:r:all', undefined)).toBeNull();
    });

    it('toggles from compact to detail view while preserving period', async () => {
      const result = await handleBudgetCallback('bgt:d:all', mockClient, 'id', referenceDate);

      expect(result).not.toBeNull();
      expect(result!.mode).toBe('detail');
      expect(result!.period).toBe('all');
      expect(result!.text).toContain('_(Detail)_');
      // Toggle button should now offer Mode Ringkas on row 3
      const rows = result!.replyMarkup.inline_keyboard;
      expect(rows[2][0].text).toBe('📱 Mode Ringkas');
      expect(rows[2][0].callback_data).toBe('bgt:r:all');
    });

    it('toggles from detail to compact view while preserving period', async () => {
      const result = await handleBudgetCallback('bgt:r:1w', mockClient, 'id', referenceDate);

      expect(result).not.toBeNull();
      expect(result!.mode).toBe('compact');
      expect(result!.period).toBe('1w');
      expect(result!.text).not.toContain('_(Detail)_');
      // Toggle button should offer Mode Detail on row 3
      const rows = result!.replyMarkup.inline_keyboard;
      expect(rows[2][0].text).toBe('🔍 Mode Detail');
      expect(rows[2][0].callback_data).toBe('bgt:d:1w');
    });

    it('switches period while preserving detail mode', async () => {
      const result = await handleBudgetCallback('bgt:d:1m', mockClient, 'id', referenceDate);

      expect(result).not.toBeNull();
      expect(result!.mode).toBe('detail');
      expect(result!.period).toBe('1m');
      expect(result!.text).toContain('_(Detail)_');
      expect(result!.text).toContain('1 Bulan');

      const rows = result!.replyMarkup.inline_keyboard;
      expect(rows[1][1].text).toBe('• 1 Bulan •');
      expect(rows[2][0].text).toBe('📱 Mode Ringkas');
    });

    it('switches period while preserving compact mode', async () => {
      const result = await handleBudgetCallback('bgt:r:1w', mockClient, 'id', referenceDate);

      expect(result).not.toBeNull();
      expect(result!.mode).toBe('compact');
      expect(result!.period).toBe('1w');
      expect(result!.text).not.toContain('_(Detail)_');

      const rows = result!.replyMarkup.inline_keyboard;
      expect(rows[1][0].text).toBe('• 1 Minggu •');
      expect(rows[2][0].text).toBe('🔍 Mode Detail');
    });
  });
});
