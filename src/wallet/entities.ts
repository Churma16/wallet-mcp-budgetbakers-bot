import type {
  WalletAccountItem,
  WalletCategoryItem,
  WalletLabelItem,
  WalletBudgetItem,
} from './types.js';
import {
  type WalletToolCaller,
  type RawAccountItem,
  type RawCategoryItem,
  type RawLabelItem,
  type RawBudgetItem,
  extractRawArray,
  callGetAccounts,
  callGetCategories,
  callGetLabels,
  callCreateLabel,
  callGetBudgets,
} from './toolWrappers.js';
import { applicationLogger } from '../lib/logger.js';

export type ToolInvoker = WalletToolCaller;

export interface EntityCacheStore {
  cachedAccountList?: WalletAccountItem[];
  cachedCategoryList?: WalletCategoryItem[];
  cachedLabelList?: WalletLabelItem[];
  cacheLastUpdatedTimestamp?: number;
  cacheDurationMilliseconds?: number;
}

export async function fetchAccounts(
  client: ToolInvoker,
  cacheStore?: EntityCacheStore,
  forceRefresh: boolean = false
): Promise<WalletAccountItem[]> {
  const cacheDuration = cacheStore?.cacheDurationMilliseconds ?? 60 * 60 * 1000;
  const isCacheExpired = Date.now() - (cacheStore?.cacheLastUpdatedTimestamp ?? 0) > cacheDuration;

  if (!forceRefresh && (cacheStore?.cachedAccountList?.length ?? 0) > 0 && !isCacheExpired) {
    return cacheStore!.cachedAccountList!;
  }

  const fetchedAccountData = await callGetAccounts(client);
  const rawAccountArray = extractRawArray<RawAccountItem>(fetchedAccountData, 'accounts', 'items');

  const accounts = rawAccountArray.map(item => {
    let resolvedBalance: number | undefined = undefined;
    let resolvedCurrency: string | undefined = item.currency || item.currencyCode;

    if (typeof item.balance === 'number') {
      resolvedBalance = item.balance;
    } else if (typeof item.balance === 'object' && item.balance !== null) {
      resolvedBalance =
        item.balance.currentBalance ??
        item.balance.rawCurrentBalance ??
        item.balance.amount ??
        item.balance.value ??
        item.balance.current;
      resolvedCurrency = item.balance.currencyCode ?? item.balance.currency ?? resolvedCurrency;
    }

    return {
      id: item.id || item.accountId || '',
      name: item.name || item.accountName || 'Unnamed Account',
      currency: resolvedCurrency || 'IDR',
      balance: resolvedBalance,
      accountType: item.accountType || item.type,
      bankAccountNumber: item.bankAccountNumber || item.accountNumber || item.number || undefined,
      isBankSynced: Boolean(
        item.isBankSynced ||
        item.bankSync ||
        item.syncState === 'SYNCED' ||
        item.syncState === 'ACTIVE' ||
        item.bankId ||
        item.connectedBank ||
        false
      ),
    };
  });

  if (cacheStore) {
    cacheStore.cachedAccountList = accounts;
    cacheStore.cacheLastUpdatedTimestamp = Date.now();
  }
  return accounts;
}

export async function fetchCategories(
  client: ToolInvoker,
  cacheStore?: EntityCacheStore,
  forceRefresh: boolean = false
): Promise<WalletCategoryItem[]> {
  const cacheDuration = cacheStore?.cacheDurationMilliseconds ?? 60 * 60 * 1000;
  const isCacheExpired = Date.now() - (cacheStore?.cacheLastUpdatedTimestamp ?? 0) > cacheDuration;

  if (!forceRefresh && (cacheStore?.cachedCategoryList?.length ?? 0) > 0 && !isCacheExpired) {
    return cacheStore!.cachedCategoryList!;
  }

  const fetchedCategoryData = await callGetCategories(client);
  const rawCategoryArray = extractRawArray<RawCategoryItem>(fetchedCategoryData, 'categories', 'items');

  const categories = rawCategoryArray.map(item => {
    const rawGroup = item.group as unknown;
    const categoryGroupObject = typeof rawGroup === 'object' && rawGroup !== null
      ? {
          id: String((rawGroup as { id?: string; name?: string }).id || (rawGroup as { id?: string; name?: string }).name || '').trim(),
          name: String((rawGroup as { id?: string; name?: string }).name || (rawGroup as { id?: string; name?: string }).id || '').trim(),
        }
      : undefined;

    const groupRecord = item.group as unknown as { id?: string } | undefined;

    return {
      id: item.id || item.categoryId || '',
      name: item.name || item.categoryName || 'Unnamed Category',
      parentCategoryId: item.parentId || item.parentCategoryId,
      parentCategoryName: (item as { parentName?: string; parentCategoryName?: string }).parentName ||
        (item as { parentName?: string; parentCategoryName?: string }).parentCategoryName,
      group: categoryGroupObject,
      systemId: (item as { systemId?: string }).systemId,
      cardinality: (item as { cardinality?: string }).cardinality,
      customCategory: (item as { customCategory?: boolean }).customCategory,
      archived: (item as { archived?: boolean }).archived,
      enabled: (item as { enabled?: boolean }).enabled,
      isAssignable: typeof (item as { isAssignable?: boolean }).isAssignable === 'boolean'
        ? (item as { isAssignable?: boolean }).isAssignable
        : typeof (item as { assignable?: boolean }).assignable === 'boolean'
          ? (item as { assignable?: boolean }).assignable
          : (item as { enabled?: boolean }).enabled !== false &&
            (item as { archived?: boolean }).archived !== true &&
            groupRecord?.id !== 'system_categories',
    };
  });

  if (cacheStore) {
    cacheStore.cachedCategoryList = categories;
    cacheStore.cacheLastUpdatedTimestamp = Date.now();
  }
  return categories;
}

export async function fetchLabels(
  client: ToolInvoker,
  cacheStore?: EntityCacheStore,
  forceRefresh: boolean = false
): Promise<WalletLabelItem[]> {
  const cacheDuration = cacheStore?.cacheDurationMilliseconds ?? 60 * 60 * 1000;
  const isCacheExpired = Date.now() - (cacheStore?.cacheLastUpdatedTimestamp ?? 0) > cacheDuration;

  if (!forceRefresh && (cacheStore?.cachedLabelList?.length ?? 0) > 0 && !isCacheExpired) {
    return cacheStore!.cachedLabelList!;
  }

  const fetchedLabelData = await callGetLabels(client);
  const rawLabelArray = extractRawArray<RawLabelItem>(fetchedLabelData, 'labels', 'items');

  const labels = rawLabelArray.map(item => ({
    id: String(item.id || item.labelId || ''),
    name: String(item.name || item.labelName || (item as { title?: string }).title || '').trim(),
    color: item.color,
    icon: item.icon,
  })).filter(item => item.id.length > 0 && item.name.length > 0);

  if (cacheStore) {
    cacheStore.cachedLabelList = labels;
    cacheStore.cacheLastUpdatedTimestamp = Date.now();
  }
  return labels;
}

export async function createLabel(
  client: ToolInvoker,
  labelName: string,
  cacheStore?: EntityCacheStore
): Promise<WalletLabelItem | null> {
  const sanitizedLabelName = labelName.replace(/^#/, '').trim();
  if (!sanitizedLabelName) return null;

  try {
    const toolCallResult = await callCreateLabel(client, {
      name: sanitizedLabelName,
    });
    const labelPayload = (
      toolCallResult && typeof toolCallResult === 'object' && 'label' in toolCallResult && toolCallResult.label
        ? toolCallResult.label
        : toolCallResult
    ) as RawLabelItem | undefined;

    if (labelPayload && (labelPayload.id || labelPayload.labelId)) {
      const createdLabel: WalletLabelItem = {
        id: String(labelPayload.id || labelPayload.labelId),
        name: String(labelPayload.name || sanitizedLabelName),
        color: labelPayload.color,
        icon: labelPayload.icon,
      };
      if (cacheStore?.cachedLabelList) {
        const existingIndex = cacheStore.cachedLabelList.findIndex(item => item.id === createdLabel.id);
        if (existingIndex >= 0) {
          cacheStore.cachedLabelList[existingIndex] = createdLabel;
        } else {
          cacheStore.cachedLabelList.push(createdLabel);
        }
      }
      return createdLabel;
    }
    return null;
  } catch (error) {
    applicationLogger.fileDetail('warn', `Wallet MCP label creation not available or failed for "${sanitizedLabelName}"`, {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export async function fetchBudgets(
  client: ToolInvoker,
  includeClosed: boolean = false
): Promise<WalletBudgetItem[]> {
  const fetchedBudgetData = await callGetBudgets(client);
  const rawBudgetArray = extractRawArray<RawBudgetItem>(fetchedBudgetData, 'budgets', 'items');
  const targetBudgetArray = includeClosed
    ? rawBudgetArray
    : rawBudgetArray.filter(item => !item.closed);

  return targetBudgetArray.map(item => {
    const currentSpending = item.spending?.current;
    const spentAmount = Number(
      currentSpending?.spent ??
      currentSpending?.totalExpenses ??
      item.spent ??
      item.currentSpent ??
      0
    );
    const limitAmount = Number(
      currentSpending?.effectiveLimit ??
      item.limit ??
      item.amount ??
      0
    );
    const remainingAmount = currentSpending?.remaining !== undefined
      ? Number(currentSpending.remaining)
      : (limitAmount - spentAmount);

    const isOverspent = Boolean(
      (currentSpending?.overspent !== undefined && Number(currentSpending.overspent) > 0) ||
      remainingAmount < 0
    );

    return {
      id: item.id || item.budgetId || '',
      name: item.name || item.budgetName || 'Unnamed Budget',
      spentAmount,
      limitAmount,
      remainingAmount,
      currency: item.currencyCode || item.currency || 'IDR',
      isClosed: Boolean(item.closed || item.isClosed),
      period: currentSpending?.period ?? item.period ?? item.recurrence ?? item.frequency,
      periodType: item.periodType,
      isOverspent,
    };
  });
}
