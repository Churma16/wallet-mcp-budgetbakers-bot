import { WalletMcpRequestError, type WalletCacheService } from '../wallet/index.js';
import type { CreateRecordInputPayload } from '../wallet/types.js';
import type { PendingTransactionItem } from './pendingTypes.js';

/**
 * Builds standard Wallet MCP record payload(s) from a pending transaction candidate item.
 */
export function buildRecordsForPendingItem(
  item: PendingTransactionItem,
  walletCacheService?: WalletCacheService
): CreateRecordInputPayload[] {
  if (item.transactionType === 'TRANSFER') {
    if (item.transfer?.pairingMode === 'existing') {
      return [{
        accountId: item.matchedAccountId,
        amount: item.amount < 0 ? -Math.abs(item.amount) : Math.abs(item.amount),
        recordDate: item.recordDate,
        note: item.note || `Transfer ke ${item.destinationAccountNameHint || 'akun lain'}`,
        counterParty: item.destinationAccountNameHint || '',
        transfer: item.transfer,
      }];
    }

    if (!item.matchedDestinationAccountId) {
      throw new WalletMcpRequestError(
        'Transfer destination account was not resolved before dispatch',
        'DEFINITIVE_FAILURE'
      );
    }
    return [{
      accountId: item.matchedAccountId,
      amount: -Math.abs(item.amount),
      recordDate: item.recordDate,
      note: item.note || `Transfer ke ${item.destinationAccountNameHint || 'akun lain'}`,
      counterParty: item.destinationAccountNameHint || '',
      transfer: {
        pairingMode: 'new',
        accountId: item.matchedDestinationAccountId,
      },
    }];
  }

  const finalAmount = item.transactionType === 'EXPENSE'
    ? -Math.abs(item.amount)
    : Math.abs(item.amount);

  let resolvedCategoryId = item.matchedCategoryId?.trim() || undefined;
  if (!resolvedCategoryId && item.matchedCategoryName && walletCacheService) {
    const matchedCategory = walletCacheService
      .getCategories()
      .find(c => c.name.toLowerCase() === item.matchedCategoryName?.trim().toLowerCase());
    if (matchedCategory) {
      resolvedCategoryId = matchedCategory.id;
    }
  }

  if (resolvedCategoryId && walletCacheService) {
    const category = walletCacheService
      .getCategories()
      .find(c => c.id === resolvedCategoryId);
    if (category && (category.isAssignable === false || category.group?.id === 'system_categories')) {
      resolvedCategoryId = undefined;
    }
  }

  return [
    {
      accountId: item.matchedAccountId,
      categoryId: resolvedCategoryId,
      amount: finalAmount,
      recordDate: item.recordDate,
      note: item.note,
      counterParty: item.counterParty,
      labels: item.labels,
    },
  ];
}
