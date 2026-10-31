import type {
  WalletRecordItem,
  WalletAccountItem,
  WalletCategoryItem,
} from '../types.js';
import type { WalletMcpRecordTypeValue } from '../constants.js';
import type { RawRecordItem } from '../mcp/toolWrappers.js';

export function normalizeRawRecord(item: RawRecordItem): WalletRecordItem {
  let resolvedAmount = 0;
  let resolvedCurrency = 'IDR';

  if (typeof item.amount === 'number') {
    resolvedAmount = item.amount;
  } else if (typeof item.amount === 'object' && item.amount !== null) {
    resolvedAmount = typeof item.amount.value === 'number' ? item.amount.value : 0;
    resolvedCurrency = item.amount.currencyCode || resolvedCurrency;
  }

  resolvedCurrency = item.currencyCode || item.currency || resolvedCurrency;

  let categoryObject: WalletRecordItem['category'] = undefined;
  if (item.category && typeof item.category === 'object') {
    categoryObject = {
      id: String(item.category.id || item.categoryId || ''),
      name: String(item.category.name || item.categoryName || ''),
      color: item.category.color,
      group: item.category.group,
    };
  } else if (item.categoryId) {
    categoryObject = {
      id: String(item.categoryId),
      name: item.categoryName ? String(item.categoryName) : 'Unknown',
    };
  }

  let labelsArray: WalletRecordItem['labels'] = undefined;
  if (Array.isArray(item.labels)) {
    labelsArray = item.labels.map((label: any) => ({
      id: String(label.id || label.labelId || ''),
      name: String(label.name || label.title || ''),
      color: label.color,
      icon: label.icon,
    }));
  }

  let transferObject: WalletRecordItem['transfer'] = undefined;
  if (item.transfer && typeof item.transfer === 'object') {
    transferObject = {
      type: item.transfer.type || item.transfer.pairingMode || 'paired',
      transferId: item.transfer.transferId || item.transfer.recordId,
      mirrorRecord: item.transfer.mirrorRecord,
    };
  }

  return {
    id: item.id || item.recordId || '',
    accountId: item.accountId || '',
    accountName: item.accountName,
    amount: resolvedAmount,
    currency: resolvedCurrency,
    recordDate: item.recordDate || '',
    recordType: (item.recordType || item.type || 'expense') as WalletMcpRecordTypeValue,
    category: categoryObject,
    note: item.note,
    counterParty: item.counterParty,
    labels: labelsArray,
    recordState: item.recordState,
    source: item.source,
    transfer: transferObject,
  };
}

export function normalizeRawRecords(rawRecordArray: readonly RawRecordItem[]): WalletRecordItem[] {
  return rawRecordArray.map(normalizeRawRecord);
}

/**
 * Enriches a list of normalized wallet records with account names and category details
 * from cached entities when upstream records have incomplete entity information.
 */
export function enrichHistoryRecords(
  records: WalletRecordItem[],
  cachedAccounts: WalletAccountItem[] = [],
  cachedCategories: WalletCategoryItem[] = []
): WalletRecordItem[] {
  return records.map(recordItem => {
    let enrichedAccountName = recordItem.accountName;
    if (!enrichedAccountName && recordItem.accountId && cachedAccounts.length > 0) {
      const matched = cachedAccounts.find(account => account.id === recordItem.accountId);
      if (matched) enrichedAccountName = matched.name;
    }

    let enrichedCategory = recordItem.category;
    const categoryId = recordItem.category?.id;
    if ((!enrichedCategory?.name || enrichedCategory.name === 'Unknown') && categoryId && cachedCategories.length > 0) {
      const matchedCat = cachedCategories.find(cat => cat.id === categoryId);
      if (matchedCat) {
        enrichedCategory = {
          id: matchedCat.id,
          name: matchedCat.name,
          color: enrichedCategory?.color,
          group: enrichedCategory?.group,
        };
      } else if (!enrichedCategory?.name) {
        enrichedCategory = { id: categoryId, name: 'Unknown' };
      }
    }

    return {
      ...recordItem,
      accountName: enrichedAccountName,
      category: enrichedCategory,
    };
  });
}

