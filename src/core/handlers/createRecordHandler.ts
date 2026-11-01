import {
  WalletMcpClientService,
  WalletCacheService,
  WalletRecordPreparationService,
  TransactionMessageStore,
} from '../../wallet/index.js';

import { MessagingGatewayService } from '../../gateway/index.js';

import { AccountClarificationHandler } from './accountClarificationHandler.js';
import { CategoryClarificationHandler } from './categoryClarificationHandler.js';
import { CategoryClarificationConversationService } from '../../brain/index.js';
import { CreateRecordActionContext, FinancialActionHandler } from '../types.js';
import {
  AccountResolutionIssue,
  validateAndSanitizeFinancialRecords,
} from '../../wallet/records/recordValidator.js';
import { extractHashtags } from '../../brain/index.js';
import {
  formatRecordSuccessMessage,
  getHumanReadableTimestamp,
} from '../../wallet/formatters/humanResponseFormatter.js';
import { getDictionary } from '../../i18n/index.js';
import { applicationLogger } from '../../lib/logger.js';
import { CategoryContextService } from '../../brain/category/categoryContext.js';
import { FINANCIAL_ACTION_TYPES } from '../../brain/constants.js';

function formatAccountResolutionIssueMessage(issue: AccountResolutionIssue): string {
  const dictionary = getDictionary();
  if (issue.reason === 'AMBIGUOUS') {
    return dictionary.errors.accountResolutionAmbiguous(
      issue.recordIndex + 1,
      issue.accountHint,
      issue.candidates.map(candidate => candidate.name)
    );
  }

  return dictionary.errors.accountResolutionUnresolved(issue.recordIndex + 1, issue.accountHint);
}

/**
 * Handles the complete record creation lifecycle including validation,
 * account clarification drafting, hashtag association, label resolution,
 * Wallet MCP dispatch, and user confirmation response.
 */
export class CreateRecordActionHandler implements FinancialActionHandler<typeof FINANCIAL_ACTION_TYPES.CREATE_RECORD> {
  public readonly action = FINANCIAL_ACTION_TYPES.CREATE_RECORD;

  private readonly categoryClarificationConversationService: CategoryClarificationConversationService;

  /**
   * @param categoryResolutionMode Optional fallback mode used only if categoryContextService is omitted
   */
  constructor(
    private readonly walletMcpClient: WalletMcpClientService,
    private readonly walletCacheService: WalletCacheService,
    private readonly messagingGateway: MessagingGatewayService,
    private readonly recordPreparationService: WalletRecordPreparationService,
    private readonly accountClarificationHandler: AccountClarificationHandler,
    private readonly categoryContextService?: CategoryContextService,
    private readonly categoryClarificationHandler?: CategoryClarificationHandler,
    private readonly categoryResolutionMode?: 'ask' | 'auto',
    categoryClarificationConversationService?: CategoryClarificationConversationService,
    private readonly transactionMessageStore?: TransactionMessageStore
  ) {
    this.categoryClarificationConversationService =
      categoryClarificationConversationService ||
      new CategoryClarificationConversationService();
  }

  private resolveActiveCategoryResolutionMode(): 'ask' | 'auto' {
    const environmentOverride = process.env.CATEGORY_RESOLUTION_MODE?.trim().toLowerCase();
    if (environmentOverride === 'auto' || environmentOverride === 'ask') {
      return environmentOverride;
    }
    if (this.categoryContextService) {
      return this.categoryContextService.getCategoryResolutionMode();
    }
    return this.categoryResolutionMode ?? 'ask';
  }

  public async execute(context: CreateRecordActionContext): Promise<void> {
    const event = context.event;
    const processingStartTimestamp = context.processingStartTimestamp ?? Date.now();
    const requestReferenceInstant = context.requestReferenceInstant ?? new Date(processingStartTimestamp);

    if (!context.records || context.records.length === 0) {
      applicationLogger.warn('[CreateRecordActionHandler] Received CREATE_RECORD action with 0 records.');
      await this.messagingGateway.sendMessage(
        event.channel,
        event.chatIdentifier,
        getDictionary().errors.accountResolutionFallback
      );
      return;
    }

    const cachedAccounts = this.walletCacheService.getAccounts();
    const cachedCategories = this.walletCacheService.getCategories();
    const incomingRecords = context.records.map(record => ({
      ...record,
      accountId: record.accountId ?? record.accountHint ?? '',
    }));

    let currentValidationResult = validateAndSanitizeFinancialRecords(
      incomingRecords,
      cachedAccounts,
      cachedCategories,
      event.textPayload,
      requestReferenceInstant,
      undefined,
      this.categoryContextService?.getConfiguration().categoryRules
    );

    if (
      currentValidationResult.validationErrors.length === 0 &&
      currentValidationResult.accountResolutionIssues.length > 0 &&
      currentValidationResult.entityResolutionIssues.every(issue => issue.entityType === 'ACCOUNT')
    ) {
      const drafted = await this.accountClarificationHandler.createPendingAccountSelectionDraft(
        event,
        incomingRecords,
        currentValidationResult.accountResolutionIssues,
        cachedAccounts,
        cachedCategories,
        requestReferenceInstant
      );
      if (drafted) {
        return;
      }
    }

    const categoryIssues = currentValidationResult.entityResolutionIssues.filter(
      issue => issue.entityType === 'CATEGORY'
    );

    if (currentValidationResult.validationErrors.length === 0 && categoryIssues.length > 0) {
      const activeCategoryResolutionMode = this.resolveActiveCategoryResolutionMode();
      if (activeCategoryResolutionMode === 'auto') {
        let autoResolvedAny = false;
        for (const issue of categoryIssues) {
          const matchedCategory = await this.categoryClarificationConversationService.selectBestCategory(
            issue.hint,
            issue.candidates,
            cachedCategories,
            incomingRecords[issue.recordIndex]?.note
          );
          if (matchedCategory) {
            incomingRecords[issue.recordIndex] = {
              ...incomingRecords[issue.recordIndex],
              categoryId: matchedCategory.id,
              categoryHint: undefined,
            };
            autoResolvedAny = true;
          }
        }

        if (autoResolvedAny) {
          currentValidationResult = validateAndSanitizeFinancialRecords(
            incomingRecords,
            cachedAccounts,
            cachedCategories,
            event.textPayload,
            requestReferenceInstant,
            undefined,
            this.categoryContextService?.getConfiguration().categoryRules
          );
        }
      }

      const remainingCategoryIssues = currentValidationResult.entityResolutionIssues.filter(
        issue => issue.entityType === 'CATEGORY'
      );

      if (
        currentValidationResult.validationErrors.length === 0 &&
        currentValidationResult.accountResolutionIssues.length === 0 &&
        remainingCategoryIssues.length > 0 &&
        currentValidationResult.entityResolutionIssues.every(issue => issue.entityType === 'CATEGORY') &&
        this.categoryClarificationHandler
      ) {
        const drafted = await this.categoryClarificationHandler.createPendingCategorySelectionDraft(
          event,
          incomingRecords,
          remainingCategoryIssues,
          cachedAccounts,
          cachedCategories,
          requestReferenceInstant
        );
        if (drafted) {
          return;
        }
      }
    }

    const validationResult = currentValidationResult;

    if (!validationResult.isValid || validationResult.sanitizedRecords.length === 0) {
      const accountResolutionMessages = validationResult.accountResolutionIssues.map(
        formatAccountResolutionIssueMessage
      );
      const validationErrorMessage = [
        ...validationResult.validationErrors,
        ...accountResolutionMessages,
        ...validationResult.entityResolutionIssues
          .filter(issue => issue.entityType === 'CATEGORY')
          .map(issue => {
            const candidates = issue.candidates.map(candidate => candidate.name).join(', ');
            return issue.reason === 'AMBIGUOUS'
              ? `Transaksi #${issue.recordIndex + 1}: kategori "${issue.hint}" ambigu${candidates ? ` (${candidates})` : ''}.`
              : `Transaksi #${issue.recordIndex + 1}: kategori "${issue.hint}" tidak ditemukan.`;
          }),
      ].join('\n') || getDictionary().errors.accountResolutionFallback;
      const totalValidationIssueCount =
        validationResult.validationErrors.length + validationResult.entityResolutionIssues.length;

      applicationLogger.warn(
        `Financial record validation rejected (${totalValidationIssueCount} issue(s)).`
      );

      applicationLogger.fileDetail('error', 'Financial Record Validation Failure', {
        originalRecords: context.records,
        validationErrors: validationResult.validationErrors,
        accountResolutionIssues: validationResult.accountResolutionIssues,
        entityResolutionIssues: validationResult.entityResolutionIssues,
      });

      await this.messagingGateway.sendMessage(
        event.channel,
        event.chatIdentifier,
        getDictionary().errors.validationRejected(validationErrorMessage)
      );
      const processingDurationMs = Date.now() - processingStartTimestamp;
      applicationLogger.warn(
        `[${event.channel.toUpperCase()}] Validation rejected with ${totalValidationIssueCount} issue(s) (${processingDurationMs}ms).`
      );
      return;
    }

    const validRecordsToCreate = validationResult.sanitizedRecords;

    // Fallback: if single record has no labels but raw user message contained hashtags, associate them
    if (
      validRecordsToCreate.length === 1 &&
      (!validRecordsToCreate[0].labels || validRecordsToCreate[0].labels.length === 0) &&
      event.textPayload
    ) {
      const userMessageHashtags = extractHashtags(event.textPayload).tags;
      if (userMessageHashtags.length > 0) {
        validRecordsToCreate[0].labels = userMessageHashtags;
      }
    }

    // Resolve and auto-create labels for all records
    await this.recordPreparationService.prepareRecordsForDispatch(validRecordsToCreate);

    applicationLogger.mcp(`Creating ${validRecordsToCreate.length} record(s) in Wallet...`);

    applicationLogger.fileDetail('mcp', 'Dispatching Record Creation to Wallet MCP', {
      recordsCount: validRecordsToCreate.length,
      records: validRecordsToCreate,
    });

    const creationResponse = await this.walletMcpClient.createRecords(validRecordsToCreate);

    const replyMessage = formatRecordSuccessMessage(
      validRecordsToCreate,
      cachedAccounts,
      cachedCategories
    );

    applicationLogger.fileDetail('chat', 'Dispatched Record Creation Success Reply', {
      channel: event.channel,
      recipientChatId: event.chatIdentifier,
      replyText: replyMessage,
    });

    const sendReceipt = await this.messagingGateway.sendMessage(
      event.channel,
      event.chatIdentifier,
      replyMessage.trim()
    );

    if (sendReceipt && 'messageId' in sendReceipt && sendReceipt.messageId && creationResponse?.results?.[0]?.id) {
      const firstRecord = validRecordsToCreate[0];
      this.transactionMessageStore?.recordMessageMapping(sendReceipt.messageId, {
        recordId: creationResponse.results[0].id,
        accountId: firstRecord.accountId,
        note: firstRecord.note,
        categoryId: firstRecord.categoryId,
        amount: firstRecord.amount,
        counterParty: firstRecord.counterParty,
        channel: event.channel,
      });
    }
    const processingDurationMs = Date.now() - processingStartTimestamp;
    applicationLogger.success(
      `[${event.channel.toUpperCase()}] Successfully recorded ${validRecordsToCreate.length} transaction(s) to Wallet & sent confirmation (${processingDurationMs}ms).`
    );
  }
}
