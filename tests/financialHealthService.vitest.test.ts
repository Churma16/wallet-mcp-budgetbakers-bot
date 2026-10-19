import { describe, it, expect, beforeEach, vi } from 'vitest';
import { FinancialHealthService } from '../src/services/financialHealthService.js';
import { WalletMcpClientService } from '../src/services/walletMcpService.js';
import { WalletCacheService } from '../src/services/walletCacheService.js';
import { TransactionHistoryService } from '../src/services/transactionHistoryService.js';
import { CategoryContextService } from '../src/services/categoryContextService.js';
import {
  WalletAccountItem,
  WalletBudgetItem,
  WalletCategoryItem,
  WalletRecordItem,
} from '../src/types/walletTypes.js';

describe('FinancialHealthService Tests', () => {
  let mockMcpClient: Partial<WalletMcpClientService>;
  let mockCacheService: Partial<WalletCacheService>;
  let mockHistoryService: Partial<TransactionHistoryService>;
  let mockCategoryContextService: Partial<CategoryContextService>;
  let service: FinancialHealthService;

  beforeEach(() => {
    mockMcpClient = {
      fetchBudgets: vi.fn().mockResolvedValue([]),
    };

    mockCacheService = {
      refreshAccounts: vi.fn().mockResolvedValue([
        { id: 'acc-1', name: 'BCA Utama', balance: 5000000, currency: 'IDR' },
        { id: 'acc-2', name: 'GoPay', balance: 250000, currency: 'IDR' },
        { id: 'acc-3', name: 'Credit Card', balance: -1500000, currency: 'IDR' },
        { id: 'acc-4', name: 'Empty Vault', balance: 0, currency: 'IDR' },
      ] as WalletAccountItem[]),
      getAccounts: vi.fn().mockReturnValue([]),
      getCategories: vi.fn().mockReturnValue([]),
    };

    mockHistoryService = {
      getTransactionHistory: vi.fn().mockResolvedValue({
        records: [],
        total: 0,
        page: 1,
        limit: 50,
      }),
    };

    mockCategoryContextService = {
      getConfiguration: vi.fn().mockReturnValue({
        version: '1.0',
        categories: [],
        financialHealth: {
          overrideRegularCategoryIds: ['cat-custom-reg-id'],
          overrideDiscretionaryCategoryIds: ['cat-custom-disc-id'],
          overrideRegularCategoryNames: ['Kebutuhan Khusus'],
          overrideDiscretionaryCategoryNames: ['Hobi Mahal'],
          recurringPayees: ['tokopedia subscription', 'netflix', 'kosan bapak'],
        },
      }),
    };

    service = new FinancialHealthService(
      mockMcpClient as WalletMcpClientService,
      mockCacheService as WalletCacheService,
      mockHistoryService as TransactionHistoryService,
      undefined,
      mockCategoryContextService as CategoryContextService
    );
  });

  describe('Suite 1: 3-Layer Hybrid Category Classification', () => {
    it('Layer 1: overrides by category ID', () => {
      expect(service.classifyCategory({ id: 'cat-custom-reg-id', name: 'Random' })).toBe('regular');
      expect(service.classifyCategory({ id: 'cat-custom-disc-id', name: 'Random' })).toBe('discretionary');
    });

    it('Layer 1: overrides by category Name', () => {
      expect(service.classifyCategory({ id: 'cat-99', name: 'Kebutuhan Khusus' })).toBe('regular');
      expect(service.classifyCategory({ id: 'cat-100', name: 'Hobi Mahal' })).toBe('discretionary');
    });

    it('Layer 1: overrides by Recurring Payee / CounterParty', () => {
      expect(
        service.classifyCategory(
          { id: 'cat-any', name: 'General Expense' },
          'Netflix Monthly Subscription'
        )
      ).toBe('regular');

      expect(
        service.classifyCategory(
          { id: 'cat-any', name: 'General Expense' },
          'Bayar Kosan Bapak Kost'
        )
      ).toBe('regular');
    });

    it('Layer 2: classifies based on native category group', () => {
      // Regular group
      expect(
        service.classifyCategory({
          id: 'cat-food',
          name: 'Restoran',
          group: { id: 'grp-1', name: 'Food & Drinks' },
        })
      ).toBe('regular');

      expect(
        service.classifyCategory({
          id: 'cat-ojol',
          name: 'GrabBike',
          group: 'transportation',
        })
      ).toBe('regular');

      // Discretionary group
      expect(
        service.classifyCategory({
          id: 'cat-mall',
          name: 'ZARA',
          group: { id: 'grp-2', name: 'Shopping' },
        })
      ).toBe('discretionary');
    });

    it('Layer 2: falls back to keyword heuristics in category name', () => {
      expect(service.classifyCategory({ id: 'cat-1', name: 'Makan Siang Tim' })).toBe('regular');
      expect(service.classifyCategory({ id: 'cat-2', name: 'Ojol Ke Kantor' })).toBe('regular');
      expect(service.classifyCategory({ id: 'cat-3', name: 'Pulsa & Paket Data' })).toBe('regular');
      expect(service.classifyCategory({ id: 'cat-4', name: 'Beli Gadget Baru' })).toBe('discretionary');
    });

    it('Layer 3: uses cached classification when available and valid', () => {
      service.setCacheEntry('cat-cached-freq', 'regular', Date.now());
      expect(service.classifyCategory({ id: 'cat-cached-freq', name: 'Miscellaneous Unnamed' })).toBe(
        'regular'
      );
    });

    it('Layer 3: ignores expired cache entries (>24h TTL) and falls back to default', () => {
      const expiredTimestamp = Date.now() - 25 * 60 * 60 * 1000;
      service.setCacheEntry('cat-expired', 'regular', expiredTimestamp);
      expect(service.classifyCategory({ id: 'cat-expired', name: 'Unknown Miscellaneous' })).toBe(
        'discretionary'
      );
    });

    it('falls back to discretionary when no rules match', () => {
      expect(service.classifyCategory({ id: 'cat-unknown', name: 'Something Exotic' })).toBe(
        'discretionary'
      );
    });
  });

  describe('Suite 2: Cache Warm-Up & Frequency Heuristics', () => {
    it('populates cache from historical records: frequent expenses >= 4 become regular', async () => {
      const mockHistoryRecords: WalletRecordItem[] = [
        // 4 transactions for cat-coffee
        { id: 'rec-1', recordType: 'expense', amount: -25000, category: { id: 'cat-coffee', name: 'Kopi' } },
        { id: 'rec-2', recordType: 'expense', amount: -25000, category: { id: 'cat-coffee', name: 'Kopi' } },
        { id: 'rec-3', recordType: 'expense', amount: -30000, category: { id: 'cat-coffee', name: 'Kopi' } },
        { id: 'rec-4', recordType: 'expense', amount: -28000, category: { id: 'cat-coffee', name: 'Kopi' } },
        // 1 transaction for cat-party
        { id: 'rec-5', recordType: 'expense', amount: -500000, category: { id: 'cat-party', name: 'Pesta' } },
        // Income record (should be ignored)
        { id: 'rec-6', recordType: 'income', amount: 10000000, category: { id: 'cat-salary', name: 'Gaji' } },
      ];

      (mockHistoryService.getTransactionHistory as any).mockResolvedValueOnce({
        records: mockHistoryRecords,
        total: mockHistoryRecords.length,
        page: 1,
        limit: 50,
      });

      await service.warmUpCache(new Date(2026, 9, 19));

      expect(service.getCacheSize()).toBeGreaterThanOrEqual(2);
      expect(service.classifyCategory({ id: 'cat-coffee', name: 'Kopi' })).toBe('regular');
      expect(service.classifyCategory({ id: 'cat-party', name: 'Pesta' })).toBe('discretionary');
    });

    it('handles warm-up errors gracefully without throwing', async () => {
      (mockHistoryService.getTransactionHistory as any).mockRejectedValueOnce(
        new Error('Network MCP failure')
      );

      await expect(service.warmUpCache()).resolves.not.toThrow();
    });
  });

  describe('Suite 3: Comprehensive Financial Health & Runway Evaluation', () => {
    it('computes cash flow, liquid balances, active budgets, and runway projection correctly', async () => {
      const fixedDate = new Date(2026, 9, 20); // October 20, 2026 (31 days in October, 11 days remaining)

      const currentMonthRecords: WalletRecordItem[] = [
        { id: 'r1', recordType: 'income', amount: 15000000, category: { id: 'c-inc', name: 'Salary' } },
        {
          id: 'r2',
          recordType: 'expense',
          amount: -1500000,
          category: { id: 'c-warteg', name: 'Makan Rutin Warteg', group: 'food_and_drinks' },
        },
        {
          id: 'r3',
          recordType: 'expense',
          amount: -500000,
          category: { id: 'c-ojol', name: 'Ojol Harian', group: 'transportation' },
        },
        {
          id: 'r4',
          recordType: 'expense',
          amount: -2000000,
          category: { id: 'c-shoe', name: 'Sepatu Baru', group: 'shopping' },
        },
      ];

      const prevMonthRecords: WalletRecordItem[] = [
        { id: 'p1', recordType: 'income', amount: 14000000, category: { id: 'c-inc', name: 'Salary' } },
        { id: 'p2', recordType: 'expense', amount: -3500000, category: { id: 'c-all', name: 'Expense' } },
      ];

      (mockHistoryService.getTransactionHistory as any).mockImplementation((opts: any) => {
        if (opts.datePeriod === 'this_month') {
          return Promise.resolve({ records: currentMonthRecords, total: currentMonthRecords.length });
        }
        return Promise.resolve({ records: prevMonthRecords, total: prevMonthRecords.length });
      });

      const mockBudgets: WalletBudgetItem[] = [
        {
          id: 'b-1',
          name: 'Belanja Bulanan',
          spentAmount: 2000000,
          limitAmount: 1500000,
          remainingAmount: -500000,
          currency: 'IDR',
          isOverspent: true,
        },
        {
          id: 'b-2',
          name: 'Makan',
          spentAmount: 1500000,
          limitAmount: 3000000,
          remainingAmount: 1500000,
          currency: 'IDR',
          isOverspent: false,
        },
      ];
      (mockMcpClient.fetchBudgets as any).mockResolvedValueOnce(mockBudgets);

      const evaluation = await service.evaluateFinancialHealth(fixedDate);

      // 1. Liquid Balances (acc-1: 5M + acc-2: 250k = 5,250,000, credit card and 0 vault excluded)
      expect(evaluation.totalLiquidBalance).toBe(5250000);
      expect(evaluation.liquidAccounts.length).toBe(2);

      // 2. Cash Flow
      expect(evaluation.cashFlow.currentMonth.income).toBe(15000000);
      expect(evaluation.cashFlow.currentMonth.expense).toBe(4000000);
      expect(evaluation.cashFlow.currentMonth.net).toBe(11000000);
      expect(evaluation.cashFlow.currentMonth.regularExpense).toBe(2000000); // 1.5M warteg + 500k ojol
      expect(evaluation.cashFlow.currentMonth.discretionaryExpense).toBe(2000000); // 2M sepatu

      // 3. Budgets
      expect(evaluation.activeBudgets.length).toBe(2);
      expect(evaluation.activeBudgets[0].isOverspent).toBe(true);

      // 4. Runway Projection on Oct 20 (Days elapsed = 20, Days remaining = 11)
      expect(evaluation.runway.daysElapsedInMonth).toBe(20);
      expect(evaluation.runway.daysRemainingInMonth).toBe(11);
      // Daily regular burn = 2,000,000 / 20 = 100,000
      expect(evaluation.runway.dailyRegularBurnRate).toBe(100000);
      // Projected remaining regular = 100,000 * 11 = 1,100,000
      expect(evaluation.runway.projectedRemainingRegularExpense).toBe(1100000);
      // Liquid balance 5,250,000 >= 1,100,000 -> isSufficient true
      expect(evaluation.runway.isSufficient).toBe(true);
      expect(evaluation.runway.runwayCoverageRatio).toBeGreaterThan(4);
    });

    it('flags tight runway when liquid balance is insufficient for remaining routine burn', async () => {
      const fixedDate = new Date(2026, 9, 10); // Oct 10, 2026 (21 days remaining)

      // Set low liquid balance
      (mockCacheService.refreshAccounts as any).mockResolvedValueOnce([
        { id: 'acc-low', name: 'Dompet Tipis', balance: 400000, currency: 'IDR' },
      ]);

      const currentMonthRecords: WalletRecordItem[] = [
        {
          id: 'r1',
          recordType: 'expense',
          amount: -1000000, // 100k per day over 10 days
          category: { id: 'c-food', name: 'Makan', group: 'food_and_drinks' },
        },
      ];

      (mockHistoryService.getTransactionHistory as any).mockImplementation((opts: any) => {
        if (opts.datePeriod === 'this_month') {
          return Promise.resolve({ records: currentMonthRecords, total: currentMonthRecords.length });
        }
        return Promise.resolve({ records: [], total: 0 });
      });

      const evaluation = await service.evaluateFinancialHealth(fixedDate);

      // Daily burn = 100,000
      // 21 days remaining -> projected remaining = 2,100,000
      // Liquid balance = 400,000 < 2,100,000 -> isSufficient = false
      expect(evaluation.runway.isSufficient).toBe(false);
      expect(evaluation.runway.projectedRemainingRegularExpense).toBe(2100000);
      expect(evaluation.runway.totalLiquidBalance).toBe(400000);
    });
  });
});
