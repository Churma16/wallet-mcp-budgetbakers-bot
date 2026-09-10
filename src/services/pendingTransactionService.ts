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

export class PendingTransactionService {
  private nextTicketSequentialId: number = 1;
  private readonly pendingTransactionMap: Map<number, PendingTransactionItem> = new Map();
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
    return pendingItem;
  }

  /**
   * Retrieves a pending transaction by its ticket ID
   */
  public getPendingTransaction(ticketId: number): PendingTransactionItem | undefined {
    this.purgeExpiredTransactions();
    return this.pendingTransactionMap.get(ticketId);
  }

  /**
   * Retrieves all currently active pending transactions
   */
  public getAllPendingTransactions(): PendingTransactionItem[] {
    this.purgeExpiredTransactions();
    return Array.from(this.pendingTransactionMap.values());
  }

  /**
   * Retrieves the most recently created pending transaction
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
   * Checks if there are any active pending transactions
   */
  public hasPendingTransactions(): boolean {
    this.purgeExpiredTransactions();
    return this.pendingTransactionMap.size > 0;
  }

  /**
   * Resolves (confirms and removes) a pending transaction by its ticket ID
   */
  public resolvePendingTransaction(ticketId: number): PendingTransactionItem | undefined {
    const item = this.pendingTransactionMap.get(ticketId);
    if (item) {
      this.pendingTransactionMap.delete(ticketId);
    }
    return item;
  }

  /**
   * Resolves (confirms and removes) all currently pending transactions
   */
  public resolveAllPendingTransactions(): PendingTransactionItem[] {
    const items = Array.from(this.pendingTransactionMap.values());
    this.pendingTransactionMap.clear();
    return items;
  }

  /**
   * Rejects (cancels and removes) a pending transaction by its ticket ID
   */
  public rejectPendingTransaction(ticketId: number): PendingTransactionItem | undefined {
    const item = this.pendingTransactionMap.get(ticketId);
    if (item) {
      this.pendingTransactionMap.delete(ticketId);
    }
    return item;
  }

  /**
   * Rejects (cancels and removes) all pending transactions
   */
  public rejectAllPendingTransactions(): PendingTransactionItem[] {
    const items = Array.from(this.pendingTransactionMap.values());
    this.pendingTransactionMap.clear();
    return items;
  }

  /**
   * Removes any transactions that have passed their expiration timestamp
   */
  public purgeExpiredTransactions(): void {
    const currentTime = Date.now();
    for (const [ticketId, item] of this.pendingTransactionMap.entries()) {
      if (item.expiresAt.getTime() < currentTime) {
        this.pendingTransactionMap.delete(ticketId);
      }
    }
  }

  /**
   * Restores (re-adds) previously resolved transactions back into the pending queue.
   * Used for error recovery when MCP dispatch fails.
   */
  public restorePendingTransactions(items: PendingTransactionItem[]): void {
    for (const item of items) {
      this.pendingTransactionMap.set(item.ticketId, item);
    }
  }
}
