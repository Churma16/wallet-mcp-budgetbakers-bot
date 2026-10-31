import type {
  TransactionSummaryGroupBy,
  TransactionCurrencyTotals,
  TransactionSummaryBreakdownItem,
  WalletRecordItem,
  WalletAccountItem,
  WalletCategoryItem,
  WalletRecordAggregationResultItem,
} from '../types.js';

export interface MutableCurrencyTotals {
  currency: string;
  income: number;
  expense: number;
  transactionCount: number;
}

export interface MutableBreakdownItem {
  key: string;
  name?: string;
  transactionCount: number;
  totalsByCurrency: Map<string, MutableCurrencyTotals>;
}

export function normalizeCurrencyCode(currencyCode?: string): string {
  const normalized = currencyCode?.trim().toUpperCase();
  return normalized || 'UNKNOWN';
}

export function addRecordToCurrencyTotals(
  totalsByCurrency: Map<string, MutableCurrencyTotals>,
  recordItem: WalletRecordItem
): void {
  const currency = normalizeCurrencyCode(recordItem.currency);
  let currencyTotals = totalsByCurrency.get(currency);

  if (!currencyTotals) {
    currencyTotals = {
      currency,
      income: 0,
      expense: 0,
      transactionCount: 0,
    };
    totalsByCurrency.set(currency, currencyTotals);
  }

  const absoluteAmount = Math.abs(recordItem.amount);
  if (recordItem.recordType === 'expense') {
    currencyTotals.expense += absoluteAmount;
  } else {
    currencyTotals.income += absoluteAmount;
  }
  currencyTotals.transactionCount += 1;
}

export function finalizeCurrencyTotals(
  totalsByCurrency: Map<string, MutableCurrencyTotals>
): TransactionCurrencyTotals[] {
  return [...totalsByCurrency.values()]
    .map(currencyTotals => ({
      currency: currencyTotals.currency,
      income: currencyTotals.income,
      expense: currencyTotals.expense,
      net: currencyTotals.income - currencyTotals.expense,
      transactionCount: currencyTotals.transactionCount,
    }))
    .sort((left, right) => left.currency.localeCompare(right.currency));
}

export function resolveBreakdownIdentity(
  recordItem: WalletRecordItem,
  groupBy: Exclude<TransactionSummaryGroupBy, 'none'>
): { key: string; name?: string } {
  if (groupBy === 'category') {
    const categoryId = recordItem.category?.id?.trim();
    return {
      key: categoryId || '__uncategorized__',
      name: recordItem.category?.name?.trim() || undefined,
    };
  }

  const accountId = recordItem.accountId?.trim();
  return {
    key: accountId || '__unknown_account__',
    name: recordItem.accountName?.trim() || undefined,
  };
}

export function finalizeAndSortBreakdown(
  groupedItemMap: Map<string, MutableBreakdownItem>,
  isMultiCurrency: boolean
): TransactionSummaryBreakdownItem[] {
  const finalizedBreakdown = [...groupedItemMap.values()].map(groupedItem => ({
    key: groupedItem.key,
    name: groupedItem.name,
    transactionCount: groupedItem.transactionCount,
    totals: finalizeCurrencyTotals(groupedItem.totalsByCurrency),
  }));

  if (isMultiCurrency) {
    return finalizedBreakdown.sort((left, right) =>
      (left.name || left.key).localeCompare(right.name || right.key)
    );
  }

  return finalizedBreakdown.sort((left, right) => {
    const leftTotals = left.totals[0];
    const rightTotals = right.totals[0];
    const expenseDifference = (rightTotals?.expense || 0) - (leftTotals?.expense || 0);
    if (expenseDifference !== 0) {
      return expenseDifference;
    }
    const incomeDifference = (rightTotals?.income || 0) - (leftTotals?.income || 0);
    if (incomeDifference !== 0) {
      return incomeDifference;
    }
    return (left.name || left.key).localeCompare(right.name || right.key);
  });
}

export function buildBreakdown(
  recordList: WalletRecordItem[],
  groupBy: TransactionSummaryGroupBy,
  isMultiCurrency: boolean
): TransactionSummaryBreakdownItem[] {
  if (groupBy === 'none') {
    return [];
  }

  const groupedItemMap = new Map<string, MutableBreakdownItem>();

  for (const recordItem of recordList) {
    const identity = resolveBreakdownIdentity(recordItem, groupBy);
    let groupedItem = groupedItemMap.get(identity.key);

    if (!groupedItem) {
      groupedItem = {
        key: identity.key,
        name: identity.name,
        transactionCount: 0,
        totalsByCurrency: new Map<string, MutableCurrencyTotals>(),
      };
      groupedItemMap.set(identity.key, groupedItem);
    } else if (!groupedItem.name && identity.name) {
      groupedItem.name = identity.name;
    }

    groupedItem.transactionCount += 1;
    addRecordToCurrencyTotals(groupedItem.totalsByCurrency, recordItem);
  }

  return finalizeAndSortBreakdown(groupedItemMap, isMultiCurrency);
}

export function buildNativeBreakdown(
  rawResults: WalletRecordAggregationResultItem[],
  groupBy: TransactionSummaryGroupBy,
  isMultiCurrency: boolean,
  cachedAccounts: WalletAccountItem[],
  cachedCategories: WalletCategoryItem[]
): TransactionSummaryBreakdownItem[] {
  if (groupBy === 'none') {
    return [];
  }

  const accountNameMap = new Map<string, string>();
  for (const account of cachedAccounts) {
    if (account.id) {
      accountNameMap.set(account.id, account.name);
    }
  }

  const categoryNameMap = new Map<string, string>();
  for (const category of cachedCategories) {
    if (category.id) {
      categoryNameMap.set(category.id, category.name);
    }
  }

  const groupedItemMap = new Map<string, MutableBreakdownItem>();

  for (const row of rawResults) {
    if (!row.count || row.count <= 0) {
      continue;
    }

    let key: string;
    let name: string | undefined;

    if (groupBy === 'category') {
      const rawCategoryId = (row['category:id'] as string | undefined)?.trim();
      key = rawCategoryId || '__uncategorized__';
      name = (row['category:name'] as string | undefined)?.trim() ||
        (rawCategoryId ? categoryNameMap.get(rawCategoryId) : undefined);
    } else {
      const rawAccountId = (row.accountId as string | undefined)?.trim();
      key = rawAccountId || '__unknown_account__';
      name = rawAccountId ? accountNameMap.get(rawAccountId) : undefined;
    }

    let groupedItem = groupedItemMap.get(key);
    if (!groupedItem) {
      groupedItem = {
        key,
        name,
        transactionCount: 0,
        totalsByCurrency: new Map<string, MutableCurrencyTotals>(),
      };
      groupedItemMap.set(key, groupedItem);
    } else if (!groupedItem.name && name) {
      groupedItem.name = name;
    }

    const currency = normalizeCurrencyCode(row.currency);
    let currencyTotals = groupedItem.totalsByCurrency.get(currency);
    if (!currencyTotals) {
      currencyTotals = {
        currency,
        income: 0,
        expense: 0,
        transactionCount: 0,
      };
      groupedItem.totalsByCurrency.set(currency, currencyTotals);
    }

    const rawAmount = typeof row['amount:sum'] === 'number' ? row['amount:sum'] : 0;
    groupedItem.transactionCount += row.count;
    currencyTotals.transactionCount += row.count;

    if (row.recordType === 'expense') {
      currencyTotals.expense += Math.abs(rawAmount);
    } else {
      currencyTotals.income += Math.abs(rawAmount);
    }
  }

  return finalizeAndSortBreakdown(groupedItemMap, isMultiCurrency);
}
