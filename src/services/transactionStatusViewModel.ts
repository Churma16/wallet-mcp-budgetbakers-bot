import {
  PendingTransactionService,
  PendingTransactionItem,
  PendingAccountSelectionDraft,
} from './pendingTransactionService.js';
import { formatCurrencyAmount } from '../utils/humanResponseFormatter.js';
import { SupportedLanguage } from '../i18n/index.js';

export type TransactionAttentionStatus =
  | 'NEEDS_CHECK'
  | 'WAITING_FOR_CONFIRMATION'
  | 'WAITING_FOR_ACCOUNT';

export interface TransactionAttentionItemViewModel {
  ticketId: number;
  status: TransactionAttentionStatus;
  amount: number;
  currency?: string;
  formattedAmount: string;
  description: string;
  accountName: string;
  categoryName?: string;
  isTransfer: boolean;
  destinationAccountName?: string;
  createdAt: Date;
  primaryAction: string;
  secondaryAction: string;
  sourceKind: 'STANDARD' | 'CLARIFICATION_DRAFT';
}

export interface TransactionAttentionSummaryViewModel {
  totalNeedingAttention: number;
  needsCheckItems: TransactionAttentionItemViewModel[];
  waitingConfirmationItems: TransactionAttentionItemViewModel[];
  waitingAccountItems: TransactionAttentionItemViewModel[];
}

export function buildItemViewModelFromPendingItem(
  item: PendingTransactionItem,
  status: TransactionAttentionStatus,
  languageCode?: SupportedLanguage
): TransactionAttentionItemViewModel {
  const isTransfer = item.transactionType === 'TRANSFER';
  const formattedAmount = formatCurrencyAmount(item.amount, item.currency, languageCode);
  const description = item.counterParty || item.note || item.bankDisplayName || 'Transaksi';
  const accountName = item.accountNameHint || 'Akun';

  let primaryAction = 'MARK_PRESENT';
  let secondaryAction = 'MARK_ABSENT';
  if (status === 'WAITING_FOR_CONFIRMATION') {
    primaryAction = 'CONFIRM';
    secondaryAction = 'CANCEL';
  }

  return {
    ticketId: item.ticketId,
    status,
    amount: item.amount,
    currency: item.currency,
    formattedAmount,
    description,
    accountName,
    categoryName: item.matchedCategoryName,
    isTransfer,
    destinationAccountName: item.destinationAccountNameHint,
    createdAt: item.createdAt,
    primaryAction,
    secondaryAction,
    sourceKind: 'STANDARD',
  };
}

export function buildItemViewModelFromClarificationDraft(
  draft: PendingAccountSelectionDraft,
  status: TransactionAttentionStatus,
  languageCode?: SupportedLanguage
): TransactionAttentionItemViewModel {
  const record = draft.records[draft.pendingRecordIndex] || draft.records[0];
  const draftCurrency = record?.currency || draft.candidateAccounts[0]?.currency;
  const amount = record ? Number(record.amount) : 0;
  const formattedAmount = formatCurrencyAmount(amount, draftCurrency, languageCode);
  const description = record?.note || record?.counterParty || 'Transaksi';
  const accountName = draft.accountHint || draft.candidateAccounts[0]?.name || 'Akun';

  let primaryAction = 'MARK_PRESENT';
  let secondaryAction = 'MARK_ABSENT';
  if (status === 'WAITING_FOR_ACCOUNT') {
    primaryAction = 'SELECT_ACCOUNT';
    secondaryAction = 'CANCEL';
  }

  return {
    ticketId: draft.ticketId,
    status,
    amount,
    currency: draftCurrency,
    formattedAmount,
    description,
    accountName,
    isTransfer: false,
    createdAt: draft.createdAt,
    primaryAction,
    secondaryAction,
    sourceKind: 'CLARIFICATION_DRAFT',
  };
}

export function buildTransactionAttentionSummary(
  pendingService: PendingTransactionService,
  languageCode?: SupportedLanguage
): TransactionAttentionSummaryViewModel {
  const needsCheckItems: TransactionAttentionItemViewModel[] = [];
  const waitingConfirmationItems: TransactionAttentionItemViewModel[] = [];
  const waitingAccountItems: TransactionAttentionItemViewModel[] = [];

  const standardItems = pendingService.getAllPendingTransactions();
  for (const item of standardItems) {
    const state = pendingService.getPendingTransactionState(item.ticketId);
    if (state === 'UNKNOWN') {
      needsCheckItems.push(buildItemViewModelFromPendingItem(item, 'NEEDS_CHECK', languageCode));
    } else if (state === 'PENDING') {
      waitingConfirmationItems.push(
        buildItemViewModelFromPendingItem(item, 'WAITING_FOR_CONFIRMATION', languageCode)
      );
    }
  }

  const clarificationDrafts = pendingService.getAllPendingAccountSelectionDrafts();
  for (const draft of clarificationDrafts) {
    const state = pendingService.getPendingAccountSelectionDraftState(draft.ticketId);
    if (state === 'UNKNOWN') {
      needsCheckItems.push(buildItemViewModelFromClarificationDraft(draft, 'NEEDS_CHECK', languageCode));
    } else if (state === 'PENDING') {
      waitingAccountItems.push(
        buildItemViewModelFromClarificationDraft(draft, 'WAITING_FOR_ACCOUNT', languageCode)
      );
    }
  }

  // Sort by ticketId ascending
  needsCheckItems.sort((first, second) => first.ticketId - second.ticketId);
  waitingConfirmationItems.sort((first, second) => first.ticketId - second.ticketId);
  waitingAccountItems.sort((first, second) => first.ticketId - second.ticketId);

  const totalNeedingAttention =
    needsCheckItems.length + waitingConfirmationItems.length + waitingAccountItems.length;

  return {
    totalNeedingAttention,
    needsCheckItems,
    waitingConfirmationItems,
    waitingAccountItems,
  };
}
