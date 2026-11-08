import type { SupportedMessengerChannel } from '../gateway/index.js';
import type {
  PendingAccountSelectionDraft,
  PendingCategorySelectionDraft,
  AccountSelectionDraftUpdate,
  CategorySelectionDraftUpdate,
} from './pendingTypes.js';

/**
 * Manages in-memory storage, candidate selection updates, and channel-scoped lookups
 * for interactive account and category clarification drafts.
 */
export class ClarificationDraftStore {
  private readonly pendingAccountSelectionDraftMap: Map<number, PendingAccountSelectionDraft> = new Map();
  private readonly pendingCategorySelectionDraftMap: Map<number, PendingCategorySelectionDraft> = new Map();

  /**
   * Restores in-memory draft maps from persistent storage.
   */
  public restoreDrafts(
    accountDrafts: Map<number, PendingAccountSelectionDraft>,
    categoryDrafts: Map<number, PendingCategorySelectionDraft>
  ): void {
    this.pendingAccountSelectionDraftMap.clear();
    for (const [ticketId, draft] of accountDrafts.entries()) {
      this.pendingAccountSelectionDraftMap.set(ticketId, draft);
    }

    this.pendingCategorySelectionDraftMap.clear();
    for (const [ticketId, draft] of categoryDrafts.entries()) {
      this.pendingCategorySelectionDraftMap.set(ticketId, draft);
    }
  }

  public addAccountDraft(draft: PendingAccountSelectionDraft): void {
    this.pendingAccountSelectionDraftMap.set(draft.ticketId, draft);
  }

  public getAccountDraft(ticketId: number): PendingAccountSelectionDraft | undefined {
    return this.pendingAccountSelectionDraftMap.get(ticketId);
  }

  public getAllAccountDrafts(): PendingAccountSelectionDraft[] {
    return Array.from(this.pendingAccountSelectionDraftMap.values());
  }

  public getLatestAccountDraft(
    channel: SupportedMessengerChannel,
    chatIdentifier: string,
    senderIdentifier: string
  ): PendingAccountSelectionDraft | undefined {
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

  public updateAccountDraft(
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

  public removeAccountDraft(ticketId: number): PendingAccountSelectionDraft | undefined {
    const draft = this.pendingAccountSelectionDraftMap.get(ticketId);
    if (draft) {
      this.pendingAccountSelectionDraftMap.delete(ticketId);
    }
    return draft;
  }

  public hasAccountDrafts(
    channel?: SupportedMessengerChannel,
    chatIdentifier?: string,
    senderIdentifier?: string
  ): boolean {
    if (!channel || !chatIdentifier || !senderIdentifier) {
      return this.pendingAccountSelectionDraftMap.size > 0;
    }

    return Array.from(this.pendingAccountSelectionDraftMap.values()).some(draft =>
      draft.channel === channel &&
      draft.chatIdentifier === chatIdentifier &&
      draft.senderIdentifier === senderIdentifier
    );
  }

  public countAccountDrafts(): number {
    return this.pendingAccountSelectionDraftMap.size;
  }

  public addCategoryDraft(draft: PendingCategorySelectionDraft): void {
    this.pendingCategorySelectionDraftMap.set(draft.ticketId, draft);
  }

  public getCategoryDraft(ticketId: number): PendingCategorySelectionDraft | undefined {
    return this.pendingCategorySelectionDraftMap.get(ticketId);
  }

  public getAllCategoryDrafts(): PendingCategorySelectionDraft[] {
    return Array.from(this.pendingCategorySelectionDraftMap.values());
  }

  public getLatestCategoryDraft(
    channel: SupportedMessengerChannel,
    chatIdentifier: string,
    senderIdentifier: string
  ): PendingCategorySelectionDraft | undefined {
    const drafts = Array.from(this.pendingCategorySelectionDraftMap.values());
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

  public updateCategoryDraft(
    ticketId: number,
    update: CategorySelectionDraftUpdate
  ): PendingCategorySelectionDraft | undefined {
    const draft = this.pendingCategorySelectionDraftMap.get(ticketId);
    if (!draft) {
      return undefined;
    }

    const updatedDraft: PendingCategorySelectionDraft = {
      ...draft,
      ...update,
      records: update.records
        ? update.records.map(record => ({ ...record }))
        : draft.records,
      candidateCategories: update.candidateCategories
        ? update.candidateCategories.map(candidate => ({ ...candidate }))
        : draft.candidateCategories,
    };

    this.pendingCategorySelectionDraftMap.set(ticketId, updatedDraft);
    return updatedDraft;
  }

  public removeCategoryDraft(ticketId: number): PendingCategorySelectionDraft | undefined {
    const draft = this.pendingCategorySelectionDraftMap.get(ticketId);
    if (draft) {
      this.pendingCategorySelectionDraftMap.delete(ticketId);
    }
    return draft;
  }

  public hasCategoryDrafts(
    channel?: SupportedMessengerChannel,
    chatIdentifier?: string,
    senderIdentifier?: string
  ): boolean {
    if (!channel || !chatIdentifier || !senderIdentifier) {
      return this.pendingCategorySelectionDraftMap.size > 0;
    }

    return Array.from(this.pendingCategorySelectionDraftMap.values()).some(draft =>
      draft.channel === channel &&
      draft.chatIdentifier === chatIdentifier &&
      draft.senderIdentifier === senderIdentifier
    );
  }

  public countCategoryDrafts(): number {
    return this.pendingCategorySelectionDraftMap.size;
  }

  public hasDraft(ticketId: number): boolean {
    return (
      this.pendingAccountSelectionDraftMap.has(ticketId) ||
      this.pendingCategorySelectionDraftMap.has(ticketId)
    );
  }

  public removeDraft(ticketId: number): boolean {
    const deletedAccount = this.pendingAccountSelectionDraftMap.delete(ticketId);
    const deletedCategory = this.pendingCategorySelectionDraftMap.delete(ticketId);
    return deletedAccount || deletedCategory;
  }

  public isEmpty(): boolean {
    return (
      this.pendingAccountSelectionDraftMap.size === 0 &&
      this.pendingCategorySelectionDraftMap.size === 0
    );
  }

  public getAllTicketIds(): number[] {
    return [
      ...Array.from(this.pendingAccountSelectionDraftMap.keys()),
      ...Array.from(this.pendingCategorySelectionDraftMap.keys()),
    ];
  }

  public purgeExpiredDrafts(
    currentTime: number,
    isPending: (ticketId: number) => boolean,
    onExpired: (ticketId: number) => void
  ): boolean {
    let hasChanges = false;

    for (const [ticketId, draft] of this.pendingAccountSelectionDraftMap.entries()) {
      if (draft.expiresAt.getTime() < currentTime && isPending(ticketId)) {
        onExpired(ticketId);
        hasChanges = true;
      }
    }

    for (const [ticketId, draft] of this.pendingCategorySelectionDraftMap.entries()) {
      if (draft.expiresAt.getTime() < currentTime && isPending(ticketId)) {
        onExpired(ticketId);
        hasChanges = true;
      }
    }

    return hasChanges;
  }
}
