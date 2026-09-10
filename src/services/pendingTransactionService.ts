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
  emailSubject?: string;
  createdAt: Date;
  expiresAt: Date;
}

export type PendingTransactionDispatchState = 'PENDING' | 'PROCESSING' | 'UNKNOWN';

export class PendingTransactionService {
  private nextTicketSequentialId: number = 1;
  private readonly pendingTransactionMap: Map<number, PendingTransactionItem> = new Map();
  private readonly dispatchStateMap: Map<number, PendingTransactionDispatchState> = new Map();
  private readonly completedRecordIndexesMap: Map<number, Set<number>> = new Map();
  private readonly defaultTimeToLiveMilliseconds: number = 24 * 60 * 60 * 1000; // 24 hours

  /**
   * Registers a new pending transaction and assigns a sequential ticket ID (#1, #2, etc.)
   */
  public addPendingTransaction(
    itemData: Omit<PendingTransactionItem, 'ticketId' | 'createdAt' | 'expiresAt'>
  ): PendingTransactionItem {
    this.purgeExpiredTransactions();

    const ticketId = this.nextTicketSequentialId++;
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
    this.completedRecordIndexesMap.set(ticketId, new Set());
    return pendingItem;
  }

  /**
   * Retrieves a pending transaction by its ticket ID.
   * This includes PROCESSING and UNKNOWN tickets for inspection/status reporting.
   */
  public getPendingTransaction(ticketId: number): PendingTransactionItem | undefined {
    this.purgeExpiredTransactions();
    return this.pendingTransactionMap.get(ticketId);
  }

  /**
   * Retrieves all currently active pending transactions regardless of dispatch state.
   */
  public getAllPendingTransactions(): PendingTransactionItem[] {
    this.purgeExpiredTransactions();
    return Array.from(this.pendingTransactionMap.values());
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

  /**
   * Marks a ticket UNKNOWN when the server-side commit outcome cannot be determined safely.
   * UNKNOWN tickets are intentionally not claimable for automatic retry.
   */
  public markPendingTransactionUnknown(ticketId: number): void {
    if (this.pendingTransactionMap.has(ticketId)) {
      this.dispatchStateMap.set(ticketId, 'UNKNOWN');
    }
  }

  public getPendingTransactionState(ticketId: number): PendingTransactionDispatchState | undefined {
    this.purgeExpiredTransactions();
    return this.dispatchStateMap.get(ticketId);
  }

  /**
   * Records a successfully committed record index for multi-record transactions such as transfers.
   */
  public markRecordIndexCompleted(ticketId: number, recordIndex: number): void {
    if (!this.pendingTransactionMap.has(ticketId)) {
      return;
    }

    let completedIndexes = this.completedRecordIndexesMap.get(ticketId);
    if (!completedIndexes) {
      completedIndexes = new Set<number>();
      this.completedRecordIndexesMap.set(ticketId, completedIndexes);
    }
    completedIndexes.add(recordIndex);
  }

  public getCompletedRecordIndexes(ticketId: number): number[] {
    return Array.from(this.completedRecordIndexesMap.get(ticketId) ?? []).sort((a, b) => a - b);
  }

  /**
   * Checks if there are any active pending transactions in any dispatch state.
   */
  public hasPendingTransactions(): boolean {
    this.purgeExpiredTransactions();
    return this.pendingTransactionMap.size > 0;
  }

  /**
   * Resolves (confirms and removes) a pending transaction by its ticket ID.
   */
  public resolvePendingTransaction(ticketId: number): PendingTransactionItem | undefined {
    const item = this.pendingTransactionMap.get(ticketId);
    if (item) {
      this.removeTicketMetadata(ticketId);
    }
    return item;
  }

  /**
   * Resolves (confirms and removes) all currently pending transactions.
   */
  public resolveAllPendingTransactions(): PendingTransactionItem[] {
    const items = Array.from(this.pendingTransactionMap.values());
    this.pendingTransactionMap.clear();
    this.dispatchStateMap.clear();
    this.completedRecordIndexesMap.clear();
    return items;
  }

  /**
   * Rejects a pending/unknown transaction. PROCESSING tickets cannot be removed concurrently.
   */
  public rejectPendingTransaction(ticketId: number): PendingTransactionItem | undefined {
    const item = this.pendingTransactionMap.get(ticketId);
    if (!item || this.dispatchStateMap.get(ticketId) === 'PROCESSING') {
      return undefined;
    }

    this.removeTicketMetadata(ticketId);
    return item;
  }

  /**
   * Rejects all tickets that are not currently PROCESSING.
   */
  public rejectAllPendingTransactions(): PendingTransactionItem[] {
    const rejectedItems: PendingTransactionItem[] = [];

    for (const [ticketId, item] of Array.from(this.pendingTransactionMap.entries())) {
      if (this.dispatchStateMap.get(ticketId) !== 'PROCESSING') {
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
  }

  private removeTicketMetadata(ticketId: number): void {
    this.pendingTransactionMap.delete(ticketId);
    this.dispatchStateMap.delete(ticketId);
    this.completedRecordIndexesMap.delete(ticketId);
  }
}
