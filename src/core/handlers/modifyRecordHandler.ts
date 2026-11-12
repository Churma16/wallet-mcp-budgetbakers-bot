import type { IncomingUserMessageEvent, MessagingGatewayService } from '../../gateway/index.js';
import type {
  WalletCacheService,
  WalletMcpClientService,
  WalletCategoryItem,
  PatchRecordInputPayload,
} from '../../wallet/index.js';
import {
  parseRecordEditCommand,
  isAutoCategoryToken,
  resolveAndEnsureLabels,
  TransactionMessageStore,
  FILTER_ERROR_REASONS,
} from '../../wallet/index.js';
import { resolveSemanticAccountHint, inferCategoryFromText, FinancialAiProvider } from '../../brain/index.js';
import type { CategoryContextService } from '../../brain/category/categoryContext.js';
import {
  formatCurrencyAmount,
  formatTransactionDate,
  resolveTransactionDisplayTitle,
} from '../../wallet/formatters/humanResponseFormatter.js';
import { getDefaultCurrency } from '../../config/applicationConfig.js';
import { normalizeTransactionText } from '../../lib/textCasing.js';
import { applicationLogger } from '../../lib/logger.js';
import { getDictionary } from '../../i18n/index.js';
import type { PendingTransactionService } from '../pending.js';

/**
 * Coordinates conversational transaction edit commands triggered when a user
 * replies to a previously recorded transaction confirmation message.
 *
 * Validates entity references, enforces upstream currency compatibility and bank-sync
 * immutability guards, handles field clearing via native $clear, and dispatches
 * atomic patch updates to the Wallet MCP client.
 */
export class ModifyRecordHandler {
  constructor(
    private readonly walletMcpClient: WalletMcpClientService,
    private readonly walletCacheService: WalletCacheService,
    private readonly messagingGateway: MessagingGatewayService,
    private readonly transactionMessageStore: TransactionMessageStore,
    private readonly categoryContextService?: CategoryContextService,
    private readonly financialAiProvider?: FinancialAiProvider,
    private readonly pendingTransactionService?: PendingTransactionService
  ) {}

  public async handleModifyRecordReply(
    event: IncomingUserMessageEvent,
    _processingStartTimestamp: number
  ): Promise<boolean> {
    if (!event.replyToMessageId || !event.textPayload) {
      return false;
    }

    const editCommand = parseRecordEditCommand(event.textPayload);
    if (!editCommand || !editCommand.hasModifications) {
      return false;
    }

    applicationLogger.fileDetail('chat', 'Detected Record Edit Command on Reply', {
      replyToMessageId: event.replyToMessageId,
      editCommand,
    });

    const dictionary = getDictionary();
    const mapping = this.transactionMessageStore.getMessageMapping(event.replyToMessageId);
    if (!mapping) {
      // If the replied message belongs to an active pending transaction,
      // allow dispatcher to proceed to pending transaction confirmation/edit handling.
      if (this.pendingTransactionService) {
        const allPending = typeof this.pendingTransactionService.getAllPendingTransactions === 'function'
          ? this.pendingTransactionService.getAllPendingTransactions()
          : [];
        const isPendingItem = allPending.some(item =>
          item.notificationMessageIds &&
          Object.values(item.notificationMessageIds).includes(event.replyToMessageId!)
        );
        if (isPendingItem) {
          return false;
        }
      }

      await this.messagingGateway.sendMessage(
        event.channel,
        event.chatIdentifier,
        dictionary.errors.recordEditNotFound
      );
      return true;
    }

    const cachedAccounts = this.walletCacheService.getAccounts();
    const sourceAccount = cachedAccounts.find(account => account.id === mapping.accountId);

    let movedFromAccountName: string | undefined;
    let resolvedTargetAccountId: string | undefined;
    let resolvedTargetAccountName: string | undefined;
    let resolvedTargetCurrency: string | undefined;

    if (editCommand.targetAccountHint) {
      if (sourceAccount?.isBankSynced === true) {
        await this.messagingGateway.sendMessage(
          event.channel,
          event.chatIdentifier,
          dictionary.errors.recordEditSourceBankSynced(sourceAccount.name)
        );
        return true;
      }

      const accountResolution = resolveSemanticAccountHint(
        editCommand.targetAccountHint,
        cachedAccounts
      );

      if (accountResolution.status === 'CLARIFICATION_REQUIRED') {
        if (accountResolution.reason === FILTER_ERROR_REASONS.AMBIGUOUS) {
          await this.messagingGateway.sendMessage(
            event.channel,
            event.chatIdentifier,
            dictionary.errors.recordEditAccountAmbiguous(
              editCommand.targetAccountHint,
              accountResolution.candidates.map(candidate => candidate.name)
            )
          );
        } else {
          await this.messagingGateway.sendMessage(
            event.channel,
            event.chatIdentifier,
            dictionary.errors.recordEditAccountNotFound(editCommand.targetAccountHint)
          );
        }
        return true;
      }

      const targetAccount = cachedAccounts.find(account => account.id === accountResolution.id);
      if (!targetAccount) {
        await this.messagingGateway.sendMessage(
          event.channel,
          event.chatIdentifier,
          dictionary.errors.recordEditAccountNotFound(editCommand.targetAccountHint)
        );
        return true;
      }

      if (targetAccount.isBankSynced === true) {
        await this.messagingGateway.sendMessage(
          event.channel,
          event.chatIdentifier,
          dictionary.errors.recordEditTargetBankSynced(targetAccount.name)
        );
        return true;
      }

      const sourceCurrency = (
        sourceAccount?.currency ||
        mapping.currency ||
        getDefaultCurrency()
      )
        .trim()
        .toUpperCase();
      const targetCurrency = (targetAccount.currency || getDefaultCurrency()).trim().toUpperCase();

      if (sourceCurrency !== targetCurrency) {
        await this.messagingGateway.sendMessage(
          event.channel,
          event.chatIdentifier,
          dictionary.errors.recordEditCurrencyMismatch(
            sourceAccount?.name || mapping.accountName || 'Sumber',
            sourceCurrency,
            targetAccount.name,
            targetCurrency
          )
        );
        return true;
      }

      if (targetAccount.id !== mapping.accountId) {
        resolvedTargetAccountId = targetAccount.id;
        resolvedTargetAccountName = targetAccount.name;
        resolvedTargetCurrency = targetCurrency;
        movedFromAccountName = sourceAccount?.name || mapping.accountName;
      }
    }

    const clearFields = editCommand.clearFields ? [...editCommand.clearFields] : [];

    // Auto-capitalize note and counterParty using Smart Title Casing
    const formattedNote =
      editCommand.note !== undefined && !clearFields.includes('note')
        ? normalizeTransactionText(editCommand.note) || editCommand.note
        : undefined;

    const formattedCounterParty =
      editCommand.counterParty !== undefined && !clearFields.includes('counterParty')
        ? normalizeTransactionText(editCommand.counterParty) || editCommand.counterParty
        : undefined;

    const isAutoCategoryRequested = Boolean(
      editCommand.isAutoCategory ||
      isAutoCategoryToken(editCommand.categoryName)
    );

    let resolvedCategoryId: string | undefined;
    let resolvedCategoryName: string | undefined;

    if (isAutoCategoryRequested && !clearFields.includes('categoryId')) {
      const textToClassify = [
        formattedNote || editCommand.note || mapping.note,
        formattedCounterParty || editCommand.counterParty || mapping.counterParty,
      ]
        .filter(Boolean)
        .join(' ');

      const autoCategory = await inferCategoryFromText(
        textToClassify,
        this.walletCacheService.getCategories(),
        this.financialAiProvider,
        this.categoryContextService?.getConfiguration().categoryRules
      );

      if (autoCategory) {
        resolvedCategoryId = autoCategory.id;
        resolvedCategoryName = autoCategory.name;
      } else {
        const onlyAutoRequested =
          editCommand.note === undefined &&
          editCommand.amount === undefined &&
          editCommand.counterParty === undefined &&
          editCommand.targetAccountHint === undefined &&
          (!editCommand.tags || editCommand.tags.length === 0) &&
          clearFields.length === 0;

        if (onlyAutoRequested) {
          await this.messagingGateway.sendMessage(
            event.channel,
            event.chatIdentifier,
            dictionary.errors.recordEditCategoryAutoNotFound(textToClassify || '')
          );
          return true;
        }

        resolvedCategoryId = mapping.categoryId;
        resolvedCategoryName = mapping.categoryName;
      }
    } else if (editCommand.categoryName && !clearFields.includes('categoryId')) {
      const match = this.findAssignableCategory(editCommand.categoryName);
      if (!match) {
        await this.messagingGateway.sendMessage(
          event.channel,
          event.chatIdentifier,
          dictionary.errors.recordEditCategoryNotFound(editCommand.categoryName)
        );
        return true;
      }
      resolvedCategoryId = match.id;
      resolvedCategoryName = match.name;
    }

    let resolvedLabelIds: string[] | undefined;
    let resolvedLabelNames: string[] | undefined;

    if (editCommand.tags && editCommand.tags.length > 0 && !clearFields.includes('labelIds')) {
      const labelResolution = await resolveAndEnsureLabels(
        editCommand.tags,
        this.walletCacheService,
        this.walletMcpClient
      );
      resolvedLabelIds = labelResolution.resolvedLabelIds;
      resolvedLabelNames = labelResolution.resolvedLabelNames;
    }

    let resolvedAmount: number | undefined;
    if (editCommand.amount !== undefined) {
      if (editCommand.amount === 0) {
        await this.messagingGateway.sendMessage(
          event.channel,
          event.chatIdentifier,
          dictionary.errors.recordEditZeroAmount
        );
        return true;
      }
      // Preserve negative expense sign if original transaction was an expense and no explicit '+' was provided
      if (mapping.amount !== undefined && mapping.amount < 0 && !editCommand.hasExplicitPositiveSign) {
        resolvedAmount = -Math.abs(editCommand.amount);
      } else {
        resolvedAmount = editCommand.amount;
      }
    }

    const patchPayload: PatchRecordInputPayload = {
      id: mapping.recordId,
      ...(resolvedTargetAccountId ? { accountId: resolvedTargetAccountId } : {}),
      ...(resolvedCategoryId && !clearFields.includes('categoryId') ? { categoryId: resolvedCategoryId } : {}),
      ...(resolvedLabelIds && !clearFields.includes('labelIds') ? { labelIds: resolvedLabelIds } : {}),
      ...(formattedNote !== undefined && !clearFields.includes('note') ? { note: formattedNote } : {}),
      ...(resolvedAmount !== undefined ? { amount: resolvedAmount } : {}),
      ...(formattedCounterParty !== undefined && !clearFields.includes('counterParty')
        ? { counterParty: formattedCounterParty }
        : {}),
      ...(clearFields.length > 0 ? { $clear: clearFields } : {}),
    };

    try {
      const patchResult = await this.walletMcpClient.patchRecords([patchPayload]);
      const singleResult = patchResult.results?.[0];
      if (!singleResult || singleResult.success === false) {
        throw new Error(singleResult?.error || 'Gagal memperbarui rekor di Wallet MCP');
      }

      this.transactionMessageStore.updateMessageMapping(event.replyToMessageId, {
        ...(resolvedTargetAccountId
          ? {
              accountId: resolvedTargetAccountId,
              accountName: resolvedTargetAccountName,
              currency: resolvedTargetCurrency,
            }
          : {}),
        ...(resolvedCategoryId ? { categoryId: resolvedCategoryId, categoryName: resolvedCategoryName } : {}),
        ...(clearFields.includes('categoryId') ? { categoryId: undefined, categoryName: undefined } : {}),
        ...(resolvedLabelIds ? { labelIds: resolvedLabelIds, labels: resolvedLabelNames } : {}),
        ...(clearFields.includes('labelIds') ? { labelIds: [], labels: [] } : {}),
        ...(formattedNote !== undefined ? { note: formattedNote } : {}),
        ...(clearFields.includes('note') ? { note: undefined } : {}),
        ...(resolvedAmount !== undefined ? { amount: resolvedAmount } : {}),
        ...(formattedCounterParty !== undefined ? { counterParty: formattedCounterParty } : {}),
        ...(clearFields.includes('counterParty') ? { counterParty: undefined } : {}),
        ...(clearFields.includes('transfer')
          ? { isTransfer: false, partnerRecordId: undefined }
          : {}),
      });

      // Build structured receipt response
      const isTransfer = clearFields.includes('transfer') ? false : mapping.isTransfer === true;
      const finalAmount = resolvedAmount !== undefined ? resolvedAmount : (mapping.amount ?? 0);
      const isExpense = finalAmount < 0;
      const transactionTypeIcon = isTransfer ? '🔄' : isExpense ? '💸' : '💰';

      const finalAccountId = resolvedTargetAccountId || mapping.accountId;
      const targetAccount = cachedAccounts.find(account => account.id === finalAccountId);
      const resolvedCurrency =
        resolvedTargetCurrency ||
        mapping.currency ||
        targetAccount?.currency ||
        getDefaultCurrency();
      const formattedAmount = formatCurrencyAmount(finalAmount, resolvedCurrency, dictionary.languageCode);
      const resolvedAccountName =
        resolvedTargetAccountName ||
        targetAccount?.name ||
        mapping.accountName ||
        'Wallet';

      const cachedCategories = this.walletCacheService.getCategories();
      const defaultCategoryName = isTransfer ? dictionary.labels.transfer : (dictionary.labels.defaultCategory || 'Umum');
      let finalCategoryName: string;
      if (clearFields.includes('categoryId') || clearFields.includes('transfer')) {
        finalCategoryName = defaultCategoryName;
      } else {
        finalCategoryName =
          resolvedCategoryName ||
          mapping.categoryName ||
          cachedCategories.find(category => category.id === mapping.categoryId)?.name ||
          defaultCategoryName;
      }

      const recordTimestampDisplay = formatTransactionDate(
        mapping.recordDate || mapping.createdAt,
        dictionary.languageCode
      );

      const finalNote = clearFields.includes('note')
        ? undefined
        : formattedNote !== undefined
          ? formattedNote
          : mapping.note;
      const finalCounterParty = clearFields.includes('counterParty')
        ? undefined
        : formattedCounterParty !== undefined
          ? formattedCounterParty
          : mapping.counterParty;
      const defaultTitle = isTransfer
        ? dictionary.labels.transfer
        : (isExpense ? dictionary.labels.expense : dictionary.labels.income);
      const displayTitle = resolveTransactionDisplayTitle({
        counterParty: finalCounterParty,
        note: finalNote,
        defaultTitle,
      });

      let finalLabels: string[] | undefined;
      if (clearFields.includes('labelIds')) {
        finalLabels = undefined;
      } else {
        finalLabels = resolvedLabelNames !== undefined ? resolvedLabelNames : mapping.labels;
      }

      const receiptMessage = dictionary.records.editSuccess({
        transactionTitle: displayTitle,
        formattedAmount,
        accountName: resolvedAccountName,
        categoryName: finalCategoryName,
        recordTimestampDisplay,
        transactionTypeIcon,
        labels: finalLabels,
        movedFromAccountName,
        clearedFields: clearFields.length > 0 ? clearFields : undefined,
        isTransfer,
      });

      const sendReceipt = await this.messagingGateway.sendMessage(
        event.channel,
        event.chatIdentifier,
        receiptMessage
      );

      // Support chained edits by recording the new response message ID
      if (sendReceipt && 'messageId' in sendReceipt && sendReceipt.messageId) {
        this.transactionMessageStore.recordMessageMapping(sendReceipt.messageId, {
          ...mapping,
          ...(resolvedTargetAccountId
            ? {
                accountId: resolvedTargetAccountId,
                accountName: resolvedTargetAccountName,
                currency: resolvedTargetCurrency,
              }
            : {}),
          ...(resolvedCategoryId ? { categoryId: resolvedCategoryId, categoryName: resolvedCategoryName } : {}),
          ...(clearFields.includes('categoryId') ? { categoryId: undefined, categoryName: undefined } : {}),
          ...(resolvedLabelIds ? { labelIds: resolvedLabelIds, labels: resolvedLabelNames } : {}),
          ...(clearFields.includes('labelIds') ? { labelIds: [], labels: [] } : {}),
          ...(formattedNote !== undefined ? { note: formattedNote } : {}),
          ...(clearFields.includes('note') ? { note: undefined } : {}),
          ...(resolvedAmount !== undefined ? { amount: resolvedAmount } : {}),
          ...(formattedCounterParty !== undefined ? { counterParty: formattedCounterParty } : {}),
          ...(clearFields.includes('counterParty') ? { counterParty: undefined } : {}),
          ...(clearFields.includes('transfer')
            ? { isTransfer: false, partnerRecordId: undefined }
            : {}),
        });
      }

      return true;
    } catch (patchError) {
      applicationLogger.error(
        `Failed to patch record '${mapping.recordId}': ${
          patchError instanceof Error ? patchError.message : String(patchError)
        }`
      );
      await this.messagingGateway.sendMessage(
        event.channel,
        event.chatIdentifier,
        dictionary.errors.recordEditFailed(
          patchError instanceof Error ? patchError.message : String(patchError)
        )
      );
      return true;
    }
  }

  private findAssignableCategory(nameOrIdHint: string): WalletCategoryItem | undefined {
    const categories = this.walletCacheService.getCategories();
    const cleanHint = nameOrIdHint.trim().toLowerCase();

    // 1. Direct ID match
    const byId = categories.find(c => c.id === nameOrIdHint.trim());
    if (byId && byId.isAssignable !== false && byId.group?.id !== 'system_categories') {
      return byId;
    }

    // 2. Exact name match (case-insensitive)
    const exactName = categories.find(
      c =>
        c.name.trim().toLowerCase() === cleanHint &&
        c.isAssignable !== false &&
        c.group?.id !== 'system_categories'
    );
    if (exactName) return exactName;

    // 3. Partial substring name match
    const partialName = categories.find(
      c =>
        c.name.trim().toLowerCase().includes(cleanHint) &&
        c.isAssignable !== false &&
        c.group?.id !== 'system_categories'
    );
    if (partialName) return partialName;

    return undefined;
  }
}
