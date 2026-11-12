import {
  TransactionAttentionSummaryViewModel,
  TransactionAttentionItemViewModel,
} from './transactionStatusViewModel.js';
import type { PendingTransactionItem } from '../../core/pending.js';
import { formatCurrencyAmount, formatTransactionDate } from './humanResponseFormatter.js';
import { getDefaultCurrency } from '../../config/applicationConfig.js';
import { getDictionary, SupportedLanguage } from '../../i18n/index.js';

/**
 * Formats a comprehensive transaction attention summary for "check queue" or status commands.
 */
export function formatTransactionAttentionSummary(
  summary: TransactionAttentionSummaryViewModel,
  languageCode?: SupportedLanguage
): string {
  const dictionary = getDictionary(languageCode);
  const parts: string[] = [dictionary.status.header];

  if (summary.totalNeedingAttention === 0) {
    parts.push('', dictionary.status.emptyAttention);
    return parts.join('\n');
  }

  // 1. Items needing manual verification (UNKNOWN state)
  if (summary.needsCheckItems.length > 0) {
    parts.push('', dictionary.status.needsCheckHeader(summary.needsCheckItems.length));
    const isSingleUncertain = summary.needsCheckItems.length === 1;

    for (const item of summary.needsCheckItems) {
      const ticketLabel = `(#${item.ticketId})`;
      const line = `• *${item.formattedAmount}* • ${item.description} ${ticketLabel}`.trim();
      const explanation = dictionary.languageCode === 'id'
        ? isSingleUncertain
          ? '  Belum dapat dipastikan apakah sudah masuk ke Wallet. Balas *Sudah ada* atau *Belum ada*.'
          : `  Belum dapat dipastikan apakah sudah masuk ke Wallet. Balas *Sudah ada #${item.ticketId}* atau *Belum ada #${item.ticketId}*.`
        : isSingleUncertain
          ? '  Cannot confirm whether saved to Wallet yet. Reply *Already exists* or *Not there*.'
          : `  Cannot confirm whether saved to Wallet yet. Reply *Already exists #${item.ticketId}* or *Not there #${item.ticketId}*.`;
      parts.push(line, explanation);
    }
  }

  // 2. Items waiting for user confirmation (standard PENDING items)
  if (summary.waitingConfirmationItems.length > 0) {
    parts.push('', dictionary.status.waitingConfirmationHeader(summary.waitingConfirmationItems.length));
    const isSinglePending = summary.waitingConfirmationItems.length === 1 && summary.totalNeedingAttention === 1;

    for (const item of summary.waitingConfirmationItems) {
      const ticketLabel = `(#${item.ticketId})`;
      const line = `• *${item.formattedAmount}* • ${item.description} ${ticketLabel}`.trim();
      const actionHint = dictionary.languageCode === 'id'
        ? isSinglePending
          ? '  Balas *Ya* atau *Batal*.'
          : `  Balas *Ya #${item.ticketId}* atau *Batal #${item.ticketId}*.`
        : isSinglePending
          ? '  Reply *Yes* or *Cancel*.'
          : `  Reply *Yes #${item.ticketId}* or *Cancel #${item.ticketId}*.`;
      parts.push(line, actionHint);
    }
  }

  // 3. Items waiting for account selection (draft PENDING items)
  if (summary.waitingAccountItems.length > 0) {
    parts.push('', dictionary.status.waitingAccountHeader(summary.waitingAccountItems.length));

    for (const item of summary.waitingAccountItems) {
      const ticketLabel = `(#${item.ticketId})`;
      const line = `• *${item.formattedAmount}* • ${item.description} ${ticketLabel}`.trim();
      const actionHint = dictionary.languageCode === 'id'
        ? `  Balas dengan nomor pilihan akun atau *Batal #${item.ticketId}*.`
        : `  Reply with chosen account option or *Cancel #${item.ticketId}*.`;
      parts.push(line, actionHint);
    }
  }

  // 4. Items waiting for category selection (draft PENDING items)
  if (summary.waitingCategoryItems && summary.waitingCategoryItems.length > 0) {
    parts.push('', dictionary.status.waitingCategoryHeader(summary.waitingCategoryItems.length));

    for (const item of summary.waitingCategoryItems) {
      const ticketLabel = `(#${item.ticketId})`;
      const line = `• *${item.formattedAmount}* • ${item.description} ${ticketLabel}`.trim();
      const actionHint = dictionary.languageCode === 'id'
        ? `  Balas dengan nomor pilihan kategori atau *Batal #${item.ticketId}*.`
        : `  Reply with chosen category option or *Cancel #${item.ticketId}*.`;
      parts.push(line, actionHint);
    }
  }

  // If there are ONLY uncertain items, explicitly reassure that there are no normal pending items
  if (
    summary.needsCheckItems.length > 0 &&
    summary.waitingConfirmationItems.length === 0 &&
    summary.waitingAccountItems.length === 0 &&
    (!summary.waitingCategoryItems || summary.waitingCategoryItems.length === 0)
  ) {
    parts.push('', dictionary.status.noOtherTransactionsWaiting);
  }

  return parts.join('\n');
}

/**
 * Formats the response sent when one or more transactions end in an UNKNOWN dispatch outcome.
 * totalUncertainCount is the global UNKNOWN count, not merely the number of items being rendered.
 * This prevents a single-item response from advertising an unnumbered command that would be
 * ambiguous against another UNKNOWN item elsewhere in the pending service.
 */
export function formatUncertainOutcomeResponse(
  items: TransactionAttentionItemViewModel[] | TransactionAttentionItemViewModel,
  languageCode?: SupportedLanguage,
  totalUncertainCount?: number
): string {
  const dictionary = getDictionary(languageCode);
  const itemList = Array.isArray(items) ? items : [items];
  const globalUncertainCount = totalUncertainCount ?? itemList.length;
  const parts: string[] = [dictionary.uncertain.title, ''];

  if (itemList.length === 1) {
    const single = itemList[0];
    const ticketSuffix = ` (#${single.ticketId})`;
    parts.push(`*${single.formattedAmount}* • ${single.description}${ticketSuffix}`);
    if (single.accountName) {
      const accountLabel = dictionary.languageCode === 'id' ? 'Akun' : 'Account';
      parts.push(`${accountLabel}: ${single.accountName}`);
    }
    parts.push('');
    parts.push(dictionary.uncertain.riskWarning);
    parts.push('');
    if (globalUncertainCount > 1) {
      parts.push(dictionary.uncertain.actionPromptMultiple([single.ticketId]));
    } else {
      parts.push(dictionary.uncertain.actionPromptSingle);
    }
  } else {
    for (const item of itemList) {
      const ticketSuffix = ` (#${item.ticketId})`;
      parts.push(`• *${item.formattedAmount}* • ${item.description}${ticketSuffix}`);
      if (item.accountName) {
        const accountLabel = dictionary.languageCode === 'id' ? 'Akun' : 'Account';
        parts.push(`  ${accountLabel}: ${item.accountName}`);
      }
    }
    parts.push('');
    parts.push(dictionary.uncertain.riskWarning);
    parts.push('');
    const ticketIds = itemList.map(item => item.ticketId);
    parts.push(dictionary.uncertain.actionPromptMultiple(ticketIds));
  }

  return parts.join('\n');
}

/**
 * Formats reconciliation response when user confirms transaction is already recorded in Wallet.
 */
export function formatReconciliationRecordedResponse(
  ticketId?: number,
  languageCode?: SupportedLanguage
): string {
  const dictionary = getDictionary(languageCode);
  return ticketId !== undefined
    ? dictionary.reconciliation.recordedWithTicket(ticketId)
    : dictionary.reconciliation.recordedSingle;
}

/**
 * Formats reconciliation response when user confirms transaction is NOT yet in Wallet.
 */
export function formatReconciliationAbsentResponse(
  ticketId?: number,
  languageCode?: SupportedLanguage
): string {
  const dictionary = getDictionary(languageCode);
  return ticketId !== undefined
    ? dictionary.reconciliation.absentWithTicket(ticketId)
    : dictionary.reconciliation.absentSingle;
}

/**
 * Formats reconciliation response when ticket is not found or already resolved.
 */
export function formatReconciliationNotFoundResponse(
  ticketId?: number,
  languageCode?: SupportedLanguage
): string {
  const dictionary = getDictionary(languageCode);
  return ticketId !== undefined
    ? dictionary.reconciliation.notFoundWithTicket(ticketId)
    : dictionary.reconciliation.notFoundNone;
}

/**
 * Formats reconciliation response when unnumbered command is ambiguous across multiple uncertain items.
 */
export function formatReconciliationAmbiguousResponse(
  items: TransactionAttentionItemViewModel[],
  languageCode?: SupportedLanguage
): string {
  const dictionary = getDictionary(languageCode);
  const ticketIds = items.map(item => item.ticketId);
  return dictionary.reconciliation.ambiguous(ticketIds);
}

/**
 * Formats an individual pending transaction as a standalone mobile card for per-bubble queue display.
 */
export function formatPendingQueueItemCard(
  pendingItem: PendingTransactionItem,
  languageCode?: SupportedLanguage
): string {
  const dictionary = getDictionary(languageCode);
  const isTransfer = pendingItem.transactionType === 'TRANSFER';
  const isExpense = pendingItem.amount < 0 || pendingItem.transactionType === 'EXPENSE';
  const typeIcon = isTransfer ? '🔄' : isExpense ? '💸' : '💰';
  const itemCurrency = pendingItem.currency || getDefaultCurrency();
  const formattedAmount = formatCurrencyAmount(pendingItem.amount, itemCurrency, languageCode);
  const formattedTime = formatTransactionDate(pendingItem.recordDate, languageCode);

  const headline = dictionary.status.queueItemHeadline(pendingItem.ticketId);
  const promptBody = dictionary.status.queueItemPrompt;

  if (isTransfer) {
    const defaultAccount = dictionary.languageCode === 'en' ? 'Account' : 'Akun';
    const route = pendingItem.destinationAccountNameHint
      ? `${pendingItem.accountNameHint || defaultAccount} ➔ ${pendingItem.destinationAccountNameHint}`
      : (pendingItem.accountNameHint || defaultAccount);

    const lines = [
      headline,
      '',
      `🔁 ${formattedAmount}`,
      `💳 ${route}`,
      `⏰ ${formattedTime}`,
    ];
    if (pendingItem.note) {
      lines.push(`📝 ${pendingItem.note}`);
    }
    lines.push('', promptBody);
    return lines.join('\n');
  }

  const account = pendingItem.accountNameHint || (dictionary.languageCode === 'en' ? 'Account' : 'Akun');
  const category = pendingItem.matchedCategoryName || (dictionary.languageCode === 'en' ? 'General' : 'Umum');
  const merchant = pendingItem.counterParty || pendingItem.bankDisplayName;

  const lines = [
    headline,
    '',
    `${typeIcon} ${formattedAmount} • ${account}`,
  ];

  if (merchant) {
    lines.push(`🏪 ${merchant}`);
  }

  lines.push(`🏷️ ${category} • ${formattedTime}`);

  if (pendingItem.note && pendingItem.note !== merchant) {
    lines.push(`📝 ${pendingItem.note}`);
  }

  if (pendingItem.isBankSyncedAccount) {
    lines.push(
      dictionary.languageCode === 'en'
        ? '💡 _This account is synced with Wallet bank sync._'
        : '💡 _Rekening ini terhubung dengan bank sync Wallet._'
    );
  }

  lines.push('', promptBody);
  return lines.join('\n');
}

/**
 * Fallback formatter for pending queue card using ViewModel representation.
 */
export function formatPendingQueueItemFromViewModel(
  item: TransactionAttentionItemViewModel,
  languageCode?: SupportedLanguage
): string {
  const dictionary = getDictionary(languageCode);
  const headline = dictionary.status.queueItemHeadline(item.ticketId);
  const promptBody = dictionary.status.queueItemPrompt;
  const formattedTime = formatTransactionDate(item.createdAt.toISOString(), languageCode);

  if (item.isTransfer) {
    const route = item.destinationAccountName
      ? `${item.accountName} ➔ ${item.destinationAccountName}`
      : item.accountName;

    const lines = [
      headline,
      '',
      `🔁 ${item.formattedAmount}`,
      `💳 ${route}`,
      `⏰ ${formattedTime}`,
    ];
    if (item.description && item.description !== 'Transaksi') {
      lines.push(`📝 ${item.description}`);
    }
    lines.push('', promptBody);
    return lines.join('\n');
  }

  const lines = [
    headline,
    '',
    `💸 ${item.formattedAmount} • ${item.accountName}`,
  ];

  if (item.description && item.description !== 'Transaksi') {
    lines.push(`🏪 ${item.description}`);
  }

  if (item.categoryName) {
    lines.push(`🏷️ ${item.categoryName} • ${formattedTime}`);
  } else {
    lines.push(`🏷️ ${dictionary.languageCode === 'en' ? 'General' : 'Umum'} • ${formattedTime}`);
  }

  lines.push('', promptBody);
  return lines.join('\n');
}
