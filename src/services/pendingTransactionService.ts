import type { SupportedMessengerChannel } from './messaging/types.js';
import type { CreateRecordInputPayload } from '../types/walletTypes.js';

export interface PendingTransactionItem {
  ticketId: number;
  sourceType: 'EMAIL' | 'WHATSAPP';
  bankDisplayName: string;
  accountNameHint: string;
  counterParty: string;
  amount: number; // negative for expense, positive for income
  transactionType: 'EXPENSE' | 'INCOME' | 'TRANSFER';
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

export type PendingTransactionDispatchState = 'PENDING' | 'PROCESSING' | 'UNKNOWN';

type AccountSelectionDraftUpdate = Partial<Pick<
  PendingAccountSelectionDraft,
  'records' | 'pendingRecordIndex' | 'accountHint' | 'candidateAccounts' | 'sourceUserText' | 'sourceReferenceInstant'
>>;

export class PendingTransactionService {
  private nextTicketSequentialId: number = 1;
  private readonly pendingTransactionMap: Map<number, PendingTransactionItem> = new Map();
  private readonly pendingAccountSelectionDraftMap: Map<number, PendingAccountSelectionDraft> = new Map();
  private readonly dispatchStateMap: Map<number, PendingTransactionDispatchState> = new Map();
  private readonly recentlyResolvedTicketIds: Map<number, number> = new Map();
  private readonly defaultTimeToLiveMilliseconds: number = 24 * 60 * 60 * 1000; // 24 hours
  private readonly recentResolvedTtlMilliseconds: number = 5 * 60 * 1000; // 5 minutes

  /**
   * Registers a new pending transaction and assigns a sequential ticket ID (#1, #2, etc.)
   */
  public addPendingTransaction(
    itemData: Omit<PendingTransactionItem, 'ticketId' | 'createdAt' | 'expiresAt'>
  ): PendingTransactionItem {
    this.purgeExpiredTransactions();

    if (this.pendingTransactionMap.size === 0 && this.pendingAccountSelectionDraftMap.size === 0) {
      this.nextTicketSequentialId = 1;
    }

    const ticketId = this.nextTicketSequentialId++;
    this.recentlyResolvedTicketIds.delete(ticketId);
    const createdAt = new Date();
    const expiresAt = new Date(createdAt.getTime() + this.defaultTimeToLiveMilliseconds);

    const pendingItem: PendingTransactionItem = {
      ...itemData,
      ticketId,
      createdAt,
      expiresAt,
    };

    this.pendingTransactionMap.set(ticketId, pendingItem);
    this.dispatchStateMap.set(ticketId, 'PENDING');
    return pendingItem;
  }

  /**
   * Registers a user-originated transaction batch that is waiting for an account choice.
   */
  public addPendingAccountSelectionDraft(
    itemData: Omit<PendingAccountSelectionDraft, 'ticketId' | 'createdAt' | 'expiresAt'>
  ): PendingAccountSelectionDraft {
    this.purgeExpiredTransactions();

    if (this.pendingTransactionMap.size === 0 && this.pendingAccountSelectionDraftMap.size === 0) {
      this.nextTicketSequentialId = 1;
    }

    const ticketId = this.nextTicketSequentialId++;
    const createdAt = new Date();
    const expiresAt = new Date(createdAt.getTime() + this.defaultTimeToLiveMilliseconds);
    const sourceReferenceInstant = itemData.sourceReferenceInstant
      ? new Date(itemData.sourceReferenceInstant)
      : createdAt;
    const pendingDraft: PendingAccountSelectionDraft = {
      ...itemData,
      records: itemData.records.map(record => ({ ...record })),
      candidateAccounts: itemData.candidateAccounts.map(candidate => ({ ...candidate })),
      sourceReferenceInstant,
      ticketId,
      createdAt,
      expiresAt,
    };

    this.pendingAccountSelectionDraftMap.set(ticketId, pendingDraft);
    this.dispatchStateMap.set(ticketId, 'PENDING');
    return pendingDraft;
  }

  /**
   * Retrieves a pending transaction by its ticket ID.
   * This includes PROCESSING and UNKNOWN tickets for inspection/status reporting.
   */
  public getPendingTransaction(ticketId: number): PendingTransactionItem | undefined {
    this.purgeExpiredTransactions();
    return this.pendingTransactionMap.get(ticketId);
  }

  public getPendingAccountSelectionDraft(ticketId: number): PendingAccountSelectionDraft | undefined {
    this.purgeExpiredTransactions();
    return this.pendingAccountSelectionDraftMap.get(ticketId);
  }

  /**
   * Retrieves all currently active pending transactions regardless of dispatch state.
   */
  public getAllPendingTransactions(): PendingTransactionItem[] {
    this.purgeExpiredTransactions();
    return Array.from(this.pendingTransactionMap.values());
  }

  public getAllPendingAccountSelectionDrafts(): PendingAccountSelectionDraft[] {
    this.purgeExpiredTransactions();
    return Array.from(this.pendingAccountSelectionDraftMap.values());
  }

  /**
   * Retrieves the most recently created pending transaction.
   */
  public getLatestPendingTransaction(): PendingTransactionItem | undefined {
    this.purgeExpiredTransactions();
    const items = Array.from(this.pendingTransactionMap.values());
    if (items.length === 0) {
      return undefined;
    }
    return items[items.length - 1];
  }

  /**
   * Retrieves the oldest created pending transaction with PENDING status (FIFO).
   */
  public getOldestPendingTransaction(): PendingTransactionItem | undefined {
    this.purgeExpiredTransactions();
    for (const [ticketId, item] of this.pendingTransactionMap.entries()) {
      if (this.dispatchStateMap.get(ticketId) === 'PENDING') {
        return item;
      }
    }
    return undefined;
  }

  public getLatestPendingAccountSelectionDraft(
    channel: SupportedMessengerChannel,
    chatIdentifier: string,
    senderIdentifier: string
  ): PendingAccountSelectionDraft | undefined {
    this.purgeExpiredTransactions();
    const drafts = Array.from(this.pendingAccountSelectionDraftMap.values());

    for (let index = drafts.length - 1; index >= 0; index--) {
      const draft = drafts[index];
      if (
        draft.channel === channel &&
        draft.chatIdentifier === chatIdentifier &&
        draft.senderIdentifier === senderIdentifier
      ) {
        return draft;
      }
    }

    return undefined;
  }

  /**
   * Atomically claims one PENDING ticket before external I/O.
   * A second concurrent confirmation cannot claim the same ticket.
   */
  public claimPendingTransaction(ticketId: number): PendingTransactionItem | undefined {
    this.purgeExpiredTransactions();
    const item = this.pendingTransactionMap.get(ticketId);
    if (!item || this.dispatchStateMap.get(ticketId) !== 'PENDING') {
      return undefined;
    }

    this.dispatchStateMap.set(ticketId, 'PROCESSING');
    return item;
  }

  public claimPendingAccountSelectionDraft(ticketId: number): PendingAccountSelectionDraft | undefined {
    this.purgeExpiredTransactions();
    const draft = this.pendingAccountSelectionDraftMap.get(ticketId);
    if (!draft || this.dispatchStateMap.get(ticketId) !== 'PENDING') {
      return undefined;
    }

    this.dispatchStateMap.set(ticketId, 'PROCESSING');
    return draft;
  }

  /**
   * Atomically claims all currently PENDING tickets.
   */
  public claimAllPendingTransactions(): PendingTransactionItem[] {
    this.purgeExpiredTransactions();
    const claimedItems: PendingTransactionItem[] = [];

    for (const [ticketId, item] of this.pendingTransactionMap.entries()) {
      if (this.dispatchStateMap.get(ticketId) === 'PENDING') {
        this.dispatchStateMap.set(ticketId, 'PROCESSING');
        claimedItems.push(item);
      }
    }

    return claimedItems;
  }

  /**
   * Atomically claims the newest PENDING ticket.
   */
  public claimLatestPendingTransaction(): PendingTransactionItem | undefined {
    this.purgeExpiredTransactions();
    const entries = Array.from(this.pendingTransactionMap.entries());

    for (let index = entries.length - 1; index >= 0; index--) {
      const [ticketId, item] = entries[index];
      if (this.dispatchStateMap.get(ticketId) === 'PENDING') {
        this.dispatchStateMap.set(ticketId, 'PROCESSING');
        return item;
      }
    }

    return undefined;
  }

  /**
   * Atomically claims the oldest PENDING ticket (FIFO).
   * Used for bare confirmations ('Ya' / 'Catat') so sequential confirmations
   * process chronologically without race collisions.
   */
  public claimOldestPendingTransaction(): PendingTransactionItem | undefined {
    this.purgeExpiredTransactions();
    for (const [ticketId, item] of this.pendingTransactionMap.entries()) {
      if (this.dispatchStateMap.get(ticketId) === 'PENDING') {
        this.dispatchStateMap.set(ticketId, 'PROCESSING');
        return item;
      }
    }

    return undefined;
  }

  /**
   * Returns a PROCESSING ticket to PENDING after a definitive non-commit failure.
   */
  public releaseProcessingTransaction(ticketId: number): void {
    if (
      this.pendingTransactionMap.has(ticketId) &&
      this.dispatchStateMap.get(ticketId) === 'PROCESSING'
    ) {
      this.dispatchStateMap.set(ticketId, 'PENDING');
    }
  }

  public releaseProcessingAccountSelectionDraft(ticketId: number): void {
    if (
      this.pendingAccountSelectionDraftMap.has(ticketId) &&
      this.dispatchStateMap.get(ticketId) === 'PROCESSING'
    ) {
      this.dispatchStateMap.set(ticketId, 'PENDING');
    }
  }

  public updatePendingAccountSelectionDraft(
    ticketId: number,
    update: AccountSelectionDraftUpdate
  ): PendingAccountSelectionDraft | undefined {
    const draft = this.pendingAccountSelectionDraftMap.get(ticketId);
    if (!draft) {
      return undefined;
    }

    const updatedDraft: PendingAccountSelectionDraft = {
      ...draft,
      ...update,
      records: update.records
        ? update.records.map(record => ({ ...record }))
        : draft.records,
      candidateAccounts: update.candidateAccounts
        ? update.candidateAccounts.map(candidate => ({ ...candidate }))
        : draft.candidateAccounts,
    };

    this.pendingAccountSelectionDraftMap.set(ticketId, updatedDraft);
    return updatedDraft;
  }

  /**
   * Enriches or updates an existing PENDING transaction with additional multi-source evidence
   * (e.g. merging bank debit with merchant itemized receipt) without altering its ticket ID or lifecycle.
   */
  public enrichPendingTransaction(
    ticketId: number,
    update: Partial<PendingTransactionItem>
  ): PendingTransactionItem | undefined {
    const existingItem = this.pendingTransactionMap.get(ticketId);
    if (!existingItem || this.dispatchStateMap.get(ticketId) !== 'PENDING') {
      return undefined;
    }

    const mergedReferenceNumbers = Array.from(
      new Set([
        ...(existingItem.referenceNumbers || []),
        ...(existingItem.referenceNumber ? [existingItem.referenceNumber] : []),
        ...(update.referenceNumbers || []),
        ...(update.referenceNumber ? [update.referenceNumber] : []),
      ])
    ).filter(Boolean);

    const mergedEvidenceSources = Array.from(
      new Set([
        ...(existingItem.evidenceSources || []),
        ...(update.evidenceSources || []),
      ])
    ).filter(Boolean);

    const updatedItem: PendingTransactionItem = {
      ...existingItem,
      ...update,
      ticketId: existingItem.ticketId,
      createdAt: existingItem.createdAt,
      expiresAt: existingItem.expiresAt,
      isBankSyncedAccount: update.isBankSyncedAccount ?? existingItem.isBankSyncedAccount,
      clarificationPrompt: update.clarificationPrompt ?? existingItem.clarificationPrompt,
      referenceNumbers: mergedReferenceNumbers.length > 0 ? mergedReferenceNumbers : undefined,
      referenceNumber: update.referenceNumber || existingItem.referenceNumber || mergedReferenceNumbers[0],
      evidenceSources: mergedEvidenceSources.length > 0 ? mergedEvidenceSources : undefined,
    };

    this.pendingTransactionMap.set(ticketId, updatedItem);
    return updatedItem;
  }


  /**
   * Marks a ticket UNKNOWN when the server-side commit outcome cannot be determined safely.
   * UNKNOWN tickets are intentionally not claimable for automatic retry.
   */
  public markPendingTransactionUnknown(ticketId: number): void {
    if (this.pendingTransactionMap.has(ticketId)) {
      this.dispatchStateMap.set(ticketId, 'UNKNOWN');
    }
  }

  public markPendingAccountSelectionDraftUnknown(ticketId: number): void {
    if (this.pendingAccountSelectionDraftMap.has(ticketId)) {
      this.dispatchStateMap.set(ticketId, 'UNKNOWN');
    }
  }

  /**
   * Reopens an UNKNOWN transaction or draft as PENDING after conservative reconciliation.
   * Never triggers an automatic write.
   */
  public reopenUnknownTransactionAsPending(ticketId: number): boolean {
    if (
      this.pendingTransactionMap.has(ticketId) &&
      this.dispatchStateMap.get(ticketId) === 'UNKNOWN'
    ) {
      this.dispatchStateMap.set(ticketId, 'PENDING');
      return true;
    }

    if (
      this.pendingAccountSelectionDraftMap.has(ticketId) &&
      this.dispatchStateMap.get(ticketId) === 'UNKNOWN'
    ) {
      this.dispatchStateMap.set(ticketId, 'PENDING');
      return true;
    }

    return false;
  }

  public getUncertainTransactions(): PendingTransactionItem[] {
    this.purgeExpiredTransactions();
    return Array.from(this.pendingTransactionMap.values()).filter(
      item => this.dispatchStateMap.get(item.ticketId) === 'UNKNOWN'
    );
  }

  public getUncertainAccountSelectionDrafts(): PendingAccountSelectionDraft[] {
    this.purgeExpiredTransactions();
    return Array.from(this.pendingAccountSelectionDraftMap.values()).filter(
      draft => this.dispatchStateMap.get(draft.ticketId) === 'UNKNOWN'
    );
  }

  public hasUncertainTransactions(): boolean {
    this.purgeExpiredTransactions();
    return (
      this.getUncertainTransactions().length > 0 ||
      this.getUncertainAccountSelectionDrafts().length > 0
    );
  }

  public getPendingTransactionState(ticketId: number): PendingTransactionDispatchState | undefined {
    this.purgeExpiredTransactions();
    if (!this.pendingTransactionMap.has(ticketId)) {
      return undefined;
    }
    return this.dispatchStateMap.get(ticketId);
  }

  public getPendingAccountSelectionDraftState(
    ticketId: number
  ): PendingTransactionDispatchState | undefined {
    this.purgeExpiredTransactions();
    if (!this.pendingAccountSelectionDraftMap.has(ticketId)) {
      return undefined;
    }
    return this.dispatchStateMap.get(ticketId);
  }

  /**
   * Checks if there are any active pending transactions in any dispatch state.
   */
  public hasPendingTransactions(): boolean {
    this.purgeExpiredTransactions();
    return this.pendingTransactionMap.size > 0;
  }

  public hasPendingAccountSelectionDrafts(
    channel?: SupportedMessengerChannel,
    chatIdentifier?: string,
    senderIdentifier?: string
  ): boolean {
    this.purgeExpiredTransactions();
    if (!channel || !chatIdentifier || !senderIdentifier) {
      return this.pendingAccountSelectionDraftMap.size > 0;
    }

    return Array.from(this.pendingAccountSelectionDraftMap.values()).some(draft =>
      draft.channel === channel &&
      draft.chatIdentifier === chatIdentifier &&
      draft.senderIdentifier === senderIdentifier
    );
  }

  /**
   * Resolves (confirms and removes) a pending transaction by its ticket ID.
   */
  public resolvePendingTransaction(ticketId: number): PendingTransactionItem | undefined {
    const item = this.pendingTransactionMap.get(ticketId);
    if (item) {
      this.recentlyResolvedTicketIds.set(ticketId, Date.now());
      this.removeTicketMetadata(ticketId);
    }
    return item;
  }

  public resolvePendingAccountSelectionDraft(
    ticketId: number
  ): PendingAccountSelectionDraft | undefined {
    const draft = this.pendingAccountSelectionDraftMap.get(ticketId);
    if (draft) {
      this.recentlyResolvedTicketIds.set(ticketId, Date.now());
      this.removeTicketMetadata(ticketId);
    }
    return draft;
  }

  /**
   * Resolves (confirms and removes) all currently pending transactions.
   */
  public resolveAllPendingTransactions(): PendingTransactionItem[] {
    const items = Array.from(this.pendingTransactionMap.values());
    const now = Date.now();
    for (const ticketId of this.pendingTransactionMap.keys()) {
      this.recentlyResolvedTicketIds.set(ticketId, now);
      this.removeTicketMetadata(ticketId);
    }
    return items;
  }

  /**
   * Rejects a PENDING transaction. PROCESSING and UNKNOWN tickets are preserved.
   */
  public rejectPendingTransaction(ticketId: number): PendingTransactionItem | undefined {
    const item = this.pendingTransactionMap.get(ticketId);
    if (!item || this.dispatchStateMap.get(ticketId) !== 'PENDING') {
      return undefined;
    }

    this.removeTicketMetadata(ticketId);
    return item;
  }

  public rejectPendingAccountSelectionDraft(
    ticketId: number
  ): PendingAccountSelectionDraft | undefined {
    const draft = this.pendingAccountSelectionDraftMap.get(ticketId);
    if (!draft || this.dispatchStateMap.get(ticketId) !== 'PENDING') {
      return undefined;
    }

    this.removeTicketMetadata(ticketId);
    return draft;
  }

  /**
   * Rejects all PENDING transactions while preserving PROCESSING and UNKNOWN tickets.
   */
  public rejectAllPendingTransactions(): PendingTransactionItem[] {
    const rejectedItems: PendingTransactionItem[] = [];

    for (const [ticketId, item] of Array.from(this.pendingTransactionMap.entries())) {
      if (this.dispatchStateMap.get(ticketId) === 'PENDING') {
        rejectedItems.push(item);
        this.removeTicketMetadata(ticketId);
      }
    }

    return rejectedItems;
  }

  /**
   * Removes expired PENDING tickets. PROCESSING/UNKNOWN tickets are retained so uncertain
   * dispatch outcomes never disappear silently before they can be reconciled.
   */
  public purgeExpiredTransactions(): void {
    const currentTime = Date.now();
    for (const [ticketId, item] of this.pendingTransactionMap.entries()) {
      if (
        item.expiresAt.getTime() < currentTime &&
        this.dispatchStateMap.get(ticketId) === 'PENDING'
      ) {
        this.removeTicketMetadata(ticketId);
      }
    }

    for (const [ticketId, draft] of this.pendingAccountSelectionDraftMap.entries()) {
      if (
        draft.expiresAt.getTime() < currentTime &&
        this.dispatchStateMap.get(ticketId) === 'PENDING'
      ) {
        this.removeTicketMetadata(ticketId);
      }
    }

    for (const [ticketId, timestamp] of this.recentlyResolvedTicketIds.entries()) {
      if (currentTime - timestamp > this.recentResolvedTtlMilliseconds) {
        this.recentlyResolvedTicketIds.delete(ticketId);
      }
    }
  }

  public isTicketProcessing(ticketId: number): boolean {
    return this.dispatchStateMap.get(ticketId) === 'PROCESSING';
  }

  public wasTicketRecentlyResolved(ticketId: number): boolean {
    this.purgeExpiredTransactions();
    return this.recentlyResolvedTicketIds.has(ticketId);
  }

  public getNextTicketSequentialId(): number {
    return this.nextTicketSequentialId;
  }

  private removeTicketMetadata(ticketId: number): void {
    this.pendingTransactionMap.delete(ticketId);
    this.pendingAccountSelectionDraftMap.delete(ticketId);
    this.dispatchStateMap.delete(ticketId);

    if (this.pendingTransactionMap.size === 0 && this.pendingAccountSelectionDraftMap.size === 0) {
      this.nextTicketSequentialId = 1;
    }
  }
}
