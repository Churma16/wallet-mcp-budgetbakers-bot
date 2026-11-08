import type { SupportedMessengerChannel } from '../gateway/index.js';
import type { CreateRecordInputPayload, WalletTransferInput } from '../wallet/types.js';
import type { InternalTransactionTypeValue } from '../wallet/constants.js';
import { TicketDispatchState } from '../brain/constants.js';

export interface PendingTransactionItem {
  ticketId: number;
  sourceType: 'EMAIL' | 'WHATSAPP' | 'PUSH_NOTIFICATION';
  bankDisplayName: string;
  accountNameHint: string;
  counterParty: string;
  amount: number; // negative for expense, positive for income
  transactionType: InternalTransactionTypeValue;
  destinationAccountNameHint?: string;
  matchedAccountId: string;
  matchedDestinationAccountId?: string;
  matchedCategoryId?: string;
  matchedCategoryName?: string;
  note: string;
  recordDate: string; // ISO 8601 string
  currency?: string;
  referenceNumber?: string;
  referenceNumbers?: string[];
  evidenceSources?: string[];
  emailSubject?: string;
  isBankSyncedAccount?: boolean;
  clarificationPrompt?: string;
  labels?: string[];
  transfer?: WalletTransferInput;
  notificationMessageIds?: Record<string, string>;
  createdAt: Date;
  expiresAt: Date;
}

export interface PendingAccountSelectionCandidate {
  id: string;
  name: string;
  currency?: string;
  bankAccountNumber?: string;
}

export interface PendingAccountSelectionDraft {
  ticketId: number;
  sourceType: 'USER';
  channel: SupportedMessengerChannel;
  senderIdentifier: string;
  chatIdentifier: string;
  records: CreateRecordInputPayload[];
  pendingRecordIndex: number;
  accountHint: string;
  candidateAccounts: PendingAccountSelectionCandidate[];
  sourceUserText?: string;
  sourceReferenceInstant?: Date;
  createdAt: Date;
  expiresAt: Date;
}

export type PendingTransactionDispatchState =
  | TicketDispatchState.Pending
  | TicketDispatchState.Processing
  | TicketDispatchState.Unknown;

export interface PendingTransactionStorageSnapshot {
  version: number;
  nextTicketSequentialId: number;
  pendingTransactions: PendingTransactionItem[];
  pendingAccountSelectionDrafts: PendingAccountSelectionDraft[];
  pendingCategorySelectionDrafts: PendingCategorySelectionDraft[];
  dispatchStates: [number, PendingTransactionDispatchState][];
  recentlyResolvedTicketIds: [number, number][];
}

export type AccountSelectionDraftUpdate = Partial<Pick<
  PendingAccountSelectionDraft,
  'records' | 'pendingRecordIndex' | 'accountHint' | 'candidateAccounts' | 'sourceUserText' | 'sourceReferenceInstant'
>>;

export interface PendingCategorySelectionCandidate {
  id: string;
  name: string;
}

export interface PendingCategorySelectionDraft {
  ticketId: number;
  sourceType: 'USER';
  channel: SupportedMessengerChannel;
  senderIdentifier: string;
  chatIdentifier: string;
  records: CreateRecordInputPayload[];
  pendingRecordIndex: number;
  categoryHint: string;
  candidateCategories: PendingCategorySelectionCandidate[];
  sourceUserText?: string;
  sourceReferenceInstant?: Date;
  createdAt: Date;
  expiresAt: Date;
}

export type CategorySelectionDraftUpdate = Partial<Pick<
  PendingCategorySelectionDraft,
  'records' | 'pendingRecordIndex' | 'categoryHint' | 'candidateCategories' | 'sourceUserText' | 'sourceReferenceInstant'
>>;
