import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { WalletMcpClientService } from '../src/services/walletMcpService.js';
import { formatBudgetSummaryMessage } from '../src/utils/humanResponseFormatter.js';
import { setActiveLanguage } from '../src/i18n/index.js';

const mockRawBudgets = [
  {
    id: 'dbb3274f-3e23-4b04-b895-45647f237a06',
    name: 'Jajan Semuanya',
    limit: 700000,
    currencyCode: 'IDR',
    closed: false,
    periodType: 'WEEK',
    spending: {
      current: {
        effectiveLimit: 700000,
        spent: 81400,
        remaining: 618600,
        overspent: 0,
        period: '2026-W37',
      },
    },
  },
  {
    id: 'budget-archived-2023',
    name: 'Makan Lama (Archived)',
    limit: 500000,
    currencyCode: 'IDR',
    closed: true,
    closedDate: '2023-05-12T00:00:00.000Z',
    spending: {
      current: {
        effectiveLimit: 500000,
        spent: 0,
        remaining: 500000,
        overspent: 0,
        period: '2023-W20',
      },
    },
  },
  {
    id: 'budget-override-overspent',
    name: 'Liburan Weekend',
    limit: 2000000,
    currencyCode: 'IDR',
    closed: false,
    periodType: 'MONTH',
    spending: {
      current: {
        effectiveLimit: 2500000,
        spent: 2750000,
        remaining: -250000,
        overspent: 250000,
        period: '2026-M09',
      },
    },
  },
  {
    id: 'budget-legacy-flat',
    name: 'Legacy Entertainment',
    amount: 1500000,
    spent: 350000,
    currency: 'IDR',
    closed: false,
  },
  {
    id: 'budget-zero-spent',
    name: 'Emergency Fund',
    limit: 10000000,
    currencyCode: 'IDR',
    closed: false,
    spending: {
      current: {
        effectiveLimit: 10000000,
        spent: 0,
        remaining: 10000000,
        overspent: 0,
        period: '2026-M09',
      },
    },
  },
];

function createMockClient(mockReturnPayload: unknown): WalletMcpClientService {
  const clientInstance = new WalletMcpClientService('http://localhost:8080', 'mock-token');
  clientInstance.callMcpTool = async <T>(_toolName: string): Promise<T> => mockReturnPayload as T;
  return clientInstance;
}

describe('budget parsing and schema normalization', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-13T06:00:00.000Z'));
    setActiveLanguage('id');
  });

  afterAll(() => {
    vi.useRealTimers();
    setActiveLanguage('id');
  });

  it('filters closed budgets by default', async () => {
    const activeBudgets = await createMockClient(mockRawBudgets).fetchBudgets();

    expect(activeBudgets).toHaveLength(4);
    expect(activeBudgets.some(budget => budget.id === 'budget-archived-2023')).toBe(false);
  });

  it('includes closed budgets when explicitly requested', async () => {
    const allBudgets = await createMockClient(mockRawBudgets).fetchBudgets(true);
    const archivedItem = allBudgets.find(budget => budget.id === 'budget-archived-2023');

    expect(allBudgets).toHaveLength(5);
    expect(archivedItem).toBeDefined();
    expect(archivedItem?.isClosed).toBe(true);
  });

  it('extracts spending.current metrics and effective-limit overrides', async () => {
    const activeBudgets = await createMockClient(mockRawBudgets).fetchBudgets();
    const jajanItem = activeBudgets.find(budget => budget.name === 'Jajan Semuanya');
    const overrideItem = activeBudgets.find(budget => budget.name === 'Liburan Weekend');

    expect(jajanItem).toBeDefined();
    expect(jajanItem?.spentAmount).toBe(81400);
    expect(jajanItem?.limitAmount).toBe(700000);
    expect(jajanItem?.remainingAmount).toBe(618600);
    expect(jajanItem?.currency).toBe('IDR');
    expect(jajanItem?.period).toBe('2026-W37');
    expect(jajanItem?.isOverspent).toBe(false);

    expect(overrideItem).toBeDefined();
    expect(overrideItem?.limitAmount).toBe(2500000);
    expect(overrideItem?.spentAmount).toBe(2750000);
    expect(overrideItem?.remainingAmount).toBe(-250000);
    expect(overrideItem?.isOverspent).toBe(true);
  });

  it('preserves legacy flat-schema fallbacks and zero spending', async () => {
    const activeBudgets = await createMockClient(mockRawBudgets).fetchBudgets();
    const legacyItem = activeBudgets.find(budget => budget.name === 'Legacy Entertainment');
    const zeroSpentItem = activeBudgets.find(budget => budget.name === 'Emergency Fund');

    expect(legacyItem).toBeDefined();
    expect(legacyItem?.spentAmount).toBe(350000);
    expect(legacyItem?.limitAmount).toBe(1500000);
    expect(legacyItem?.remainingAmount).toBe(1150000);

    expect(zeroSpentItem).toBeDefined();
    expect(zeroSpentItem?.spentAmount).toBe(0);
    expect(zeroSpentItem?.remainingAmount).toBe(10000000);
  });

  it('parses budgets and items envelope response shapes', async () => {
    const parsedBudgetsEnvelope = await createMockClient({ budgets: mockRawBudgets }).fetchBudgets();
    const parsedItemsEnvelope = await createMockClient({ items: mockRawBudgets }).fetchBudgets();

    expect(parsedBudgetsEnvelope).toHaveLength(4);
    expect(parsedItemsEnvelope).toHaveLength(4);
  });

  it('formats parsed active budgets in Indonesian and English', async () => {
    const activeBudgets = await createMockClient(mockRawBudgets).fetchBudgets();

    setActiveLanguage('id');
    const formattedIdSummary = formatBudgetSummaryMessage(activeBudgets);
    expect(formattedIdSummary).toContain('Jajan Semuanya');
    expect(formattedIdSummary).toContain('Rp 81.400 / Rp 700.000');
    expect(formattedIdSummary).toContain('sisa Rp 618.600');
    expect(formattedIdSummary).toContain('Liburan Weekend');
    expect(formattedIdSummary).toContain('lebih Rp 250.000');
    expect(formattedIdSummary).not.toContain('Makan Lama (Archived)');

    setActiveLanguage('en');
    const formattedEnSummary = formatBudgetSummaryMessage(activeBudgets);
    expect(formattedEnSummary).toContain('Jajan Semuanya');
    expect(formattedEnSummary).toContain('left');
    expect(formattedEnSummary).toContain('over');
  });

  it('normalizes invalid, empty, and midnight record dates to valid ISO timestamps', () => {
    const client = createMockClient([]);
    const normalizeRecordDate = (client as unknown as { normalizeRecordDate(d?: string): string }).normalizeRecordDate.bind(client);

    const invalidDateNormalized = normalizeRecordDate('invalid-date-string');
    const emptyDateNormalized = normalizeRecordDate(undefined);
    const midnightNormalized = normalizeRecordDate('2026-09-09T00:00:00.000Z');

    expect(Number.isNaN(Date.parse(invalidDateNormalized))).toBe(false);
    expect(Number.isNaN(Date.parse(emptyDateNormalized))).toBe(false);
    expect(Number.isNaN(Date.parse(midnightNormalized))).toBe(false);
  });
});
