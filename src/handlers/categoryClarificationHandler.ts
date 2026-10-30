import {
  PendingCategorySelectionCandidate,
  PendingCategorySelectionDraft,
  PendingTransactionService,
} from '../services/pendingTransactionService.js';
import {
  WalletMcpClientService,
  isWalletMcpDefinitiveFailure,
  WalletCacheService,
  WalletRecordPreparationService,
  CreateRecordInputPayload,
  WalletAccountItem,
  WalletCategoryItem,
} from '../wallet/index.js';
import {
  IncomingUserMessageEvent,
  MessagingGatewayService,
  SupportedMessengerChannel,
} from '../services/messaging/index.js';
import {
  EntityResolutionIssue,
  validateAndSanitizeFinancialRecords,
} from '../utils/recordValidator.js';
import { formatRecordSuccessMessage } from '../utils/humanResponseFormatter.js';
import { detectPendingConfirmationAction } from '../utils/fastPathIntentDetector.js';
import {
  formatCategorySelectionCancellation,
  formatCategorySelectionProcessing,
  formatCategorySelectionPrompt,
  formatCategorySelectionRetry,
  formatCategorySelectionUnknownOutcome,
} from '../utils/categoryClarificationFormatter.js';
import { getDictionary } from '../i18n/index.js';
import { applicationLogger, formatConciseErrorMessage } from '../utils/logger.js';
import { CategoryContextService } from '../services/categoryContextService.js';
import { CategoryClarificationConversationService } from '../services/ai/categoryClarificationConversationService.js';

export class CategoryClarificationHandler {
  private readonly recordPreparationService: WalletRecordPreparationService;
  private readonly conversationService: CategoryClarificationConversationService;
  private readonly dispatchLockedTicketIds = new Set<number>();
  private readonly promptDeliveryPromises = new Map<number, Promise<void>>();

  constructor(
    private readonly pendingTransactionManager: PendingTransactionService,
    private readonly walletMcpClient: WalletMcpClientService,
    private readonly walletCacheService: WalletCacheService,
    private readonly messagingGateway: MessagingGatewayService,
    recordPreparationService?: WalletRecordPreparationService,
    private readonly categoryContextService?: CategoryContextService,
    conversationService?: CategoryClarificationConversationService
  ) {
    this.recordPreparationService =
      recordPreparationService ||
      new WalletRecordPreparationService(walletCacheService, walletMcpClient);
    this.conversationService =
      conversationService ||
      new CategoryClarificationConversationService();
  }

  public async createPendingCategorySelectionDraft(
    event: IncomingUserMessageEvent,
    originalRecords: CreateRecordInputPayload[],
    categoryResolutionIssues: EntityResolutionIssue[],
    availableAccounts: WalletAccountItem[],
    availableCategories: WalletCategoryItem[],
    requestReferenceInstant: Date = new Date()
  ): Promise<boolean> {
    const firstIssue = categoryResolutionIssues.find(issue => issue.entityType === 'CATEGORY');
    if (!firstIssue || !originalRecords[firstIssue.recordIndex]) {
      return false;
    }

    const candidateCategories = this.buildCandidateCategories(firstIssue, availableCategories);
    if (candidateCategories.length === 0) {
      return false;
    }

    const pendingDraft = this.pendingTransactionManager.addPendingCategorySelectionDraft({
      sourceType: 'USER',
      channel: event.channel,
      senderIdentifier: event.senderIdentifier,
      chatIdentifier: event.chatIdentifier,
      records: originalRecords,
      pendingRecordIndex: firstIssue.recordIndex,
      categoryHint: firstIssue.hint,
      candidateCategories,
      sourceUserText: event.textPayload,
      sourceReferenceInstant: requestReferenceInstant,
    });

    // Synchronously claim the draft before any await to keep it in PROCESSING
    // throughout question generation and delivery, preventing concurrent replies
    // from claiming or advancing the draft before prompt delivery completes.
    this.pendingTransactionManager.claimPendingCategorySelectionDraft(pendingDraft.ticketId);

    applicationLogger.info(
      `[Category Clarification] Draft #${pendingDraft.ticketId} created for record ${firstIssue.recordIndex + 1}/${originalRecords.length}.`
    );

    try {
      const prompt = await this.conversationService.generateClarificationQuestion(
        pendingDraft,
        availableCategories
      );

      if (!this.pendingTransactionManager.getPendingCategorySelectionDraft(pendingDraft.ticketId)) {
        applicationLogger.info(
          `[Category Clarification] Draft #${pendingDraft.ticketId} was cancelled before prompt delivery; suppressing message.`
        );
        return true;
      }

      const delivered = await this.deliverClarificationPrompt(
        pendingDraft.ticketId,
        event.channel,
        event.chatIdentifier,
        prompt,
        'initial prompt'
      );
      if (!delivered) {
        return false;
      }

      if (this.pendingTransactionManager.getPendingCategorySelectionDraft(pendingDraft.ticketId)) {
        this.pendingTransactionManager.releaseProcessingCategorySelectionDraft(pendingDraft.ticketId);
      }
      return true;
    } catch (error) {
      const activeDraft = this.pendingTransactionManager.getPendingCategorySelectionDraft(pendingDraft.ticketId);
      if (activeDraft) {
        this.pendingTransactionManager.releaseProcessingCategorySelectionDraft(pendingDraft.ticketId);
        this.pendingTransactionManager.rejectPendingCategorySelectionDraft(pendingDraft.ticketId);
      }
      applicationLogger.error(
        `[Category Clarification] Failed to create pending category selection draft #${pendingDraft.ticketId}: ${formatConciseErrorMessage(error)}`
      );
      throw error;
    }
  }

  private async deliverClarificationPrompt(
    ticketId: number,
    channel: SupportedMessengerChannel,
    chatIdentifier: string,
    prompt: string,
    promptType: 'initial prompt' | 'retry prompt' | 'follow-up prompt'
  ): Promise<boolean> {
    const deliveryPromise = this.messagingGateway.sendMessage(channel, chatIdentifier, prompt);
    this.promptDeliveryPromises.set(ticketId, deliveryPromise);

    try {
      await deliveryPromise;
      return true;
    } catch (messagingError) {
      const activeDraft = this.pendingTransactionManager.getPendingCategorySelectionDraft(ticketId);
      if (activeDraft) {
        this.pendingTransactionManager.releaseProcessingCategorySelectionDraft(ticketId);
        this.pendingTransactionManager.rejectPendingCategorySelectionDraft(ticketId);
      }
      applicationLogger.error(
        `[Category Clarification] Draft #${ticketId} ${promptType} delivery failed: ${formatConciseErrorMessage(messagingError)}`
      );
      return false;
    } finally {
      this.promptDeliveryPromises.delete(ticketId);
    }
  }

  public isCancellablePreDispatch(ticketId: number): boolean {
    const draftState = this.pendingTransactionManager.getPendingCategorySelectionDraftState(ticketId);
    return (draftState === 'PENDING' || draftState === 'PROCESSING') && !this.dispatchLockedTicketIds.has(ticketId);
  }

  public async handlePendingCategorySelectionReply(
    event: IncomingUserMessageEvent,
    userReply: string,
    processingStartTimestamp: number
  ): Promise<boolean> {
    if (!this.supportsCategorySelectionDrafts()) {
      return false;
    }

    const normalizedReply = userReply.trim();
    const pendingConfirmationIntent = detectPendingConfirmationAction(normalizedReply);
    const targetedPendingTicketId = typeof pendingConfirmationIntent?.targetScope === 'number'
      ? pendingConfirmationIntent.targetScope
      : undefined;
    const targetedCancellationTicketId = pendingConfirmationIntent?.actionType === 'REJECT'
      ? targetedPendingTicketId
      : undefined;
    const latestPendingDraft = this.pendingTransactionManager.getLatestPendingCategorySelectionDraft(
      event.channel,
      event.chatIdentifier,
      event.senderIdentifier
    );

    let pendingDraft = latestPendingDraft;
    if (targetedPendingTicketId !== undefined) {
      const targetedDraft = this.pendingTransactionManager.getPendingCategorySelectionDraft(
        targetedPendingTicketId
      );

      if (!targetedDraft || !this.isDraftScopedToEvent(targetedDraft, event)) {
        return false;
      }
      pendingDraft = targetedDraft;
    }

    if (!pendingDraft) {
      return false;
    }

    const draftState = this.pendingTransactionManager.getPendingCategorySelectionDraftState(
      pendingDraft.ticketId
    );
    const isGenericCancellationRequest = /^(?:batal|cancel)$/i.test(normalizedReply);
    const isTargetedCancellationRequest = targetedCancellationTicketId === pendingDraft.ticketId;

    if (draftState === 'UNKNOWN') {
      return false;
    }

    if (draftState === 'PROCESSING') {
      if (
        (isGenericCancellationRequest || isTargetedCancellationRequest) &&
        !this.dispatchLockedTicketIds.has(pendingDraft.ticketId)
      ) {
        this.pendingTransactionManager.releaseProcessingCategorySelectionDraft(pendingDraft.ticketId);
        const cancelledDraft = this.pendingTransactionManager.rejectPendingCategorySelectionDraft(
          pendingDraft.ticketId
        );

        const inFlightDelivery = this.promptDeliveryPromises.get(pendingDraft.ticketId);
        if (inFlightDelivery) {
          await inFlightDelivery;
        }

        if (cancelledDraft) {
          await this.messagingGateway.sendMessage(
            event.channel,
            event.chatIdentifier,
            formatCategorySelectionCancellation(cancelledDraft)
          );
          applicationLogger.info(
            `[Category Clarification] Draft #${cancelledDraft.ticketId} cancelled before Wallet dispatch.`
          );
        }
        return true;
      }

      await this.messagingGateway.sendMessage(
        event.channel,
        event.chatIdentifier,
        formatCategorySelectionProcessing(pendingDraft)
      );
      return true;
    }

    if (isGenericCancellationRequest || isTargetedCancellationRequest) {
      const cancelledDraft = this.pendingTransactionManager.rejectPendingCategorySelectionDraft(
        pendingDraft.ticketId
      );
      const inFlightDelivery = this.promptDeliveryPromises.get(pendingDraft.ticketId);
      if (inFlightDelivery) {
        await inFlightDelivery;
      }
      if (cancelledDraft) {
        await this.messagingGateway.sendMessage(
          event.channel,
          event.chatIdentifier,
          formatCategorySelectionCancellation(cancelledDraft)
        );
        applicationLogger.info(
          `[Category Clarification] Draft #${cancelledDraft.ticketId} cancelled before Wallet dispatch.`
        );
      }
      return true;
    }

    const claimedDraft = this.pendingTransactionManager.claimPendingCategorySelectionDraft(
      pendingDraft.ticketId
    );
    if (!claimedDraft) {
      await this.messagingGateway.sendMessage(
        event.channel,
        event.chatIdentifier,
        formatCategorySelectionProcessing(pendingDraft)
      );
      return true;
    }

    const availableCategories = this.walletCacheService.getCategories();
    const selectedCategory = await this.conversationService.interpretClarificationReply(
      normalizedReply,
      claimedDraft,
      availableCategories
    );

    if (!this.pendingTransactionManager.getPendingCategorySelectionDraft(claimedDraft.ticketId)) {
      applicationLogger.info(
        `[Category Clarification] Draft #${claimedDraft.ticketId} was cancelled during reply interpretation; aborting dispatch.`
      );
      return true;
    }

    if (!selectedCategory) {
      try {
        const retryPrompt = await this.conversationService.generateClarificationQuestion(
          claimedDraft,
          availableCategories,
          normalizedReply
        );

        if (!this.pendingTransactionManager.getPendingCategorySelectionDraft(claimedDraft.ticketId)) {
          applicationLogger.info(
            `[Category Clarification] Draft #${claimedDraft.ticketId} was cancelled during retry prompt generation; suppressing delivery.`
          );
          return true;
        }

        const delivered = await this.deliverClarificationPrompt(
          claimedDraft.ticketId,
          event.channel,
          event.chatIdentifier,
          retryPrompt,
          'retry prompt'
        );
        if (!delivered) {
          return true;
        }

        if (this.pendingTransactionManager.getPendingCategorySelectionDraft(claimedDraft.ticketId)) {
          this.pendingTransactionManager.releaseProcessingCategorySelectionDraft(claimedDraft.ticketId);
        }
      } catch (messagingError) {
        const activeDraft = this.pendingTransactionManager.getPendingCategorySelectionDraft(claimedDraft.ticketId);
        if (activeDraft) {
          this.pendingTransactionManager.releaseProcessingCategorySelectionDraft(claimedDraft.ticketId);
          applicationLogger.error(
            `[Category Clarification] Draft #${claimedDraft.ticketId} retry prompt delivery failed: ${formatConciseErrorMessage(messagingError)}`
          );
          throw messagingError;
        }
      }
      return true;
    }

    const updatedRecords = claimedDraft.records.map(record => ({ ...record }));
    updatedRecords[claimedDraft.pendingRecordIndex] = {
      ...updatedRecords[claimedDraft.pendingRecordIndex],
      categoryId: selectedCategory.id,
      categoryHint: undefined,
    };

    this.pendingTransactionManager.updatePendingCategorySelectionDraft(claimedDraft.ticketId, {
      records: updatedRecords,
      categoryHint: selectedCategory.name,
    });

    const availableAccounts = this.walletCacheService.getAccounts();
    const referenceInstantForClarification =
      claimedDraft.sourceReferenceInstant ?? claimedDraft.createdAt;
    const validationResult = validateAndSanitizeFinancialRecords(
      updatedRecords,
      availableAccounts,
      availableCategories,
      undefined,
      referenceInstantForClarification,
      claimedDraft.sourceUserText,
      this.categoryContextService?.getConfiguration().categoryRules
    );

    if (validationResult.validationErrors.length > 0) {
      this.pendingTransactionManager.releaseProcessingCategorySelectionDraft(claimedDraft.ticketId);
      this.pendingTransactionManager.rejectPendingCategorySelectionDraft(claimedDraft.ticketId);
      await this.messagingGateway.sendMessage(
        event.channel,
        event.chatIdentifier,
        getDictionary().errors.validationRejected(validationResult.validationErrors.join('\n'))
      );
      return true;
    }

    // Check if another record also has an unresolved category
    const remainingCategoryIssues = validationResult.entityResolutionIssues.filter(
      issue => issue.entityType === 'CATEGORY'
    );
    if (remainingCategoryIssues.length > 0) {
      const nextIssue = remainingCategoryIssues[0];
      const nextCandidates = this.buildCandidateCategories(nextIssue, availableCategories);

      if (nextCandidates.length === 0) {
        this.pendingTransactionManager.releaseProcessingCategorySelectionDraft(claimedDraft.ticketId);
        this.pendingTransactionManager.rejectPendingCategorySelectionDraft(claimedDraft.ticketId);
        await this.messagingGateway.sendMessage(
          event.channel,
          event.chatIdentifier,
          getDictionary().errors.validationRejected(getDictionary().errors.accountResolutionFallback)
        );
        return true;
      }

      const updatedDraft = this.pendingTransactionManager.updatePendingCategorySelectionDraft(
        claimedDraft.ticketId,
        {
          records: updatedRecords,
          pendingRecordIndex: nextIssue.recordIndex,
          categoryHint: nextIssue.hint,
          candidateCategories: nextCandidates,
        }
      );

      if (!updatedDraft) {
        this.pendingTransactionManager.releaseProcessingCategorySelectionDraft(claimedDraft.ticketId);
        this.pendingTransactionManager.rejectPendingCategorySelectionDraft(claimedDraft.ticketId);
        return false;
      }

      try {
        const followUpPrompt = await this.conversationService.generateClarificationQuestion(
          updatedDraft,
          availableCategories
        );

        if (!this.pendingTransactionManager.getPendingCategorySelectionDraft(claimedDraft.ticketId)) {
          return true;
        }

        const delivered = await this.deliverClarificationPrompt(
          claimedDraft.ticketId,
          event.channel,
          event.chatIdentifier,
          followUpPrompt,
          'follow-up prompt'
        );
        if (!delivered) {
          return true;
        }

        if (this.pendingTransactionManager.getPendingCategorySelectionDraft(claimedDraft.ticketId)) {
          this.pendingTransactionManager.releaseProcessingCategorySelectionDraft(claimedDraft.ticketId);
        }
        return true;
      } catch (messagingError) {
        const activeDraft = this.pendingTransactionManager.getPendingCategorySelectionDraft(claimedDraft.ticketId);
        if (activeDraft) {
          this.pendingTransactionManager.releaseProcessingCategorySelectionDraft(claimedDraft.ticketId);
          applicationLogger.error(
            `[Category Clarification] Draft #${claimedDraft.ticketId} follow-up prompt delivery failed: ${formatConciseErrorMessage(messagingError)}`
          );
          throw messagingError;
        }
        return true;
      }
    }

    if (!this.pendingTransactionManager.getPendingCategorySelectionDraft(claimedDraft.ticketId)) {
      applicationLogger.info(
        `[Category Clarification] Draft #${claimedDraft.ticketId} was cancelled before dispatch; aborting dispatch.`
      );
      return true;
    }

    if (
      !validationResult.isValid ||
      validationResult.sanitizedRecords.length === 0 ||
      validationResult.sanitizedRecords.length !== updatedRecords.length
    ) {
      this.pendingTransactionManager.releaseProcessingCategorySelectionDraft(claimedDraft.ticketId);
      this.pendingTransactionManager.rejectPendingCategorySelectionDraft(claimedDraft.ticketId);
      await this.messagingGateway.sendMessage(
        event.channel,
        event.chatIdentifier,
        getDictionary().errors.validationRejected(
          validationResult.validationErrors.join('\n') || getDictionary().errors.accountResolutionFallback
        )
      );
      return true;
    }

    this.dispatchLockedTicketIds.add(claimedDraft.ticketId);
    try {
      await this.recordPreparationService.prepareRecordsForDispatch(validationResult.sanitizedRecords);
      await this.walletMcpClient.createRecords(validationResult.sanitizedRecords);
    } catch (error) {
      if (isWalletMcpDefinitiveFailure(error)) {
        this.pendingTransactionManager.releaseProcessingCategorySelectionDraft(claimedDraft.ticketId);
        await this.messagingGateway.sendMessage(
          event.channel,
          event.chatIdentifier,
          formatCategorySelectionRetry(claimedDraft)
        );
        applicationLogger.warn(
          `[Category Clarification] Draft #${claimedDraft.ticketId} failed definitively and remains retryable.`
        );
      } else {
        this.pendingTransactionManager.markPendingCategorySelectionDraftUnknown(claimedDraft.ticketId);
        try {
          await this.messagingGateway.sendMessage(
            event.channel,
            event.chatIdentifier,
            formatCategorySelectionUnknownOutcome(claimedDraft)
          );
        } catch (messagingError) {
          applicationLogger.error(
            `[Category Clarification] Draft #${claimedDraft.ticketId} remains UNKNOWN, but warning failed to deliver: ${formatConciseErrorMessage(messagingError)}`
          );
        }
        applicationLogger.warn(
          `[Category Clarification] Draft #${claimedDraft.ticketId} has an unknown dispatch outcome; automatic retry disabled.`
        );
      }
      return true;
    } finally {
      this.dispatchLockedTicketIds.delete(claimedDraft.ticketId);
    }

    this.pendingTransactionManager.resolvePendingCategorySelectionDraft(claimedDraft.ticketId);

    try {
      await this.messagingGateway.sendMessage(
        event.channel,
        event.chatIdentifier,
        formatRecordSuccessMessage(
          validationResult.sanitizedRecords,
          availableAccounts,
          availableCategories
        ).trim()
      );
    } catch (messagingError) {
      applicationLogger.error(
        `[Category Clarification] Draft #${claimedDraft.ticketId} was recorded, but acknowledgement failed: ${formatConciseErrorMessage(messagingError)}`
      );
    }

    const processingDurationMs = Date.now() - processingStartTimestamp;
    applicationLogger.success(
      `[Category Clarification] Draft #${claimedDraft.ticketId} recorded after category selection (${processingDurationMs}ms).`
    );
    return true;
  }

  private supportsCategorySelectionDrafts(): boolean {
    const manager = this.pendingTransactionManager as Partial<PendingTransactionService>;
    return (
      typeof manager.getLatestPendingCategorySelectionDraft === 'function' &&
      typeof manager.claimPendingCategorySelectionDraft === 'function' &&
      typeof manager.releaseProcessingCategorySelectionDraft === 'function' &&
      typeof manager.updatePendingCategorySelectionDraft === 'function' &&
      typeof manager.resolvePendingCategorySelectionDraft === 'function' &&
      typeof manager.rejectPendingCategorySelectionDraft === 'function'
    );
  }

  private isDraftScopedToEvent(
    draft: PendingCategorySelectionDraft,
    event: IncomingUserMessageEvent
  ): boolean {
    return (
      draft.channel === event.channel &&
      draft.chatIdentifier === event.chatIdentifier &&
      draft.senderIdentifier === event.senderIdentifier
    );
  }

  public buildCandidateCategories(
    issue: EntityResolutionIssue,
    availableCategories: WalletCategoryItem[]
  ): PendingCategorySelectionCandidate[] {
    const assignableCategories = availableCategories.filter(
      category => category.isAssignable !== false
    );

    if (issue.candidates && issue.candidates.length > 0) {
      return issue.candidates.map(candidate => ({
        id: candidate.id,
        name: candidate.name,
      }));
    }

    const hintWords = issue.hint.toLowerCase().split(/\s+/).filter(Boolean);
    const scoredCategories = assignableCategories.map(category => {
      const categoryName = category.name.toLowerCase();
      let score = 0;
      for (const word of hintWords) {
        if (categoryName.includes(word)) score += 3;
      }
      return { category, score };
    });

    const matchingScored = scoredCategories
      .filter(item => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .map(item => ({ id: item.category.id, name: item.category.name }));

    if (matchingScored.length > 0) {
      return matchingScored.slice(0, 5);
    }

    return assignableCategories.slice(0, 5).map(category => ({
      id: category.id,
      name: category.name,
    }));
  }
}
