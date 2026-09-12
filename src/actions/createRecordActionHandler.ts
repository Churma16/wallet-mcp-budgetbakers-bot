import { WalletMcpClientService } from '../services/walletMcpService.js';
import { WalletCacheService } from '../services/walletCacheService.js';
import { MessagingGatewayService } from '../services/messaging/index.js';
import { WalletRecordPreparationService } from '../services/walletRecordPreparationService.js';
import { AccountClarificationHandler } from '../handlers/accountClarificationHandler.js';
import { CreateRecordActionContext, FinancialActionHandler } from './types.js';
import {
  AccountResolutionIssue,
  validateAndSanitizeFinancialRecords,
} from '../utils/recordValidator.js';
import { extractHashtags } from '../utils/hashtagParser.js';
import {
  formatRecordSuccessMessage,
  getHumanReadableTimestamp,
} from '../utils/humanResponseFormatter.js';
import { getDictionary } from '../i18n/index.js';
import { applicationLogger } from '../utils/logger.js';

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
export class CreateRecordActionHandler implements FinancialActionHandler<'CREATE_RECORD'> {
  public readonly action = 'CREATE_RECORD' as const;

  constructor(
    private readonly walletMcpClient: WalletMcpClientService,
    private readonly walletCacheService: WalletCacheService,
    private readonly messagingGateway: MessagingGatewayService,
    private readonly recordPreparationService: WalletRecordPreparationService,
    private readonly accountClarificationHandler: AccountClarificationHandler
  ) {}

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

    const validationResult = validateAndSanitizeFinancialRecords(
      context.records,
      cachedAccounts,
      cachedCategories,
      event.textPayload,
      requestReferenceInstant
    );

    if (
      validationResult.validationErrors.length === 0 &&
      validationResult.accountResolutionIssues.length > 0
    ) {
      const drafted = await this.accountClarificationHandler.createPendingAccountSelectionDraft(
        event,
        context.records,
        validationResult.accountResolutionIssues,
        cachedAccounts,
        cachedCategories,
        requestReferenceInstant
      );
      if (drafted) {
        return;
      }
    }

    if (!validationResult.isValid || validationResult.sanitizedRecords.length === 0) {
      const accountResolutionMessages = validationResult.accountResolutionIssues.map(
        formatAccountResolutionIssueMessage
      );
      const validationErrorMessage = [
        ...validationResult.validationErrors,
        ...accountResolutionMessages,
      ].join('\n') || getDictionary().errors.accountResolutionFallback;
      const totalValidationIssueCount =
        validationResult.validationErrors.length + validationResult.accountResolutionIssues.length;

      applicationLogger.warn(
        `Financial record validation rejected (${totalValidationIssueCount} issue(s)).`
      );

      applicationLogger.fileDetail('error', 'Financial Record Validation Failure', {
        originalRecords: context.records,
        validationErrors: validationResult.validationErrors,
        accountResolutionIssues: validationResult.accountResolutionIssues,
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

    await this.walletMcpClient.createRecords(validRecordsToCreate);

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

    await this.messagingGateway.sendMessage(event.channel, event.chatIdentifier, replyMessage.trim());
    const processingDurationMs = Date.now() - processingStartTimestamp;
    applicationLogger.success(
      `[${event.channel.toUpperCase()}] Successfully recorded ${validRecordsToCreate.length} transaction(s) to Wallet & sent confirmation (${processingDurationMs}ms).`
    );
  }
}
