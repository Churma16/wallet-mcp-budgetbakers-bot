import assert from 'node:assert';
import { WalletMcpClientService } from '../src/services/walletMcpService.js';
import { formatBudgetSummaryMessage } from '../src/utils/humanResponseFormatter.js';
import { setActiveLanguage } from '../src/i18n/index.js';

console.log('[TEST] Starting Budget Parsing & Schema Normalization Unit Tests...');

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
        effectiveLimit: 2500000, // Adjusted override limit
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

// Helper to instantiate client with mocked tool call
function createMockClient(mockReturnPayload: unknown): WalletMcpClientService {
  const clientInstance = new WalletMcpClientService('http://localhost:8080', 'mock-token');
  clientInstance.callMcpTool = async <T>(_toolName: string): Promise<T> => {
    return mockReturnPayload as T;
  };
  return clientInstance;
}

// 1. Test fetchBudgets filters closed budgets by default
console.log('\n[1] Testing fetchBudgets closed budget filtering...');
const clientDefaultFilter = createMockClient(mockRawBudgets);
const activeBudgets = await clientDefaultFilter.fetchBudgets();

assert.strictEqual(activeBudgets.length, 4, 'Should filter out 1 closed budget by default');
assert.ok(!activeBudgets.some(budget => budget.id === 'budget-archived-2023'), 'Archived budget must be excluded');
console.log('[PASS] Closed budgets filtered out when includeClosed is false (default).');

// 2. Test fetchBudgets includes closed budgets when explicitly requested
console.log('\n[2] Testing fetchBudgets with includeClosed: true...');
const clientIncludeClosed = createMockClient(mockRawBudgets);
const allBudgets = await clientIncludeClosed.fetchBudgets(true);

assert.strictEqual(allBudgets.length, 5, 'Should include all 5 budgets when includeClosed is true');
const archivedItem = allBudgets.find(budget => budget.id === 'budget-archived-2023');
assert.ok(archivedItem, 'Archived budget must be present');
assert.strictEqual(archivedItem?.isClosed, true, 'Archived budget isClosed property should be true');
console.log('[PASS] All budgets preserved when includeClosed is true.');

// 3. Test spending.current schema extraction and limit overrides
console.log('\n[3] Testing metric extraction from spending.current and effectiveLimit overrides...');
const jajanItem = activeBudgets.find(budget => budget.name === 'Jajan Semuanya');
assert.ok(jajanItem, 'Jajan Semuanya budget should be found');
assert.strictEqual(jajanItem?.spentAmount, 81400, 'Spent amount should match spending.current.spent');
assert.strictEqual(jajanItem?.limitAmount, 700000, 'Limit amount should match spending.current.effectiveLimit');
assert.strictEqual(jajanItem?.remainingAmount, 618600, 'Remaining amount should match spending.current.remaining');
assert.strictEqual(jajanItem?.currency, 'IDR', 'Currency should resolve from currencyCode');
assert.strictEqual(jajanItem?.period, '2026-W37', 'Period should match spending.current.period');
assert.strictEqual(jajanItem?.isOverspent, false, 'Should not be overspent');

const overrideItem = activeBudgets.find(budget => budget.name === 'Liburan Weekend');
assert.ok(overrideItem, 'Liburan Weekend budget should be found');
assert.strictEqual(overrideItem?.limitAmount, 2500000, 'Limit should resolve to effectiveLimit (2,500,000) not base limit (2,000,000)');
assert.strictEqual(overrideItem?.spentAmount, 2750000, 'Spent amount should be 2,750,000');
assert.strictEqual(overrideItem?.remainingAmount, -250000, 'Remaining amount should be negative');
assert.strictEqual(overrideItem?.isOverspent, true, 'isOverspent should be true');
console.log('[PASS] spending.current metrics and effectiveLimit overrides parsed accurately.');

// 4. Test legacy and zero-spent budget fallbacks
console.log('\n[4] Testing fallback for legacy schema and zero spending...');
const legacyItem = activeBudgets.find(budget => budget.name === 'Legacy Entertainment');
assert.ok(legacyItem, 'Legacy Entertainment budget should be found');
assert.strictEqual(legacyItem?.spentAmount, 350000, 'Legacy spent fallback');
assert.strictEqual(legacyItem?.limitAmount, 1500000, 'Legacy amount fallback');
assert.strictEqual(legacyItem?.remainingAmount, 1150000, 'Calculated remaining amount');

const zeroSpentItem = activeBudgets.find(budget => budget.name === 'Emergency Fund');
assert.ok(zeroSpentItem, 'Emergency Fund budget should be found');
assert.strictEqual(zeroSpentItem?.spentAmount, 0, 'Zero spending should resolve to 0 without fallback skipping');
assert.strictEqual(zeroSpentItem?.remainingAmount, 10000000, 'Remaining amount should be full limit');
console.log('[PASS] Legacy fields and zero spending handled properly.');

// 5. Test enveloped response payloads (budgets: [...] and items: [...])
console.log('\n[5] Testing envelope response handling...');
const envelopedBudgetsClient = createMockClient({ budgets: mockRawBudgets });
const parsedEnveloped = await envelopedBudgetsClient.fetchBudgets();
assert.strictEqual(parsedEnveloped.length, 4, 'Enveloped budgets array parsed correctly');

const itemsEnvelopedClient = createMockClient({ items: mockRawBudgets });
const parsedItems = await itemsEnvelopedClient.fetchBudgets();
assert.strictEqual(parsedItems.length, 4, 'Enveloped items array parsed correctly');
console.log('[PASS] JSON-RPC wrapped response shapes handled correctly.');

// 6. Test humanResponseFormatter with parsed budgets
console.log('\n[6] Testing humanResponseFormatter output with parsed budgets...');
setActiveLanguage('id');
const formattedIdSummary = formatBudgetSummaryMessage(activeBudgets);
assert.ok(formattedIdSummary.includes('Jajan Semuanya'), 'Includes Jajan Semuanya');
assert.ok(formattedIdSummary.includes('Rp 81.400 / Rp 700.000'), 'Formatted spending and limit');
assert.ok(formattedIdSummary.includes('sisa Rp 618.600'), 'Formatted remaining amount');
assert.ok(formattedIdSummary.includes('Liburan Weekend'), 'Includes Liburan Weekend');
assert.ok(formattedIdSummary.includes('lebih Rp 250.000'), 'Formatted overspent alert');
assert.ok(!formattedIdSummary.includes('Makan Lama (Archived)'), 'Excludes archived budget');

setActiveLanguage('en');
const formattedEnSummary = formatBudgetSummaryMessage(activeBudgets);
assert.ok(formattedEnSummary.includes('Jajan Semuanya'), 'Includes Jajan Semuanya in EN');
assert.ok(formattedEnSummary.includes('left'), 'Includes left keyword');
assert.ok(formattedEnSummary.includes('over'), 'Includes over keyword');
console.log('[PASS] Formatted message produces correct values and overspent alerts.');

console.log('\n[SUCCESS] ALL BUDGET PARSING TESTS PASSED!');
